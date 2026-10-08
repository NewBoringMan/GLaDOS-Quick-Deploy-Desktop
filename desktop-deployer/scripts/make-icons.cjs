'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');
fs.mkdirSync('build', { recursive: true });
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type); const n = Buffer.alloc(4); n.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([n, t, data, c]); }
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const xx = x / size, yy = y / size;
    const edge = Math.hypot(Math.max(Math.abs(xx - .5) - .31, 0), Math.max(Math.abs(yy - .5) - .31, 0));
    let rgb = [17 + Math.round(8 * yy), 35 + Math.round(11 * yy), 61 + Math.round(12 * yy)];
    let alpha = edge <= .16 ? 255 : 0;
    const radius = Math.hypot(xx - .49, yy - .48);
    if (radius < .255 && radius > .185 && !(xx > .54 && yy < .43)) rgb = [65, 215, 170];
    if (xx > .48 && xx < .75 && yy > .465 && yy < .535) rgb = [65, 215, 170];
    if (xx > .685 && xx < .75 && yy > .48 && yy < .66) rgb = [65, 215, 170];
    if (Math.hypot(xx - .735, yy - .26) < .038) rgb = [246, 250, 253];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    raw.set([...rgb, alpha], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const largest = png(1024), small = png(256);
fs.writeFileSync('build/icon.png', largest);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(small.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync('build/icon.ico', Buffer.concat([ico, small]));
const icnsChunks = [[256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(([size, type]) => { const data = size === 1024 ? largest : size === 256 ? small : png(size); const h = Buffer.alloc(8); h.write(type); h.writeUInt32BE(data.length + 8, 4); return Buffer.concat([h, data]); });
const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns'); icnsHeader.writeUInt32BE(icnsChunks.reduce((sum, c) => sum + c.length, 8), 4);
fs.writeFileSync('build/icon.icns', Buffer.concat([icnsHeader, ...icnsChunks]));
console.log('Generated application icons.');
