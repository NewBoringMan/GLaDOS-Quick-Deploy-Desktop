'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve('dist');
const out = path.resolve('delivery');
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(root).filter(file => /\.(?:exe|dmg|zip)$/.test(file));
if (!files.length) throw new Error('No built application packages found');
const manifest = { version: require('../package.json').version, platform: process.platform, arch: process.arch, commit: process.env.GITHUB_SHA || '', packages: [] };
for (const name of files) {
  const file = path.join(root, name);
  const bytes = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const parts = [];
  const partSize = 24 * 1024 * 1024;
  for (let offset = 0, index = 0; offset < bytes.length; offset += partSize, index++) {
    const part = `${name}.part${String(index).padStart(3, '0')}`;
    fs.writeFileSync(path.join(out, part), bytes.subarray(offset, offset + partSize));
    parts.push(part);
  }
  manifest.packages.push({ name, size: bytes.length, sha256, parts });
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), manifest.packages.map(p => `${p.sha256}  ${p.name}`).join('\n') + '\n');
console.log(JSON.stringify(manifest, null, 2));
