// zalo_drive_auth_server.js
// Standalone Local Google OAuth2 (Authorization Code + PKCE S256) & Sign-In Server for Zalo Cloud Vault
// Zero external npm dependencies.
// Serves:
//   - GET  /login           : Google Cloud OAuth2 Setup & Sign-In Page
//   - POST /auth/config     : Save Google OAuth Client ID & optional Client Secret into sync_config.json
//   - GET  /oauth/start     : Initiates real Google OAuth2 Authorization Code + PKCE (S256) loopback flow
//   - GET  /oauth/callback  : Handles OAuth2 callback, exchanges code for tokens, verifies Drive connection
//   - POST /auth/refresh    : Forces token refresh via GoogleDriveApiEngine & updates sync_config.json
//   - GET/POST /auth/start  : Opens browser to /login (legacy compatible)
//   - GET  /auth/status     : Polling endpoint for Zalo UI
//   - GET  /auth/jsonp      : XSS-validated JSONP endpoint
//   - GET  /auth/events     : Server-Sent Events (SSE) stream
//   - POST /auth/complete   : Legacy manual sign-in completion endpoint
//   - GET/POST /auth/reset  : Resets authentication state
//   - GET  /health          : Health-check endpoint

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const GoogleDriveApiEngine = require('./GoogleDriveApiEngine');

const DEFAULT_PORT = Number(process.env.ZALO_AUTH_PORT) || 8585;
const APP_DIR = __dirname;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_BODY_BYTES = 64 * 1024; // 64 KB
const JSONP_CALLBACK_RE = /^[a-zA-Z_$][0-9a-zA-Z_$.]*$/;

let activePort = DEFAULT_PORT;

function getOAuthEndpoints() {
  return {
    authUrl: process.env.ZALO_OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.ZALO_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    driveApiUrl: process.env.ZALO_DRIVE_API_URL || 'https://www.googleapis.com'
  };
}

