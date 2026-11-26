/**
 * GoogleDriveApiEngine.js - Native Node.js Google Drive API v3 Engine
 * Zero external npm dependencies.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const CHUNK_MULTIPLIER = 256 * 1024; // 262,144 bytes
const DEFAULT_CHUNK_SIZE = 20 * CHUNK_MULTIPLIER; // 5 MB
const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5 MB

class GoogleDriveApiEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.clientId = options.clientId || '';
    this.clientSecret = options.clientSecret || '';
    this.refreshToken = options.refreshToken || '';
    this.accessToken = options.accessToken || '';
    this.tokenExpiry = options.tokenExpiry || 0;
    this.onTokenRefresh = options.onTokenRefresh || null;
    this.tokenEndpoint = options.tokenEndpoint || process.env.ZALO_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
    this.apiBaseUrl = options.apiBaseUrl || process.env.ZALO_DRIVE_API_URL || 'https://www.googleapis.com';
    this.folderCache = new Map();
  }

  _buildApiUrl(apiPath) {
    const base = String(this.apiBaseUrl || 'https://www.googleapis.com').replace(/\/+$/, '');
    const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    return `${base}${normalizedPath}`;
  }

  _escapeQueryValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  async ensureValidAccessToken() {
    const now = Date.now();
    if (this.accessToken && this.tokenExpiry && now < this.tokenExpiry - 300000) {
      return this.accessToken;
    }

    if (!this.refreshToken) {
      if (this.accessToken) return this.accessToken;
      throw new Error('[GoogleDriveAPI] Không có refresh_token hoặc access_token hợp lệ.');
    }

    this.emit('status', 'Đang làm mới Access Token từ Google OAuth2...');

    const params = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token'
    });
    if (this.clientSecret) {
      params.append('client_secret', this.clientSecret);
    }
    const tokenPayload = params.toString();

    const response = await this._executeHttpRequest({
      url: this.tokenEndpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(tokenPayload)
      },
      body: tokenPayload,
      timeoutMs: 15000
    });

    if (response.statusCode !== 200) {
      throw new Error(`[GoogleDriveAPI] Làm mới token thất bại (${response.statusCode}): ${response.data}`);
    }

    const data = JSON.parse(response.data);
    this.accessToken = data.access_token;
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }
    this.tokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000);

    if (typeof this.onTokenRefresh === 'function') {
      try {
        const result = this.onTokenRefresh({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          tokenExpiry: this.tokenExpiry
        });
        if (result && typeof result.catch === 'function') {
          result.catch((err) => console.error('[GoogleDriveAPI] onTokenRefresh error:', err));
        }
      } catch (e) {
        console.error('[GoogleDriveAPI] onTokenRefresh error:', e);
      }
    }

    this.emit('tokenRefreshed', { accessToken: this.accessToken, tokenExpiry: this.tokenExpiry });
    return this.accessToken;
  }

  async _queryDriveFiles(q, fields = 'files(id, name, parents)', errorContext = 'Tìm kiếm file') {
    const queryParams = new URLSearchParams({
      q,
      fields,
      spaces: 'drive',
      pageSize: '10'
    }).toString();

    const res = await this._executeWithRetry(async (token) => {
      return await this._executeHttpRequest({
        url: this._buildApiUrl(`/drive/v3/files?${queryParams}`),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    });

    if (res.statusCode !== 200) {
      throw new Error(`[GoogleDriveAPI] ${errorContext} thất bại (${res.statusCode}): ${res.data}`);
    }

    const json = JSON.parse(res.data);
    return Array.isArray(json.files) ? json.files : [];
  }

  async findFolder(name, parentId = null) {
    const cacheKey = `${parentId || 'root'}:${name}`;
    if (this.folderCache.has(cacheKey)) {
      return this.folderCache.get(cacheKey);
    }

    const safeName = this._escapeQueryValue(name);
    let q = `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (parentId) {
      q += ` and '${this._escapeQueryValue(parentId)}' in parents`;
    }

    const files = await this._queryDriveFiles(q, 'files(id, name, parents)', 'Tìm kiếm thư mục');
    if (files.length > 0) {
      const folderId = files[0].id;
      this.folderCache.set(cacheKey, folderId);
      return folderId;
    }

    return null;
  }

  async findFile(name, parentId = null) {
    const safeName = this._escapeQueryValue(name);
    let q = `name='${safeName}' and trashed=false`;
    if (parentId) {
      q += ` and '${this._escapeQueryValue(parentId)}' in parents`;
    }

    const files = await this._queryDriveFiles(q, 'files(id, name, parents, size)', 'Tìm kiếm file');
    return files.length > 0 ? files[0] : null;
  }

  async getDriveAbout() {
    const res = await this._executeWithRetry(async (token) => {
      return await this._executeHttpRequest({
        url: this._buildApiUrl('/drive/v3/about?fields=user(displayName,emailAddress,photoLink),storageQuota(limit,usage)'),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    });

    if (res.statusCode !== 200) {
      throw new Error(`[GoogleDriveAPI] Xác minh kết nối Drive thất bại (${res.statusCode}): ${res.data}`);
    }

    const json = JSON.parse(res.data);
    return {
      user: json.user || null,
      storageQuota: json.storageQuota || null
    };
  }

  async verifyConnection() {
    return await this.getDriveAbout();
  }

  async createFolder(name, parentId = null) {
    const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
    if (parentId) meta.parents = [parentId];

    const bodyStr = JSON.stringify(meta);
    const res = await this._executeWithRetry(async (token) => {
      return await this._executeHttpRequest({
        url: this._buildApiUrl('/drive/v3/files'),
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'Content-Length': Buffer.byteLength(bodyStr)
        },
        body: bodyStr
      });
    });

    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new Error(`[GoogleDriveAPI] Tạo thư mục thất bại (${res.statusCode}): ${res.data}`);
    }

    const json = JSON.parse(res.data);
    const cacheKey = `${parentId || 'root'}:${name}`;
    this.folderCache.set(cacheKey, json.id);
    return json.id;
  }

  async ensureFolderPath(segments, rootParentId = null) {
    let currentParentId = rootParentId;
    for (const seg of segments) {
      let folderId = await this.findFolder(seg, currentParentId);
      if (!folderId) {
        this.emit('status', `Đang tạo thư mục "${seg}" trên Google Drive...`);
        folderId = await this.createFolder(seg, currentParentId);
      }
      currentParentId = folderId;
    }
    return currentParentId;
  }

  async uploadFile(localFilePath, parentFolderId, options = {}) {
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`[GoogleDriveAPI] File không tồn tại: ${localFilePath}`);
    }

    const stat = fs.statSync(localFilePath);
    const fileSize = stat.size;
    const fileName = options.customName || path.basename(localFilePath);
    const mimeType = options.mimeType || this._guessMimeType(fileName);

    this.emit('uploadStart', { fileName, fileSize, method: fileSize < MULTIPART_THRESHOLD ? 'multipart' : 'resumable' });

    if (fileSize < MULTIPART_THRESHOLD) {
      return await this._uploadMultipart(localFilePath, fileName, parentFolderId, mimeType, fileSize, options.onProgress);
    } else {
      return await this._uploadResumable(localFilePath, fileName, parentFolderId, mimeType, fileSize, options.onProgress);
    }
  }

  async _uploadMultipart(localFilePath, fileName, parentFolderId, mimeType, fileSize, onProgress) {
    const boundary = `-------ZaloVaultBoundary${Date.now()}`;
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadata = { name: fileName, parents: parentFolderId ? [parentFolderId] : [] };
    const metaPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
    const fileHeader = `${delimiter}Content-Type: ${mimeType}\r\n\r\n`;

    const metaPartBuf = Buffer.from(metaPart, 'utf8');
    const fileHeaderBuf = Buffer.from(fileHeader, 'utf8');
    const closeBuf = Buffer.from(closeDelimiter, 'utf8');
    const fileBuf = fs.readFileSync(localFilePath);

    const fullPayload = Buffer.concat([metaPartBuf, fileHeaderBuf, fileBuf, closeBuf]);
    const totalBytes = fullPayload.length;

    const res = await this._executeWithRetry(async (token) => {
      return await this._executeHttpRequest({
        url: this._buildApiUrl('/upload/drive/v3/files?uploadType=multipart'),
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': totalBytes
        },
        body: fullPayload
      });
    });

    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new Error(`[GoogleDriveAPI] Multipart Upload thất bại (${res.statusCode}): ${res.data}`);
    }

    const uploaded = JSON.parse(res.data);
    this.emit('uploadComplete', { fileName, fileId: uploaded.id, method: 'multipart' });
    return uploaded;
  }

  async _uploadResumable(localFilePath, fileName, parentFolderId, mimeType, fileSize, onProgress) {
    const metadata = { name: fileName, parents: parentFolderId ? [parentFolderId] : [] };
    const metaStr = JSON.stringify(metadata);

    const initRes = await this._executeWithRetry(async (token) => {
      return await this._executeHttpRequest({
        url: this._buildApiUrl('/upload/drive/v3/files?uploadType=resumable'),
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': fileSize,
          'Content-Type': 'application/json; charset=UTF-8',
          'Content-Length': Buffer.byteLength(metaStr)
        },
        body: metaStr
      });
    });

    if (initRes.statusCode !== 200) {
      throw new Error(`[GoogleDriveAPI] Khởi tạo Resumable thất bại (${initRes.statusCode}): ${initRes.data}`);
    }

    const sessionUri = initRes.headers['location'];
    if (!sessionUri) throw new Error('[GoogleDriveAPI] Không có Location header');

    const resolvedSessionUrl = new URL(sessionUri, this.apiBaseUrl).toString();
    let uploadedBytes = 0;
    const chunkSize = DEFAULT_CHUNK_SIZE;
    const startTime = Date.now();
    let fileResult = null;

    while (uploadedBytes < fileSize) {
      const endByte = Math.min(uploadedBytes + chunkSize, fileSize) - 1;
      const currentChunkLen = endByte - uploadedBytes + 1;
      const chunkBuf = await this._readChunkFromFile(localFilePath, uploadedBytes, currentChunkLen);

      let res = null;
      let chunkAttempt = 0;
      while (chunkAttempt < 3) {
        try {
          res = await this._executeHttpRequest({
            url: resolvedSessionUrl,
            method: 'PUT',
            headers: {
              'Content-Range': `bytes ${uploadedBytes}-${endByte}/${fileSize}`,
              'Content-Length': chunkBuf.length
            },
            body: chunkBuf
          });
          break;
        } catch (err) {
          chunkAttempt++;
          if (chunkAttempt >= 3) throw err;
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, chunkAttempt)));
        }
      }

      if (res.statusCode === 308) {
        const range = res.headers['range'];
        if (range) {
          const m = range.match(/bytes=0-(\d+)/);
          uploadedBytes = m ? parseInt(m[1], 10) + 1 : endByte + 1;
        } else {
          uploadedBytes = endByte + 1;
        }
      } else if (res.statusCode === 200 || res.statusCode === 201) {
        uploadedBytes = fileSize;
        fileResult = JSON.parse(res.data);
      } else {
        throw new Error(`[GoogleDriveAPI] Resumable chunk error: ${res.statusCode}`);
      }

      const elapsedSec = (Date.now() - startTime) / 1000 || 0.001;
      const speed = (uploadedBytes / (1024 * 1024)) / elapsedSec;
      const pct = Math.min(100, Math.round((uploadedBytes / fileSize) * 100));

      const progressData = {
        fileName,
        uploadedBytes,
        totalBytes: fileSize,
        percent: pct,
        speedMBs: speed.toFixed(2)
      };
      this.emit('progress', progressData);
      if (typeof onProgress === 'function') onProgress(progressData);
    }

    this.emit('uploadComplete', { fileName, fileId: fileResult ? fileResult.id : null, method: 'resumable' });
    return fileResult;
  }

  async _readChunkFromFile(filePath, start, length) {
    return new Promise((resolve, reject) => {
      fs.open(filePath, 'r', (err, fd) => {
        if (err) return reject(err);
        const buf = Buffer.alloc(length);
        fs.read(fd, buf, 0, length, start, (readErr, bytesRead) => {
          fs.close(fd, () => {});
          if (readErr) return reject(readErr);
          resolve(bytesRead < length ? buf.subarray(0, bytesRead) : buf);
        });
      });
    });
  }

  _resolveRequestTarget(opts) {
    if (opts.url) {
      const parsed = new URL(opts.url);
      return {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'http:' ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`
      };
    }
    const protocol = opts.protocol || 'https:';
    return {
      protocol,
      hostname: opts.hostname,
      port: opts.port || (protocol === 'http:' ? 80 : 443),
      path: opts.path
    };
  }

  async _executeHttpRequest(opts) {
    const target = this._resolveRequestTarget(opts);
    return new Promise((resolve, reject) => {
      const client = target.protocol === 'http:' ? http : https;
      const req = client.request({
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method: opts.method || 'GET',
        headers: opts.headers || {}
      }, (res) => {
        let chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: Buffer.concat(chunks).toString('utf8')
          });
        });
      });

      if (opts.timeoutMs) {
        req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('Timeout')));
      }
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  async _executeWithRetry(fn, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
      attempt++;
      try {
        const token = await this.ensureValidAccessToken();
        const res = await fn(token);
        if (res.statusCode === 401) {
          this.accessToken = null;
          this.tokenExpiry = 0;
          if (attempt >= maxRetries) return res;
          continue;
        }
        if (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode <= 599)) {
          if (attempt >= maxRetries) return res;
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
          continue;
        }
        return res;
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  _guessMimeType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const map = {
      '.tar.gz': 'application/gzip',
      '.gz': 'application/gzip',
      '.zip': 'application/zip',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.mp4': 'video/mp4',
      '.json': 'application/json',
      '.db': 'application/x-sqlite3'
    };
    return map[ext] || 'application/octet-stream';
  }
}

module.exports = GoogleDriveApiEngine;
