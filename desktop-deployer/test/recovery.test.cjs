'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Controller } = require('../src/controller.cjs');
const { ResumeStore } = require('../src/resume-store.cjs');
const { saveState, loadState } = require('../src/state.cjs');

const USER = { login: 'tester', id: 1234, workflowScope: true };
const SETTINGS = { repoName: 'original-recovery-job', time: '07:13', exchangePlan: 'plan100' };
const clone = value => JSON.parse(JSON.stringify(value));
function error(code, stage = 'deploying') { return Object.assign(new Error(`Fixture ${code}`), { code, stage }); }
function credential(label = 'alpha') {
  const email = `${label}@fixture.test`;
  return {
    cookie: `gld:sess=private-${label}-session-value; gld:sess.sig=private-${label}-signature-value`,
    userAgent: `Private actual ${label} UA fixture`, origin: 'https://glados.cloud', email,
    accountKey: crypto.createHash('sha256').update(`glados:email:${email}`).digest('hex').slice(0, 16).toUpperCase(),
    browser: 'Fixture Browser', capturedAt: new Date().toISOString(),
  };
}
const ALPHA = credential('alpha');
const BRAVO = credential('bravo');

// Test-only OS-crypto substitute. It never imports Electron or opens Keychain,
// DPAPI, a browser, or a real GitHub/GLaDOS account.
function testSafeStorage() {
  const key = crypto.createHash('sha256').update('gqd-recovery-tests-only').digest();
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async text => {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decryptStringAsync: async bytes => {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
  };
}

function checkpoint(record = ALPHA, overrides = {}) {
  return {
    schemaVersion: 1, githubLogin: USER.login, githubId: USER.id, accountKey: record.accountKey,
    repository: `${USER.login}/${SETTINGS.repoName}`, repositoryId: 71, branch: 'main',
    secretStored: false, configured: false, ...overrides,
  };
}
function run(repository = `${USER.login}/${SETTINGS.repoName}`, runId = 901) {
  return { repository, runId, runUrl: `https://github.com/${repository}/actions/runs/${runId}`, status: 'completed', conclusion: 'success' };
}
function pending(record = ALPHA, overrides = {}) {
  const stamp = new Date().toISOString();
  return {
    id: (record === BRAVO ? 'b' : 'a').repeat(32), revision: 2, credentialVersion: 'c'.repeat(32),
    createdAt: stamp, updatedAt: stamp, githubLogin: USER.login, githubId: USER.id,
    settings: { ...SETTINGS }, browserId: 'embedded', phase: 'deploying',
    account: { accountKey: record.accountKey, email: record.email, browser: record.browser },
    expectedAccountKey: record.accountKey, credential: { ...record }, checkpoint: checkpoint(record), ...overrides,
  };
}
function completeResult(record = ALPHA, repository = `${USER.login}/${SETTINGS.repoName}`, runId = 901) {
  return { ...run(repository, runId), accountKey: record.accountKey, result: { status: 'points_increased', accounts: [{ accountKey: record.accountKey, outcome: 'checked', pointsAdded: 2, exchange: 'not_needed' }] } };
}

async function environment(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'gqd-recovery-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return { directory, safeStorage: testSafeStorage() };
}
async function seedPending(env, tasks, accounts = []) {
  saveState(env.directory, { pendingDeployments: tasks, activeTaskId: tasks[0]?.id || '', accounts });
  await new ResumeStore({ directory: env.directory, safeStorage: env.safeStorage }).save(tasks);
}
function harness(env, overrides = {}) {
  const calls = { captures: [], deploys: [], logins: [], refreshes: [], saved: [], snapshots: [], order: [] };
  let currentIdentity = { ...USER };
  const github = {
    whoami: async () => ({ ...currentIdentity }),
    login: async options => { calls.logins.push({ refresh: options.refresh }); calls.order.push('github-login'); currentIdentity = { ...USER }; return { ...currentIdentity }; },
    refresh: async args => { calls.refreshes.push(clone(args)); return completeResult({ accountKey: args.accountKey }, args.repository, 999); },
    pause: async () => {},
    ...overrides.github,
  };
  github.deploy = async args => {
    calls.deploys.push({ credential: args.credential ? clone(args.credential) : undefined, checkpoint: args.checkpoint ? clone(args.checkpoint) : undefined, repoName: args.repoName, time: args.time, exchangePlan: args.exchangePlan });
    calls.order.push('deploy');
    if (overrides.deploy) return overrides.deploy(args, calls);
    const record = args.credential || { accountKey: args.checkpoint.accountKey };
    const repository = args.checkpoint?.repository || `${USER.login}/${args.repoName}`;
    const result = completeResult(record, repository);
    const saved = checkpoint(record, { repository, secretStored: true, configured: true, run: run(repository) });
    await args.onCheckpoint?.(saved);
    return { ...result, checkpoint: saved };
  };
  const resumeStore = overrides.resumeStore || new ResumeStore({ directory: env.directory, safeStorage: env.safeStorage });
  const controller = new Controller({
    github, resumeStore, restored: overrides.restored ?? loadState(env.directory),
    now: overrides.now,
    discoverBrowsers: async () => [{ id: 'embedded', available: true }],
    captureLogin: async args => {
      calls.captures.push({ browserId: args.browserId }); calls.order.push('capture');
      return overrides.captureLogin ? overrides.captureLogin(args, calls) : { ...ALPHA };
    },
    save: state => {
      calls.saved.push(clone(state));
      if (overrides.save) overrides.save(state, calls);
      else saveState(env.directory, state);
    },
    openExternal: async () => {},
  });
  controller.on('state', state => calls.snapshots.push(clone(state)));
  return { controller, calls, resumeStore };
}
function assertNoSecrets(value, records = [ALPHA, BRAVO]) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const record of records) {
    assert.ok(!text.includes(record.cookie));
    assert.ok(!text.includes(record.userAgent));
    for (const pair of record.cookie.split(';')) assert.ok(!text.includes(pair.slice(pair.indexOf('=') + 1).trim()));
  }
  assert.ok(!/"cookie"\s*:/.test(text));
}

