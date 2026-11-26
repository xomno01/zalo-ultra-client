/**
 * HybridDriveManager.js - Orchestrates Local Mount vs Cloud API v3
 */

const fs = require('fs');
const path = require('path');
const GoogleDriveApiEngine = require('./GoogleDriveApiEngine');
const MountedDriveEngine = require('./MountedDriveEngine');

class HybridDriveManager {
  constructor(configFilePath, options = {}) {
    this.configFilePath = configFilePath || path.join(__dirname, 'sync_config.json');
    this.options = options || {};
    this.config = this._loadConfig();

    this.cloudEngine = new GoogleDriveApiEngine(this._buildCloudEngineOptions());
    this.mountedEngine = new MountedDriveEngine();
  }

  _buildCloudEngineOptions() {
    return {
      clientId: this.config.googleClientId || this.options.clientId || '',
      clientSecret: this.config.googleClientSecret || this.options.clientSecret || '',
      refreshToken: this.config.googleRefreshToken || this.options.refreshToken || '',
      accessToken: this.config.googleAccessToken || this.options.accessToken || '',
      tokenExpiry: this.config.googleTokenExpiry || this.options.tokenExpiry || 0,
      tokenEndpoint: this.config.tokenEndpoint || this.options.tokenEndpoint,
      apiBaseUrl: this.config.apiBaseUrl || this.options.apiBaseUrl,
      onTokenRefresh: (tokens) => this._saveUpdatedTokens(tokens)
    };
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configFilePath)) {
        return JSON.parse(fs.readFileSync(this.configFilePath, 'utf8'));
      }
    } catch (e) {
      console.error('[HybridDriveManager] Failed to load config:', e);
    }
    return {};
  }

  reloadConfig() {
    this.config = this._loadConfig();
    const opts = this._buildCloudEngineOptions();

    if (!this.cloudEngine) {
      this.cloudEngine = new GoogleDriveApiEngine(opts);
      return this.config;
    }

    const credsChanged =
      this.cloudEngine.refreshToken !== opts.refreshToken ||
      this.cloudEngine.clientId !== opts.clientId;

    this.cloudEngine.clientId = opts.clientId;
    this.cloudEngine.clientSecret = opts.clientSecret;
    this.cloudEngine.refreshToken = opts.refreshToken;
    this.cloudEngine.accessToken = opts.accessToken;
    this.cloudEngine.tokenExpiry = opts.tokenExpiry;
    if (opts.tokenEndpoint) {
      this.cloudEngine.tokenEndpoint = opts.tokenEndpoint;
    }
    if (opts.apiBaseUrl) {
      this.cloudEngine.apiBaseUrl = opts.apiBaseUrl;
    }
    this.cloudEngine.onTokenRefresh = opts.onTokenRefresh;

    if (credsChanged && this.cloudEngine.folderCache instanceof Map) {
      this.cloudEngine.folderCache.clear();
    }

    return this.config;
  }

  _saveUpdatedTokens(tokens) {
    const latest = this._loadConfig();
    this.config = Object.assign({}, this.config, latest, {
      googleAccessToken: tokens.accessToken,
      googleTokenExpiry: tokens.tokenExpiry
    });
    try {
      fs.writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (e) {
      console.error('[HybridDriveManager] Failed to save updated tokens:', e);
    }
  }

  hasCloudTokens() {
    return Boolean(this.config.googleRefreshToken || this.config.googleAccessToken);
  }

  getEffectiveMode() {
    if (this.config.preferredSyncMode === 'cloud_api' && this.hasCloudTokens()) {
      return 'cloud_api';
    }
    if (this.config.preferredSyncMode === 'mounted_drive' && this.mountedEngine.detectMountedDrive()) {
      return 'mounted_drive';
    }
    if (this.mountedEngine.detectMountedDrive()) {
      return 'mounted_drive';
    }
    if (this.hasCloudTokens()) {
      return 'cloud_api';
    }
    return 'local_fallback';
  }

  getSystemCapabilities() {
    const mountedDrive = this.mountedEngine.detectMountedDrive();
    const hasCloudAuth = this.hasCloudTokens() || Boolean(this.config.googleAccount);

    let recommendedMode = 'local_fallback';
    if (mountedDrive) {
      recommendedMode = 'mounted_drive';
    } else if (hasCloudAuth) {
      recommendedMode = 'cloud_api';
    }

    return {
      mountedDriveAvailable: Boolean(mountedDrive),
      mountedDriveInfo: mountedDrive,
      cloudAuthAvailable: hasCloudAuth,
      cloudAccountInfo: this.config.googleAccount || null,
      recommendedMode: recommendedMode,
      activeMode: this.getEffectiveMode()
    };
  }

  setMode(mode) {
    this.config.preferredSyncMode = mode;
    fs.writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2), 'utf8');
    return mode;
  }

  async syncFile(localFilePath, category, user, onProgress, options = {}) {
    if (!this.hasCloudTokens()) {
      this.reloadConfig();
    }

    const mode = this.getEffectiveMode();
    const safeUser = user || {};
    const cleanUid = String(safeUser.uid || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'Shared';
    const cleanName = String(safeUser.name || 'User').replace(/[\\/:*?"<>|]/g, '_').trim() || 'User';

    if (mode === 'mounted_drive') {
      const targetDir = this.mountedEngine.ensureTargetDirectory(cleanUid, cleanName, category);
      return await this.mountedEngine.copyFileWithProgress(localFilePath, targetDir, onProgress);
    }

    if (mode === 'cloud_api') {
      if (!this.cloudEngine.refreshToken && !this.cloudEngine.accessToken) {
        this.reloadConfig();
      }
      const folderPath = ['Zalo_Cloud_Vault', `${cleanName}_${cleanUid}`, category];
      const targetFolderId = await this.cloudEngine.ensureFolderPath(folderPath);
      const uploadName = options.customName || path.basename(localFilePath);

      if (options.deduplicate) {
        const existing = await this.cloudEngine.findFile(uploadName, targetFolderId);
        if (existing) {
          const existingId = typeof existing === 'string' ? existing : existing.id;
          return { skipped: true, fileId: existingId, mode: 'cloud_api' };
        }
      }

      const uploaded = await this.cloudEngine.uploadFile(localFilePath, targetFolderId, {
        onProgress,
        customName: options.customName
      });
      return Object.assign({}, uploaded || {}, { mode: 'cloud_api' });
    }

    const baseRoot = this.config.vaultDir || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'Zalo_Cloud_Vault');
    const targetDir = path.join(baseRoot, `${cleanName}_${cleanUid}`, category);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const destName = options.customName || path.basename(localFilePath);
    const destPath = path.join(targetDir, destName);
    fs.copyFileSync(localFilePath, destPath);
    return { success: true, destPath, mode: 'local_fallback' };
  }
}

module.exports = HybridDriveManager;
