const fs = require('fs');
const path = require('path');

const destDir = 'U:\\Zalo_Cloud_Vault\\614370275596490287\\Tin_Nhan';
console.log('Testing fs.mkdirSync for:', destDir);
fs.mkdirSync(destDir, { recursive: true });

const testFile = path.join(destDir, 'test_write.txt');
fs.writeFileSync(testFile, 'Hello from Zalo Ultra to Google Drive U: on ' + new Date().toISOString(), 'utf8');
console.log('Successfully written test file:', fs.readFileSync(testFile, 'utf8'));