test('network retry reuses the captured credential and original settings despite changed form settings', async t => {
  const env = await environment(t);
  let attempt = 0;
  const f = harness(env, { deploy: async args => {
    if (++attempt === 1) throw error('NETWORK_ERROR');
    return completeResult(args.credential, `${USER.login}/${args.repoName}`);
  } });
  await f.controller.initialize();
  const failed = await f.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS });
  assert.equal(failed.stage, 'error'); assert.equal(failed.resumeTasks.length, 1);
  const taskId = failed.resumeTasks[0].id;
  await f.controller.action('saveSettings', { repoName: 'different-form-repository', time: '23:41', exchangePlan: 'off' });
  const resumed = await f.controller.action('resumeDeploy', { taskId, repoName: 'ignored-renderer-value', time: '22:00' });
  assert.equal(resumed.stage, 'complete'); assert.equal(f.calls.captures.length, 1);
  assert.equal(f.calls.deploys.length, 2);
  assert.deepEqual(f.calls.deploys[1], { credential: f.calls.deploys[0].credential, checkpoint: undefined, ...SETTINGS });
  assert.equal(resumed.resumeTasks.length, 0);
  assertNoSecrets(f.calls.snapshots); assertNoSecrets(f.calls.saved);
});

test('a fresh controller restores encrypted credentials but never exposes them in state or plaintext files', async t => {
  const env = await environment(t);
  const first = harness(env, { deploy: async () => { throw error('NETWORK_ERROR'); } });
  await first.controller.initialize();
  await first.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS });
  const taskId = first.controller.state.resumeTasks[0].id;
  await first.controller.shutdown();
  assertNoSecrets(await fsp.readFile(path.join(env.directory, 'deployment-state.json'), 'utf8'));
  const ciphertext = await fsp.readFile(path.join(env.directory, 'pending-deployments.enc'));
  assert.equal(ciphertext.includes(Buffer.from(ALPHA.cookie)), false);
  const restarted = harness(env, { captureLogin: () => { throw new Error('Restored tasks must not open a browser'); } });
  await restarted.controller.initialize();
  assert.equal(restarted.controller.tasks.get(taskId).credential.cookie, ALPHA.cookie);
  assertNoSecrets(restarted.controller.snapshot());
  const result = await restarted.controller.action('resumeDeploy', { taskId });
  assert.equal(result.stage, 'complete'); assert.equal(restarted.calls.captures.length, 0);
  assert.equal(restarted.calls.deploys[0].credential.cookie, ALPHA.cookie);
  assertNoSecrets(restarted.calls.snapshots); assertNoSecrets(restarted.calls.saved);
});

test('a stored cloud secret resumes after restart with no local credential or new login', async t => {
  const env = await environment(t);
  const first = harness(env, { deploy: async args => {
    await args.onCheckpoint(checkpoint(args.credential, { secretStored: true }));
    throw error('NETWORK_ERROR', 'configuration');
  } });
  await first.controller.initialize();
  await first.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS });
  const taskId = first.controller.state.resumeTasks[0].id;
  assert.equal(first.controller.tasks.get(taskId).credential, undefined);
  const restarted = harness(env, { captureLogin: () => { throw new Error('Cloud secret is already stored'); } });
  await restarted.controller.initialize();
  assert.equal(restarted.controller.state.resumeTasks[0].needsLogin, false);
  const result = await restarted.controller.action('resumeDeploy', { taskId });
  assert.equal(result.stage, 'complete'); assert.equal(restarted.calls.captures.length, 0);
  assert.equal(restarted.calls.deploys[0].credential, undefined);
  assert.equal(restarted.calls.deploys[0].checkpoint.secretStored, true);
});

