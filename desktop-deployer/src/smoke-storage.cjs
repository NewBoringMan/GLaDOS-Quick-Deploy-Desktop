'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ResumeStore } = require('./resume-store.cjs');

async function runStorageRegression({ directory, safeStorage }) {
  if (!process.argv.includes('--smoke-test')) return { checked: false, reason: 'Storage fixtures run only in smoke-test mode.' };
  // Exercise an empty restart without ever exposing the real native provider.
  // Even reading a provider method would fail this fixture, so it is safe on
  // the user's computer and runs before the CI-only native encryption branch.
  const emptyDirectory = path.join(directory, 'empty-storage-fixture');
  fs.mkdirSync(emptyDirectory, { recursive: true });
  assert.ok(!fs.existsSync(path.join(emptyDirectory, 'pending-deployments.enc')), 'Empty restore fixture must not contain an encrypted session');
  let providerReads = 0;
  const forbiddenProvider = new Proxy(Object.create(null), {
    get() { providerReads += 1; throw new Error('An empty restore must not access the native key provider'); },
  });
  const empty = await new ResumeStore({ directory: emptyDirectory, safeStorage: forbiddenProvider }).load();
  assert.equal(providerReads, 0, 'An empty restore must not inspect or initialize any safeStorage method');
  assert.deepEqual(empty, { tasks: [], warning: '', durable: true }, 'An empty restore must return a clean empty state');
  const emptyResult = { emptyRestoreDoesNotAccessKeychain: true };

  // Native key-provider initialization is exercised only on ephemeral CI VMs.
  // A smoke check on the user's computer never requests Keychain access.
  if (process.env.CI !== 'true' || process.env.GQD_VALIDATE_NATIVE_STORAGE !== '1') {
    return { ...emptyResult, checked: false, reason: 'Native key-provider fixture runs only in CI.' };
  }
  let deadline;
  const fixtureDirectory = path.join(directory, 'native-storage-fixture');
  const marker = 'QUICK_DEPLOY_NON_SECRET_NATIVE_STORAGE_FIXTURE';
  const task = { id: 'f'.repeat(32), updatedAt: new Date().toISOString(), credential: { cookie: marker }, phase: 'deploying' };
  try {
    return await Promise.race([
      (async () => {
        const available = typeof safeStorage.isAsyncEncryptionAvailable === 'function'
          ? await safeStorage.isAsyncEncryptionAvailable()
          : safeStorage.isEncryptionAvailable();
        const first = new ResumeStore({ directory: fixtureDirectory, safeStorage });
        const saved = await first.save([task]);
        if (available) assert.equal(saved.durable, true, 'An available native key provider must save the fixture');
        const file = path.join(fixtureDirectory, 'pending-deployments.enc');
        if (!saved.durable) {
          assert.ok(!fs.existsSync(file), 'Unavailable native storage must never write a plaintext fallback');
          return { ...emptyResult, checked: true, encryptionAvailable: false, plaintextFallbackBlocked: true };
        }
        const bytes = fs.readFileSync(file);
        assert.ok(bytes.length && !bytes.includes(Buffer.from(marker)), 'Native fixture must be encrypted at rest');
        const reopened = new ResumeStore({ directory: fixtureDirectory, safeStorage });
        const restored = await reopened.load();
        assert.equal(restored.durable, true, 'Native encrypted fixture must remain readable');
        assert.equal(restored.tasks[0]?.credential?.cookie, marker, 'A fresh store must recover the original fixture');
        assert.equal((await reopened.save([])).durable, true, 'Native encrypted fixture must be removable');
        assert.ok(!fs.existsSync(file));
        const { ReportVault } = require('./report-vault.cjs');
        const { seal } = require('./cloud/encrypt.cjs');
        const vault = new ReportVault({ directory: fixtureDirectory, safeStorage });
        const publicKey = await vault.ensure();
        const reportContext = { repository: 'fixture/repository', runId: 1, accountKey: 'A'.repeat(16) };
        const encryptedReport = seal({ ...reportContext, points: 123 }, publicKey);
        vault.clear();
        const restoredReport = await vault.decrypt(encryptedReport, reportContext);
        assert.equal(restoredReport.points, 123);
        assert.ok(!fs.readFileSync(vault.file).includes(Buffer.from('BEGIN PRIVATE KEY')));
        return { ...emptyResult, checked: true, encryptionAvailable: true, encryptedRoundTrip: true, explicitRemoval: true, reportKeyNativeRoundTrip: true };
      })(),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Native storage fixture timed out')), 25000); }),
    ]);
  } finally { clearTimeout(deadline); }
}

module.exports = { runStorageRegression };