function resolveConfigFile() {
  if (process.env.ZALO_SYNC_CONFIG) {
    return process.env.ZALO_SYNC_CONFIG;
  }
  const candidates = [
    path.join(APP_DIR, 'sync_config.json'),
    path.join(APP_DIR, '..', 'sync_config.json'),
    path.join(APP_DIR, '..', '..', 'sync_config.json'),
    path.join(path.dirname(process.execPath || ''), 'sync_config.json'),
    'D:\\Zalo_Test_Env\\sync_config.json',
    'D:\\Zalo_Test_Env\\ZaloApp\\sync_config.json'
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

function getConfigFilePath() {
  return resolveConfigFile();
}

function readSyncConfig() {
  const cfgPath = getConfigFilePath();
  try {
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      return raw ? JSON.parse(raw) : {};
    }
  } catch (err) {
    console.error('[ZaloAuthServer] Failed to read sync_config.json:', err.message);
  }
  return {};
}

function writeSyncConfig(cfg) {
  const cfgPath = getConfigFilePath();
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDriveQuota(quota) {
  if (!quota || (!quota.limit && !quota.usage)) {
    return 'Google Drive đã kết nối';
  }
  const usageBytes = Number(quota.usage || 0);
  const limitBytes = Number(quota.limit || 0);
  const toGB = (bytes) => (bytes / (1024 * 1024 * 1024)).toFixed(2);
  if (limitBytes > 0) {
    return `${toGB(usageBytes)} GB / ${toGB(limitBytes)} GB đã dùng`;
  }
  return `${toGB(usageBytes)} GB đã dùng`;
}

// Global Auth State
const authState = {
  authenticated: false,
  user: null,
  lastUpdated: null
};

function loadAuthStateFromConfig() {
  const cfg = readSyncConfig();
  if (cfg.googleAccount && cfg.googleAccount.email) {
    authState.authenticated = true;
    authState.user = cfg.googleAccount;
    authState.lastUpdated = cfg.googleAccount.connectedAt || new Date().toISOString();
  } else {
    authState.authenticated = false;
    authState.user = null;
  }
}

loadAuthStateFromConfig();

// Pending OAuth2 PKCE states (state -> { codeVerifier, createdAt, expiresAt, redirectUri })
const pendingOAuthStates = new Map();

function cleanupExpiredOAuthStates() {
  const now = Date.now();
  for (const [key, entry] of pendingOAuthStates.entries()) {
    if (!entry || now > entry.expiresAt) {
      pendingOAuthStates.delete(key);
    }
  }
}

// Connected SSE clients
const sseClients = new Set();

function notifyClients(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache'
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache'
  });
  res.end(html);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function postFormUrlEncoded(targetUrl, formParams) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return reject(new Error(`Invalid token URL: ${err.message}`));
    }

    const body = new URLSearchParams(formParams).toString();
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          data: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.setTimeout(15000, () => req.destroy(new Error('Token exchange request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Browser Launcher Helper with 2500ms cooldown debounce (Avoid duplicate tabs)
let lastChromeLaunchTime = 0;
function launchGoogleChrome(targetUrl) {
  const now = Date.now();
  if (now - lastChromeLaunchTime < 2500) {
    console.log('[ZaloAuthServer] launchGoogleChrome debounced (cooldown active).');
    return;
  }
  lastChromeLaunchTime = now;

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];

  const foundChrome = chromePaths.find(p => fs.existsSync(p));

  if (foundChrome) {
    console.log(`[ZaloAuthServer] Launching Google Chrome: "${foundChrome}" "${targetUrl}"`);
    exec(`start "" "${foundChrome}" "${targetUrl}"`, (err) => {
      if (err) {
        console.warn('[ZaloAuthServer] Chrome launch fallback to start:', err.message);
        exec(`start "" "${targetUrl}"`);
      }
    });
  } else {
    console.log(`[ZaloAuthServer] Chrome not found at standard paths. Launching default browser: "${targetUrl}"`);
    exec(`start "" "${targetUrl}"`);
  }
}

function getOAuthResultHtml({ success, title, message, email, detail }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeEmail = escapeHtml(email);
  const safeDetail = escapeHtml(detail);

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} - Zalo Cloud Vault</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Google Sans", Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      background-color: #f0f4f9;
      color: #1f1f1f;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #ffffff;
      width: 100%;
      max-width: 480px;
      border-radius: 28px;
      padding: 40px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
      border: 1px solid #e1e3e1;
      text-align: center;
    }
    .icon-wrap {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: ${success ? '#e6f4ea' : '#fce8e6'};
      color: ${success ? '#137333' : '#c5221f'};
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
      font-size: 32px;
      font-weight: 700;
    }
    h1 {
      font-size: 22px;
      color: ${success ? '#137333' : '#c5221f'};
      margin-bottom: 10px;
    }
    p {
      font-size: 14.5px;
      color: #444746;
      line-height: 1.55;
      margin-bottom: 18px;
    }
    .alert {
      background: ${success ? '#f8fafc' : '#fef7f6'};
      border: 1px solid ${success ? '#c2e7ff' : '#f6aea9'};
      border-radius: 12px;
      padding: 14px 16px;
      font-size: 13.5px;
      color: ${success ? '#004a77' : '#8c1d18'};
      margin-bottom: 24px;
      text-align: left;
      word-break: break-word;
    }
    .btn {
      display: inline-block;
      width: 100%;
      padding: 12px 24px;
      border-radius: 12px;
      background: #0b57d0;
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      border: none;
      cursor: pointer;
    }
    .btn:hover { background: #0842a0; }
    .sub { font-size: 12px; color: #747775; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-wrap">${success ? '&#10003;' : '&#10005;'}</div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}${safeEmail ? ` (<strong>${safeEmail}</strong>)` : ''}</p>
    ${safeDetail ? `<div class="alert">${safeDetail}</div>` : ''}
    ${success
      ? `<button class="btn" onclick="window.close()">Quay lại ứng dụng Zalo</button>
         <div class="sub">Cửa sổ sẽ tự đóng sau <span id="countdown">4</span> giây...</div>
         <script>
           let s = 4;
           const el = document.getElementById('countdown');
           const t = setInterval(() => {
             s--;
             if (el) el.textContent = s;
             if (s <= 0) { clearInterval(t); window.close(); }
           }, 1000);
         </script>`
      : `<a class="btn" href="/login">Quay lại trang cấu hình &amp; đăng nhập</a>`
    }
  </div>
</body>
</html>`;
}

// Google Sign-In & OAuth2 Config HTML Page Template
function getGoogleLoginPageHtml({ clientId, hasClientSecret, initialUser, connectedUser, errorCode }) {
  const safeClientId = escapeHtml(clientId || '');
  const safeInitialName = escapeHtml((initialUser && initialUser.name) ? initialUser.name : '');
  const safeInitialEmail = escapeHtml((initialUser && initialUser.email) ? initialUser.email : '');
  const safeConnectedEmail = escapeHtml((connectedUser && connectedUser.email) ? connectedUser.email : '');
  const safeConnectedName = escapeHtml((connectedUser && connectedUser.name) ? connectedUser.name : '');
  const safeRedirectUri = escapeHtml(`http://127.0.0.1:${activePort}/oauth/callback`);
  const safeError = escapeHtml(
    errorCode === 'missing_client_id'
      ? 'Chưa có Google OAuth Client ID. Vui lòng nhập và lưu Client ID trước khi đăng nhập bằng Google.'
      : (errorCode || '')
  );
  const secretPlaceholder = hasClientSecret
    ? 'Đã lưu Client Secret (để trống nếu giữ nguyên)'
    : 'Client Secret (tùy chọn cho Desktop App)';

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Đăng nhập bằng Google - Zalo Cloud Vault</title>
  <link rel="icon" href="https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Google Sans", Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      background-color: #f0f4f9;
      color: #1f1f1f;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .auth-card {
      background: #ffffff;
      width: 100%;
      max-width: 540px;
      border-radius: 28px;
      padding: 36px 40px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.04);
      border: 1px solid #e1e3e1;
    }

    .brand-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }
    .brand-header svg {
      width: 38px;
      height: 38px;
    }
    .brand-title-wrap {
      display: flex;
      flex-direction: column;
    }
    .brand-app-name {
      font-size: 13px;
      font-weight: 500;
      color: #444746;
      letter-spacing: 0.2px;
    }
    .brand-google-title {
      font-size: 22px;
      font-weight: 600;
      color: #1f1f1f;
      line-height: 1.3;
    }

    .sub-desc {
      font-size: 14px;
      color: #444746;
      line-height: 1.5;
      margin-bottom: 18px;
    }

    .banner-error {
      background: #fce8e6;
      border: 1px solid #f6aea9;
      color: #8c1d18;
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 13px;
      margin-bottom: 16px;
      line-height: 1.45;
    }

    .banner-connected {
      background: #e6f4ea;
      border: 1px solid #a8dab5;
      color: #0d652d;
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 13px;
      margin-bottom: 18px;
      line-height: 1.45;
    }

    .guide-box {
      background: #f8fafd;
      border: 1px solid #d3e3fd;
      border-radius: 14px;
      padding: 14px 16px;
      margin-bottom: 18px;
      font-size: 12.8px;
      color: #1f1f1f;
      line-height: 1.55;
    }
    .guide-title {
      font-weight: 700;
      color: #0b57d0;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .guide-box ol {
      padding-left: 18px;
    }
    .guide-box li {
      margin-bottom: 4px;
    }
    .code-pill {
      display: inline-block;
      background: #edf2fa;
      border: 1px solid #c2e7ff;
      color: #004a77;
      padding: 1px 6px;
      border-radius: 6px;
      font-family: Consolas, monospace;
      font-size: 12px;
      user-select: all;
    }

    .field-group {
      margin-bottom: 14px;
    }
    .field-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #1f1f1f;
      margin-bottom: 6px;
    }
    .text-input {
      width: 100%;
      padding: 11px 13px;
      font-size: 14px;
      border: 1px solid #747775;
      border-radius: 8px;
      outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .text-input:focus {
      border-color: #0b57d0;
      box-shadow: 0 0 0 2px rgba(11, 87, 208, 0.2);
    }

    .status-msg {
      font-size: 12.5px;
      margin-top: 6px;
      min-height: 18px;
    }
    .status-ok { color: #137333; font-weight: 600; }
    .status-err { color: #c5221f; font-weight: 600; }

    .scopes-box {
      background: #fdfcff;
      border: 1px solid #e1e3e1;
      border-radius: 14px;
      padding: 14px 16px;
      margin: 18px 0 22px;
    }
    .scopes-header {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #444746;
      margin-bottom: 10px;
    }
    .scope-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 13px;
      color: #1f1f1f;
      line-height: 1.45;
      margin-bottom: 8px;
    }
    .scope-item:last-child { margin-bottom: 0; }
    .scope-icon { color: #0b57d0; flex-shrink: 0; margin-top: 2px; }

    .button-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .btn {
      padding: 10px 20px;
      border-radius: 100px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      outline: none;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid transparent;
      text-decoration: none;
    }
    .btn-outline {
      background: #ffffff;
      color: #0b57d0;
      border-color: #747775;
    }
    .btn-outline:hover { background: #f0f4f9; border-color: #0b57d0; }
    .btn-primary {
      background: #0b57d0;
      color: #ffffff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
      flex: 1;
    }
    .btn-primary:hover {
      background: #0842a0;
      box-shadow: 0 2px 6px rgba(11, 87, 208, 0.3);
    }
    .btn-secondary {
      background: transparent;
      color: #444746;
    }
    .btn-secondary:hover { background: #f0f4f9; }

    .footer-policy {
      margin-top: 20px;
      font-size: 12px;
      color: #747775;
      text-align: center;
    }
    .footer-policy a { color: #444746; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="auth-card">
    <div class="brand-header">
      <svg viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg">
        <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
        <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47"/>
        <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
        <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
        <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
        <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
      </svg>
      <div class="brand-title-wrap">
        <span class="brand-app-name">Zalo Cloud Vault</span>
        <h1 class="brand-google-title">Kết nối Google Drive (OAuth2 + PKCE)</h1>
      </div>
    </div>

    ${safeError ? `<div class="banner-error">${safeError}</div>` : ''}
    ${safeConnectedEmail ? `<div class="banner-connected">Đã kết nối hiện tại: <strong>${safeConnectedName || safeConnectedEmail}</strong> (${safeConnectedEmail})</div>` : ''}

    <p class="sub-desc">
      Kết nối tài khoản Google Drive của bạn qua chuẩn <strong>OAuth 2.0 Authorization Code + PKCE (S256)</strong> để sao lưu tin nhắn &amp; media tự động vào thư mục riêng của ứng dụng.
    </p>

    <div class="guide-box">
      <div class="guide-title">Hướng dẫn tạo Google Cloud Desktop OAuth (3 bước):</div>
      <ol>
        <li>Mở <strong>Google Cloud Console</strong> &rarr; <em>APIs &amp; Services &rarr; Credentials</em>, bật <strong>Google Drive API</strong>.</li>
        <li>Tạo <strong>OAuth client ID</strong> loại <strong>Desktop app</strong> (hoặc thêm Redirect URI: <span class="code-pill">${safeRedirectUri}</span>).</li>
        <li>Dán <strong>Client ID</strong> (và Client Secret nếu có) vào ô bên dưới, bấm <em>Lưu cấu hình OAuth</em> rồi chọn <em>Đăng nhập bằng Google</em>.</li>
      </ol>
    </div>

    <div class="field-group">
      <label class="field-label" for="inputClientId">Google OAuth Client ID:</label>
      <input type="text" class="text-input" id="inputClientId" placeholder="xxxx-xxxxxxxx.apps.googleusercontent.com" value="${safeClientId}" />
    </div>

    <div class="field-group">
      <label class="field-label" for="inputClientSecret">Google Client Secret (Tùy chọn):</label>
      <input type="password" class="text-input" id="inputClientSecret" placeholder="${escapeHtml(secretPlaceholder)}" value="" autocomplete="off" />
      <div id="configStatus" class="status-msg"></div>
    </div>

    <div class="scopes-box">
      <div class="scopes-header">Quyền yêu cầu (drive.file + profile):</div>
      <div class="scope-item">
        <svg class="scope-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z"/></svg>
        <div>Chỉ truy cập và quản lý tệp/thư mục <strong>Zalo_Cloud_Vault/</strong> do ứng dụng tạo ra (<code>drive.file</code>).</div>
      </div>
      <div class="scope-item">
        <svg class="scope-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z"/></svg>
        <div>Đọc thông tin hồ sơ Google cơ bản (<code>openid email profile</code>) và dung lượng Drive.</div>
      </div>
    </div>

    <div class="button-row">
      <button type="button" class="btn btn-outline" id="btnSaveConfig">Lưu cấu hình OAuth</button>
      <a class="btn btn-primary" id="btnOAuthLogin" href="/oauth/start">Đăng nhập bằng Google (OAuth2 thật)</a>
      <button type="button" class="btn btn-secondary" onclick="window.close()">Đóng</button>
    </div>
  </div>

  <div class="footer-policy">
    Bảo vệ bởi OAuth 2.0 PKCE (S256). ${safeInitialEmail ? `Zalo: ${safeInitialName || safeInitialEmail} &bull; ` : ''}<a href="https://policies.google.com/privacy" target="_blank">Quyền riêng tư</a> &bull; <a href="https://policies.google.com/terms" target="_blank">Điều khoản</a>
  </div>

  <script>
    const inputClientId = document.getElementById('inputClientId');
    const inputClientSecret = document.getElementById('inputClientSecret');
    const configStatus = document.getElementById('configStatus');
    const btnSaveConfig = document.getElementById('btnSaveConfig');
    const btnOAuthLogin = document.getElementById('btnOAuthLogin');

    async function saveOAuthConfig() {
      const googleClientId = inputClientId.value.trim();
      const googleClientSecret = inputClientSecret.value.trim();

      if (!googleClientId) {
        configStatus.className = 'status-msg status-err';
        configStatus.textContent = 'Vui lòng nhập Google OAuth Client ID.';
        inputClientId.focus();
        return false;
      }

      const payload = { googleClientId };
      if (googleClientSecret) {
        payload.googleClientSecret = googleClientSecret;
      }

      btnSaveConfig.disabled = true;
      try {
        const res = await fetch('/auth/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Không thể lưu cấu hình');
        }
        configStatus.className = 'status-msg status-ok';
        configStatus.textContent = 'Đã lưu cấu hình OAuth thành công.';
        return true;
      } catch (err) {
        configStatus.className = 'status-msg status-err';
        configStatus.textContent = 'Lỗi lưu cấu hình: ' + err.message;
        return false;
      } finally {
        btnSaveConfig.disabled = false;
      }
    }

    btnSaveConfig.addEventListener('click', saveOAuthConfig);

    btnOAuthLogin.addEventListener('click', async (e) => {
      const typedId = inputClientId.value.trim();
      const typedSecret = inputClientSecret.value.trim();
      if (typedId || typedSecret) {
        e.preventDefault();
        const saved = await saveOAuthConfig();
        if (saved) {
          window.location.href = '/oauth/start';
        }
      }
    });
  </script>
</body>
</html>`;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS Headers for Localhost communication
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Health check
  if (pathname === '/health' || pathname === '/') {
    const cfg = readSyncConfig();
    const clientId = cfg.googleClientId || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
    sendJson(res, 200, {
      ok: true,
      service: 'zalo-drive-auth-server',
      port: activePort,
      authenticated: authState.authenticated,
      user: authState.user,
      hasClientId: Boolean(clientId)
    });
    return;
  }

  // 2. Launch Browser to Google Sign-In (Accepts both GET and POST)
  if (pathname === '/auth/start') {
    const targetUrl = `http://127.0.0.1:${activePort}/login`;
    launchGoogleChrome(targetUrl);

    // Return 1x1 transparent GIF for <img> pings, or JSON for API calls
    if (req.headers.accept && req.headers.accept.includes('image')) {
      const transparentGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': transparentGif.length,
        'Cache-Control': 'no-store, no-cache'
      });
      res.end(transparentGif);
    } else {
      sendJson(res, 200, { ok: true, url: targetUrl, message: 'Google Chrome launched' });
    }
    return;
  }

  // 2b. JSONP Status Endpoint (Validated against reflected XSS)
  if (pathname === '/auth/jsonp') {
    const rawCb = parsedUrl.query.callback || parsedUrl.query.jsonp;
    if (rawCb !== undefined && !JSONP_CALLBACK_RE.test(String(rawCb))) {
      sendJson(res, 400, { success: false, error: 'Invalid callback parameter' });
      return;
    }
    const cb = rawCb ? String(rawCb) : 'callback';
    const jsonPayload = JSON.stringify({
      authenticated: authState.authenticated,
      user: authState.user,
      lastUpdated: authState.lastUpdated
    });
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, no-cache'
    });
    res.end(`${cb}(${jsonPayload});`);
    return;
  }

  // 3. Status check endpoint (polling fallback)
  if (pathname === '/auth/status') {
    sendJson(res, 200, {
      authenticated: authState.authenticated,
      user: authState.user,
      lastUpdated: authState.lastUpdated
    });
    return;
  }

  // 4. Server-Sent Events (SSE) stream for real-time push callback
  if (pathname === '/auth/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(': ping\n\n');
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 5. Google Sign-In & OAuth2 Config HTML View
  if (pathname === '/login') {
    const cfg = readSyncConfig();
    const clientId = cfg.googleClientId || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
    const hasClientSecret = Boolean(cfg.googleClientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    const html = getGoogleLoginPageHtml({
      clientId,
      hasClientSecret,
      initialUser: cfg.zaloUser || null,
      connectedUser: authState.user || null,
      errorCode: parsedUrl.query.error || ''
    });
    sendHtml(res, 200, html);
    return;
  }

  // 5b. Save OAuth Client Config (POST /auth/config)
  if (pathname === '/auth/config' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const clientId = typeof data.googleClientId === 'string' ? data.googleClientId.trim() : '';
      if (!clientId) {
        sendJson(res, 400, { success: false, error: 'googleClientId is required' });
        return;
      }

      const currentCfg = readSyncConfig();
      currentCfg.googleClientId = clientId;

      if (typeof data.googleClientSecret === 'string') {
        const trimmedSecret = data.googleClientSecret.trim();
        if (trimmedSecret) {
          currentCfg.googleClientSecret = trimmedSecret;
        } else if (data.googleClientSecret === '') {
          delete currentCfg.googleClientSecret;
        }
      }

      writeSyncConfig(currentCfg);
      console.log('[ZaloAuthServer] Saved Google OAuth Client ID into sync_config.json');

      sendJson(res, 200, {
        success: true,
        googleClientId: currentCfg.googleClientId,
        hasClientSecret: Boolean(currentCfg.googleClientSecret)
      });
    } catch (err) {
      sendJson(res, 400, { success: false, error: err.message });
    }
    return;
  }

  // 5c. Initiate OAuth2 Authorization Code + PKCE (S256) flow
  if (pathname === '/oauth/start' && req.method === 'GET') {
    cleanupExpiredOAuthStates();
    const cfg = readSyncConfig();
    const clientId = (cfg.googleClientId || process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
    if (!clientId) {
      res.writeHead(302, { Location: '/login?error=missing_client_id' });
      res.end();
      return;
    }

    const state = crypto.randomBytes(24).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const redirectUri = `http://127.0.0.1:${activePort}/oauth/callback`;
    const now = Date.now();

    pendingOAuthStates.set(state, {
      codeVerifier,
      createdAt: now,
      expiresAt: now + OAUTH_STATE_TTL_MS,
      redirectUri
    });

    const endpoints = getOAuthEndpoints();
    const authRedirect = new URL(endpoints.authUrl);
    authRedirect.searchParams.set('client_id', clientId);
    authRedirect.searchParams.set('redirect_uri', redirectUri);
    authRedirect.searchParams.set('response_type', 'code');
    authRedirect.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.file openid email profile');
    authRedirect.searchParams.set('access_type', 'offline');
    authRedirect.searchParams.set('prompt', 'consent');
    authRedirect.searchParams.set('code_challenge', codeChallenge);
    authRedirect.searchParams.set('code_challenge_method', 'S256');
    authRedirect.searchParams.set('state', state);

    res.writeHead(302, { Location: authRedirect.toString() });
    res.end();
    return;
  }

  // 5d. OAuth2 Loopback Callback
  if (pathname === '/oauth/callback' && req.method === 'GET') {
    const queryState = typeof parsedUrl.query.state === 'string' ? parsedUrl.query.state : '';
    const oauthError = typeof parsedUrl.query.error === 'string' ? parsedUrl.query.error : '';
    const oauthErrorDesc = typeof parsedUrl.query.error_description === 'string' ? parsedUrl.query.error_description : '';
    const code = typeof parsedUrl.query.code === 'string' ? parsedUrl.query.code : '';

    const pending = queryState ? pendingOAuthStates.get(queryState) : null;
    if (queryState) {
      pendingOAuthStates.delete(queryState); // single-use
    }
    cleanupExpiredOAuthStates();

    if (!pending || Date.now() > pending.expiresAt) {
      sendHtml(res, 400, getOAuthResultHtml({
        success: false,
        title: 'Phiên xác thực không hợp lệ hoặc đã hết hạn',
        message: 'Tham số state OAuth2 không khớp hoặc đã quá hạn 10 phút.',
        detail: 'Vui lòng bắt đầu lại quá trình đăng nhập từ trang /login.'
      }));
      return;
    }

    if (oauthError) {
      sendHtml(res, 400, getOAuthResultHtml({
        success: false,
        title: 'Đăng nhập Google bị từ chối hoặc lỗi',
        message: `Google trả về lỗi: ${oauthError}`,
        detail: oauthErrorDesc || 'Người dùng đã hủy hoặc từ chối cấp quyền.'
      }));
      return;
    }

    if (!code) {
      sendHtml(res, 400, getOAuthResultHtml({
        success: false,
        title: 'Thiếu mã xác thực (Authorization Code)',
        message: 'Google OAuth callback không kèm tham số code.',
        detail: 'Vui lòng thử đăng nhập lại.'
      }));
      return;
    }

    try {
      const cfg = readSyncConfig();
      const clientId = (cfg.googleClientId || process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
      const clientSecret = (cfg.googleClientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
      const endpoints = getOAuthEndpoints();

      const tokenForm = {
        code,
        client_id: clientId,
        redirect_uri: pending.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: pending.codeVerifier
      };
      if (clientSecret) {
        tokenForm.client_secret = clientSecret;
      }

      const tokenRes = await postFormUrlEncoded(endpoints.tokenUrl, tokenForm);
      if (tokenRes.statusCode !== 200) {
        throw new Error(`Token endpoint HTTP ${tokenRes.statusCode}: ${tokenRes.data}`);
      }

      const tokenData = JSON.parse(tokenRes.data);
      if (!tokenData.access_token) {
        throw new Error('Token response missing access_token');
      }

      const expiresInSec = Number(tokenData.expires_in) || 3600;
      const tokenExpiry = Date.now() + (expiresInSec * 1000);
      const refreshToken = tokenData.refresh_token || cfg.googleRefreshToken || '';

      const engine = new GoogleDriveApiEngine({
        clientId,
        clientSecret,
        accessToken: tokenData.access_token,
        refreshToken,
        tokenExpiry,
        tokenEndpoint: endpoints.tokenUrl,
        apiBaseUrl: endpoints.driveApiUrl,
        onTokenRefresh: (refreshed) => {
          try {
            const latestCfg = readSyncConfig();
            latestCfg.googleAccessToken = refreshed.accessToken;
            latestCfg.googleTokenExpiry = refreshed.tokenExpiry;
            writeSyncConfig(latestCfg);
          } catch (persistErr) {
            console.error('[ZaloAuthServer] Failed to persist refreshed tokens:', persistErr.message);
          }
        }
      });

      const about = await engine.verifyConnection();
      const driveUser = (about && about.user) ? about.user : {};
      const storageQuota = (about && about.storageQuota) ? about.storageQuota : {};
      const connectedAt = new Date().toISOString();

      const googleAccount = {
        name: driveUser.displayName || driveUser.emailAddress || 'Google User',
        email: driveUser.emailAddress || '',
        avatar: driveUser.photoLink || '',
        driveQuota: formatDriveQuota(storageQuota),
        storageQuota,
        connectedAt
      };

      const updatedCfg = readSyncConfig();
      updatedCfg.googleAccessToken = tokenData.access_token;
      if (refreshToken) {
        updatedCfg.googleRefreshToken = refreshToken;
      }
      updatedCfg.googleTokenExpiry = tokenExpiry;
      updatedCfg.googleAccount = googleAccount;
      updatedCfg.preferredSyncMode = 'cloud_api';
      writeSyncConfig(updatedCfg);

      authState.authenticated = true;
      authState.user = googleAccount;
      authState.lastUpdated = connectedAt;
      notifyClients('authenticated', authState.user);

      console.log('[ZaloAuthServer] OAuth2 PKCE authentication succeeded for:', googleAccount.email);

      sendHtml(res, 200, getOAuthResultHtml({
        success: true,
        title: 'Đăng nhập Google Drive thành công!',
        message: 'Tài khoản đã được xác thực qua OAuth 2.0 + PKCE và kết nối với Zalo Cloud Vault.',
        email: googleAccount.email,
        detail: `Dung lượng Drive: ${googleAccount.driveQuota}. Chế độ đồng bộ: cloud_api.`
      }));
    } catch (err) {
      console.error('[ZaloAuthServer] OAuth2 callback failed:', err.message);
      sendHtml(res, 502, getOAuthResultHtml({
        success: false,
        title: 'Không thể hoàn tất xác thực Google OAuth2',
        message: 'Đã xảy ra lỗi khi trao đổi mã hoặc xác minh Google Drive API.',
        detail: err.message
      }));
    }
    return;
  }

  // 5e. Force Token Refresh & Re-verify Drive Connection (POST /auth/refresh)
  if (pathname === '/auth/refresh' && req.method === 'POST') {
    try {
      const cfg = readSyncConfig();
      const clientId = (cfg.googleClientId || process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
      const clientSecret = (cfg.googleClientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
      const refreshToken = (cfg.googleRefreshToken || '').trim();

      if (!clientId || !refreshToken) {
        sendJson(res, 400, {
          success: false,
          error: 'Missing googleClientId or googleRefreshToken in sync_config.json'
        });
        return;
      }

      const endpoints = getOAuthEndpoints();
      const engine = new GoogleDriveApiEngine({
        clientId,
        clientSecret,
        refreshToken,
        accessToken: null,
        tokenExpiry: 0,
        tokenEndpoint: endpoints.tokenUrl,
        apiBaseUrl: endpoints.driveApiUrl
      });

      engine.accessToken = null;
      engine.tokenExpiry = 0;
      const newAccessToken = await engine.ensureValidAccessToken();
      const about = await engine.verifyConnection();

      const driveUser = (about && about.user) ? about.user : {};
      const storageQuota = (about && about.storageQuota) ? about.storageQuota : {};
      const existingAccount = cfg.googleAccount || {};
      const updatedAt = new Date().toISOString();

      const updatedAccount = {
        name: driveUser.displayName || existingAccount.name || driveUser.emailAddress || 'Google User',
        email: driveUser.emailAddress || existingAccount.email || '',
        avatar: driveUser.photoLink || existingAccount.avatar || '',
        driveQuota: formatDriveQuota(storageQuota),
        storageQuota,
        connectedAt: existingAccount.connectedAt || updatedAt
      };

      cfg.googleAccessToken = newAccessToken;
      cfg.googleTokenExpiry = engine.tokenExpiry;
      cfg.googleAccount = updatedAccount;
      writeSyncConfig(cfg);

      authState.authenticated = true;
      authState.user = updatedAccount;
      authState.lastUpdated = updatedAt;
      notifyClients('authenticated', authState.user);

      sendJson(res, 200, {
        success: true,
        user: updatedAccount,
        tokenExpiry: engine.tokenExpiry
      });
    } catch (err) {
      console.error('[ZaloAuthServer] Token refresh failed:', err.message);
      sendJson(res, 502, { success: false, error: err.message });
    }
    return;
  }

  // 6. Legacy Complete Auth Callback (Backwards-compatible)
  if (pathname === '/auth/complete' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      authState.authenticated = true;
      authState.user = {
        name: data.name || 'Người dùng Google',
        email: data.email || 'user@gmail.com',
        avatar: data.avatar || '',
        driveQuota: data.driveQuota || '15 GB khả dụng',
        connectedAt: new Date().toISOString()
      };
      authState.lastUpdated = new Date().toISOString();

      console.log('[ZaloAuthServer] User authenticated (legacy /auth/complete):', authState.user.email);

      try {
        const currentCfg = readSyncConfig();
        currentCfg.googleAccount = authState.user;
        writeSyncConfig(currentCfg);
      } catch (persistErr) {
        console.error('[ZaloAuthServer] Failed to persist /auth/complete:', persistErr.message);
      }

      notifyClients('authenticated', authState.user);
      sendJson(res, 200, { success: true, user: authState.user });
    } catch (err) {
      sendJson(res, 400, { success: false, error: err.message });
    }
    return;
  }

  // 7. Reset Auth
  if (pathname === '/auth/reset') {
    authState.authenticated = false;
    authState.user = null;
    authState.lastUpdated = new Date().toISOString();
    pendingOAuthStates.clear();
    notifyClients('reset', {});

    try {
      const currentCfg = readSyncConfig();
      delete currentCfg.googleAccount;
      delete currentCfg.googleAccessToken;
      delete currentCfg.googleRefreshToken;
      delete currentCfg.googleTokenExpiry;
      writeSyncConfig(currentCfg);
    } catch (persistErr) {
      console.error('[ZaloAuthServer] Failed to clear auth in sync_config.json:', persistErr.message);
    }

    sendJson(res, 200, { success: true, message: 'Auth reset' });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

// Start Server (supports optional customPort including 0 for ephemeral test port)
function startServer(customPort) {
  const targetPort = (customPort !== undefined && customPort !== null) ? Number(customPort) : DEFAULT_PORT;
  loadAuthStateFromConfig();

  return new Promise((resolve, reject) => {
    if (server.listening) {
      const addr = server.address();
      activePort = (addr && typeof addr === 'object') ? addr.port : targetPort;
      resolve({ server, port: activePort });
      return;
    }

    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        console.log(`[ZaloAuthServer] Port ${targetPort} already in use. Checking if existing instance is responsive...`);
        http.get(`http://127.0.0.1:${targetPort}/health`, (healthRes) => {
          if (healthRes.statusCode === 200) {
            console.log(`[ZaloAuthServer] Existing instance on port ${targetPort} is active and healthy!`);
          }
          healthRes.resume();
        }).on('error', () => {
          console.error(`[ZaloAuthServer] Port ${targetPort} occupied by another non-responsive service.`);
        });
      } else {
        console.error('[ZaloAuthServer] Server error:', err.message);
      }
      reject(err);
    };

    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      activePort = (addr && typeof addr === 'object') ? addr.port : targetPort;
      console.log(`[ZaloAuthServer] Google Drive Local Auth Server listening on http://127.0.0.1:${activePort}`);
      console.log(`[ZaloAuthServer] Login Page available at: http://127.0.0.1:${activePort}/login`);
      resolve({ server, port: activePort });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(targetPort, '127.0.0.1');
  });
}

function stopServer() {
  pendingOAuthStates.clear();
  for (const client of sseClients) {
    try {
      client.end();
    } catch (e) {}
  }
  sseClients.clear();

  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(() => resolve());
  });
}

if (require.main === module) {
  startServer().catch(() => {});
}

module.exports = {
  server,
  startServer,
  stopServer,
  launchGoogleChrome,
  get PORT() {
    return activePort;
  }
};