test('newer plaintext metadata preserves nonce, run and secret stage against an older encrypted envelope', async t => {
  const env = await environment(t);
  const old = pending();
  const store = new ResumeStore({ directory: env.directory, safeStorage: env.safeStorage });
  await store.save([old]);
  const latest = pending(ALPHA, { revision: 8, credential: undefined, phase: 'verifying', checkpoint: checkpoint(ALPHA, {
    secretStored: true, configured: true,
    dispatch: { nonce: 'd'.repeat(32), accountKey: ALPHA.accountKey, branch: 'main', submittedAt: Date.now() }, run: run(undefined, 934),
  }) });
  saveState(env.directory, { pendingDeployments: [latest], activeTaskId: latest.id });
  const restored = harness(env); await restored.controller.initialize();
  const task = restored.controller.tasks.get(latest.id);
  assert.equal(task.revision, 8); assert.equal(task.credential, undefined);
  assert.equal(task.checkpoint.secretStored, true); assert.equal(task.checkpoint.dispatch.nonce, 'd'.repeat(32));
  assert.equal(task.checkpoint.run.runId, 934);
  assertNoSecrets(restored.calls.snapshots); assertNoSecrets(restored.calls.saved);
});

test('an authoritative completed-task state prevents resurrection from stale ciphertext', async t => {
  const env = await environment(t);
  const store = new ResumeStore({ directory: env.directory, safeStorage: env.safeStorage });
  await store.save([pending()]);
  saveState(env.directory, { pendingDeployments: [], accounts: [{ ...completeResult(ALPHA), email: ALPHA.email, deploymentStatus: 'deployed' }] });
  const f = harness(env); await f.controller.initialize();
  assert.equal(f.controller.tasks.size, 0); assert.deepEqual(f.controller.state.resumeTasks, []);
  assert.equal(f.controller.state.accounts[0].accountKey, ALPHA.accountKey);
  assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.deploys.length, 0);
});

test('equal revision metadata wins when a checkpoint was persisted before its revision increment', async t => {
  const env = await environment(t);
  const old = pending();
  await new ResumeStore({ directory: env.directory, safeStorage: env.safeStorage }).save([old]);
  const current = pending(ALPHA, { revision: old.revision, credential: undefined, phase: 'verifying', checkpoint: checkpoint(ALPHA, {
    secretStored: true, configured: true,
    dispatch: { nonce: 'e'.repeat(32), accountKey: ALPHA.accountKey, branch: 'main', submittedAt: Date.now() }, run: run(undefined, 935),
  }) });
  saveState(env.directory, { pendingDeployments: [current], activeTaskId: current.id });
  const f = harness(env); await f.controller.initialize();
  const restored = f.controller.tasks.get(current.id);
  assert.equal(restored.checkpoint.secretStored, true);
  assert.equal(restored.checkpoint.dispatch.nonce, 'e'.repeat(32));
  assert.equal(restored.checkpoint.run.runId, 935);
  assert.equal(restored.credential, undefined);
});

test('workflow scope is refreshed before any GLaDOS login begins', async t => {
  const env = await environment(t);
  let scope = false;
  let calls;
  const f = harness(env, { github: {
    whoami: async () => ({ ...USER, workflowScope: scope }),
    login: async options => { calls.logins.push({ refresh: options.refresh }); calls.order.push('github-login'); scope = true; return { ...USER }; },
  } });
  calls = f.calls;
  await f.controller.initialize();
  const result = await f.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS });
  assert.equal(result.stage, 'complete');
  assert.deepEqual(calls.order.slice(0, 3), ['github-login', 'capture', 'deploy']);
  assert.deepEqual(calls.logins, [{ refresh: true }]);
});

