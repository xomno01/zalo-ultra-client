const fs = require('fs');
const path = require('path');

function getDirectories(srcpath) {
  if (!fs.existsSync(srcpath)) return [];
  return fs.readdirSync(srcpath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
}

function scanAccounts() {
  const dbRoots = [
    'D:\\Zalo Data\\message\\Database\\_production',
    'D:\\Zalo_Test_Env\\AppData\\Roaming\\ZaloData\\Database\\_production',
    'C:\\Users\\phamn\\AppData\\Roaming\\ZaloData\\Database\\_production',
    'C:\\Users\\phamn\\.gemini\\antigravity\\scratch\\zalo-ultra-client\\profiles\\default\\AppData\\Roaming\\ZaloData\\Database\\_production'
  ];

  const mediaRoots = [
    'D:\\Zalo Data\\media',
    'D:\\Zalo_Test_Env\\media',
    path.join(process.env.USERPROFILE || '', 'Documents', 'Zalo Received Files')
  ];

  const accounts = new Map();

  for (const root of dbRoots) {
    if (!fs.existsSync(root)) continue;
    const dirs = getDirectories(root);
    for (const d of dirs) {
      if (/^\d{15,20}$/.test(d)) {
        if (!accounts.has(d)) {
          accounts.set(d, { uid: d, dbPaths: [], mediaPaths: [] });
        }
        accounts.get(d).dbPaths.push(path.join(root, d));
      }
    }
  }

  for (const root of mediaRoots) {
    if (!fs.existsSync(root)) continue;
    const dirs = getDirectories(root);
    for (const d of dirs) {
      if (/^\d{15,20}$/.test(d) && accounts.has(d)) {
        accounts.get(d).mediaPaths.push(path.join(root, d));
      }
    }
  }

  console.log('Detected Zalo Accounts on this PC:');
  for (const [uid, acc] of accounts.entries()) {
    console.log(`\nAccount UID: ${uid}`);
    console.log(`  DB Paths:`, acc.dbPaths);
    console.log(`  Media Paths:`, acc.mediaPaths);
  }
}

scanAccounts();
