'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function httpRequest(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const req = http.request({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function createMockGoogleServer() {
  let tokenIssueCounter = 0;
  let folderIdCounter = 0;
  let fileIdCounter = 0;
  let failNextDriveCallWith401 = false;

  const state = {
    expectedClientId: 'mock-desktop-client-id.apps.googleusercontent.com',
    expectedClientSecret: 'mock-client-secret',
    codeChallengeByCode: new Map(),
    validTokens: new Set(),
    staleTokens: new Set(['stale_token_initial']),
    folders: new Map(), // key: `${parentId}:${name}` -> id
    files: new Map(),   // id -> { id, name, parents, size, contentLen }
    resumableSessions: new Map(), // sessionId -> { name, parents, totalLength, receivedBytes }
    tokenRequests: [],
    aboutRequests: [],
    driveListQueries: []
  };

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsed.pathname;

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks);
      const bodyStr = bodyBuf.toString('utf8');

      // 1. Mock OAuth2 Token Endpoint
      if (pathname === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(bodyStr);
        const grantType = params.get('grant_type');
        const clientId = params.get('client_id');
        state.tokenRequests.push({
          grantType,
          clientId,
          hasSecret: params.has('client_secret'),
          code: params.get('code'),
          codeVerifier: params.get('code_verifier'),
          refreshToken: params.get('refresh_token')
        });

        if (grantType === 'authorization_code') {
          const code = params.get('code');
          const verifier = params.get('code_verifier') || '';
          const expectedChallenge = state.codeChallengeByCode.get(code);
          const actualChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
          if (!expectedChallenge || actualChallenge !== expectedChallenge) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE code_verifier mismatch' }));
            return;
          }
          tokenIssueCounter++;
          const accessToken = `access_token_${tokenIssueCounter}`;
          const refreshToken = `refresh_token_1`;
          state.validTokens.add(accessToken);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3600,
            token_type: 'Bearer'
          }));
          return;
        }

        if (grantType === 'refresh_token') {
          const rt = params.get('refresh_token');
          if (!rt) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_request' }));
            return;
          }
          tokenIssueCounter++;
          const newAccessToken = `access_token_${tokenIssueCounter}`;
          state.validTokens.add(newAccessToken);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            access_token: newAccessToken,
            expires_in: 3600,
            token_type: 'Bearer'
          }));
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
        return;
      }

      // 2. Mock Resumable Upload PUT chunk (does not require Bearer header per Google Drive spec)
      if (pathname.startsWith('/upload/resumable/') && req.method === 'PUT') {
        const sessionId = pathname.split('/').pop();
        const sess = state.resumableSessions.get(sessionId);
        if (!sess) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }
        const contentRange = req.headers['content-range'] || '';
        const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!match) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid Content-Range' }));
          return;
        }
        const start = Number(match[1]);
        const end = Number(match[2]);
        const total = Number(match[3]);
        assert.strictEqual(end - start + 1, bodyBuf.length, 'Chunk length must match Content-Range');
        sess.receivedBytes = end + 1;

        if (sess.receivedBytes < total) {
          res.writeHead(308, {
            'Range': `bytes=0-${end}`
          });
          res.end();
          return;
        }

        fileIdCounter++;
        const id = `file_${fileIdCounter}`;
        const fileObj = {
          id,
          name: sess.name,
          parents: sess.parents,
          size: String(total),
          mimeType: 'application/octet-stream'
        };
        state.files.set(id, fileObj);
        state.resumableSessions.delete(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fileObj));
        return;
      }

      // Enforce Bearer Auth for Drive API endpoints
      const authHeader = req.headers['authorization'] || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

      if (failNextDriveCallWith401 || state.staleTokens.has(bearerToken) || !state.validTokens.has(bearerToken)) {
        failNextDriveCallWith401 = false;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }));
        return;
      }

      // 3. Mock GET /drive/v3/about
      if (pathname === '/drive/v3/about' && req.method === 'GET') {
        state.aboutRequests.push({ token: bearerToken });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          user: {
            displayName: 'E2E Test User',
            emailAddress: 'e2e.tester@example.test',
            photoLink: 'https://example.test/avatar.png'
          },
          storageQuota: {
            usage: String(2 * 1024 * 1024 * 1024),
            limit: String(15 * 1024 * 1024 * 1024)
          }
        }));
        return;
      }

      // 4. Mock GET /drive/v3/files (findFolder / findFile)
      if (pathname === '/drive/v3/files' && req.method === 'GET') {
        const q = parsed.searchParams.get('q') || '';
        state.driveListQueries.push(q);

        const nameMatch = q.match(/name='((?:\\'|[^'])*)'/);
        const parentMatch = q.match(/'([^']+)' in parents/);
        const targetName = nameMatch ? nameMatch[1].replace(/\\'/g, "'") : '';
        const targetParent = parentMatch ? parentMatch[1] : 'root';

        if (q.includes("mimeType='application/vnd.google-apps.folder'")) {
          const folderId = state.folders.get(`${targetParent}:${targetName}`);
          const files = folderId ? [{ id: folderId, name: targetName, parents: targetParent === 'root' ? [] : [targetParent] }] : [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ files }));
          return;
        }

        const matchedFiles = [];
        for (const f of state.files.values()) {
          const parentMatches = !parentMatch || (Array.isArray(f.parents) && f.parents.includes(targetParent));
          if (f.name === targetName && parentMatches) {
            matchedFiles.push(f);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: matchedFiles }));
        return;
      }

      // 5. Mock POST /drive/v3/files (createFolder)
      if (pathname === '/drive/v3/files' && req.method === 'POST') {
        const meta = JSON.parse(bodyStr);
        const parentId = (Array.isArray(meta.parents) && meta.parents[0]) ? meta.parents[0] : 'root';
        folderIdCounter++;
        const id = `folder_${folderIdCounter}`;
        state.folders.set(`${parentId}:${meta.name}`, id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, name: meta.name, parents: meta.parents || [] }));
        return;
      }

      // 6. Mock POST /upload/drive/v3/files (multipart or resumable init)
      if (pathname === '/upload/drive/v3/files' && req.method === 'POST') {
        const uploadType = parsed.searchParams.get('uploadType');
        if (uploadType === 'multipart') {
          const contentType = req.headers['content-type'] || '';
          const bMatch = contentType.match(/boundary=([^\s;]+)/);
          assert(bMatch, 'Multipart boundary required');
          const boundary = bMatch[1];
          const firstJsonStart = bodyStr.indexOf('{');
          const firstJsonEnd = bodyStr.indexOf('\r\n--', firstJsonStart);
          const meta = JSON.parse(bodyStr.slice(firstJsonStart, firstJsonEnd));
          fileIdCounter++;
          const id = `file_${fileIdCounter}`;
          const fileObj = {
            id,
            name: meta.name,
            parents: meta.parents || [],
            size: String(bodyBuf.length),
            boundary
          };
          state.files.set(id, fileObj);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fileObj));
          return;
        }

        if (uploadType === 'resumable') {
          const meta = JSON.parse(bodyStr);
          const totalLength = Number(req.headers['x-upload-content-length'] || 0);
          const sessionId = `sess_${Date.now()}_${Math.random().toString(16).slice(2)}`;
          state.resumableSessions.set(sessionId, {
            name: meta.name,
            parents: meta.parents || [],
            totalLength,
            receivedBytes: 0
          });
          const addr = server.address();
          res.writeHead(200, {
            'Location': `http://127.0.0.1:${addr.port}/upload/resumable/${sessionId}`,
            'Content-Type': 'application/json'
          });
          res.end(JSON.stringify({ status: 'resumable_session_created' }));
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unhandled mock path ${req.method} ${pathname}` }));
    });
  });

  return {
    server,
    state,
    triggerNext401() {
      failNextDriveCallWith401 = true;
    }
  };
}

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-cloud-vault-e2e-'));
  const tempConfigPath = path.join(tempRoot, 'sync_config.json');
  const mock = createMockGoogleServer();

  let authModule = null;

  try {
    await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    const mockPort = mock.server.address().port;
    const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

    // Inject isolated test env before loading auth server
    process.env.ZALO_SYNC_CONFIG = tempConfigPath;
    process.env.ZALO_OAUTH_AUTH_URL = `${mockBaseUrl}/o/oauth2/v2/auth`;
    process.env.ZALO_OAUTH_TOKEN_URL = `${mockBaseUrl}/token`;
    process.env.ZALO_DRIVE_API_URL = mockBaseUrl;

    const GoogleDriveApiEngine = require('../runtime/cloud-vault/GoogleDriveApiEngine');
    const HybridDriveManager = require('../runtime/cloud-vault/HybridDriveManager');
    authModule = require('../runtime/cloud-vault/zalo_drive_auth_server');

    const { port: authPort } = await authModule.startServer(0);
    const authBaseUrl = `http://127.0.0.1:${authPort}`;

    // -------------------------------------------------------------------------
    // TEST 1: Full OAuth2 PKCE flow + single-use state + JSONP XSS guard
    // -------------------------------------------------------------------------
    const noClientStart = await httpRequest(`${authBaseUrl}/oauth/start`);
    assert.strictEqual(noClientStart.statusCode, 302, 'Missing Client ID should redirect 302');
    assert.strictEqual(noClientStart.headers.location, '/login?error=missing_client_id');

    const cfgSaveRes = await httpRequest(`${authBaseUrl}/auth/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        googleClientId: mock.state.expectedClientId,
        googleClientSecret: mock.state.expectedClientSecret
      })
    });
    assert.strictEqual(cfgSaveRes.statusCode, 200);
    const cfgSaveJson = JSON.parse(cfgSaveRes.body);
    assert.strictEqual(cfgSaveJson.success, true);
    assert.strictEqual(cfgSaveJson.hasClientSecret, true);
    assert.strictEqual(cfgSaveJson.googleClientSecret, undefined, 'Must never echo googleClientSecret');

    const oauthStartRes = await httpRequest(`${authBaseUrl}/oauth/start`);
    assert.strictEqual(oauthStartRes.statusCode, 302);
    const redirectUrl = new URL(oauthStartRes.headers.location);
    assert.strictEqual(redirectUrl.pathname, '/o/oauth2/v2/auth');
    assert.strictEqual(redirectUrl.searchParams.get('client_id'), mock.state.expectedClientId);
    assert.strictEqual(redirectUrl.searchParams.get('redirect_uri'), `${authBaseUrl}/oauth/callback`);
    assert.strictEqual(redirectUrl.searchParams.get('response_type'), 'code');
    assert.strictEqual(redirectUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.strictEqual(redirectUrl.searchParams.get('access_type'), 'offline');
    assert.strictEqual(redirectUrl.searchParams.get('prompt'), 'consent');
    const issuedState = redirectUrl.searchParams.get('state');
    const issuedChallenge = redirectUrl.searchParams.get('code_challenge');
    assert(issuedState && issuedState.length >= 32, 'State must be strong random hex');
    assert(issuedChallenge && issuedChallenge.length >= 40, 'PKCE S256 challenge must exist');

    // Invalid state rejected 400
    const badStateRes = await httpRequest(`${authBaseUrl}/oauth/callback?state=tampered_state&code=abc`);
    assert.strictEqual(badStateRes.statusCode, 400, 'Invalid state must return 400');

    // Valid callback exchanges code + code_verifier and verifies Drive /about
    const authCode = 'mock_auth_code_1';
    mock.state.codeChallengeByCode.set(authCode, issuedChallenge);
    const callbackRes = await httpRequest(`${authBaseUrl}/oauth/callback?state=${encodeURIComponent(issuedState)}&code=${authCode}`);
    assert.strictEqual(callbackRes.statusCode, 200, `Expected 200 on valid callback, got ${callbackRes.statusCode}: ${callbackRes.body}`);
    assert(callbackRes.body.includes('e2e.tester@example.test'), 'Success HTML should display authenticated email');

    // Reused state rejected 400 (single-use)
    const reusedStateRes = await httpRequest(`${authBaseUrl}/oauth/callback?state=${encodeURIComponent(issuedState)}&code=${authCode}`);
    assert.strictEqual(reusedStateRes.statusCode, 400, 'Reused state must be rejected with 400');

    // Verify sync_config.json persisted tokens and mode
    const persistedCfg = JSON.parse(fs.readFileSync(tempConfigPath, 'utf8'));
    assert.strictEqual(persistedCfg.googleAccessToken, 'access_token_1');
    assert.strictEqual(persistedCfg.googleRefreshToken, 'refresh_token_1');
    assert.strictEqual(persistedCfg.preferredSyncMode, 'cloud_api');
    assert.strictEqual(persistedCfg.googleAccount.email, 'e2e.tester@example.test');

    // /auth/status + /auth/jsonp + XSS guard
    const statusRes = await httpRequest(`${authBaseUrl}/auth/status`);
    assert.strictEqual(statusRes.statusCode, 200);
    const statusJson = JSON.parse(statusRes.body);
    assert.strictEqual(statusJson.authenticated, true);
    assert.strictEqual(statusJson.user.email, 'e2e.tester@example.test');

    const jsonpValid = await httpRequest(`${authBaseUrl}/auth/jsonp?callback=window.__cb`);
    assert.strictEqual(jsonpValid.statusCode, 200);
    assert(jsonpValid.body.startsWith('window.__cb('), 'Valid JSONP callback should wrap payload');

    const jsonpXss = await httpRequest(`${authBaseUrl}/auth/jsonp?callback=${encodeURIComponent('alert(1);//')}`);
    assert.strictEqual(jsonpXss.statusCode, 400, 'Invalid/XSS JSONP callback must return 400');

    console.log('[PASS] Test 1: OAuth2 PKCE flow, single-use state, /auth/status, and JSONP XSS validation');

    // -------------------------------------------------------------------------
    // TEST 2: Live 401 auto-refresh retry in GoogleDriveApiEngine
    // -------------------------------------------------------------------------
    let refreshCallbackPayload = null;
    const engine401 = new GoogleDriveApiEngine({
      clientId: mock.state.expectedClientId,
      clientSecret: '', // Also verify PKCE / empty clientSecret path
      accessToken: 'stale_token_initial',
      refreshToken: 'refresh_token_1',
      tokenExpiry: Date.now() + 3600 * 1000, // Appears valid locally, but server returns 401
      tokenEndpoint: `${mockBaseUrl}/token`,
      apiBaseUrl: mockBaseUrl,
      onTokenRefresh: (tokens) => {
        refreshCallbackPayload = tokens;
      }
    });

    mock.triggerNext401();
    const aboutAfter401 = await engine401.verifyConnection();
    assert.strictEqual(aboutAfter401.user.emailAddress, 'e2e.tester@example.test');
    assert(refreshCallbackPayload && refreshCallbackPayload.accessToken === 'access_token_2', 'onTokenRefresh should receive newly refreshed access_token_2');
    const lastAboutCall = mock.state.aboutRequests[mock.state.aboutRequests.length - 1];
    assert.strictEqual(lastAboutCall.token, 'access_token_2', 'Retry after 401 must use NEW Bearer token');
    const lastTokenReq = mock.state.tokenRequests[mock.state.tokenRequests.length - 1];
    assert.strictEqual(lastTokenReq.grantType, 'refresh_token');
    assert.strictEqual(lastTokenReq.hasSecret, false, 'Empty clientSecret must be omitted from refresh payload');

    console.log('[PASS] Test 2: Live 401 auto-refresh retry with NEW Bearer token & PKCE optional clientSecret');

    // -------------------------------------------------------------------------
    // TEST 3: Folder path creation & caching, multipart (<5MB), resumable (>5MB), findFile
    // -------------------------------------------------------------------------
    const queriesBeforeFolder = mock.state.driveListQueries.length;
    const folderId1 = await engine401.ensureFolderPath(['Zalo_Cloud_Vault', 'Tester_1001', 'Media']);
    const folderId2 = await engine401.ensureFolderPath(['Zalo_Cloud_Vault', 'Tester_1001', 'Media']);
    assert.strictEqual(folderId1, folderId2, 'Folder ID must match across cached ensureFolderPath calls');
    const queriesAfterFirst = mock.state.driveListQueries.length;
    assert(queriesAfterFirst > queriesBeforeFolder, 'First ensureFolderPath should query Drive API');
    // Calling again should hit folderCache and make zero new queries
    await engine401.ensureFolderPath(['Zalo_Cloud_Vault', 'Tester_1001', 'Media']);
    assert.strictEqual(mock.state.driveListQueries.length, queriesAfterFirst, 'Cached folder path must not issue extra Drive API queries');

    // Multipart upload (<5MB)
    const smallFilePath = path.join(tempRoot, 'small_photo.png');
    fs.writeFileSync(smallFilePath, Buffer.from('PNG_TEST_PAYLOAD_12345'));
    const multiRes = await engine401.uploadFile(smallFilePath, folderId1);
    assert(multiRes && multiRes.id, 'Multipart upload should return file id');
    const foundSmall = await engine401.findFile('small_photo.png', folderId1);
    assert(foundSmall && foundSmall.id === multiRes.id, 'findFile should locate multipart uploaded file');

    // Resumable chunked upload (>5MB -> 5.5 MB: chunk 1 gets 308, chunk 2 gets 200)
    const bigFilePath = path.join(tempRoot, 'large_snapshot.tar.gz');
    const bigSize = (5 * 1024 * 1024) + (512 * 1024);
    fs.writeFileSync(bigFilePath, Buffer.alloc(bigSize, 0x41));
    const progressEvents = [];
    const resumableRes = await engine401.uploadFile(bigFilePath, folderId1, {
      onProgress: (p) => progressEvents.push(p)
    });
    assert(resumableRes && resumableRes.id, 'Resumable upload must return created file metadata');
    assert(progressEvents.length >= 2, 'Resumable upload (>5MB) should report multiple chunks');
    assert.strictEqual(progressEvents[progressEvents.length - 1].percent, 100);
    const foundBig = await engine401.findFile('large_snapshot.tar.gz', folderId1);
    assert(foundBig && foundBig.id === resumableRes.id, 'findFile should locate resumable uploaded file');

    console.log('[PASS] Test 3: Folder path creation & caching, multipart upload, resumable chunked upload (308->200), findFile');

    // -------------------------------------------------------------------------
    // TEST 4: HybridDriveManager cloud_api selection, reloadConfig(), deduplication
    // -------------------------------------------------------------------------
    const blankCfgPath = path.join(tempRoot, 'hybrid_sync_config.json');
    fs.writeFileSync(blankCfgPath, JSON.stringify({}), 'utf8');
    const manager = new HybridDriveManager(blankCfgPath, {
      tokenEndpoint: `${mockBaseUrl}/token`,
      apiBaseUrl: mockBaseUrl
    });
    // Ensure deterministic "no mounted drive" behavior regardless of host drives
    manager.mountedEngine.detectMountedDrive = () => null;
    assert.strictEqual(manager.getEffectiveMode(), 'local_fallback', 'Without tokens or mounted drive, mode must be local_fallback');

    // Write OAuth tokens to disk and call reloadConfig() without reconstructing manager
    fs.writeFileSync(blankCfgPath, JSON.stringify({
      googleClientId: mock.state.expectedClientId,
      googleAccessToken: 'access_token_2',
      googleRefreshToken: 'refresh_token_1',
      googleTokenExpiry: Date.now() + 3600 * 1000
    }, null, 2), 'utf8');
    manager.reloadConfig();
    assert.strictEqual(manager.hasCloudTokens(), true);
    assert.strictEqual(manager.getEffectiveMode(), 'cloud_api', 'With tokens and no mounted drive, mode must be cloud_api');

    const mediaFile = path.join(tempRoot, 'chat_clip.mp4');
    fs.writeFileSync(mediaFile, Buffer.from('MP4_MEDIA_TEST_BYTES'));

    const firstSync = await manager.syncFile(
      mediaFile,
      'Media',
      { uid: '9988776655', name: 'E2E Tester' },
      null,
      { deduplicate: true }
    );
    assert.strictEqual(firstSync.mode, 'cloud_api');
    assert(firstSync.id, 'First syncFile upload should return Drive file id');

    const secondSync = await manager.syncFile(
      mediaFile,
      'Media',
      { uid: '9988776655', name: 'E2E Tester' },
      null,
      { deduplicate: true }
    );
    assert.strictEqual(secondSync.skipped, true, 'Second syncFile with deduplicate=true must skip existing file');
    assert.strictEqual(secondSync.fileId, firstSync.id);
    assert.strictEqual(secondSync.mode, 'cloud_api');

    console.log('[PASS] Test 4: HybridDriveManager cloud_api auto-selection, reloadConfig(), and deduplication');

    // -------------------------------------------------------------------------
    // TEST 5: POST /auth/refresh refreshes token on demand & persists to config
    // -------------------------------------------------------------------------
    const refreshEndpointRes = await httpRequest(`${authBaseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.strictEqual(refreshEndpointRes.statusCode, 200);
    const refreshJson = JSON.parse(refreshEndpointRes.body);
    assert.strictEqual(refreshJson.success, true);
    assert.strictEqual(refreshJson.user.email, 'e2e.tester@example.test');
    const cfgAfterRefresh = JSON.parse(fs.readFileSync(tempConfigPath, 'utf8'));
    assert.strictEqual(cfgAfterRefresh.googleAccessToken, 'access_token_3', 'POST /auth/refresh must persist new access token');

    console.log('[PASS] Test 5: POST /auth/refresh on-demand token refresh & persistence');
    console.log('ALL CLOUD VAULT E2E TESTS PASSED (5/5)');
  } finally {
    if (authModule && typeof authModule.stopServer === 'function') {
      await authModule.stopServer().catch(() => {});
    }
    await new Promise((resolve) => mock.server.close(() => resolve())).catch(() => {});
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (e) {}
  }
}

runTests().catch((err) => {
  console.error('E2E TEST FAILED:', err);
  process.exit(1);
});
