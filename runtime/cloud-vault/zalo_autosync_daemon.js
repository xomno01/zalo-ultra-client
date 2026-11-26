// zalo_autosync_daemon.js
// Ultra-lightweight Real-Time Auto-Sync Daemon for Zalo (Self-Contained, Safe & Isolated)
// Run with: ELECTRON_RUN_AS_NODE=1 Zalo.exe zalo_autosync_daemon.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');

let HybridDriveManager = null;
try {
  HybridDriveManager = require('./HybridDriveManager');
} catch (e) {
  HybridDriveManager = null;
}

const APP_DIR = __dirname;
function resolveConfigFile() {
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
const CONFIG_FILE = resolveConfigFile();

function getBaseVaultRoot(dir) {
  if (!dir) return 'C:\\Users\\Default\\Zalo_Cloud_Vault';
  const parts = dir.split(/[\\/]/);
  const idx = parts.findIndex(p => p.toLowerCase() === 'zalo_cloud_vault');
  if (idx !== -1) {
    return parts.slice(0, idx + 1).join('\\');
  }
  const idxOld = parts.findIndex(p => p.toLowerCase() === 'zalo_vault');
  if (idxOld !== -1) {
    return parts.slice(0, idxOld + 1).join('\\');
  }
  return path.dirname(dir);
}

// --- HÀM TỰ ĐỘNG NHẬN DIỆN GOOGLE DRIVE HOẶC CLOUD VAULT ---
function detectCloudVault() {
  // 1. Kiểm tra cấu hình có sẵn trong sync_config.json
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (cfg.vaultDir && fs.existsSync(path.dirname(cfg.vaultDir))) {
        const baseRoot = getBaseVaultRoot(cfg.vaultDir);
        return {
          vaultDir: cfg.vaultDir,
          mediaTargetDir: cfg.mediaTargetDir || path.join(baseRoot, 'Media'),
          rootVault: baseRoot,
          source: 'config_file'
        };
      }
    } catch (e) {}
  }

  // 2. Quét các ổ đĩa Windows (U:\, G:\, H:\, I:\, J:\, D:\, E:\, F:\...)
  const candidateDrives = ['U', 'G', 'H', 'I', 'J', 'D', 'E', 'F'];
  for (const letter of candidateDrives) {
    const root = `${letter}:\\`;
    try {
      if (!fs.existsSync(root)) continue;

      // Ổ đĩa mount trực tiếp (RaiDrive Google Drive U:\, G:\)
      const cloudVault = path.join(root, 'Zalo_Cloud_Vault');
      if (fs.existsSync(cloudVault)) {
        return {
          vaultDir: cloudVault,
          mediaTargetDir: path.join(cloudVault, 'Media'),
          rootVault: cloudVault,
          source: `detected_cloud_vault_${letter}`
        };
      }

      // Google Drive for Desktop chính thức: G:\My Drive
      const myDrive = path.join(root, 'My Drive');
      if (fs.existsSync(myDrive)) {
        return {
          vaultDir: path.join(myDrive, 'Zalo_Cloud_Vault'),
          mediaTargetDir: path.join(myDrive, 'Zalo_Cloud_Vault', 'Media'),
          rootVault: path.join(myDrive, 'Zalo_Cloud_Vault'),
          source: `detected_gdrive_${letter}`
        };
      }

      const existingVault = path.join(root, 'Zalo_Vault');
      if (fs.existsSync(existingVault)) {
        return {
          vaultDir: existingVault,
          mediaTargetDir: path.join(existingVault, 'Media'),
          rootVault: existingVault,
          source: `detected_vault_${letter}`
        };
      }

      if (letter === 'U' || letter === 'G') {
        return {
          vaultDir: path.join(root, 'Zalo_Cloud_Vault'),
          mediaTargetDir: path.join(root, 'Zalo_Cloud_Vault', 'Media'),
          rootVault: path.join(root, 'Zalo_Cloud_Vault'),
          source: `direct_mount_${letter}`
        };
      }
    } catch (err) {}
  }

  // 3. Quét thư mục người dùng (%USERPROFILE%\Google Drive hoặc OneDrive)
  const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';
  const userCandidates = [
    path.join(userProfile, 'Google Drive'),
    path.join(userProfile, 'My Drive'),
    path.join(userProfile, 'OneDrive')
  ];

  for (const p of userCandidates) {
    try {
      if (fs.existsSync(p)) {
        return {
          vaultDir: path.join(p, 'Zalo_Cloud_Vault'),
          mediaTargetDir: path.join(p, 'Zalo_Cloud_Vault', 'Media'),
          rootVault: path.join(p, 'Zalo_Cloud_Vault'),
          source: 'detected_user_cloud'
        };
      }
    } catch (err) {}
  }

  // 4. Fallback an toàn (Lưu cục bộ tại User Profile nếu máy chưa mount Google Drive)
  const localSafe = path.join(userProfile, 'Zalo_Cloud_Vault');
  return {
    vaultDir: localSafe,
    mediaTargetDir: path.join(localSafe, 'Media'),
    rootVault: localSafe,
    source: 'fallback_local'
  };
}