test('multiple pending accounts retain separate tasks and credentials when another task resumes', async t => {
  const env = await environment(t);
  let successfulKey;
  const f = harness(env, {
    captureLogin: (_args, calls) => ({ ...(calls.captures.length === 1 ? ALPHA : BRAVO) }),
    deploy: async args => {
      if (args.credential.accountKey !== successfulKey) throw error('NETWORK_ERROR');
      return completeResult(args.credential, `${USER.login}/${args.repoName}`);
    },
  });
  await f.controller.initialize();
  await f.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS, newTask: true });
  await f.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS, newTask: true });
  assert.equal(f.controller.tasks.size, 2);
  const alphaTask = [...f.controller.tasks.values()].find(task => task.account.accountKey === ALPHA.accountKey);
  const bravoTask = [...f.controller.tasks.values()].find(task => task.account.accountKey === BRAVO.accountKey);
  assert.notEqual(alphaTask.id, bravoTask.id);
  successfulKey = ALPHA.accountKey;
  await f.controller.action('resumeDeploy', { taskId: alphaTask.id });
  assert.equal(f.controller.tasks.size, 1);
  assert.equal(f.controller.tasks.get(bravoTask.id).credential.cookie, BRAVO.cookie);
  assert.equal(f.controller.state.accounts.find(account => account.accountKey === ALPHA.accountKey).conclusion, 'checkin_success');
  assert.equal(f.controller.state.accounts.find(account => account.accountKey === BRAVO.accountKey).pendingTaskId, bravoTask.id);
  assert.equal(f.calls.captures.length, 2);
});

test('refreshAll records one account failure without preventing another account from updating', async t => {
  const env = await environment(t);
  const seen = [];
  const f = harness(env, { github: { refresh: async args => {
    seen.push(args.accountKey);
    if (args.accountKey === ALPHA.accountKey) throw error('NETWORK_ERROR', 'results');
    return completeResult(BRAVO, args.repository, 992);
  } } });
  await f.controller.initialize();
  for (const record of [ALPHA, BRAVO]) f.controller.upsert({ ...completeResult(record, `${USER.login}/${SETTINGS.repoName}`, 911), email: record.email, deploymentStatus: 'deployed' });
  const result = await f.controller.action('refreshAll');
  assert.deepEqual(seen, [ALPHA.accountKey, BRAVO.accountKey]);
  const alpha = result.accounts.find(account => account.accountKey === ALPHA.accountKey);
  const bravo = result.accounts.find(account => account.accountKey === BRAVO.accountKey);
  assert.equal(alpha.runId, 911); assert.match(alpha.lastRefreshError, /NETWORK_ERROR/);
  assert.equal(bravo.runId, 992); assert.equal(bravo.conclusion, 'checkin_success');
  assert.equal(bravo.lastRefreshError, ''); assert.equal(result.busy, false);
});

test('restart restores an unverified deployed account and reopens bounded reads without login or redeployment', async t => {
  const env = await environment(t);
  let now = 0; let reads = 0;
  const unresolved = { ...run(), accountKey: ALPHA.accountKey, email: ALPHA.email, deploymentStatus: 'deployed',
    result: { status: 'unverified', readError: 'NETWORK_ERROR', accounts: [] } };
  const initial = harness(env, { now: () => now, github: { refresh: async () => { reads++; return unresolved; } } });
  await initial.controller.initialize();
  initial.controller.recordResult(unresolved);
  for (let i = 0; i < 7; i++) { now += 30000; await initial.controller.refreshPending(); }
  assert.equal(reads, 5);
  const stored = loadState(env.directory);
  assert.equal(stored.pendingDeployments.length, 0);
  assert.equal(stored.accounts[0].conclusion, 'unverified');
  assert.equal(stored.accounts[0].resultReadError, 'NETWORK_ERROR');
  assert.match(stored.accounts[0].message, /已暂停自动补读/);
  await initial.controller.shutdown();

  const requested = [];
  const restarted = harness(env, { now: () => now, github: { refresh: async args => {
    requested.push({ repository: args.repository, accountKey: args.accountKey, runId: args.runId });
    return { ...run(args.repository, args.runId), result: { status: 'checked', accounts: [{ accountKey: args.accountKey, outcome: 'checked', pointsAdded: 0, exchange: 'not_needed' }] } };
  } } });
  await restarted.controller.initialize();
  await restarted.controller.refreshPending(); assert.equal(requested.length, 0);
  now += 30000; await restarted.controller.refreshPending();
  assert.deepEqual(requested, [{ repository: unresolved.repository, accountKey: ALPHA.accountKey, runId: unresolved.runId }]);
  const state = restarted.controller.snapshot();
  assert.equal(state.resumeTasks.length, 0); assert.equal(state.accounts[0].conclusion, 'checkin_success');
  assert.equal(state.accounts[0].resultReadError, ''); assert.equal(state.accounts[0].lastRefreshError, '');
  assert.equal(state.currentRun.conclusion, 'checkin_success'); assert.equal(state.currentRun.pointsAdded, 0);
  assert.deepEqual(state.progress.completed, [0, 1, 2, 3]);
  assert.equal(restarted.calls.captures.length, 0); assert.equal(restarted.calls.deploys.length, 0); assert.equal(restarted.calls.logins.length, 0);
  assertNoSecrets(loadState(env.directory));
});

