'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { ResumeStore } = require('../src/resume-store.cjs');

const FILE_NAME = 'pending-deployments.enc';
const NOW = Date.parse('2026-10-07T12:00:00Z');
const PRIVATE_COOKIE = 'gld:sess=private-checkpoint-session; gld:sess.sig=private-checkpoint-signature';
// A test-only cipher replaces safeStorage. Tests never load Electron or touch
// the operating system Keychain, DPAPI, browser profiles, or live credentials.
function mockStorage() {
  const key = crypto.createHash('sha256').update('resume-store-unit-tests-only').digest();
  const calls = { encrypt: 0, decrypt: 0, synchronous: 0 };
  const encrypt = text => {
    calls.encrypt++;
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from('TEST'), nonce, cipher.getAuthTag(), ciphertext]);
  };
  const decrypt = bytes => {
    calls.decrypt++;
    if (bytes.subarray(0, 4).toString() !== 'TEST') throw new Error(`never print ${PRIVATE_COOKIE}`);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
    decipher.setAuthTag(bytes.subarray(16, 32));
    return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString('utf8');
  };
  return {
    calls, getSelectedStorageBackend: () => 'test_secure_store',
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async text => encrypt(text),
    decryptStringAsync: async bytes => ({ result: decrypt(bytes), shouldReEncrypt: false }),
    isEncryptionAvailable: () => true,
    encryptString: text => { calls.synchronous++; return encrypt(text); },
    decryptString: bytes => { calls.synchronous++; return decrypt(bytes); },
  };
}
function task(overrides = {}) {
  return {
    id: 'a'.repeat(32), createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    githubLogin: 'example', githubId: 17, settings: { repoName: 'glados-quick-deploy', time: '09:30', exchangePlan: 'off' },
    account: { accountKey: 'A'.repeat(16), email: 'fixture@example.test', browser: 'embedded' },
    credential: { cookie: PRIVATE_COOKIE, userAgent: 'Unit-test-only browser', origin: 'https://glados.cloud' },
    checkpoint: { repository: 'example/glados-quick-deploy', repositoryId: 23, phase: 'dispatch_requested', nonce: 'b'.repeat(32), runId: 987 },
    phase: 'deploying', ...overrides,
  };
}
async function fixture(t, options = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'gqd-resume-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const safeStorage = options.safeStorage ?? mockStorage();
  const store = new ResumeStore({ directory, safeStorage, now: () => NOW, ...options });
  return { directory, safeStorage, store, file: path.join(directory, FILE_NAME) };
}

test('absent recovery data does not access any safeStorage method or getter', async t => {
  for (const missingDirectory of [false, true]) await t.test(missingDirectory ? 'directory is absent' : 'file is absent', async t => {
    let propertyReads = 0;
    const storage = new Proxy({}, { get() { propertyReads++; throw new Error('OS key provider must remain untouched'); } });
    const f = await fixture(t, { safeStorage: storage });
    const directory = missingDirectory ? path.join(f.directory, 'not-created') : f.directory;
    const store = new ResumeStore({ directory, safeStorage: storage, now: () => NOW });
    assert.deepEqual(await store.load(), { tasks: [], warning: '', durable: true });
    assert.equal(propertyReads, 0);
    assert.deepEqual(await fsp.readdir(f.directory), []);
  });
});

test('after an empty load, real saves and existing encrypted loads still verify the system provider', async t => {
  const storage = mockStorage();
  let available = false;
  let availabilityChecks = 0;
  storage.isAsyncEncryptionAvailable = async () => { availabilityChecks++; return available; };
  const f = await fixture(t, { safeStorage: storage });
  assert.deepEqual(await f.store.load(), { tasks: [], warning: '', durable: true });
  assert.equal(availabilityChecks, 0);
  const unavailable = await f.store.save([task()]);
  assert.equal(unavailable.durable, false); assert.match(unavailable.warning, /系统安全存储暂不可用/);
  assert.equal(availabilityChecks, 1); assert.equal(storage.calls.encrypt, 0); assert.equal(storage.calls.synchronous, 0);
  assert.deepEqual(await fsp.readdir(f.directory), []);

  available = true;
  assert.deepEqual(await f.store.save([task()]), { durable: true, warning: '' });
  assert.equal(availabilityChecks, 2); assert.equal(storage.calls.encrypt, 1);
  const original = await fsp.readFile(f.file);
  assert.equal(original.includes(Buffer.from(PRIVATE_COOKIE)), false);
  const restarted = new ResumeStore({ directory: f.directory, safeStorage: storage, now: () => NOW });
  const recovered = await restarted.load();
  assert.equal(recovered.durable, true); assert.deepEqual(recovered.tasks, [task()]);
  assert.equal(availabilityChecks, 3); assert.equal(storage.calls.decrypt, 1); assert.equal(storage.calls.synchronous, 0);
  assert.deepEqual(await fsp.readFile(f.file), original);
});

