/**
 * MountedDriveEngine.js - Local Mount Drive Sync Engine (RaiDrive U:\, Google Drive G:\)
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class MountedDriveEngine extends EventEmitter {
  constructor() {
    super();
    this.detectedDrive = null;
  }

  detectMountedDrive() {
    // 1. Kiểm tra ưu tiên ổ U:\ (RaiDrive Google Drive hiện có trên máy)
    if (fs.existsSync('U:\\')) {
      this.detectedDrive = {
        letter: 'U',
        root: 'U:\\',
        type: 'RaiDrive Google Drive',
        displayName: 'Google Drive (RaiDrive Ổ U:\\)'
      };
      return this.detectedDrive;
    }

    // 2. Kiểm tra ổ G:\ (Google Drive for Desktop chính thức)
    if (fs.existsSync('G:\\')) {
      const gMy = path.join('G:\\', 'My Drive');
      const rootPath = fs.existsSync(gMy) ? gMy : 'G:\\';
      this.detectedDrive = {
        letter: 'G',
        root: rootPath,
        type: 'Google Drive for Desktop',
        displayName: 'Google Drive (Ổ G:\\)'
      };
      return this.detectedDrive;
    }

    return null;
  }

  ensureTargetDirectory(userUid, userName = 'User', category = 'Tin_Nhan') {
    const drive = this.detectedDrive || this.detectMountedDrive();
    if (!drive) {
      throw new Error('[MountedDrive] Không tìm thấy ổ đĩa Google Drive nào được mount trên máy.');
    }

    const cleanUid = String(userUid || '').replace(/[^0-9]/g, '');
    const cleanName = String(userName || 'User').replace(/[\\/:*?"<>|]/g, '_');
    const folderName = `${cleanName}_${cleanUid}`;

    const targetDir = path.join(drive.root, 'Zalo_Cloud_Vault', folderName, category);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    return targetDir;
  }

  async copyFileWithProgress(sourcePath, targetDir, onProgress) {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`[MountedDrive] File không tồn tại: ${sourcePath}`);
    }

    const fileName = path.basename(sourcePath);
    const destPath = path.join(targetDir, fileName);
    const stat = fs.statSync(sourcePath);
    const totalBytes = stat.size;

    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });
      const writeStream = fs.createWriteStream(destPath);

      let copiedBytes = 0;
      const startTime = Date.now();

      readStream.on('data', chunk => {
        copiedBytes += chunk.length;
        const elapsedSec = (Date.now() - startTime) / 1000 || 0.001;
        const speed = (copiedBytes / (1024 * 1024)) / elapsedSec;
        const pct = Math.min(100, Math.round((copiedBytes / totalBytes) * 100));

        const progressData = {
          fileName,
          uploadedBytes: copiedBytes,
          totalBytes,
          percent: pct,
          speedMBs: speed.toFixed(2),
          mode: 'mounted_drive'
        };

        this.emit('progress', progressData);
        if (typeof onProgress === 'function') onProgress(progressData);
      });

      writeStream.on('finish', () => {
        resolve({ success: true, destPath, size: totalBytes, mode: 'mounted_drive' });
      });

      readStream.on('error', reject);
      writeStream.on('error', reject);
      readStream.pipe(writeStream);
    });
  }
}

module.exports = MountedDriveEngine;
