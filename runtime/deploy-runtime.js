/**
 * deploy-runtime.js
 * Safe installer that copies bootstrap-ultra.js to D:\Zalo_Test_Env\ZaloApp\resources\app
 * and configures package.json without deleting any existing files.
 */

const fs = require('fs');
const path = require('path');

const targetAppDir = 'D:\\Zalo_Test_Env\\ZaloApp\\resources\\app';
const sourceBootstrap = path.join(__dirname, 'bootstrap-ultra.js');

if (!fs.existsSync(targetAppDir)) {
  console.error(`Target directory not found: ${targetAppDir}`);
  process.exit(1);
}

// 1. Copy bootstrap-ultra.js to target
const targetBootstrapUltra = path.join(targetAppDir, 'bootstrap-ultra.js');
fs.copyFileSync(sourceBootstrap, targetBootstrapUltra);
console.log(`[OK] Copied bootstrap-ultra.js to ${targetBootstrapUltra}`);

// 2. Backup existing package.json if not already backed up
const packageJsonPath = path.join(targetAppDir, 'package.json');
const packageJsonBak = path.join(targetAppDir, 'package.json.bak');

if (!fs.existsSync(packageJsonBak)) {
  fs.copyFileSync(packageJsonPath, packageJsonBak);
  console.log(`[OK] Created backup of package.json at ${packageJsonBak}`);
}

// 3. Update main in package.json to point to bootstrap-ultra.js
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const oldMain = pkg.main;
pkg.main = 'bootstrap-ultra.js';
fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2), 'utf8');
console.log(`[OK] Updated package.json 'main' from '${oldMain}' -> '${pkg.main}'`);
console.log(`\n🎉 ZALO ULTRA RUNTIME DEPLOYED SUCCESSFULLY!`);
console.log(`To revert anytime, restore package.json.bak or set "main": "${oldMain}".`);