test('encrypted round trip uses async safeStorage and never writes plaintext', async t => {
  const f = await fixture(t);
  const tasks = [task()];
  assert.deepEqual(await f.store.save(tasks), { durable: true, warning: '' });
  const bytes = await fsp.readFile(f.file);
  for (const secret of [PRIVATE_COOKIE, 'fixture@example.test', 'Unit-test-only browser', 'example/glados-quick-deploy']) assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.deepEqual((await new ResumeStore({ directory: f.directory, safeStorage: f.safeStorage, now: () => NOW }).load()).tasks, tasks);
  assert.equal(f.safeStorage.calls.synchronous, 0);
  assert.deepEqual(await fsp.readdir(f.directory), [FILE_NAME]);
  if (process.platform !== 'win32') assert.equal((await fsp.stat(f.file)).mode & 0o777, 0o600);
});

test('legacy safeStorage works only when async methods are absent', async t => {
  const storage = mockStorage();
  delete storage.encryptStringAsync; delete storage.decryptStringAsync;
  const f = await fixture(t, { safeStorage: storage });
  assert.equal((await f.store.save([task()])).durable, true);
  assert.equal((await f.store.load()).tasks.length, 1);
  assert.equal(storage.calls.synchronous, 2);
});

test('unavailable async provider does not downgrade to sync or plaintext', async t => {
  const storage = mockStorage();
  storage.isAsyncEncryptionAvailable = async () => false;
  const f = await fixture(t, { safeStorage: storage });
  const saved = await f.store.save([task()]);
  assert.equal(saved.durable, false);
  assert.match(saved.warning, /尚未上传的登录信息仅保留到退出/);
  assert.equal(storage.calls.synchronous, 0);
  assert.equal(storage.calls.encrypt, 0);
  assert.deepEqual(await fsp.readdir(f.directory), []);
});

test('basic_text provider is rejected even if encryption reports available', async t => {
  const storage = mockStorage(); storage.getSelectedStorageBackend = () => 'basic_text';
  const f = await fixture(t, { safeStorage: storage });
  assert.equal((await f.store.save([task()])).durable, false);
  assert.equal(storage.calls.encrypt, 0);
  assert.deepEqual(await fsp.readdir(f.directory), []);
});

test('temporary key unavailability preserves existing ciphertext for later recovery', async t => {
  const f = await fixture(t);
  await f.store.save([task()]);
  const original = await fsp.readFile(f.file);
  f.safeStorage.isAsyncEncryptionAvailable = async () => false;
  const restarted = new ResumeStore({ directory: f.directory, safeStorage: f.safeStorage, now: () => NOW });
  assert.equal((await restarted.load()).durable, false);
  assert.equal((await restarted.save([task({ id: 'c'.repeat(32) })])).durable, false);
  assert.deepEqual(await fsp.readFile(f.file), original);
  f.safeStorage.isAsyncEncryptionAvailable = async () => true;
  assert.equal((await restarted.load()).tasks[0].id, 'a'.repeat(32));
});

test('corrupt files cannot be overwritten, including save before load', async t => {
  const f = await fixture(t);
  const corrupt = Buffer.from(`corrupt data ${PRIVATE_COOKIE}`);
  await fsp.writeFile(f.file, corrupt);
  const loaded = await f.store.load();
  assert.equal(loaded.durable, false); assert.deepEqual(loaded.tasks, []);
  assert.ok(!loaded.warning.includes('private-checkpoint'));
  assert.equal((await f.store.save([task()])).durable, false);
  const restarted = new ResumeStore({ directory: f.directory, safeStorage: f.safeStorage, now: () => NOW });
  assert.equal((await restarted.save([task()])).durable, false);
  assert.deepEqual(await fsp.readFile(f.file), corrupt);
});

