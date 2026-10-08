'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let failed = false;
for (const folder of ['src', 'renderer', 'scripts', 'test']) {
  if (!fs.existsSync(folder)) continue;
  for (const entry of fs.readdirSync(folder, { recursive: true })) {
    if (!/\.(?:cjs|mjs|js)$/.test(entry)) continue;
    const file = path.join(folder, entry);
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
const html = fs.readFileSync('renderer/index.html', 'utf8');
const renderer = fs.readFileSync('renderer/app.js', 'utf8') + fs.readFileSync('renderer/management.js', 'utf8');
if (!/Content-Security-Policy/i.test(html)) { console.error('Renderer CSP is required'); failed = true; }
if (/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(renderer)) { console.error('Renderer persistence APIs are forbidden'); failed = true; }
process.exitCode = failed ? 1 : 0;
