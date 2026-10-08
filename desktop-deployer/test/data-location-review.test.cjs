'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectDataDirectory } = require('../src/data-location.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gqd-location-review-'));
  const standard = path.join(root, 'OSData');
  const volume = path.join(root, 'MacData');
  const external = path.join(volume, 'Applications/GLaDOSQuickDeploy/Data');
  fs.mkdirSync(standard, { recursive: true }); fs.mkdirSync(volume);
  return { root, standard, external, volume, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('first upgrade keeps the existing standard-directory accounts instead of creating an empty external library', () => {
  const f = fixture();
  try {
    const old = JSON.stringify({ version: 2, accounts: [{ accountKey: 'AAAAAAAAAAAAAAAA' }] });
    fs.writeFileSync(path.join(f.standard, 'deployment-state.json'), old);
    const chosen = selectDataDirectory({ standard: f.standard, platform: 'darwin', external: f.external, externalVolume: f.volume });
    assert.equal(chosen, f.standard, 'A pre-existing 1.1.2 account store must not silently disappear when a volume is attached');
    assert.equal(fs.readFileSync(path.join(chosen, 'deployment-state.json'), 'utf8'), old);
  } finally { f.close(); }
});

test('a genuinely fresh install may choose the external directory without creating duplicate stores', () => {
  const f = fixture();
  try {
    const chosen = selectDataDirectory({ standard: f.standard, platform: 'darwin', external: f.external, externalVolume: f.volume });
    assert.equal(chosen, f.external);
    assert.equal(fs.existsSync(path.join(f.standard, 'deployment-state.json')), false);
  } finally { f.close(); }
});
