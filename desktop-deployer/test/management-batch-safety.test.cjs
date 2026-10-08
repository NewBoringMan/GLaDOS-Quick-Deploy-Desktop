'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ManagementController } = require('../src/management-controller.cjs');
const { ManagementClient } = require('../src/management-client.cjs');
const { normalizeManifest } = require('../src/schedule-config.cjs');
const { GitHubError } = require('../src/github.cjs');
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

test('a failed batch retains only safe diagnostic fields and preserves the healthy repository result', async () => {
  const f = controllerFixture(); const persisted = [];
  f.github.saveManagement = function () { persisted.push(copy(this.managed)); this.onManagement?.(); };
  const error = new GitHubError('GITHUB_UNAVAILABLE', 'GitHub 暂时无法处理请求。', 'dispatch', {
    httpStatus: 503, exitCode: 1, reason: 'service_unavailable', method: 'POST', endpointKind: 'actions-dispatch',
  });
  Object.assign(error, { raw: 'diagnostic-private-raw', body: 'diagnostic-private-body', url: 'https://private.example.invalid/secret' });
  f.github.runOperation = async repository => { if (repository === REPOS[0]) throw error; return { status: 'completed', conclusion: 'success' }; };
  await f.controller.action('manage.checkinAll');
  const result = f.github.managed.batch.results[REPOS[0]];
  assert.deepEqual(result.diagnostic, { code: 'GITHUB_UNAVAILABLE', stage: 'dispatch', httpStatus: 503, exitCode: 1, reason: 'service_unavailable', method: 'POST', endpointKind: 'actions-dispatch' });
  assert.equal(f.github.managed.batch.results[REPOS[1]].conclusion, 'success');
  assert.ok(persisted.some(state => state.batch?.results[REPOS[0]]?.diagnostic?.httpStatus === 503));
  assert.doesNotMatch(JSON.stringify(persisted), /diagnostic-private|private\.example/);
  const restored = controllerFixture({ restoredBatch: f.github.managed.batch });
  assert.deepEqual(restored.github.managed.batch.results[REPOS[0]].diagnostic, result.diagnostic);
});

test('partial upgrade success is retained as unfinished maintenance, not counted as a completed repository', async () => {
  const f = controllerFixture(); const commitSha = 'c'.repeat(40);
  f.github.managed.repositories[REPOS[0]].upgradeVerifiedAt = '2026-10-01T00:00:00Z';
  f.github.upgrade = async repository => {
    if (repository === REPOS[0]) {
      const error = new GitHubError('GITHUB_UNAVAILABLE', '配置已一致，后续核验待完成。', 'upgrade-retention', { httpStatus: 503, exitCode: 1, reason: 'service_unavailable', method: 'GET', endpointKind: 'actions-retention' });
      error.upgradeProgress = { stage: 'retention', configurationVerified: true, maintenanceVerified: false, commitSha, raw: 'private-upgrade-detail' };
      throw error;
    }
    return { config: { accounts: [{ accountKey: A }] }, changed: false, upgradeProgress: { stage: 'completed', configurationVerified: true, maintenanceVerified: true, commitSha } };
  };
  await f.controller.action('manage.upgradeAll');
  const summary = f.github.managed.upgrade;
  assert.equal(summary.completed.length, 1); assert.equal(summary.completed[0].repository, REPOS[1]);
  assert.equal(summary.failed.length, 1); assert.equal(summary.failed[0].repository, REPOS[0]);
  assert.deepEqual(summary.failed[0].upgradeProgress, { stage: 'retention', configurationVerified: true, maintenanceVerified: false, commitSha });
  assert.equal(summary.failed[0].diagnostic.stage, 'upgrade-retention');
  assert.equal(summary.failed[0].diagnostic.httpStatus, 503);
  assert.doesNotMatch(JSON.stringify(summary), /private-upgrade-detail/);
});