test('reloginAccount refuses a different GLaDOS identity before any credential upload', async t => {
  const env = await environment(t);
  const f = harness(env, { captureLogin: async () => ({ ...BRAVO }) });
  await f.controller.initialize();
  f.controller.upsert({ ...completeResult(ALPHA), email: ALPHA.email, deploymentStatus: 'deployed', settings: SETTINGS });
  const result = await f.controller.action('reloginAccount', { accountKey: ALPHA.accountKey, browserId: 'embedded' });
  assert.equal(result.errorInfo.code, 'ACCOUNT_MISMATCH'); assert.equal(f.calls.deploys.length, 0);
  assert.equal(result.accounts.length, 1); assert.equal(result.accounts[0].accountKey, ALPHA.accountKey);
  assert.equal(result.accounts[0].email, ALPHA.email); assert.equal(result.accounts[0].runId, 901);
  assert.equal([...f.controller.tasks.values()][0].expectedAccountKey, ALPHA.accountKey);
  assert.equal([...f.controller.tasks.values()][0].credential, undefined);
  assertNoSecrets(result);
});

test('missing cloud secret resets upload stages so a new login is actually submitted', async t => {
  const env = await environment(t);
  const saved = pending(ALPHA, { credential: undefined, checkpoint: checkpoint(ALPHA, { secretStored: true, configured: true, configSha: 'a'.repeat(40) }) });
  saveState(env.directory, { pendingDeployments: [saved], activeTaskId: saved.id });
  let attempts = 0;
  const fresh = { ...ALPHA, cookie: 'gld:sess=fresh-alpha-session; gld:sess.sig=fresh-alpha-signature' };
  const f = harness(env, { captureLogin: async () => fresh, deploy: async args => {
    if (++attempts === 1) throw error('STORED_CREDENTIAL_MISSING', 'secrets');
    assert.equal(args.checkpoint.secretStored, false);
    assert.equal(args.checkpoint.configured, false);
    assert.equal(args.credential.cookie, fresh.cookie);
    return completeResult(args.credential, args.checkpoint.repository);
  } });
  await f.controller.initialize();
  const failed = await f.controller.action('resumeDeploy', { taskId: saved.id });
  assert.equal(failed.errorInfo.code, 'STORED_CREDENTIAL_MISSING');
  assert.equal(failed.resumeTasks[0].needsLogin, true);
  const resumed = await f.controller.action('resumeDeploy', { taskId: saved.id });
  assert.equal(resumed.stage, 'complete'); assert.equal(f.calls.captures.length, 1);
  assert.equal(f.calls.deploys[1].checkpoint.secretStored, false);
  assert.equal(f.calls.deploys[1].checkpoint.configured, false);
  assert.equal(f.calls.deploys[1].credential.cookie, fresh.cookie);
});

test('completing one task keeps its progress separate and leaves the remaining task resumable', async t => {
  const env = await environment(t);
  let completedKey = ALPHA.accountKey;
  const first = pending(); const second = pending(BRAVO);
  saveState(env.directory, { pendingDeployments: [first, second], activeTaskId: first.id });
  const store = new ResumeStore({ directory: env.directory, safeStorage: env.safeStorage });
  await store.save([first, second]);
  const f = harness(env, { deploy: async args => {
    assert.equal(args.credential.accountKey, completedKey);
    return completeResult(args.credential);
  } });
  await f.controller.initialize();
  const result = await f.controller.action('resumeDeploy', { taskId: first.id });
  assert.equal(result.stage, 'complete'); assert.deepEqual(result.progress.completed, [0, 1, 2, 3]);
  assert.notEqual(result.activeTaskId, second.id);
  assert.equal(result.resumeTasks.length, 1); assert.equal(result.resumeTasks[0].id, second.id);
  completedKey = BRAVO.accountKey;
  const last = await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(last.stage, 'complete'); assert.equal(last.resumeTasks.length, 0);
  assert.equal(f.calls.deploys[1].credential.accountKey, BRAVO.accountKey);
  assert.equal(f.calls.captures.length, 0);
});

test('plaintext state persistence failure prevents deployment mutations', async t => {
  const env = await environment(t);
  const f = harness(env, { save: () => { throw error('STATE_WRITE_FAILED'); } });
  await f.controller.initialize();
  const result = await f.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS });
  assert.equal(result.stage, 'error'); assert.equal(result.busy, false);
  assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.deploys.length, 0);
});

