'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const packaged = process.argv[2];
const executable = packaged ? path.resolve(packaged) : require('electron');
const output = path.resolve('smoke-output');
fs.mkdirSync(output, { recursive: true });
const args = [...(packaged ? [] : ['.']), '--smoke-test', `--smoke-output=${output}`];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
const child = spawn(executable, args, { stdio: 'pipe', env, windowsHide: true });
let text = '';
child.stdout.on('data', chunk => { text += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => process.stderr.write(chunk));
const timer = setTimeout(() => { child.kill(); console.error('Desktop smoke timed out'); process.exitCode = 1; }, 45000);
child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timer);
  if (code !== 0 || !text.includes('QUICK_DEPLOY_SMOKE=')) process.exitCode = 1;
  else console.log('Native packaged desktop smoke passed.');
});