test('invalid task count and one-MiB limits preserve a previous valid record', async t => {
  const f = await fixture(t);
  const hundred = Array.from({ length: 100 }, (_, i) => task({ id: String(i) }));
  assert.equal((await f.store.save(hundred)).durable, true);
  const original = await fsp.readFile(f.file);
  assert.equal((await f.store.save([...hundred, task()])).durable, false);
  assert.equal((await f.store.save([task({ extra: 'x'.repeat(1024 * 1024) })])).durable, false);
  assert.equal((await f.store.save('invalid')).durable, false);
  const circular = task(); circular.self = circular;
  assert.equal((await f.store.save([circular])).durable, false);
  assert.deepEqual(await fsp.readFile(f.file), original);
});

test('oversized encrypted output or preexisting file never bypasses the size limit', async t => {
  const f = await fixture(t);
  f.safeStorage.encryptStringAsync = async () => Buffer.alloc(1024 * 1024 + 1);
  assert.equal((await f.store.save([task()])).durable, false);
  assert.deepEqual(await fsp.readdir(f.directory), []);
  const oversized = Buffer.alloc(1024 * 1024 + 1, 0x42);
  await fsp.writeFile(f.file, oversized);
  assert.equal((await f.store.load()).durable, false);
  assert.equal((await f.store.save([task()])).durable, false);
  assert.equal((await fsp.stat(f.file)).size, oversized.length);
});

test('expired credentials are removed while nonce, run and cloud stages survive', async t => {
  const f = await fixture(t);
  const original = task();
  await f.store.save([original]);
  const future = new ResumeStore({ directory: f.directory, safeStorage: f.safeStorage, now: () => NOW + 7 * 86400000 });
  const loaded = await future.load();
  assert.equal(loaded.durable, true); assert.match(loaded.warning, /过保存期限/);
  const expired = loaded.tasks[0];
  assert.equal(expired.credential, undefined);
  assert.equal(expired.needsLogin, true); assert.equal(expired.credentialExpired, true);
  assert.deepEqual(expired.checkpoint, original.checkpoint);
  assert.deepEqual(expired.account, original.account);
  assert.equal(expired.updatedAt, original.updatedAt);
  const decoded = await f.safeStorage.decryptStringAsync(await fsp.readFile(f.file));
  assert.ok(!decoded.result.includes(PRIVATE_COOKIE));
  assert.ok(decoded.result.includes('987'));
  assert.equal(original.credential.cookie, PRIVATE_COOKIE);
});

test('cloud-only progress is retained after TTL and invalid timestamps expire only credentials', async t => {
  const f = await fixture(t);
  const cloudOnly = task({ credential: undefined, updatedAt: new Date(NOW - 30 * 86400000).toISOString() });
  await f.store.save([cloudOnly, task({ id: 'c'.repeat(32), updatedAt: 'invalid' }), task({ id: 'd'.repeat(32), updatedAt: NOW })]);
  const loaded = await f.store.load();
  assert.equal(loaded.tasks[0].needsLogin, undefined);
  assert.equal(loaded.tasks[0].checkpoint.runId, 987);
  assert.equal(loaded.tasks[1].credential, undefined);
  assert.equal(loaded.tasks[1].needsLogin, true);
  assert.equal(loaded.tasks[2].credential.cookie, PRIVATE_COOKIE);
});

test('file and directory symlinks are rejected without modifying targets', { skip: process.platform === 'win32' ? 'Symlink creation can require optional Windows privileges.' : false }, async t => {
  const f = await fixture(t);
  const target = path.join(f.directory, 'unrelated');
  await fsp.writeFile(target, 'keep this file');
  await fsp.symlink(target, f.file);
  assert.equal((await f.store.load()).durable, false);
  assert.equal((await f.store.save([task()])).durable, false);
  assert.equal((await f.store.save([])).durable, false);
  assert.equal(await fsp.readFile(target, 'utf8'), 'keep this file');
  await fsp.unlink(f.file);
  const linkedDirectory = path.join(f.directory, 'linked');
  await fsp.symlink(f.directory, linkedDirectory, 'dir');
  const linkedStore = new ResumeStore({ directory: linkedDirectory, safeStorage: f.safeStorage, now: () => NOW });
  assert.equal((await linkedStore.save([task()])).durable, false);
  await assert.rejects(fsp.stat(f.file), { code: 'ENOENT' });
});

