'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VERSION = '2.102.0';
const RELEASES = {
  'win32-x64': { name: 'gh_2.102.0_windows_amd64.zip', sha256: 'ae64e556ecc240b200f7eba60d550e4bb60d78e860e69dd88c449405b86067f4' },
  'darwin-arm64': { name: 'gh_2.102.0_macOS_arm64.zip', sha256: 'da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e' },
  'darwin-x64': { name: 'gh_2.102.0_macOS_amd64.zip', sha256: 'b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3' },
};

function find(root, name) {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isFile() && item.name === name) return file;
    if (item.isDirectory()) { const found = find(file, name); if (found) return found; }
  }
  return null;
}

async function main() {
  const platform = process.argv[2] || process.platform;
  const arch = process.argv[3] || process.arch;
  const release = RELEASES[`${platform}-${arch}`];
  if (!release) throw new Error(`Unsupported GitHub CLI target: ${platform}-${arch}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-gh-download-'));
  try {
    const response = await fetch(`https://github.com/cli/cli/releases/download/v${VERSION}/${release.name}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Official GitHub CLI download returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('GitHub CLI checksum mismatch');
    const archive = path.join(temp, release.name);
    fs.writeFileSync(archive, bytes);
    const extracted = path.join(temp, 'extracted');
    fs.mkdirSync(extracted);
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'zipfile', '-e', archive, extracted], { stdio: 'inherit' });
    const name = platform === 'win32' ? 'gh.exe' : 'gh';
    const binary = find(extracted, name);
    if (!binary) throw new Error('Official archive contains no GitHub CLI executable');
    const destination = path.resolve('vendor', 'gh', `${platform}-${arch}`);
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(binary, path.join(destination, name));
    if (platform !== 'win32') fs.chmodSync(path.join(destination, name), 0o755);
    const license = find(extracted, 'LICENSE');
    if (license) fs.copyFileSync(license, path.join(destination, 'LICENSE'));
    else throw new Error('Official GitHub CLI license not found');
    fs.writeFileSync(path.join(destination, 'provenance.json'), JSON.stringify({ version: VERSION, asset: release.name, sha256: release.sha256 }, null, 2));
    console.log(`Verified and prepared official GitHub CLI ${VERSION} for ${platform}-${arch}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
