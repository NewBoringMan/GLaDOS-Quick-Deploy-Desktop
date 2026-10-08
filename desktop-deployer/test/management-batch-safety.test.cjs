'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ManagementController } = require('../src/management-controller.cjs');
const { ManagementClient } = require('../src/management-client.cjs');
const { normalizeManifest } = require('../src/schedule-config.cjs');
const REPOS = ['owner/first', 'owner/second'];
const A = 'A'.repeat(16);
const WORKFLOW = 'glados-quick-deploy.yml';
const NOW = Date.parse('2026-10-08T09:00:00Z');
const copy = value => JSON.parse(JSON.stringify(value));
const failure = code => Object.assign(new Error(code), { code });
function batch(operation = 'checkin') {
  return { requestId: 'a'.repeat(32), operation, repositories: REPOS, index: 0, status: 'waiting', autoResume: true, results: {}, createdAt: new Date(NOW).toISOString() };
}
function controllerFixture({ restoredBatch } = {}) {
  const calls = [];
  const github = {
    managed: { version: 1, repositories: Object.fromEntries(REPOS.map(repository => [repository, { repository }])), accounts: {}, operations: {}, history: [], ...(restoredBatch ? { batch: copy(restoredBatch) } : {}) },
    snapshotManagement() { return copy(this.managed); },
    saveManagement() { this.onManagement?.(); },
    whoami: async () => ({ login: 'owner', workflowScope: true }),
    refreshRepository: async repository => { calls.push(['read', repository]); },
    runOperation: async (repository, operation, options) => { calls.push([operation, repository, options.requestId]); return { status: 'completed', conclusion: 'success' }; },
  };
  const controller = new ManagementController({ github, now: () => NOW, save() {}, openExternal: async () => {} });
  return { controller, github, calls };
}

test('information query never resumes a pending check-in batch, or vice versa', async () => {
  for (const [existing, action] of [['checkin', 'manage.statusAll'], ['status', 'manage.checkinAll']]) {
    const f = controllerFixture(); f.github.managed.batch = batch(existing);
    const state = await f.controller.action(action);
    assert.equal(state.errorInfo.code, 'BATCH_OPERATION_MISMATCH');
    assert.deepEqual(f.calls, [], 'A mismatched button must not submit or resume the other operation');
    assert.equal(f.github.managed.batch.operation, existing);
    assert.equal(f.github.managed.batch.index, 0);
    assert.equal(f.github.managed.batch.status, 'paused');
    await f.controller.refreshPending();
    assert.ok(f.calls.every(x => x[0] === 'read'), 'The mismatched action must not leave a hidden background submission');
  }
});

test('one failed repository does not starve healthy repositories and calls remain serial', async () => {
  for (const code of ['PERMISSION_DENIED', 'NETWORK_ERROR', 'DISPATCH_UNCERTAIN']) {
    const f = controllerFixture(); let active = 0; let maxActive = 0;
    f.github.runOperation = async (repository, operation) => {
      active++; maxActive = Math.max(maxActive, active); f.calls.push([repository, operation]);
      try { await Promise.resolve(); if (repository === REPOS[0]) throw failure(code); return { status: 'completed', conclusion: 'success' }; }
      finally { active--; }
    };
    await f.controller.action('manage.checkinAll');
    assert.deepEqual(f.calls, REPOS.map(repository => [repository, 'checkin']));
    assert.equal(maxActive, 1);
    assert.equal(f.github.managed.batch.status, 'completed');
    assert.equal(f.github.managed.batch.results[REPOS[0]].code, code);
    assert.equal(f.github.managed.batch.results[REPOS[1]].conclusion, 'success');
  }
});

test('a known queued cloud run is awaited before submitting the next repository', async () => {
  const f = controllerFixture(); let first = true;
  f.github.runOperation = async (repository, operation, options) => {
    f.calls.push([repository, operation, options.requestId]);
    if (first) { first = false; return { id: 77, status: 'queued' }; }
    return { id: 77, status: 'completed', conclusion: 'success' };
  };
  await f.controller.action('manage.checkinAll');
  assert.equal(f.calls.length, 1); assert.equal(f.github.managed.batch.status, 'waiting');
  const requestId = f.github.managed.batch.requestId;
  await f.controller.action('manage.resumeBatch');
  assert.deepEqual(f.calls.map(x => x[0]), [REPOS[0], REPOS[0], REPOS[1]]);
  assert.ok(f.calls.every(x => x[2] === requestId));
  assert.equal(f.github.managed.batch.status, 'completed');
});

