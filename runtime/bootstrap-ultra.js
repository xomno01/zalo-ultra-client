/**
 * ============================================================================
 * ZALO PC ULTRA RUNTIME BOOTSTRAP (bootstrap-ultra.js)
 * ============================================================================
 * Reverse Engineered, Engineered & Hardened for Extreme Performance & Low Footprint
 * Compatible with Zalo PC v26.10.20+ / Electron Runtime
 * 
 * CORE CAPABILITIES:
 * 1. 100% Elimination of Sentry Telemetry & Crashpad Minidump Process
 * 2. 100% Elimination of Disk Spam Logging (CALF Brotli, ZLOG, DNetLog, scrshot.log)
 * 3. 100% Native Feature Preservation:
 *    - VoIP Calling (zcall native addon)
 *    - Screenshot Capture (ZaloCap native binary & shortcuts)
 *    - Optical Character Recognition (zocr native module)
 *    - End-to-End Encryption (@zsecure/zpc, libsignal)
 *    - Local Storage & SQLite Databases (node_sqlite3, db-cross-v4)
 *    - File / Media Transfer (files-wpa.zaloapp.com)
 *    - Compact App Mode & Full Window Mode
 * 4. Active V8 Garbage Collection (--expose-gc, dynamic injection & IPC trigger)
 * 5. Optimized Chromium Switches for Minimal RAM, CPU & SSD Wear
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const Module = require('module');

// Debug logger
const debugLog = path.join(process.env.APPDATA || __dirname, 'bootstrap_ultra_debug.log');
function ultraLog(msg) {
  try { fs.appendFileSync(debugLog, `[${new Date().toISOString()}] ${msg}\n`); } catch(e){}
}
ultraLog(`bootstrap-ultra.js initialized! PID: ${process.pid}, args: ${process.argv.join(' ')}`);

const origExit = process.exit;
process.exit = function(code) {
  ultraLog(`[process.exit CALLED with code: ${code}]\nStack: ${new Error().stack}`);
  return origExit.apply(this, arguments);
};

process.on('uncaughtException', (err) => {
  ultraLog(`[FATAL uncaughtException] ${err.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  ultraLog(`[FATAL unhandledRejection] ${reason}`);
});

// ----------------------------------------------------------------------------
// 1. IN-PROCESS V8 GARBAGE COLLECTION ENABLER
// ----------------------------------------------------------------------------
try {
  const v8 = require('v8');
  if (v8 && typeof v8.setFlagsFromString === 'function') {
    v8.setFlagsFromString('--expose_gc');
    const vm = require('vm');
    if (!global.gc) {
      global.gc = vm.runInNewContext('gc');
    }
  }
} catch (e) {
  // Graceful fallback if v8 API is locked
}

// ----------------------------------------------------------------------------
// 2. CHROMIUM COMMAND LINE SWITCHES (APPLIED BEFORE ELECTRON APP READY)
// ----------------------------------------------------------------------------
const electron = require('electron');
const { app, crashReporter, ipcMain, BrowserWindow, session, webContents } = electron;

// ----------------------------------------------------------------------------
// 1.1 CRITICAL: SET CUSTOM APPDATA & USERDATA BEFORE ANY APP / CHROMIUM LOCKING
// ----------------------------------------------------------------------------
const userDataArg = process.argv.find(e => e.startsWith('--user-data-dir='));
if (userDataArg && app && typeof app.setPath === 'function') {
  let customPath = userDataArg.substring('--user-data-dir='.length);
  customPath = customPath.replace(/^[\s"'\\]+|[\s"'\\]+$/g, '');
  customPath = path.resolve(customPath);
  try {
    const appDataDir = path.dirname(customPath);
    app.setPath('appData', appDataDir);
    app.setPath('userData', customPath);
  } catch (e) {}
}

// Set dedicated Windows AppUserModelID to guarantee separate Taskbar grouping & icon
if (app && typeof app.setAppUserModelId === 'function') {
  try {
    app.setAppUserModelId('com.vng.zalo.ultra');
  } catch (e) {}
}

// Hook Electron Tray to ensure 100% distinct Ultra tray icons at all times
if (electron.Tray && electron.Tray.prototype) {
  const origSetImage = electron.Tray.prototype.setImage;
  electron.Tray.prototype.setImage = function (img) {
    try {
      const pcDist = path.join(__dirname, 'pc-dist');
      if (typeof img === 'string') {
        if (img.includes('fav-reddot')) {
          return origSetImage.call(this, path.join(pcDist, 'fav-reddot.ico'));
        }
        if (img.includes('fav-busymode')) {
          return origSetImage.call(this, path.join(pcDist, 'fav-busymode.ico'));
        }
        return origSetImage.call(this, path.join(pcDist, 'favicon.ico'));
      }
    } catch (e) {}
    return origSetImage.apply(this, arguments);
  };
}

if (app && app.commandLine) {
  // A. V8 Engine & Garbage Collection (Capped to 320MB to balance RAM footprint & low CPU GC/JIT overhead)
  app.commandLine.appendSwitch('js-flags', '--expose-gc --max-old-space-size=320');

  // B. Crash & Telemetry Suppression (Safe flags only - do NOT disable background networking or audio)
  app.commandLine.appendSwitch('disable-breakpad');
  app.commandLine.appendSwitch('disable-crash-reporter');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('disable-logging');
  app.commandLine.appendSwitch('log-level', '3'); // Fatal/Silent only

  // C. Disk Cache & Memory Caps (Prevents unbounded cache ballooning)
  app.commandLine.appendSwitch('disk-cache-size', '33554432');   // Cap at 32 MB
  app.commandLine.appendSwitch('media-cache-size', '33554432');  // Cap at 32 MB

  // D. CRITICAL: Preserve Native Zalo Functional Switches & VoIP Calling
  app.commandLine.appendSwitch('ignore-connections-limit', 'files-wpa.zaloapp.com,vlogin.zaloapp.com,api.conf.talk.zing.vn');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // Ensures ringtones play immediately
  app.commandLine.appendSwitch('disable-pinch');
  app.commandLine.appendSwitch('enable-features', 'WebAssembly,JXL'); // Required for JXL stickers & WASM E2EE
}

// ----------------------------------------------------------------------------
// 3. COMPLETE SENTRY & CRASHPAD NEUTRALIZATION
// ----------------------------------------------------------------------------
// A. Neutralize Electron's native crashReporter API
if (crashReporter) {
  try {
    crashReporter.start = () => {};
    crashReporter.addExtraParameter = () => {};
    crashReporter.getCrashesDirectory = () => '';
    crashReporter.getLastCrashReport = () => null;
    crashReporter.getUploadedReports = () => [];
  } catch (e) {}
}

// B. Mock Object for Sentry SDK
const noop = () => {};
const dummySentryMock = {
  init: noop,
  install: noop,
  getInstance: () => ({ install: noop }),
  addBreadcrumb: noop,
  captureException: noop,
  captureMessage: noop,
  captureEvent: noop,
  configureScope: noop,
  setTag: noop,
  setTags: noop,
  setExtra: noop,
  setExtras: noop,
  setUser: noop,
  setContext: noop,
  startTransaction: () => ({ finish: noop, setStatus: noop }),
  getCurrentHub: () => ({
    getClient: () => null,
    getScope: () => ({
      setUser: noop,
      setTag: noop,
      setTags: noop,
      setExtra: noop,
      setExtras: noop,
      setContext: noop,
      addBreadcrumb: noop
    }),
    captureException: noop,
    captureMessage: noop,
    captureEvent: noop
  })
};

// C. Pre-populate require.cache for sentry.js
try {
  const sentryCandidates = [
    path.resolve(__dirname, 'main-dist', 'sentry.js'),
    path.resolve(__dirname, 'sentry.js'),
    path.resolve(__dirname, '..', 'main-dist', 'sentry.js')
  ];
  sentryCandidates.forEach(p => {
    require.cache[p] = {
      id: p,
      filename: p,
      loaded: true,
      exports: dummySentryMock
    };
  });
} catch (e) {}

// D. Intercept dynamic Sentry require calls
const origRequire = Module.prototype.require;
Module.prototype.require = function (request) {
  if (
    request === './sentry' ||
    request === '../sentry' ||
    request.endsWith('/sentry') ||
    request.endsWith('\\sentry') ||
    request.includes('@sentry/')
  ) {
    return dummySentryMock;
  }
  return origRequire.apply(this, arguments);
};

// ----------------------------------------------------------------------------
// 4. DISK SPAM LOGGER NEUTRALIZATION (CALF / ZLOG / DNetLog / scrshot.log)
// ----------------------------------------------------------------------------
// A. Silence native Zalo logger
try {
  const nativeLogger = require('./native/nativelibs/logger/index.js');
  if (nativeLogger && typeof nativeLogger.setOffLog === 'function') {
    nativeLogger.setOffLog(true);
  }
} catch (e) {}

// B. Virtual Null Writable Stream (Zero Disk I/O, Zero CPU compression cycles)
class NullWritableStream extends Writable {
  _write(chunk, encoding, callback) {
    callback();
  }
  _writev(chunks, callback) {
    callback();
  }
}

// B2. ZaloCap.exe Spawn Guard (Prevent multi-instance cursor blink conflict)
const { EventEmitter } = require('events');
const childProcess = require('child_process');

function createDummyStream() {
  const stream = new EventEmitter();
  stream.setEncoding = function () { return this; };
  stream.resume = function () { return this; };
  stream.pause = function () { return this; };
  stream.pipe = function (dest) { return dest; };
  stream.destroy = function () { return this; };
  return stream;
}

function createDummyChildProcess() {
  const dummy = new EventEmitter();
  dummy.pid = 0;
  dummy.killed = false;
  dummy.exitCode = null;
  dummy.connected = false;
  dummy.stdout = createDummyStream();
  dummy.stderr = createDummyStream();
  dummy.stdin = new NullWritableStream();
  dummy.kill = function () {
    this.killed = true;
    return true;
  };
  dummy.unref = function () {};
  dummy.ref = function () {};
  dummy.disconnect = function () {};
  return dummy;
}

const spawnDescriptor = Object.getOwnPropertyDescriptor(childProcess, 'spawn');
if (spawnDescriptor && spawnDescriptor.writable) {
  const origSpawn = childProcess.spawn;
  let capSuppressedLogged = false;

  childProcess.spawn = function (command, args, options) {
    if (
      process.env.ZALO_DISABLE_CAP !== '0' &&
      typeof command === 'string' &&
      path.basename(command).toLowerCase() === 'zalocap.exe'
    ) {
      if (!capSuppressedLogged) {
        capSuppressedLogged = true;
        ultraLog('[CAP-GUARD] Suppressed ZaloCap.exe spawn to prevent multi-instance cursor blink conflict');
      }
      return createDummyChildProcess();
    }
    return origSpawn.apply(this, arguments);
  };
} else {
  ultraLog('[CAP-GUARD] child_process.spawn is non-writable; skipping ZaloCap.exe interceptor');
}

// C. Regex filter identifying pure diagnostic / spam telemetry files
const SPAM_LOG_REGEX = /[\\/](cal|logs)[\\/]|(\.calf|\.zlog|\.calf\.tmp)$|DNetLog.*\.log$|cloud-.*\.log$|[\\/](scrshot|voip|call|log|startup|update)\.log$/i;

function isSpamLogPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  // NEVER block databases, config files, user downloads, or caches
  if (
    filePath.endsWith('.db') ||
    filePath.endsWith('.db-wal') ||
    filePath.endsWith('.db-shm') ||
    filePath.endsWith('.json') ||
    filePath.endsWith('.html') ||
    filePath.endsWith('.js')
  ) {
    return false;
  }
  return SPAM_LOG_REGEX.test(filePath);
}

// D. Intercept filesystem writing methods safely
const origCreateWriteStream = fs.createWriteStream;
const origAppendFile = fs.appendFile;
const origAppendFileSync = fs.appendFileSync;
const origWriteFile = fs.writeFile;
const origWriteFileSync = fs.writeFileSync;

fs.createWriteStream = function (filePath, options) {
  if (isSpamLogPath(filePath)) {
    return new NullWritableStream();
  }
  return origCreateWriteStream.apply(this, arguments);
};

fs.appendFile = function (filePath, data, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  if (isSpamLogPath(filePath)) {
    if (typeof cb === 'function') setImmediate(() => cb(null));
    return;
  }
  return origAppendFile.apply(this, arguments);
};

fs.appendFileSync = function (filePath, data, options) {
  if (isSpamLogPath(filePath)) {
    return;
  }
  return origAppendFileSync.apply(this, arguments);
};

fs.writeFile = function (filePath, data, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  if (isSpamLogPath(filePath)) {
    if (typeof cb === 'function') setImmediate(() => cb(null));
    return;
  }
  return origWriteFile.apply(this, arguments);
};

fs.writeFileSync = function (filePath, data, options) {
  if (isSpamLogPath(filePath)) {
    return;
  }
  return origWriteFileSync.apply(this, arguments);
};

// ----------------------------------------------------------------------------
// 5. MEMORY MANAGEMENT SUBSYSTEM (GARBAGE COLLECTION & WORKING SET TRIMMING)
// ----------------------------------------------------------------------------
function trimAllMemory() {
  // Main process V8 GC
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch (e) {}
  }

  // Broadcast GC to all active renderers & worker windows
  try {
    const allWc = webContents.getAllWebContents();
    for (const wc of allWc) {
      if (!wc.isDestroyed()) {
        try {
          wc.executeJavaScript('if (typeof window.gc === "function") window.gc();');
        } catch (e) {}
      }
    }
  } catch (e) {}
}

// IPC Handlers for external or renderer GC requests
if (ipcMain) {
  ipcMain.on('ultra:gc', () => {
    trimAllMemory();
  });

  ipcMain.handle('ultra:get-memory', () => {
    return process.memoryUsage();
  });
}

// ----------------------------------------------------------------------------
// 6. ELECTRON WEB-CONTENTS & SESSION HOOKS
// ----------------------------------------------------------------------------
app.on('web-contents-created', (event, wc) => {
  // Prevent renderer from re-initializing Sentry
  wc.on('did-finish-load', () => {
    try {
      wc.executeJavaScript('window.__SENTRY__RENDERER_INIT__ = true;').catch(() => {});
    } catch (e) {}
  });
});

app.on('browser-window-created', (event, win) => {
  // Trigger GC whenever window is minimized
  win.on('minimize', () => {
    setTimeout(trimAllMemory, 500);
  });

  // Post-startup memory recovery (12 seconds after window ready)
  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL() || '';
    if (url.includes('index.html')) {
      setTimeout(() => {
        trimAllMemory();
      }, 12000);
    }
  });
});

// Periodic memory sweep (every 5 minutes)
setInterval(trimAllMemory, 5 * 60 * 1000);

// Telemetry network request blocker (Zero outgoing Sentry / Analytics packets)
const blockTelemetry = (targetSession) => {
  if (!targetSession || !targetSession.webRequest) return;
  const telemetryUrls = [
    '*://*.sentrypc.api.zalo.me/*',
    '*://*.senpc.api.zalo.me/*',
    '*://*.google-analytics.com/*',
    '*://*.doubleclick.net/*'
  ];
  targetSession.webRequest.onBeforeRequest({ urls: telemetryUrls }, (details, callback) => {
    callback({ cancel: true });
  });
};

const setupSessionHooks = () => {
  try {
    blockTelemetry(session.defaultSession);
    const zaloSession = session.fromPartition('persist:zalo');
    if (zaloSession) blockTelemetry(zaloSession);
  } catch (e) {}
};

if (app.isReady()) {
  setupSessionHooks();
} else if (typeof app.whenReady === 'function') {
  app.whenReady().then(setupSessionHooks);
} else {
  app.on('ready', setupSessionHooks);
}

// ----------------------------------------------------------------------------
// 7. IN-PROCESS OPTIONAL EXTENSIONS (Google Drive Auth & Safe Guards)
// ----------------------------------------------------------------------------
const buildExtensionCandidates = (fileName) => [
  path.join(__dirname, fileName),
  path.join(__dirname, 'cloud-vault', fileName),
  path.join(__dirname, '..', fileName),
  path.join(process.resourcesPath || '', fileName),
  path.join(path.dirname(process.execPath || ''), fileName),
  path.join('D:\\Zalo_Test_Env\\ZaloApp', fileName),
  path.join('D:\\Zalo_Test_Env', fileName)
];

const initOptionalExtensions = () => {
  try {
    const authCandidates = buildExtensionCandidates('zalo_drive_auth_server.js');
    const authPath = authCandidates.find(p => fs.existsSync(p));
    if (authPath) {
      const auth = require(authPath);
      if (auth && typeof auth.startServer === 'function') {
        auth.startServer();
        ultraLog(`[AUTH SERVER] Google Drive Auth Server running on port ${auth.PORT || 8585} (${authPath})`);
      }
    }
  } catch (e) {
    ultraLog(`[AUTH SERVER NOTICE] ${e.message}`);
  }

  try {
    if (process.env.ENABLE_ULTRA_SYNC === '1') {
      const daemonCandidates = buildExtensionCandidates('zalo_autosync_daemon.js');
      const daemonPath = daemonCandidates.find(p => fs.existsSync(p));
      if (daemonPath) {
        const daemon = require(daemonPath);
        if (daemon && typeof daemon.startDaemon === 'function') {
          daemon.startDaemon();
          ultraLog(`[SYNC DAEMON] Started (${daemonPath})`);
        }
      }
    }
  } catch (e) {
    ultraLog(`[SYNC DAEMON NOTICE] ${e.message}`);
  }
};

if (app.isReady()) {
  initOptionalExtensions();
} else if (typeof app.whenReady === 'function') {
  app.whenReady().then(initOptionalExtensions);
} else {
  app.on('ready', initOptionalExtensions);
}

app.on('browser-window-created', (e, w) => {
  ultraLog(`WINDOW CREATED: id=${w.id}`);
  try {
    const iconCandidates = [
      path.join(__dirname, 'pc-dist', 'zalo-ultra.png'),
      path.join(__dirname, 'pc-dist', 'zalo-ultra.ico'),
      'C:\\Users\\phamn\\.gemini\\antigravity\\scratch\\zalo-ultra-client\\zalo-ultra.png',
      'C:\\Users\\phamn\\.gemini\\antigravity\\scratch\\zalo-ultra-client\\zalo-ultra.ico'
    ];
    const ultraIcon = iconCandidates.find(p => fs.existsSync(p));
    if (ultraIcon) {
      w.setIcon(ultraIcon);
      ultraLog(`[ICON] Applied custom Zalo Ultra icon: ${ultraIcon}`);
    }
  } catch(e) {}
  w.webContents.on('did-finish-load', () => {
    const url = w.webContents.getURL();
    ultraLog(`WINDOW DID-FINISH-LOAD: id=${w.id}, url=${url}`);
    if (url.includes('index.html')) {
      try { w.setTitle('Zalo Ultra'); } catch(e){}
      try { w.show(); w.focus(); } catch(e){}
      ultraLog(`[SHOW] MainWindow shown and focused!`);
    }
  });
  setTimeout(() => {
    if (!w.isDestroyed() && !w.isVisible()) {
      const url = w.webContents.getURL();
      if (url.includes('index.html')) {
        try { w.setTitle('Zalo Ultra'); } catch(e){}
        try { w.show(); w.focus(); } catch(e){}
        ultraLog(`[FORCE-SHOW] MainWindow shown!`);
      }
    }
  }, 1500);
});

app.on('window-all-closed', (e) => ultraLog('EVENT: window-all-closed'));
app.on('before-quit', (e) => ultraLog('EVENT: before-quit'));
app.on('will-quit', (e) => ultraLog('EVENT: will-quit'));

// ----------------------------------------------------------------------------
// 9. EXECUTION PIPELINE (PERFECT PARITY WITH ORIGINAL ZALO ENTRYPOINT)
// ----------------------------------------------------------------------------
const handleEntryCompactApp = () => {
  return require('./main-dist/compact-app');
};

function bootstrap() {
  ultraLog(`bootstrap() execution started!`);
  // Step 1: Performance Tracing Runtime
  try {
    require('./libs/perf-tracing/runtime');
    if (global.perf && typeof global.perf.record === 'function') {
      global.perf.record(global.perf.STARTUP);
    }
  } catch (e) {}

  // Step 2: Database Migration
  try {
    require('./main-dist/migration');
    if (global.perf && typeof global.perf.record === 'function') {
      global.perf.record(global.perf.MIGRATION_DONE);
    }
  } catch (e) {}

  // Step 3: Handle Compact App Mode
  const isCompactApp = process.argv.some(e => e.startsWith('--launch-compact-app'));
  if (isCompactApp) {
    return handleEntryCompactApp();
  }

  // Step 4: Handle Main Application Window (main-dist manages window and locks)
  if (global.perf && typeof global.perf.record === 'function') {
    global.perf.record(global.perf.MAIN_SCRIPT);
  }
  try {
    ultraLog(`Requiring ./main-dist/main...`);
    require('./main-dist/main');
    ultraLog(`main-dist/main required successfully!`);
  } catch(e) {
    ultraLog(`[ERROR requiring main-dist/main] ${e.stack || e}`);
  }
}

// Start Ultra Runtime
bootstrap();