test('a state checkpoint failure after Secret upload stops the subsequent configuration mutation', async t => {
  const env = await environment(t);
  const mutations = [];
  const f = harness(env, {
    save: state => {
      if (state.pendingDeployments.some(task => task.checkpoint?.secretStored)) throw error('STATE_WRITE_FAILED');
      saveState(env.directory, state);
    },
    deploy: async args => {
      mutations.push('secret-upload');
      await args.onCheckpoint(checkpoint(args.credential, { secretStored: true }));
      mutations.push('configuration-write');
      return completeResult(args.credential);
    },
  });
  await f.controller.initialize();
  const result = await f.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS });
  assert.equal(result.stage, 'error'); assert.deepEqual(mutations, ['secret-upload']);
  assert.equal(result.resumeTasks.length, 1);
  assert.equal(result.resumeTasks[0].needsLogin, false);
  assertNoSecrets(result); assertNoSecrets(f.calls.saved);
});

test('adding the same account twice merges into its original task and keeps frozen settings', async t => {
  const env = await environment(t);
  const fresh = { ...ALPHA, cookie: 'gld:sess=repeated-alpha-session; gld:sess.sig=repeated-alpha-signature' };
  const f = harness(env, {
    captureLogin: (_args, calls) => ({ ...(calls.captures.length === 1 ? ALPHA : fresh) }),
    deploy: async () => { throw error('NETWORK_ERROR'); },
  });
  await f.controller.initialize();
  await f.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS, newTask: true });
  const originalId = f.controller.state.resumeTasks[0].id;
  const result = await f.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS, time: '22:17', exchangePlan: 'off', newTask: true });
  assert.equal(result.errorInfo.code, 'NETWORK_ERROR');
  assert.equal(result.resumeTasks.length, 1); assert.equal(result.resumeTasks[0].id, originalId);
  assert.equal(f.controller.tasks.size, 1); assert.deepEqual(f.controller.tasks.get(originalId).settings, SETTINGS);
  assert.equal(f.calls.captures.length, 2); assert.equal(f.calls.deploys.length, 2);
  assert.equal(f.calls.deploys[1].credential.cookie, fresh.cookie);
  assert.equal(f.calls.deploys[1].repoName, SETTINGS.repoName);
  assert.equal(f.calls.deploys[1].time, SETTINGS.time); assert.equal(f.calls.deploys[1].exchangePlan, SETTINGS.exchangePlan);
  await f.controller.action('resumeDeploy', { taskId: originalId });
  assert.equal(f.calls.captures.length, 2);
  assert.equal(f.calls.deploys[2].credential.cookie, fresh.cookie);
  assertNoSecrets(f.calls.snapshots, [ALPHA, fresh]); assertNoSecrets(f.calls.saved, [ALPHA, fresh]);
});

test('adding an account preserves each existing cloud stage and queries unresolved dispatches first', async t => {
  for (const phase of ['secretStored', 'dispatch', 'run']) {
    await t.test(phase, async t => {
      const env = await environment(t);
      const cp = checkpoint(ALPHA, { secretStored: true, configured: phase !== 'secretStored' });
      if (phase === 'dispatch') cp.dispatch = { nonce: 'd'.repeat(32), accountKey: ALPHA.accountKey, branch: 'main', submittedAt: Date.now() };
      if (phase === 'run') cp.run = { ...run(undefined, 944), status: 'in_progress', conclusion: null };
      const existing = pending(ALPHA, { credential: undefined, checkpoint: cp, phase: phase === 'secretStored' ? 'deploying' : 'verifying' });
      await seedPending(env, [existing]);
      const f = harness(env, { deploy: async () => { throw error('NETWORK_ERROR'); } });
      await f.controller.initialize();
      const result = await f.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS, time: '21:55', exchangePlan: 'off', newTask: true });
      if (phase === 'dispatch') {
        // The repository guard runs before capture can identify a duplicate.
        // Preserve the anonymous new task until the original request is known.
        assert.equal(result.errorInfo.code, 'PRIOR_DISPATCH_PENDING');
        assert.equal(result.activeTaskId, existing.id); assert.equal(result.resumeTasks.length, 2);
        assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.deploys.length, 0);
        assert.deepEqual(f.controller.tasks.get(existing.id).checkpoint, cp);
        const resumed = await f.controller.action('resumeDeploy', { taskId: existing.id });
        assert.equal(resumed.errorInfo.code, 'NETWORK_ERROR');
        assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.deploys.length, 1);
      } else {
        assert.equal(result.errorInfo.code, 'NETWORK_ERROR');
        assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.deploys.length, 1);
        assert.equal(result.resumeTasks.length, 1); assert.equal(result.resumeTasks[0].id, existing.id);
      }
      assert.equal(f.calls.deploys[0].credential, undefined);
      assert.deepEqual(f.calls.deploys[0].checkpoint, cp);
      assert.equal(f.calls.deploys[0].time, SETTINGS.time);
      assert.equal(f.calls.deploys[0].exchangePlan, SETTINGS.exchangePlan);
      assert.equal(f.controller.tasks.get(existing.id).credential, undefined);
      assert.deepEqual(f.controller.tasks.get(existing.id).checkpoint, cp);
    });
  }
});