test('preflight failures are retained without creating a batch and a later successful same action resolves the record', async () => {
  const f = controllerFixture(); let loginCalls = 0;
  f.github.login = async () => { loginCalls++; throw new Error('must not authorize for an unclassified failure'); };
  f.github.whoami = async () => { throw new GitHubError('GITHUB_COMMAND_FAILED', 'GitHub 命令未完成，原因尚未确定。', 'identity', { exitCode: 1, reason: 'cli_failed' }); };
  const state = await f.controller.action('manage.statusAll');
  assert.equal(state.errorInfo.code, 'GITHUB_COMMAND_FAILED'); assert.equal(loginCalls, 0);
  assert.equal(f.github.managed.batch, undefined); assert.deepEqual(f.calls, []);
  assert.equal(f.github.managed.lastFailure.action, 'manage.statusAll');
  assert.deepEqual(f.github.managed.lastFailure.diagnostic, { code: 'GITHUB_COMMAND_FAILED', stage: 'identity', exitCode: 1, reason: 'cli_failed' });
  f.github.whoami = async () => ({ login: 'owner', workflowScope: true });
  await f.controller.action('manage.statusAll');
  assert.equal(f.github.managed.lastFailure.resolvedAt, new Date(NOW).toISOString());
  assert.equal(f.github.managed.batch.status, 'completed'); assert.equal(loginCalls, 0);
});

test('failure diagnostic persistence cannot replace the original GitHub error when local storage fails', async () => {
  const f = controllerFixture();
  f.github.whoami = async () => { throw new GitHubError('NETWORK_ERROR', '连接中断。', 'identity', { reason: 'network_eof' }); };
  f.github.saveManagement = () => { throw new Error('local diagnostic storage unavailable'); };
  const state = await f.controller.action('manage.checkinAll');
  assert.equal(state.errorInfo.code, 'NETWORK_ERROR');
  assert.match(state.storageWarning, /失败诊断暂未保存/);
  assert.equal(state.management.lastFailure.diagnostic.reason, 'network_eof');
});

test('completed and uncertain readback errors stay pending while independent repositories continue', async () => {
  for (const progress of [
    { submission: 'accepted', stage: 'receipts', runId: 91, runStatus: 'completed', runConclusion: 'success', resultVerified: false, detailsVerified: false },
    { submission: 'uncertain', stage: 'dispatch', resultVerified: false, detailsVerified: false },
  ]) {
    const f = controllerFixture(); const error = new GitHubError('NETWORK_ERROR', '读回暂未完成。', 'results', { reason: 'network_eof', exitCode: 1 });
    error.operationProgress = { ...progress, raw: 'must-not-persist' };
    f.github.runOperation = async repository => { f.calls.push(repository); if (repository === REPOS[0]) throw error; return { status: 'completed', conclusion: 'success' }; };
    const state = await f.controller.action('manage.checkinAll');
    assert.deepEqual(f.calls, REPOS); assert.equal(state.error, '');
    assert.equal(f.github.managed.batch.status, 'completed');
    const result = f.github.managed.batch.results[REPOS[0]];
    assert.equal(result.observationPending, true); assert.equal(result.error, undefined);
    assert.deepEqual(result.operationProgress, progress); assert.doesNotMatch(JSON.stringify(result), /must-not-persist/);
    assert.equal(result.diagnostic.reason, 'network_eof');
    assert.equal(f.github.managed.batch.results[REPOS[1]].conclusion, 'success');
  }
});

test('accepted active readback errors retain serial waiting until that cloud run finishes', async () => {
  const f = controllerFixture(); let first = true;
  const error = new GitHubError('NETWORK_ERROR', '运行读取中断。', 'results', { reason: 'network_transport' });
  error.operationProgress = { submission: 'accepted', stage: 'run', runId: 92, runStatus: 'in_progress', resultVerified: false, detailsVerified: false };
  f.github.runOperation = async repository => { f.calls.push(repository); if (first) { first = false; throw error; } return { status: 'completed', conclusion: 'success' }; };
  await f.controller.action('manage.checkinAll');
  assert.deepEqual(f.calls, [REPOS[0]]); assert.equal(f.github.managed.batch.status, 'waiting'); assert.equal(f.github.managed.batch.index, 0);
  assert.equal(f.github.managed.batch.results[REPOS[0]].error, undefined);
  await f.controller.action('manage.resumeBatch');
  assert.deepEqual(f.calls, [REPOS[0], REPOS[0], REPOS[1]]); assert.equal(f.github.managed.batch.status, 'completed');
});

test('completed cloud results awaiting receipts do not block the rest of a batch', async () => {
  const f = controllerFixture();
  f.github.runOperation = async repository => { f.calls.push(repository); return { status: 'completed', conclusion: 'success', observationPending: repository === REPOS[0], operationProgress: { submission: 'accepted', stage: 'receipts', runStatus: 'completed', resultVerified: repository !== REPOS[0], detailsVerified: repository !== REPOS[0] } }; };
  await f.controller.action('manage.statusAll');
  assert.deepEqual(f.calls, REPOS); assert.equal(f.github.managed.batch.status, 'completed');
  assert.equal(f.github.managed.batch.results[REPOS[0]].observationPending, true);
});

