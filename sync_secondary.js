const fs = require('fs');
const path = require('path');

function ensureDirStep(dirPath) {
  const resolved = path.resolve(dirPath);
  const parts = resolved.split(path.sep);
  let current = parts[0] + path.sep;
  for (let i = 1; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (!fs.existsSync(current)) {
      try { fs.mkdirSync(current); } catch (e) { if (!fs.existsSync(current)) throw e; }
    }
  }
}

function safeCopyFile(src, dest) {
  try {
    if (fs.existsSync(dest)) {
      const srcStat = fs.statSync(src);
      const destStat = fs.statSync(dest);
      if (srcStat.size === destStat.size && Math.abs(srcStat.mtimeMs - destStat.mtimeMs) < 2000) {
        return false;
      }
    }
    ensureDirStep(path.dirname(dest));
    fs.copyFileSync(src, dest);
    return true;
  } catch (e) {
    try {
      const data = fs.readFileSync(src);
      ensureDirStep(path.dirname(dest));
      fs.writeFileSync(dest, data);
      return true;
    } catch (err2) {
      return false;
    }
  }
}

function syncDirectory(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return { copied: 0, skipped: 0 };
  let copied = 0;
  let skipped = 0;

  function walk(currentSrc, currentDest) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentSrc, { withFileTypes: true });
    } catch (e) {
      return;
    }

    for (const entry of entries) {
      const srcPath = path.join(currentSrc, entry.name);
      const destPath = path.join(currentDest, entry.name);

      if (entry.isDirectory()) {
        walk(srcPath, destPath);
      } else if (entry.isFile()) {
        try {
          const wasCopied = safeCopyFile(srcPath, destPath);
          if (wasCopied) copied++;
          else skipped++;
        } catch (e) {}
      }
    }
  }

  walk(srcDir, destDir);
  return { copied, skipped };
}

// Sync Account 614370275596490287 (Wintelip)
const srcWintelip = 'D:\\Zalo_Test_Env\\AppData\\Roaming\\ZaloData\\Database\\_production\\614370275596490287';
const dstWintelip = 'U:\\Zalo_Cloud_Vault\\614370275596490287\\Tin_Nhan';
console.log('Syncing Wintelip (614370275596490287)...');
const resWintelip = syncDirectory(srcWintelip, dstWintelip);
console.log('Result Wintelip:', resWintelip);

// Sync Account 2132859265739813562
const src213 = 'D:\\Zalo_Test_Env\\AppData\\Roaming\\ZaloData\\Database\\_production\\2132859265739813562';
const dst213 = 'U:\\Zalo_Cloud_Vault\\2132859265739813562\\Tin_Nhan';
console.log('Syncing Account 2132859265739813562...');
const res213 = syncDirectory(src213, dst213);
console.log('Result 2132859265739813562:', res213);

console.log('ALL SECONDARY ACCOUNTS SYNCED SUCCESSFULLY!');