test('after restart an unresolved dispatch blocks another account before login or deployment mutations', async t => {
  const env = await environment(t);
  const cp = checkpoint(ALPHA, {
    secretStored: true, configured: true,
    dispatch: { nonce: 'e'.repeat(32), accountKey: ALPHA.accountKey, branch: 'main', submittedAt: Date.now() },
  });
  const original = pending(ALPHA, { credential: undefined, phase: 'verifying', checkpoint: cp });
  const waiting = pending(BRAVO, { credential: undefined });
  await seedPending(env, [original, waiting]);
  // This new client has no in-memory pending-dispatch map. Only the persisted
  // controller checkpoint can enforce ordering before any login or deploy call.
  const f = harness(env, {
    captureLogin: () => { throw new Error('B must wait before login'); },
    deploy: async args => {
      assert.equal(args.credential, undefined);
      assert.equal(args.checkpoint.accountKey, ALPHA.accountKey);
      assert.deepEqual(args.checkpoint.dispatch, cp.dispatch);
      throw error('DISPATCH_UNCERTAIN', 'verifying');
    },
  });
  await f.controller.initialize();
  const blocked = await f.controller.action('resumeDeploy', { taskId: waiting.id });
  assert.equal(blocked.errorInfo.code, 'PRIOR_DISPATCH_PENDING');
  assert.equal(blocked.activeTaskId, original.id); assert.equal(blocked.errorInfo.taskId, original.id);
  assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.deploys.length, 0);
  assert.equal(f.controller.tasks.size, 2);
  assert.deepEqual(f.controller.tasks.get(waiting.id).settings, waiting.settings);
  assert.deepEqual(f.controller.tasks.get(waiting.id).checkpoint, waiting.checkpoint);
  assert.deepEqual(f.controller.tasks.get(original.id).checkpoint, cp);
  const queried = await f.controller.action('resumeDeploy', { taskId: original.id });
  assert.equal(queried.errorInfo.code, 'DISPATCH_UNCERTAIN');
  assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.deploys.length, 1);
  assert.equal(f.controller.tasks.size, 2);
  assert.deepEqual(f.controller.tasks.get(original.id).checkpoint, cp);
  assertNoSecrets(f.calls.snapshots); assertNoSecrets(f.calls.saved);
});

test('the same account at a different repository or GitHub identity is explicitly blocked', async t => {
  for (const conflict of ['repository', 'github-login', 'github-id']) {
    await t.test(conflict, async t => {
      const env = await environment(t);
      const existing = pending();
      await seedPending(env, [existing]);
      const identity = conflict === 'github-login' ? { ...USER, login: 'different-owner', id: 2222 }
        : conflict === 'github-id' ? { ...USER, id: 2222 } : { ...USER };
      const f = harness(env, { github: { whoami: async () => ({ ...identity }) } });
      await f.controller.initialize();
      const result = await f.controller.action('startDeploy', {
        browserId: 'embedded', ...SETTINGS, repoName: conflict === 'repository' ? 'different-target' : SETTINGS.repoName, newTask: true,
      });
      assert.equal(result.errorInfo.code, 'ACCOUNT_ALREADY_PENDING');
      assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.deploys.length, 0);
      assert.equal(f.controller.tasks.size, 1); assert.equal(result.activeTaskId, existing.id);
      const remaining = f.controller.tasks.get(existing.id);
      assert.equal(remaining.githubLogin, USER.login); assert.equal(remaining.githubId, USER.id);
      assert.deepEqual(remaining.settings, SETTINGS); assert.deepEqual(remaining.checkpoint, existing.checkpoint);
      assert.equal(remaining.credential.cookie, ALPHA.cookie);
      assert.equal(result.resumeTasks[0].repository, existing.checkpoint.repository);
      assertNoSecrets(result);
    });
  }
});