// --- THIẾT LẬP CẤU HÌNH TỰ ĐỘNG ---
const cloud = detectCloudVault();

function detectZaloDbDir() {
  const candidates = [
    path.join(APP_DIR, 'AppData', 'Roaming', 'ZaloData', 'Database'),
    path.join(APP_DIR, '..', 'AppData', 'Roaming', 'ZaloData', 'Database'),
    path.join(process.env.APPDATA || '', 'ZaloData', 'Database'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Zalo', 'ZaloData', 'Database')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(process.env.APPDATA || '', 'ZaloData', 'Database');
}

function detectZaloMediaDir() {
  const candidates = [
    path.join(APP_DIR, 'media'),
    path.join(APP_DIR, '..', 'media'),
    path.join(process.env.USERPROFILE || '', 'Documents', 'Zalo Received Files')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(process.env.USERPROFILE || '', 'Documents', 'Zalo Received Files');
}

let customConfig = {};
if (fs.existsSync(CONFIG_FILE)) {
  try {
    customConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch(e) {}
}

let rawDbDir = process.env.TEST_DB_DIR || (customConfig.watchDbDir && fs.existsSync(customConfig.watchDbDir) ? customConfig.watchDbDir : detectZaloDbDir());
if (fs.existsSync(path.join(rawDbDir, 'Database'))) {
  rawDbDir = path.join(rawDbDir, 'Database');
}

const CONFIG = {
  watchDbDir: rawDbDir,
  watchMediaDir: process.env.TEST_MEDIA_DIR || (customConfig.watchMediaDir && fs.existsSync(customConfig.watchMediaDir) ? customConfig.watchMediaDir : detectZaloMediaDir()),
  vaultDir: process.env.TEST_VAULT_DIR || (customConfig.vaultDir && fs.existsSync(path.dirname(customConfig.vaultDir)) ? customConfig.vaultDir : cloud.vaultDir),
  mediaTargetDir: process.env.TEST_MEDIA_TARGET_DIR || (customConfig.mediaTargetDir && fs.existsSync(path.dirname(customConfig.mediaTargetDir)) ? customConfig.mediaTargetDir : cloud.mediaTargetDir),
  rootVault: cloud.rootVault,
  stagingDir: process.env.TEST_STAGING_DIR || path.join(process.env.TEMP || APP_DIR, 'Zalo_Snapshot_Staging'),
  activeUid: customConfig.activeUid || null,
  dbDebounceMs: process.env.TEST_DEBOUNCE_MS ? parseInt(process.env.TEST_DEBOUNCE_MS) : (typeof customConfig.dbDebounceMs === 'number' ? customConfig.dbDebounceMs : 45000),
  maxWaitMs: 300000, // 5 phút tối đa để chống starvation khi chat liên tục
  logFile: path.join(process.env.APPDATA || APP_DIR, 'ZaloTelegram', 'autosync.log')
};

// Cập nhật sync_config.json (giữ nguyên OAuth tokens và các trường cấu hình khác)
try {
  const mergedConfig = Object.assign({}, customConfig, {
    note: "File cau hinh tu dong dong bo Zalo len Google Drive. Ban co the sua duong dan tuy y.",
    cloudSource: cloud.source,
    vaultDir: CONFIG.vaultDir,
    mediaTargetDir: CONFIG.mediaTargetDir,
    watchDbDir: CONFIG.watchDbDir,
    watchMediaDir: CONFIG.watchMediaDir,
    activeUid: CONFIG.activeUid || "",
    dbDebounceMs: CONFIG.dbDebounceMs
  });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(mergedConfig, null, 2), 'utf8');
} catch (e) {}

const hybridManager = HybridDriveManager ? new HybridDriveManager(CONFIG_FILE) : null;

function log(msg) {
  const line = `[${new Date().toLocaleString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    const dir = path.dirname(CONFIG.logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(CONFIG.logFile, line);
  } catch (e) {}
}

log('=== ZALO REAL-TIME AUTO-SYNC DAEMON INITIALIZED ===');
log(`Storage Source: ${cloud.source}`);
log(`Watching DB: ${CONFIG.watchDbDir}`);
log(`Watching Media: ${CONFIG.watchMediaDir}`);
log(`Target Vault: ${CONFIG.vaultDir}`);

// Tạo sẵn thư mục staging
if (!fs.existsSync(CONFIG.stagingDir)) {
  try { fs.mkdirSync(CONFIG.stagingDir, { recursive: true }); } catch (e) {}
}

// --- 1. MEDIA AUTO-SYNC (Instant Event-Driven) ---
let mediaPending = new Set();
let mediaTimer = null;

async function processPendingMedia() {
  if (mediaPending.size === 0) return;
  const pendingFiles = Array.from(mediaPending);
  const count = pendingFiles.length;
  mediaPending.clear();

  log(`[MEDIA SYNC] Triggering sync for ${count} file(s)...`);

  if (hybridManager && typeof hybridManager.reloadConfig === 'function') {
    hybridManager.reloadConfig();
  }
  const effectiveMode = hybridManager ? hybridManager.getEffectiveMode() : 'local_fallback';

  if (effectiveMode === 'cloud_api') {
    const uid = currentActiveUid || resolveActiveUid(CONFIG.watchDbDir, CONFIG.activeUid);
    const userName = getUserDisplayName(CONFIG.watchDbDir, uid);
    for (const relFile of pendingFiles) {
      const fullPath = path.join(CONFIG.watchMediaDir, relFile);
      try {
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
          continue;
        }
        const res = await hybridManager.syncFile(
          fullPath,
          'Media',
          { uid, name: userName },
          null,
          { deduplicate: true }
        );
        if (res && res.skipped) {
          log(`[MEDIA SYNC] Skipped existing file on Drive: ${relFile} (id: ${res.fileId || 'n/a'})`);
        } else {
          log(`[MEDIA SYNC] Uploaded via Drive API: ${relFile} (id: ${(res && (res.id || res.fileId)) || 'ok'})`);
        }
      } catch (err) {
        log(`[MEDIA SYNC] Error uploading ${relFile}: ${err.message}`);
      }
    }
    return;
  }

  const activeMediaTarget = resolveTargetFolder(currentActiveUid, 'Media');
  if (!fs.existsSync(activeMediaTarget)) {
    try { fs.mkdirSync(activeMediaTarget, { recursive: true }); } catch(e) {}
  }
  const cmd = `robocopy "${CONFIG.watchMediaDir}" "${activeMediaTarget}" /E /XO /XN /XC /MT:4 /FFT /R:2 /W:3 /NP`;
  exec(cmd, (err) => {
    const exitCode = err ? err.code : 0;
    if (exitCode <= 7) {
      log(`[MEDIA SYNC] Completed upload to Vault (code ${exitCode}).`);
    } else {
      log(`[MEDIA SYNC] Upload warning (exit code ${exitCode}).`);
    }
  });
}

function startMediaWatcher() {
  if (!fs.existsSync(CONFIG.watchMediaDir)) {
    try { fs.mkdirSync(CONFIG.watchMediaDir, { recursive: true }); } catch (e) {}
  }
  try {
    mediaWatcherInstance = fs.watch(CONFIG.watchMediaDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (filename.endsWith('.tmp') || filename.startsWith('~') || filename.endsWith('.crdownload')) return;
      mediaPending.add(filename);
      clearTimeout(mediaTimer);
      mediaTimer = setTimeout(processPendingMedia, 2500);
    });
    log('[MEDIA WATCHER] Active and monitoring incoming media in real time.');
  } catch (err) {
    log(`[MEDIA WATCHER] Note: ${err.message}`);
  }
}

// --- 2. ACCURATE MULTI-ACCOUNT DETECTION ENGINE ---

function resolveActiveUid(dbDir, explicitUid = null) {
  if (explicitUid && /^\d+$/.test(explicitUid)) return explicitUid;

  const prodDir = path.join(dbDir, '_production');
  if (fs.existsSync(prodDir)) {
    try {
      const uids = fs.readdirSync(prodDir)
        .filter(n => /^\d{10,}$/.test(n) && fs.statSync(path.join(prodDir, n)).isDirectory());
      if (uids.length === 1) return uids[0];
      if (uids.length > 1) {
        // Đánh giá tài khoản đang active dựa trên mtimeMs mới nhất của SQLite DB / WAL
        const scored = uids.map(uid => {
          let maxMtime = 0;
          try {
            maxMtime = fs.statSync(path.join(prodDir, uid)).mtimeMs;
            const msgDir = path.join(prodDir, uid, 'Core', 'Message');
            if (fs.existsSync(msgDir)) {
              const files = fs.readdirSync(msgDir);
              for (const f of files) {
                if (f.endsWith('.db') || f.endsWith('.db-wal')) {
                  const m = fs.statSync(path.join(msgDir, f)).mtimeMs;
                  if (m > maxMtime) maxMtime = m;
                }
              }
            }
          } catch (e) {}
          return { uid, maxMtime };
        });
        scored.sort((a, b) => b.maxMtime - a.maxMtime);
        if (scored[0].maxMtime > 0) return scored[0].uid;
      }
    } catch(e) {}
  }

  // Quét ftsm_<UID>.db trong ZaloData xếp theo mtimeMs
  const zaloDataDir = path.dirname(dbDir);
  try {
    const files = fs.readdirSync(zaloDataDir)
      .filter(f => /^ftsm_(\d{10,})\.db$/.test(f))
      .map(f => {
        const m = f.match(/^ftsm_(\d{10,})\.db$/);
        const mtimeMs = fs.statSync(path.join(zaloDataDir, f)).mtimeMs;
        return { uid: m[1], mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (files.length > 0) return files[0].uid;
  } catch(e) {}

  // Fallback sang cấu hình nếu không tìm thấy trên ổ đĩa
  if (CONFIG.activeUid && /^\d+$/.test(CONFIG.activeUid)) {
    return CONFIG.activeUid;
  }

  return null;
}

// Lấy tên hiển thị từ Storage.db để đặt tên folder cá nhân trên Drive
function getUserDisplayName(dbDir, uid) {
  if (!uid) return 'User';
  const storageDb = path.join(dbDir, '_production', 'Storage.db');
  if (fs.existsSync(storageDb)) {
    try {
      const buf = fs.readFileSync(storageDb);
      const str = buf.toString('utf8');
      const re = new RegExp(`0_${uid}[^{}]*(\\{[^}]+\\})`);
      const match = str.match(re);
      if (match) {
        const data = JSON.parse(match[1]);
        const name = data.name || data.displayName || data.zaloName;
        if (name) return name.replace(/[\\/:*?"<>|]/g, '_').trim();
      }
    } catch(e) {}
  }
  return 'User';
}

function resolveTargetFolder(uid, subFolder = 'Tin_Nhan') {
  const root = getBaseVaultRoot(CONFIG.rootVault || CONFIG.vaultDir);
  if (!uid) return path.join(root, subFolder);
  const name = getUserDisplayName(CONFIG.watchDbDir, uid);
  return path.join(root, `${name}_${uid}`, subFolder);
}

// Lấy trạng thái của message database (Dùng stat size + mtimeMs siêu tốc, không block IO)
function getMessageDbState(dbDir, activeUid) {
  const state = {
    uid: activeUid,
    files: {},
    profile: null,
    totalSize: 0
  };

  if (!activeUid) return state;

  const userDir = path.join(dbDir, '_production', activeUid);
  if (!fs.existsSync(userDir)) return state;

  // 1. Thư mục tin nhắn Core/Message/
  const messageDir = path.join(userDir, 'Core', 'Message');
  if (fs.existsSync(messageDir)) {
    try {
      const entries = fs.readdirSync(messageDir);
      for (const f of entries) {
        if (!f.endsWith('.db') && !f.endsWith('-wal')) continue;
        if (f.endsWith('-shm')) continue;
        const full = path.join(messageDir, f);
        try {
          const st = fs.statSync(full);
          const relKey = `Core/Message/${f}`;
          state.files[relKey] = {
            size: st.size,
            mtimeMs: st.mtimeMs
          };
          state.totalSize += st.size;
        } catch(e) {}
      }
    } catch(e) {}
  }

  // 2. Các file database meta của user
  const metaFiles = ['MsgInfo.db', 'MsgInfo.db-wal', 'Reaction.db', 'Reaction.db-wal', 'Core/Index.db', 'Core/Index.db-wal'];
  for (const rel of metaFiles) {
    const full = path.join(userDir, rel);
    if (fs.existsSync(full)) {
      try {
        const st = fs.statSync(full);
        state.files[rel] = {
          size: st.size,
          mtimeMs: st.mtimeMs
        };
        state.totalSize += st.size;
      } catch(e) {}
    }
  }

  // 3. User profile / avatar trong Storage.db
  const storageDb = path.join(dbDir, '_production', 'Storage.db');
  if (fs.existsSync(storageDb)) {
    try {
      const buf = fs.readFileSync(storageDb);
      const str = buf.toString('latin1');
      const re = new RegExp(`0_${activeUid}[^{}]*(\\{[^}]+\\})`);
      const match = str.match(re);
      if (match) {
        state.profile = match[1];
      }
    } catch(e) {}
  }

  return state;
}

function getSnapshotSignature(state) {
  if (!state) return '';
  const fileKeys = Object.keys(state.files || {}).sort();
  const summary = fileKeys.map(k => `${k}:${state.files[k].size}:${state.files[k].mtimeMs}`).join('|');
  const fullStr = `${state.uid || ''};${summary};${state.profile || ''}`;
  return crypto.createHash('md5').update(fullStr).digest('hex');
}

function checkContentDiff(oldState, newState) {
  if (!oldState || !newState) {
    return { changed: true, type: 'init', detail: 'Initial state established' };
  }

  if (oldState.profile !== newState.profile) {
    return {
      changed: true,
      type: 'profile_change',
      detail: `Avatar/profile updated for UID ${newState.uid}`
    };
  }

  const oldKeys = Object.keys(oldState.files || {});
  const newKeys = Object.keys(newState.files || {});

  for (const k of newKeys) {
    if (!oldState.files[k]) {
      return {
        changed: true,
        type: 'new_conversation',
        detail: `New conversation database detected: ${k}`
      };
    }
    const oldF = oldState.files[k];
    const newF = newState.files[k];
    if (oldF.size !== newF.size || oldF.mtimeMs !== newF.mtimeMs) {
      return {
        changed: true,
        type: 'message_data',
        detail: `Message activity detected in ${k} (size: ${oldF.size} -> ${newF.size})`
      };
    }
  }

  for (const k of oldKeys) {
    if (!newState.files[k]) {
      return {
        changed: true,
        type: 'deleted_conversation',
        detail: `Conversation database removed: ${k}`
      };
    }
  }

  return {
    changed: false,
    type: 'heartbeat_telemetry',
    detail: 'No message content or profile change detected'
  };
}

function isIgnoredFile(filename) {
  if (!filename) return false;
  const norm = filename.replace(/\\/g, '/');

  if (norm.endsWith('.tmp') || norm.startsWith('~') || norm.endsWith('.crdownload') || norm.endsWith('-shm')) {
    return true;
  }

  const ignoredKeywords = [
    'Qos.db',
    'Trust.db',
    'SecureLocalstorage.db',
    'stk_sug',
    'tf-models',
    'GPUCache',
    'DawnCache',
    'blob_storage',
    'Encrypt/',
    'Migrate/'
  ];

  for (const kw of ignoredKeywords) {
    if (norm.includes(kw)) return true;
  }

  return false;
}

// --- 3. DATABASE & CHAT AUTO-SNAPSHOT (ISOLATED & CONSISTENT) ---
let dbTimer = null;
let firstEventTime = 0;
let isSnapshotting = false;
let currentActiveUid = null;
let lastMessageDbState = null;
let lastUploadedSignature = null;
let lastSkipLogTime = 0;

function logSkipHeartbeat() {
  const now = Date.now();
  if (now - lastSkipLogTime >= 5000) {
    log('[DB WATCHER] Heartbeat/telemetry detected without message change - skipped.');
    lastSkipLogTime = now;
  }
}

function takeDatabaseSnapshot() {
  if (isSnapshotting) return;

  if (!currentActiveUid) {
    currentActiveUid = resolveActiveUid(CONFIG.watchDbDir, CONFIG.activeUid);
  }
  if (!currentActiveUid) {
    log('[DB SNAPSHOT] No active UID detected - skipping snapshot.');
    return;
  }

  const currentState = getMessageDbState(CONFIG.watchDbDir, currentActiveUid);
  const currentSignature = getSnapshotSignature(currentState);

  if (lastUploadedSignature && currentSignature === lastUploadedSignature) {
    log('[DB SNAPSHOT] Message database state unchanged since last snapshot - skipping redundant upload.');
    return;
  }

  isSnapshotting = true;
  firstEventTime = 0; // Reset debounce starvation timer

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const targetVaultDir = resolveTargetFolder(currentActiveUid, 'Tin_Nhan');
  const archiveName = `Zalo_AutoSnap_${currentActiveUid || 'Shared'}_${timestamp}.tar.gz`;
  const finalArchivePath = path.join(targetVaultDir, archiveName);

  log(`[DB SNAPSHOT] Chat activity verified for UID ${currentActiveUid}. Generating isolated snapshot: ${archiveName}...`);

  // BẢO VỆ CÁCH LY TUYỆT ĐỐI (100% ISOLATION):
  // Chỉ stage DUY NHẤT dữ liệu của currentActiveUid, không bao giờ copy thư mục của các tài khoản khác!
  const stagingDb = path.join(CONFIG.stagingDir, 'Database');
  const stagingUserProd = path.join(stagingDb, '_production', currentActiveUid);

  try {
    if (fs.existsSync(stagingDb)) {
      // Dọn dẹp an toàn bên trong thư mục staging tạm thời
      fs.rmSync(stagingDb, { recursive: true, force: true });
    }
    fs.mkdirSync(stagingUserProd, { recursive: true });
  } catch (e) {}

  const sourceUserProd = path.join(CONFIG.watchDbDir, '_production', currentActiveUid);
  
  // 1. Sao chép thư mục tài khoản đang hoạt động
  const robocopyCmd = `robocopy "${sourceUserProd}" "${stagingUserProd}" /E /XF *.tmp ~* *.crdownload *.db-shm /R:1 /W:1 /NP`;

  exec(robocopyCmd, (err) => {
    const code = err ? err.code : 0;
    if (code > 7) {
      log(`[DB SNAPSHOT] Robocopy warning (code ${code}) during user DB staging.`);
    }

    // 2. Sao chép metadata dùng chung nếu có (Storage.db, zdb.dat)
    try {
      const storageDb = path.join(CONFIG.watchDbDir, '_production', 'Storage.db');
      if (fs.existsSync(storageDb)) {
        fs.copyFileSync(storageDb, path.join(stagingDb, '_production', 'Storage.db'));
      }
      const storageWal = path.join(CONFIG.watchDbDir, '_production', 'Storage.db-wal');
      if (fs.existsSync(storageWal)) {
        fs.copyFileSync(storageWal, path.join(stagingDb, '_production', 'Storage.db-wal'));
      }
    } catch (e) {}

    // 3. TẠO ARCHIVE TẠI ĐƯỜNG DẪN ASCII STAGING (Tránh hoàn toàn lỗi tiếng Việt của tar.exe)
    const asciiStagingTar = path.join(CONFIG.stagingDir, `zalo_snap_${Date.now()}.tar.gz`);

    const tar = spawn('tar.exe', ['-czf', asciiStagingTar, '-C', CONFIG.stagingDir, 'Database'], {
      windowsHide: true
    });

    tar.on('close', async (tarCode) => {
      try {
        if (tarCode === 0 && fs.existsSync(asciiStagingTar)) {
          if (hybridManager && typeof hybridManager.reloadConfig === 'function') {
            hybridManager.reloadConfig();
          }
          const effectiveMode = hybridManager ? hybridManager.getEffectiveMode() : 'local_fallback';

          if (effectiveMode === 'cloud_api') {
            const userName = getUserDisplayName(CONFIG.watchDbDir, currentActiveUid);
            const uploadRes = await hybridManager.syncFile(
              asciiStagingTar,
              'Tin_Nhan',
              { uid: currentActiveUid, name: userName },
              null,
              { customName: archiveName }
            );
            const driveId = uploadRes && (uploadRes.id || uploadRes.fileId) ? (uploadRes.id || uploadRes.fileId) : 'unknown';
            log(`[DB SNAPSHOT] Uploaded successfully to Google Drive API (id: ${driveId}): ${archiveName}`);
          } else {
            if (!fs.existsSync(targetVaultDir)) {
              try { fs.mkdirSync(targetVaultDir, { recursive: true }); } catch (e) {}
            }
            // Dùng Node.js fs.copyFileSync để hỗ trợ đường dẫn Unicode tiếng Việt ("Lộc") hoàn hảo 100%
            fs.copyFileSync(asciiStagingTar, finalArchivePath);
            log(`[DB SNAPSHOT] Uploaded successfully to Google Drive: ${finalArchivePath}`);
          }

          try { fs.unlinkSync(asciiStagingTar); } catch (e) {}
          lastUploadedSignature = currentSignature;
          lastMessageDbState = currentState;
          log('[RETENTION] Zero-deletion policy active: All historical snapshots safely preserved on Google Drive.');
        } else {
          log(`[DB SNAPSHOT] tar.exe completed with code ${tarCode}`);
        }
      } catch (copyErr) {
        log(`[DB SNAPSHOT] Error delivering archive to Drive: ${copyErr.message}`);
      } finally {
        isSnapshotting = false;
      }
    });
  });
}

function startDbWatcher() {
  if (!fs.existsSync(CONFIG.watchDbDir)) {
    log('[DB WATCHER] Waiting for Zalo database creation...');
    return;
  }

  currentActiveUid = resolveActiveUid(CONFIG.watchDbDir, CONFIG.activeUid);
  log(`[DB WATCHER] Active account UID: ${currentActiveUid || 'Not logged in yet'}`);

  lastMessageDbState = getMessageDbState(CONFIG.watchDbDir, currentActiveUid);
  lastUploadedSignature = getSnapshotSignature(lastMessageDbState);
  log(`[DB WATCHER] Initial baseline recorded: ${Object.keys(lastMessageDbState.files).length} message DB files tracked.`);

  try {
    dbWatcherInstance = fs.watch(CONFIG.watchDbDir, { recursive: true }, (eventType, filename) => {
      if (isIgnoredFile(filename)) {
        logSkipHeartbeat();
        return;
      }

      // Nhận diện chuyển đổi tài khoản động
      const detectedUid = resolveActiveUid(CONFIG.watchDbDir);
      if (detectedUid && detectedUid !== currentActiveUid) {
        log(`[DB WATCHER] Account switch detected! Old: ${currentActiveUid} -> New: ${detectedUid}`);
        currentActiveUid = detectedUid;
        lastMessageDbState = getMessageDbState(CONFIG.watchDbDir, currentActiveUid);
        lastUploadedSignature = getSnapshotSignature(lastMessageDbState);
      }

      const norm = filename ? filename.replace(/\\/g, '/') : '';
      const userMessagePrefix = currentActiveUid ? `_production/${currentActiveUid}/` : '_production/';
      
      if (norm && !norm.includes(userMessagePrefix) && !norm.includes('Storage.db')) {
        logSkipHeartbeat();
        return;
      }

      const currentState = getMessageDbState(CONFIG.watchDbDir, currentActiveUid);
      const diff = checkContentDiff(lastMessageDbState, currentState);

      if (!diff.changed) {
        logSkipHeartbeat();
        return;
      }

      const now = Date.now();
      if (!firstEventTime) firstEventTime = now;
      const elapsedSinceFirst = now - firstEventTime;

      // Chống starvation: Nếu chat liên tục quá 5 phút (maxWaitMs), snapshot ngay lập tức
      if (elapsedSinceFirst >= CONFIG.maxWaitMs) {
        log(`[DB WATCHER] Max wait reached (${Math.round(elapsedSinceFirst / 1000)}s). Forcing snapshot now...`);
        lastMessageDbState = currentState;
        takeDatabaseSnapshot();
        return;
      }

      log(`[DB WATCHER] Real activity verified: ${diff.detail}. Scheduling snapshot in ${CONFIG.dbDebounceMs / 1000}s...`);
      lastMessageDbState = currentState;

      clearTimeout(dbTimer);
      dbTimer = setTimeout(takeDatabaseSnapshot, CONFIG.dbDebounceMs);
    });

    log(`[DB WATCHER] Active. Smart Content-Diff engine enabled (debounce: ${CONFIG.dbDebounceMs / 1000}s, maxWait: ${CONFIG.maxWaitMs / 1000}s).`);
  } catch (err) {
    log(`[DB WATCHER] Note: ${err.message}`);
  }
}

let isDaemonActive = false;
let mediaWatcherInstance = null;
let dbWatcherInstance = null;

function startDaemon() {
  if (isDaemonActive) return;
  isDaemonActive = true;
  startMediaWatcher();
  startDbWatcher();
}

function stopDaemon() {
  isDaemonActive = false;
  if (mediaWatcherInstance) {
    try { mediaWatcherInstance.close(); } catch(e) {}
    mediaWatcherInstance = null;
  }
  if (dbWatcherInstance) {
    try { dbWatcherInstance.close(); } catch(e) {}
    dbWatcherInstance = null;
  }
  clearTimeout(dbTimer);
  clearTimeout(mediaTimer);
}

if (require.main === module) {
  startDaemon();
}

module.exports = {
  startDaemon,
  stopDaemon,
  takeDatabaseSnapshot,
  processPendingMedia,
  resolveActiveUid,
  getMessageDbState,
  checkContentDiff,
  getUserDisplayName,
  resolveTargetFolder,
  hybridManager
};
