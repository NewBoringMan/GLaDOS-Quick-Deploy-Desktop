'use strict';
const { spawnSync } = require('node:child_process');
const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-m', 'unittest', 'discover', '-s', 'test/cloud', '-v'], { stdio: 'inherit', windowsHide: true });
process.exitCode = r.status ?? 1;