test('relogin searches all historical pending tasks and prioritizes an unresolved dispatch or run', async t => {
  for (const phase of ['dispatch', 'run']) {
    await t.test(phase, async t => {
      const env = await environment(t);
      const ordinary = pending();
      const cp = checkpoint(ALPHA, { secretStored: true, configured: true });
      if (phase === 'dispatch') cp.dispatch = { nonce: 'f'.repeat(32), accountKey: ALPHA.accountKey, branch: 'main', submittedAt: Date.now() };
      else cp.run = { ...run(undefined, 955), status: 'queued', conclusion: null };
      const unresolved = pending(ALPHA, { id: 'd'.repeat(32), credential: undefined, phase: 'verifying', checkpoint: cp });
      await seedPending(env, [ordinary, unresolved], [{ ...completeResult(ALPHA), email: ALPHA.email, settings: SETTINGS, deploymentStatus: 'deployed' }]);
      const f = harness(env, { captureLogin: () => { throw new Error('Do not replace an unresolved cloud request'); }, deploy: async () => { throw error('NETWORK_ERROR'); } });
      await f.controller.initialize();
      const result = await f.controller.action('reloginAccount', { accountKey: ALPHA.accountKey, browserId: 'embedded' });
      assert.equal(result.errorInfo.code, 'DISPATCH_UNCERTAIN');
      assert.equal(result.activeTaskId, unresolved.id); assert.equal(result.errorInfo.taskId, unresolved.id);
      assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.deploys.length, 0);
      assert.equal(f.controller.tasks.size, 2); assert.deepEqual(f.controller.tasks.get(unresolved.id).checkpoint, cp);
      await f.controller.action('resumeDeploy', { taskId: unresolved.id });
      assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.deploys.length, 1);
      assert.equal(f.calls.deploys[0].credential, undefined); assert.deepEqual(f.calls.deploys[0].checkpoint, cp);
    });
  }
});

test('relogin with no unresolved cloud run consolidates all same-account histories into one update task', async t => {
  const env = await environment(t);
  const first = pending();
  const second = pending(ALPHA, { id: 'd'.repeat(32), credential: undefined, checkpoint: checkpoint(ALPHA, { secretStored: true, configured: true }) });
  const unrelated = pending(BRAVO);
  await seedPending(env, [first, second, unrelated], [{ ...completeResult(ALPHA), email: ALPHA.email, settings: SETTINGS, deploymentStatus: 'deployed' }]);
  const fresh = { ...ALPHA, cookie: 'gld:sess=consolidated-alpha-session; gld:sess.sig=consolidated-alpha-signature' };
  const f = harness(env, { captureLogin: () => fresh, deploy: async () => { throw error('NETWORK_ERROR'); } });
  await f.controller.initialize();
  const result = await f.controller.action('reloginAccount', { accountKey: ALPHA.accountKey, browserId: 'embedded' });
  assert.equal(result.errorInfo.code, 'NETWORK_ERROR');
  const related = [...f.controller.tasks.values()].filter(task => task.account?.accountKey === ALPHA.accountKey);
  assert.equal(related.length, 1); assert.equal(f.controller.tasks.size, 2);
  assert.notEqual(related[0].id, first.id); assert.notEqual(related[0].id, second.id);
  assert.equal(related[0].credential.cookie, fresh.cookie); assert.equal(related[0].expectedAccountKey, ALPHA.accountKey);
  assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.deploys.length, 1);
  assert.equal(f.calls.deploys[0].checkpoint.secretStored, false); assert.equal(f.calls.deploys[0].checkpoint.configured, false);
  assert.equal(f.calls.deploys[0].checkpoint.repository, first.checkpoint.repository);
  assert.equal(f.controller.tasks.get(unrelated.id).credential.cookie, BRAVO.cookie);
  assert.deepEqual(f.controller.tasks.get(unrelated.id).checkpoint, unrelated.checkpoint);
  assertNoSecrets(f.calls.snapshots, [ALPHA, BRAVO, fresh]);
});

test('changed configured files offer an explicit redeploy action instead of an ineffective plain resume', async t => {
  const env = await environment(t);
  const f = harness(env, { deploy: async args => {
    await args.onCheckpoint(checkpoint(args.credential, { secretStored: true, configured: true }));
    throw error('CONFIGURATION_CHANGED', 'configuration');
  } });
  await f.controller.initialize();
  const result = await f.controller.action('startDeploy', { browserId: 'embedded', ...SETTINGS });
  assert.equal(result.errorInfo.code, 'CONFIGURATION_CHANGED');
  assert.equal(result.errorInfo.action, 'reloginAccount');
  assert.equal(result.errorInfo.accountKey, ALPHA.accountKey);
  assert.equal(result.errorInfo.actionLabel, '更新登录并重新部署');
  assert.equal(result.resumeTasks[0].actionLabel, '重新核对远端配置');
  assert.deepEqual(result.resumeTasks[0].settings, SETTINGS);
});