test('single-account and cleanup readback failures show awaiting_result without a business failure', async () => {
  for (const name of ['manage.checkin', 'manage.status', 'manage.cleanup']) {
    const f = controllerFixture(); f.github.managed.accounts[REPOS[0] + '/' + A] = { repository: REPOS[0], accountKey: A };
    const error = new GitHubError('NETWORK_ERROR', '账号报告待读取。', 'results', { reason: 'network_eof', httpStatus: 503 });
    error.operationProgress = { submission: 'accepted', stage: 'receipts', runId: 93, runStatus: 'completed', runConclusion: 'success', resultVerified: false, detailsVerified: false };
    f.github.runOperation = async () => { throw error; };
    const state = await f.controller.action(name, { repository: REPOS[0], accountKey: A });
    assert.equal(state.stage, 'awaiting_result'); assert.equal(state.error, ''); assert.equal(state.errorInfo, null);
    assert.equal(f.github.managed.lastFailure, undefined); assert.equal(f.github.managed.lastPending.operationProgress.runId, 93);
    assert.equal(f.github.managed.lastPending.diagnostic.httpStatus, 503);
    assert.match(state.feedback[name === 'manage.cleanup' ? 'maintenance' : 'management'].message, /结果待确认/);
  }
});

test('read-only refresh keeps incomplete observations pending and resolves only matching completed operations', async () => {
  const f = controllerFixture();
  const progress = { submission: 'accepted', stage: 'receipts', runId: 94, runStatus: 'completed', resultVerified: false, detailsVerified: false };
  f.github.managed.batch = { ...batch(), status: 'completed', index: 2, autoResume: false, results: { [REPOS[0]]: { observationPending: true, operationProgress: progress } } };
  f.github.managed.operations[REPOS[0] + ':' + WORKFLOW] = { repository: REPOS[0], workflow: WORKFLOW, requestId: f.github.managed.batch.requestId, runId: 94, status: 'completed', observationPending: true, operationProgress: progress };
  f.github.refreshRepository = async () => ({ observationPending: true });
  let state = await f.controller.action('manage.refresh');
  assert.match(state.message, /尚未同步/); assert.equal(f.github.managed.batch.results[REPOS[0]].observationPending, true);
  f.github.refreshRepository = async () => {
    const saved = f.github.managed.operations[REPOS[0] + ':' + WORKFLOW]; saved.observationPending = false; saved.conclusion = 'success'; saved.operationProgress.resultVerified = true;
    return { observationPending: false };
  };
  state = await f.controller.action('manage.refresh');
  assert.equal(f.github.managed.batch.results[REPOS[0]].observationPending, false);
  assert.equal(f.github.managed.batch.results[REPOS[0]].conclusion, 'success');
  assert.deepEqual(f.calls, [], 'Refreshing a pending observation must not dispatch');
});

test('real management actions and background events preserve feedback in other pages', async () => {
  const f = controllerFixture();
  Object.assign(f.controller.state, { stage: 'awaiting_result', message: 'deployment result pending', currentRun: { runId: 111 }, error: '', progress: { completed: [0,1,2], current: 3 } });
  f.controller.changed(); const deployment = copy(f.controller.state.feedback.deployment);
  await f.controller.action('manage.statusAll');
  assert.equal(f.controller.state.actionScope, 'management'); assert.deepEqual(f.controller.state.feedback.deployment, deployment);
  f.controller.state.actionScope = 'maintenance'; f.controller.state.stage = 'error'; f.controller.state.message = 'maintenance failure'; f.controller.changed();
  const maintenance = copy(f.controller.state.feedback.maintenance);
  f.github.managed.batch = batch(); await f.controller.action('manage.stopBatch');
  assert.match(f.controller.state.feedback.management.message, /本机批次已停止/); assert.deepEqual(f.controller.state.feedback.maintenance, maintenance);
  f.controller.managementAbort = new AbortController();
  f.controller.onGitHubEvent({ type: 'progress', stage: 'verifying', message: 'background account readback' });
  assert.equal(f.controller.state.feedback.management.message, 'background account readback');
  assert.deepEqual(f.controller.state.feedback.maintenance, maintenance); assert.deepEqual(f.controller.state.feedback.deployment, deployment);
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
    if (saved?.runId === run.id) { saved.status = 'completed'; saved.observationPending = false; client.saveManagement(); }
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
