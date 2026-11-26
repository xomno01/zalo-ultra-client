// query_cdp.js
const net = require('net');
const crypto = require('crypto');

const targetId = process.argv[2] || '661982F91525E445E035FFC9B3037A67';
const expr = process.argv[3] || 'document.title';

const s = net.connect(9333, '127.0.0.1', () => {
  const key = crypto.randomBytes(16).toString('base64');
  s.write('GET /devtools/page/' + targetId + ' HTTP/1.1\r\nHost: 127.0.0.1:9333\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
});

let buf = Buffer.alloc(0);
let handshaked = false;

s.on('data', d => {
  buf = Buffer.concat([buf, d]);
  if (!handshaked) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx !== -1) {
      handshaked = true;
      buf = buf.slice(idx + 4);
      const payload = JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true }
      });
      const len = Buffer.byteLength(payload);
      let frame;
      if (len <= 125) {
        frame = Buffer.alloc(len + 6);
        frame[0] = 0x81;
        frame[1] = 0x80 | len;
        const mask = crypto.randomBytes(4);
        mask.copy(frame, 2);
        const pBuf = Buffer.from(payload);
        for (let i = 0; i < len; i++) frame[6 + i] = pBuf[i] ^ mask[i % 4];
      } else {
        frame = Buffer.alloc(len + 8);
        frame[0] = 0x81;
        frame[1] = 0x80 | 126;
        frame.writeUInt16BE(len, 2);
        const mask = crypto.randomBytes(4);
        mask.copy(frame, 4);
        const pBuf = Buffer.from(payload);
        for (let i = 0; i < len; i++) frame[8 + i] = pBuf[i] ^ mask[i % 4];
      }
      s.write(frame);
    }
  } else {
    if (buf.length >= 2) {
      let payloadLen = buf[1] & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buf.length < 4) return;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buf.length < 10) return;
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length >= offset + payloadLen) {
        const res = buf.slice(offset, offset + payloadLen).toString('utf8');
        console.log(res);
        s.end();
        process.exit(0);
      }
    }
  }
});