test('cancel during a batch retains progress and background refresh never submits remaining repositories', async () => {
  const f = controllerFixture(); let started;
  const start = new Promise(resolve => { started = resolve; });
  f.github.runOperation = (repository, operation, { signal }) => {
    f.calls.push([operation, repository]); started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(failure('ABORTED')), { once: true }));
  };
  const running = f.controller.action('manage.checkinAll'); await start;
  await f.controller.action('cancel'); await running;
  assert.equal(f.github.managed.batch.status, 'paused');
  assert.equal(f.github.managed.batch.autoResume, false);
  assert.equal(f.github.managed.batch.index, 0);
  await f.controller.refreshPending();
  assert.equal(f.calls.filter(x => x[0] === 'checkin').length, 1);
  assert.equal(f.calls.filter(x => x[0] === 'read').length, 2);
});

test('a late response after stopping cannot re-enable or advance the paused batch', async () => {
  const f = controllerFixture(); let release; let started;
  const start = new Promise(resolve => { started = resolve; });
  f.github.runOperation = (repository, operation) => {
    f.calls.push([operation, repository]); started(); return new Promise(resolve => { release = resolve; });
  };
  const running = f.controller.action('manage.checkinAll'); await start;
  await f.controller.action('manage.stopBatch');
  release({ id: 77, status: 'completed', conclusion: 'success' }); await running;
  assert.equal(f.github.managed.batch.status, 'paused');
  assert.equal(f.github.managed.batch.index, 0);
  assert.equal(f.github.managed.batch.results[REPOS[0]].id, 77);
  assert.equal(f.calls.length, 1);
});

test('restart and shutdown retain an unfinished batch without background submission', async () => {
  const f = controllerFixture({ restoredBatch: batch() });
  assert.equal(f.github.managed.batch.status, 'paused');
  assert.equal(f.github.managed.batch.requestId, 'a'.repeat(32));
  await f.controller.refreshPending(); assert.ok(f.calls.every(x => x[0] === 'read'));
  f.github.managed.batch.status = 'waiting'; f.github.managed.batch.autoResume = true;
  await f.controller.shutdown();
  assert.equal(f.github.managed.batch.status, 'paused');
  assert.equal(f.github.managed.batch.autoResume, false);
});

test('ending a batch permits a new explicit operation without clearing uncertain requests', async () => {
  const f = controllerFixture(); f.github.managed.batch = batch();
  const uncertain = { nonce: 'b'.repeat(32), status: 'submitting', operation: 'checkin' };
  f.github.managed.operations[REPOS[0] + ':' + WORKFLOW] = uncertain;
  await f.controller.action('manage.endBatch');
  assert.equal(f.github.managed.batch.status, 'ended'); assert.deepEqual(f.calls, []);
  await f.controller.action('manage.statusAll');
  assert.ok(f.calls.every(x => x[0] === 'status'));
  assert.equal(f.github.managed.operations[REPOS[0] + ':' + WORKFLOW], uncertain);
});

function clientFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gqd-management-safety-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = NOW; const posts = [];
  const client = new ManagementClient({ directory, ghPath: '/never-executed-gh', reportVault: {}, now: () => now });
  const config = normalizeManifest({ schemaVersion: 1, accounts: [{ accountKey: A }], time: '12:30', exchangePlan: 'plan500' });
  client.inspect = async () => ({ schemaVersion: 2, actionsEnabled: true, branch: 'main', config });
  client.pages = async () => [];
  client._api = async (endpoint, options = {}) => {
    assert.equal(options.method, 'POST', 'No unmocked CLI/API calls are allowed');
    posts.push({ endpoint, body: options.body }); return { workflow_run_id: 88 };
  };
  client.waitOperation = async (_repository, run) => {
    const saved = client.managed.operations[REPOS[0] + ':' + WORKFLOW];
    if (saved?.runId === run.id) { saved.status = 'completed'; client.saveManagement(); }
    return { id: run.id, status: 'completed', conclusion: 'success' };
  };
  return { client, posts, advanceDay: () => { now += 86400000; } };
}
function uncertainOperation() {
  return { repository: REPOS[0], workflow: WORKFLOW, nonce: 'b'.repeat(32), requestId: 'a'.repeat(32), operation: 'checkin', accountKey: '', submittedAt: new Date(NOW).toISOString(), status: 'submitting' };
}