test('encryption failure preserves old file and exposes no raw error or plaintext', async t => {
  const f = await fixture(t); await f.store.save([task()]);
  const original = await fsp.readFile(f.file);
  f.safeStorage.encryptStringAsync = async () => { throw new Error(PRIVATE_COOKIE); };
  const result = await f.store.save([task({ id: 'e'.repeat(32) })]);
  assert.equal(result.durable, false); assert.ok(!result.warning.includes('private-checkpoint'));
  assert.deepEqual(await fsp.readFile(f.file), original);
  assert.deepEqual(await fsp.readdir(f.directory), [FILE_NAME]);
});

test('atomic replacement failure retains the old checkpoint and removes temporary ciphertext', async t => {
  const f = await fixture(t); await f.store.save([task()]);
  const original = await fsp.readFile(f.file);
  t.mock.method(fsp, 'rename', async () => { throw Object.assign(new Error('write interrupted'), { code: 'EACCES' }); });
  assert.equal((await f.store.save([task({ id: 'e'.repeat(32) })])).durable, false);
  assert.deepEqual(await fsp.readFile(f.file), original);
  assert.deepEqual(await fsp.readdir(f.directory), [FILE_NAME]);
});

test('a decrypt response reporting temporary unavailability cannot replace existing progress', async t => {
  const f = await fixture(t); await f.store.save([task()]);
  const original = await fsp.readFile(f.file);
  f.safeStorage.decryptStringAsync = async () => ({ result: PRIVATE_COOKIE, isTemporarilyUnavailable: true });
  const restarted = new ResumeStore({ directory: f.directory, safeStorage: f.safeStorage, now: () => NOW });
  assert.equal((await restarted.load()).durable, false);
  assert.equal((await restarted.save([task()])).durable, false);
  assert.deepEqual(await fsp.readFile(f.file), original);
});

test('completed tasks remove the file even when OS crypto is unavailable', async t => {
  const f = await fixture(t); await f.store.save([task()]);
  f.safeStorage.isAsyncEncryptionAvailable = async () => false;
  assert.deepEqual(await f.store.save([]), { durable: true, warning: '' });
  await assert.rejects(fsp.stat(f.file), { code: 'ENOENT' });
  assert.deepEqual(await f.store.save([]), { durable: true, warning: '' });
});

test('an explicit empty save can clear a damaged file, without automatic replacement', async t => {
  const f = await fixture(t); await fsp.writeFile(f.file, 'corrupt');
  assert.equal((await f.store.load()).durable, false);
  assert.equal((await f.store.save([])).durable, true);
  assert.equal((await f.store.save([task()])).durable, true);
  assert.equal((await f.store.load()).tasks.length, 1);
});

test('queued saves retain invocation order and clone input before asynchronous writes', async t => {
  const f = await fixture(t);
  const original = task();
  const saving = f.store.save([original]);
  original.credential.cookie = 'changed after invocation';
  await saving;
  assert.equal((await f.store.load()).tasks[0].credential.cookie, PRIVATE_COOKIE);
  const operations = [f.store.save([task()]), f.store.save([])];
  assert.ok((await Promise.all(operations)).every(result => result.durable));
  await assert.rejects(fsp.stat(f.file), { code: 'ENOENT' });
});

test('key rotation re-encrypts a valid record without changing task progress', async t => {
  const f = await fixture(t); const tasks = [task()]; await f.store.save(tasks);
  const oldBytes = await fsp.readFile(f.file);
  const decrypt = f.safeStorage.decryptStringAsync;
  f.safeStorage.decryptStringAsync = async bytes => ({ ...(await decrypt(bytes)), shouldReEncrypt: true });
  const loaded = await f.store.load();
  assert.deepEqual(loaded.tasks, tasks); assert.equal(loaded.durable, true);
  assert.notDeepEqual(await fsp.readFile(f.file), oldBytes);
});
