'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ManagementClient, recordKey } = require('../src/management-client.cjs');
const { GitHubError, WORKFLOW_FILE, WORKFLOW_PATH } = require('../src/github.cjs');
const { normalizeManifest } = require('../src/schedule-config.cjs');
const REPOSITORY = 'tester/managed'; const A = 'A'.repeat(16); const B = 'B'.repeat(16);
const NOW = Date.parse('2026-10-08T13:00:00Z'); const scope = REPOSITORY + ':' + WORKFLOW_FILE;
const copy = x => JSON.parse(JSON.stringify(x));
const network = kind => new GitHubError('NETWORK_ERROR', 'Simulated read failure', 'results', { method: 'GET', endpointKind: kind, reason: 'network_transport', exitCode: 1 });

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gqd-observation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = NOW; const calls = []; const runs = new Map(); const vaultCache = new Map();
  const controls = { jobsFail: false, reportFail: false, detailsFail: false, hideReceipts: false, runReads: 0, denyExtraRead: false, rejectDispatch: false, loseDispatch: false };
  const config = normalizeManifest({ schemaVersion: 1, time: '12:30', exchangePlan: 'plan500', accounts: [{ accountKey: A }, { accountKey: B }] });
  const client = new ManagementClient({ directory, ghPath: '/never-executed-gh', now: () => now, waitTimeoutMs: options.waitTimeoutMs ?? 10,
    sleepImpl: async ms => { now += ms; }, spawnImpl: () => { throw new Error('No external processes'); },
    reportVault: { cache: vaultCache, decrypt: async (_report, context) => {
      if (controls.detailsFail) throw new GitHubError('NETWORK_ERROR', 'Simulated private detail read failure', 'report');
      vaultCache.set('test-key', true);
      return { ...context, points: 321, leftDays: 30, statusFresh: true, observedAt: new Date(NOW).toISOString(), businessDate: '2026-10-08' };
    } },
  });
  client.managed.repositories[REPOSITORY] = { repository: REPOSITORY, branch: 'main', config, actionsEnabled: true };
  for (const key of [A, B]) client.managed.accounts[recordKey(REPOSITORY, key)] = { repository: REPOSITORY, accountKey: key, settings: config.accounts.find(a => a.accountKey === key) };
  client.inspect = async () => ({ ...client.managed.repositories[REPOSITORY], schemaVersion: 2, runs: [...runs.values()].reverse() });
  function addRun(id, keys = [A], operation = 'checkin', nonce = 'a'.repeat(32)) {
    const run = { id, path: WORKFLOW_PATH, head_branch: 'main', event: 'workflow_dispatch', status: options.runStatus || 'completed',
      conclusion: options.runStatus ? null : 'success', run_attempt: 1, display_title: nonce, created_at: new Date(NOW).toISOString(), operation, keys };
    runs.set(id, run); return run;
  }
  client._api = async (endpoint, opts = {}) => {
    const method = opts.method || 'GET'; calls.push({ endpoint, method });
    if (endpoint.endsWith('/dispatches')) {
      if (controls.rejectDispatch) throw new GitHubError('BAD_REQUEST', 'Rejected dispatch', 'dispatch', { httpStatus: 400, method: 'POST', endpointKind: 'actions-dispatch' });
      addRun(100, opts.body.inputs.account_key ? [opts.body.inputs.account_key] : [A, B], opts.body.inputs.operation, opts.body.inputs.deployment_id);
      if (controls.loseDispatch) throw new GitHubError('NETWORK_ERROR', 'Lost response', 'dispatch', { method: 'POST', endpointKind: 'actions-dispatch' });
      return { workflow_run_id: 100 };
    }
    if (endpoint.includes('/workflows/') && endpoint.includes('/runs?')) return { workflow_runs: [...runs.values()].reverse().map(copy) };
    const match = endpoint.match(/\/actions\/runs\/(\d+)(?:\/(jobs|artifacts)\?)?/); assert.ok(match, 'Unexpected observation endpoint');
    const run = runs.get(Number(match[1])); assert.ok(run);
    if (!match[2]) {
      controls.runReads++;
      if (controls.denyExtraRead && controls.runReads > 1) throw network('actions-run');
      return copy(run);
    }
    if (match[2] === 'jobs') {
      if (controls.jobsFail) throw network('actions-jobs');
      return { jobs: run.keys.map((key, index) => ({ id: run.id * 100 + index, name: 'Account ' + key, status: run.status, conclusion: run.conclusion })) };
    }
    return { artifacts: controls.hideReceipts ? [] : run.keys.map((key, index) => ({ id: run.id * 100 + index, name: `gqd-result-${key}-${run.id}-1`,
      expired: false, size_in_bytes: 1000, created_at: new Date(NOW).toISOString() })) };
  };
  client.downloadReport = async (_repository, runId, name) => {
    if (controls.reportFail) throw network('actions-artifacts');
    const run = runs.get(runId); const key = name.split('-')[2];
    return { receipt: { schemaVersion: 2, phase: 'final', repository: REPOSITORY, runId, accountKey: key, observedAt: new Date(NOW).toISOString(),
      businessDate: '2026-10-08', operation: run.operation, outcome: run.operation === 'status' ? 'status_only' : 'checked',
      checkinConfirmed: run.operation === 'checkin', ...(run.operation === 'checkin' ? { checkinBusinessDate: '2026-10-08', checkinConfirmedAt: new Date(NOW).toISOString() } : {}) },
    report: { keyId: 'test-key' } };
  };
  return { client, controls, calls, runs, addRun, writes: () => calls.filter(x => x.method !== 'GET') };
}