test('an invalid dispatch response preserves the nonce and cannot cause another POST', async t => {
  const f = clientFixture(t); let posts = 0;
  f.client._api = async (_endpoint, options) => { assert.equal(options.method, 'POST'); posts++; throw failure('INVALID_RESPONSE'); };
  await assert.rejects(f.client.runOperation(REPOS[0], 'checkin'), { code: 'INVALID_RESPONSE' });
  const nonce = f.client.managed.operations[REPOS[0] + ':' + WORKFLOW].nonce;
  await assert.rejects(f.client.runOperation(REPOS[0], 'checkin'), { code: 'DISPATCH_UNCERTAIN' });
  assert.equal(posts, 1); assert.equal(f.client.managed.operations[REPOS[0] + ':' + WORKFLOW].nonce, nonce);
});

test('a definite rejected dispatch remains safely retryable after permission repair', async t => {
  const f = clientFixture(t); const api = f.client._api;
  f.client._api = async () => { throw failure('PERMISSION_DENIED'); };
  await assert.rejects(f.client.runOperation(REPOS[0], 'checkin'), { code: 'PERMISSION_DENIED' });
  assert.equal(f.client.managed.operations[REPOS[0] + ':' + WORKFLOW], undefined);
  f.client._api = api; await f.client.runOperation(REPOS[0], 'checkin'); assert.equal(f.posts.length, 1);
});

test('ending an unknown request is read-only and the same-day guard survives a new status request', async t => {
  const f = clientFixture(t); const saved = uncertainOperation();
  f.client.managed.operations[REPOS[0] + ':' + WORKFLOW] = saved;
  const result = await f.client.endOperation(REPOS[0], { workflow: WORKFLOW, expectedNonce: saved.nonce });
  assert.equal(result.checkinBlocked, true); assert.equal(saved.status, 'ended'); assert.equal(f.posts.length, 0);
  await assert.rejects(f.client.runOperation(REPOS[0], 'checkin'), { code: 'CHECKIN_UNVERIFIED' });
  await f.client.runOperation(REPOS[0], 'status');
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].body.inputs.operation, 'status');
  await assert.rejects(f.client.runOperation(REPOS[0], 'checkin'), { code: 'CHECKIN_UNVERIFIED' });
  assert.equal(f.posts.length, 1);
  f.advanceDay(); await f.client.runOperation(REPOS[0], 'checkin');
  assert.equal(f.posts.length, 2); assert.equal(f.posts[1].body.inputs.operation, 'checkin');
});

test('ending tracking refuses any active cloud run and a stale request selector', async t => {
  const f = clientFixture(t); const saved = uncertainOperation();
  f.client.managed.operations[REPOS[0] + ':' + WORKFLOW] = saved;
  await assert.rejects(f.client.endOperation(REPOS[0], { workflow: WORKFLOW, expectedNonce: 'c'.repeat(32) }), { code: 'OPERATION_CHANGED' });
  f.client.pages = async () => [{ id: 77, status: 'in_progress' }];
  await assert.rejects(f.client.endOperation(REPOS[0], { workflow: WORKFLOW, expectedNonce: saved.nonce }), { code: 'CLOUD_BUSY' });
  assert.equal(saved.status, 'submitting'); assert.equal(f.posts.length, 0);
});

test('ending tracking resolves a found completed request instead of marking its result unknown', async t => {
  const f = clientFixture(t); const saved = uncertainOperation();
  f.client.managed.operations[REPOS[0] + ':' + WORKFLOW] = saved;
  f.client.pages = async () => [{ id: 77, status: 'completed', head_branch: 'main', event: 'workflow_dispatch', display_title: saved.nonce }];
  const reads = []; f.client.readOperation = async (repository, id) => { reads.push([repository, id]); };
  const result = await f.client.endOperation(REPOS[0], { workflow: WORKFLOW, expectedNonce: saved.nonce });
  assert.deepEqual(reads, [[REPOS[0], 77]]); assert.equal(saved.status, 'completed');
  assert.equal(result.checkinBlocked, false); assert.equal(f.posts.length, 0);
});