test('a completed receipt is used directly and no redundant status GET can turn success into an error', async t => {
  const f = fixture(t); f.controls.denyExtraRead = true;
  const result = await f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A });
  assert.equal(result.status, 'completed'); assert.equal(result.conclusion, 'success'); assert.equal(result.observationPending, false);
  assert.equal(result.operationProgress.resultVerified, true); assert.equal(result.operationProgress.detailsVerified, true);
  assert.equal(f.controls.runReads, 1); assert.equal(f.writes().length, 1);
});

test('confirmed workflow completion is saved before a jobs read fails, then the same nonce resumes through GET', async t => {
  const f = fixture(t); f.controls.jobsFail = true;
  await assert.rejects(f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A }), error => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.deepEqual(error.operationProgress, { submission: 'accepted', stage: 'receipts', runId: 100, runStatus: 'completed', runConclusion: 'success', resultVerified: false, detailsVerified: false }); return true;
  });
  const saved = f.client.managed.operations[scope]; const nonce = saved.nonce;
  assert.equal(saved.status, 'completed'); assert.equal(saved.conclusion, 'success'); assert.equal(saved.observationPending, true);
  assert.equal(f.client.managed.accounts[recordKey(REPOSITORY, A)].latestRun.conclusion, 'success');
  assert.equal(f.client.managed.accounts[recordKey(REPOSITORY, A)].result, undefined, 'A successful workflow alone is not an account receipt');
  f.controls.jobsFail = false;
  const result = await f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A });
  assert.equal(result.observationPending, false); assert.equal(saved.nonce, nonce); assert.equal(saved.readback.pending, false);
  assert.equal(f.writes().length, 1, 'Readback recovery must not dispatch a second check-in');
});

test('a dropped dispatch response remains uncertain and recovery finds the original nonce without another POST', async t => {
  const f = fixture(t); f.controls.loseDispatch = true;
  await assert.rejects(f.client.runOperation(REPOSITORY, 'status', { accountKey: A }), error => {
    assert.equal(error.operationProgress.submission, 'uncertain'); assert.equal(error.operationProgress.stage, 'dispatch'); return true;
  });
  const nonce = f.client.managed.operations[scope].nonce; f.controls.loseDispatch = false;
  const result = await f.client.runOperation(REPOSITORY, 'status', { accountKey: A });
  assert.equal(result.operationProgress.submission, 'accepted'); assert.equal(result.observationPending, false, JSON.stringify(result));
  assert.equal(f.client.managed.operations[scope].nonce, nonce); assert.equal(f.writes().length, 1);
  assert.equal(f.client.managed.accounts[recordKey(REPOSITORY, A)].result.checkinConfirmed, false, 'A status query cannot manufacture check-in success');
});

test('definite dispatch rejection carries no accepted-operation claim and clears the intent', async t => {
  const f = fixture(t); f.controls.rejectDispatch = true;
  await assert.rejects(f.client.runOperation(REPOSITORY, 'checkin'), error => { assert.equal(error.code, 'BAD_REQUEST'); assert.equal(error.operationProgress, undefined); return true; });
  assert.equal(f.client.managed.operations[scope], undefined);
});

test('an all-account request is not fully verified when the workflow omits one requested account job and receipt', async t => {
  const f = fixture(t); const api = f.client._api;
  f.client._api = async (endpoint, options) => {
    const result = await api(endpoint, options);
    if (endpoint.endsWith('/dispatches')) f.runs.get(100).keys = [A];
    return result;
  };
  const result = await f.client.runOperation(REPOSITORY, 'checkin');
  assert.equal(result.status, 'completed'); assert.equal(result.conclusion, 'success');
  assert.equal(result.operationProgress.resultVerified, false); assert.equal(result.observationPending, true);
  assert.equal(f.client.managed.accounts[recordKey(REPOSITORY, A)].result.checkinConfirmed, true);
  assert.equal(f.client.managed.accounts[recordKey(REPOSITORY, B)].result, undefined);
  assert.equal(f.writes().length, 1);
});

test('wait timeout reports the known running task as pending and never creates another dispatch', async t => {
  const f = fixture(t, { runStatus: 'in_progress', waitTimeoutMs: 10 });
  const result = await f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A });
  assert.equal(result.status, 'in_progress'); assert.equal(result.conclusion, null); assert.equal(result.waitTimedOut, true);
  assert.equal(result.observationPending, true); assert.equal(result.operationProgress.submission, 'accepted');
  assert.equal(f.writes().length, 1);
});

test('missing receipts and failed report downloads remain pending while prior account success is retained', async t => {
  for (const mode of ['hideReceipts', 'reportFail']) await t.test(mode, async t => {
    const f = fixture(t); f.controls[mode] = true;
    const row = f.client.managed.accounts[recordKey(REPOSITORY, A)];
    row.result = { observedAt: '2026-10-08T12:00:00Z', businessDate: '2026-10-08', checkinConfirmed: true, checkinBusinessDate: '2026-10-08' };
    const before = copy(row.result);
    const result = await f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A });
    assert.equal(result.status, 'completed'); assert.equal(result.conclusion, 'success'); assert.equal(result.observationPending, true);
    assert.equal(result.operationProgress.resultVerified, false); assert.deepEqual(row.result, before);
    const nonce = f.client.managed.operations[scope].nonce; f.controls[mode] = false;
    assert.equal((await f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A })).observationPending, false);
    assert.equal(f.client.managed.operations[scope].nonce, nonce); assert.equal(f.writes().length, 1);
  });
});

test('detail readback failure preserves the verified check-in and only details remain pending', async t => {
  const f = fixture(t); f.controls.detailsFail = true;
  const result = await f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A });
  assert.equal(result.conclusion, 'success'); assert.equal(result.observationPending, true);
  assert.equal(result.operationProgress.resultVerified, true); assert.equal(result.operationProgress.detailsVerified, false);
  const row = f.client.managed.accounts[recordKey(REPOSITORY, A)]; assert.equal(row.result.checkinConfirmed, true); assert.equal(row.readback.stage, 'details');
  // A background read is not permission to prompt/decrypt or to forget that the
  // original explicit operation still needs its details read back.
  assert.equal((await f.client.readOperation(REPOSITORY, 100, { decrypt: false })).observationPending, true);
  f.controls.detailsFail = false;
  assert.equal((await f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A })).observationPending, false);
  assert.equal(row.details.points, 321); assert.equal(row.readback.pending, false); assert.equal(f.writes().length, 1);
});

test('an older pending nonce can be verified without overwriting a newer scheduled account result', async t => {
  const f = fixture(t); f.controls.hideReceipts = true;
  await f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A });
  const row = f.client.managed.accounts[recordKey(REPOSITORY, A)];
  row.result = { observedAt: '2026-10-08T14:00:00Z', checkinConfirmed: true, checkinBusinessDate: '2026-10-08' };
  row.details = { points: 987, observedAt: '2026-10-08T14:00:00Z' };
  row.latestRun = { id: 101, status: 'completed', conclusion: 'success', createdAt: '2026-10-08T14:00:00Z' };
  f.controls.hideReceipts = false;
  const result = await f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A });
  assert.equal(result.observationPending, false); assert.equal(f.writes().length, 1);
  assert.equal(row.result.observedAt, '2026-10-08T14:00:00Z'); assert.equal(row.details.points, 987); assert.equal(row.latestRun.id, 101);
});

test('ending a completed run with missing receipts retains the same-day check-in guard', async t => {
  const f = fixture(t); f.controls.hideReceipts = true;
  await f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A });
  const saved = f.client.managed.operations[scope]; assert.equal(saved.status, 'completed'); assert.equal(saved.observationPending, true);
  const result = await f.client.endOperation(REPOSITORY, { workflow: WORKFLOW_FILE, expectedNonce: saved.nonce });
  assert.equal(result.checkinBlocked, true); assert.equal(saved.status, 'ended'); assert.equal(f.writes().length, 1);
  await assert.rejects(f.client.runOperation(REPOSITORY, 'checkin', { accountKey: A }), { code: 'CHECKIN_UNVERIFIED' });
});

test('read-only refresh isolates an unreadable run and still updates another account in the same repository', async t => {
  const f = fixture(t); f.addRun(101, [A]); f.addRun(100, [B]);
  const api = f.client._api;
  f.client._api = async (endpoint, options) => { if (endpoint.endsWith('/runs/100')) throw network('actions-run'); return api(endpoint, options); };
  const result = await f.client.refreshRepository(REPOSITORY, { decrypt: true });
  assert.equal(result.observationPending, true); assert.equal(result.readback.pendingRuns.length, 1);
  assert.equal(f.client.managed.accounts[recordKey(REPOSITORY, A)].result.checkinConfirmed, true);
  assert.equal(f.client.managed.accounts[recordKey(REPOSITORY, B)].result, undefined);
  assert.deepEqual(f.writes(), []);
});
