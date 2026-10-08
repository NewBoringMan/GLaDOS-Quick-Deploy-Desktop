'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Controller, safeMessage } = require('../src/controller.cjs');
const { saveState, loadState, cleanPendingTask } = require('../src/state.cjs');

const accountKey = 'ABCDEF1234567890';
const credential = { cookie: 'gld:sess=private-session-example; gld:sess.sig=private-signature-example', userAgent: 'Real Browser 1.0', origin: 'https://glados.cloud', email: 'person@example.com', accountKey, browser: 'embedded' };
function fixture(overrides = {}) {
  const calls = [];
  let saved;
  const github = {
    whoami: async () => ({ login: 'example' }),
    login: async () => { calls.push('login'); return { login: 'example' }; },
    deploy: async args => { calls.push(['deploy', args.credential]); return { repository: 'example/glados-quick-deploy', accountKey, runId: 42, runUrl: 'https://github.com/example/glados-quick-deploy/actions/runs/42', status: 'completed', conclusion: 'success', result: { status: 'points_increased', accounts: [{ accountKey, outcome: 'checked', pointsAdded: 12 }] } }; },
    refresh: async () => ({ repository: 'example/glados-quick-deploy', runId: 42, status: 'completed', conclusion: 'success', result: { status: 'already_checked', accounts: [{ accountKey, outcome: 'already_checked' }] } }),
    pause: async () => {}, ...overrides.github,
  };
  const controller = new Controller({ github, discoverBrowsers: async () => [{ id: 'embedded', available: true }], captureLogin: async () => ({ ...credential }), save: state => { saved = JSON.parse(JSON.stringify(state)); }, openExternal: async () => {}, ...overrides, github });
  return { controller, calls, saved: () => saved };
}
function snapshotData({ snapshotSequence, ...data }) { return data; }
test('single click performs required GitHub login then verifies an account without exposing credentials', async () => {
  const f = fixture({ github: { whoami: async () => null } });
  await f.controller.initialize();
  const state = await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(f.calls[0], 'login');
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].pointsAdded, 12);
  assert.equal(state.busy, false);
  assert.ok(!JSON.stringify(state).includes('private-session-example'));
  assert.ok(!JSON.stringify(f.saved()).includes('private-signature-example'));
});
test('cancelling during browser login does not deploy or retain the secret', async () => {
  const f = fixture({ captureLogin: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) });
  await f.controller.initialize();
  const task = f.controller.action('startDeploy', { browserId: 'embedded' });
  await new Promise(resolve => setImmediate(resolve));
  await f.controller.action('cancel');
  const state = await task;
  assert.equal(state.stage, 'cancelled');
  assert.equal(f.calls.length, 0);
  assert.equal(state.busy, false);
});
test('a run queued in GitHub is retained for read-only refresh without re-dispatch', async () => {
  const f = fixture({ github: { deploy: async () => ({ repository: 'example/glados-quick-deploy', accountKey, runId: 42, runUrl: 'https://github.com/example/glados-quick-deploy/actions/runs/42', status: 'queued' }) } });
  await f.controller.initialize();
  await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(f.controller.state.accounts[0].conclusion, 'queued');
  await f.controller.refreshPending();
  assert.equal(f.controller.state.accounts[0].conclusion, 'already_checked_in');
});
test('unexpected errors are scrubbed before reaching renderer state', async () => {
  const f = fixture({ github: { deploy: async () => { throw new Error('Header gld:sess=private-session-example; failure github_pat_secret123456789'); } } });
  await f.controller.initialize();
  const state = await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(state.stage, 'error');
  assert.ok(!state.error.includes('private-session-example'));
  assert.ok(!state.error.includes('github_pat_secret'));
  assert.equal(f.controller.secrets.length, 0);
});
test('state file stores a field whitelist and excludes cookies, user agents and authentication codes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-state-test-'));
  try {
    saveState(directory, { settings: {}, selectedBrowser: 'embedded', cookie: credential.cookie, authCode: { code: 'ABCD-EFGH' }, accounts: [{ ...credential, repository: 'example/glados-quick-deploy' }] });
    const text = fs.readFileSync(path.join(directory, 'deployment-state.json'), 'utf8');
    assert.ok(!text.includes('private-session-example'));
    assert.ok(!text.includes('Real Browser'));
    assert.ok(!text.includes('ABCD-EFGH'));
    assert.equal(loadState(directory).accounts[0].accountKey, accountKey);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('invalid settings fail before any login, network or browser operation', async () => {
  const f = fixture(); await f.controller.initialize();
  const state = await f.controller.action('startDeploy', { browserId: 'embedded', time: '25:99' });
  assert.equal(state.stage, 'error'); assert.equal(f.calls.length, 0);
});
test('redactor handles both cookie families and Authorization headers', () => {
  const result = safeMessage('koa:sess=aaa123456; Authorization: Bearer xyz123456 ghp_example123456');
  assert.ok(!result.includes('aaa123456')); assert.ok(!result.includes('xyz123456')); assert.ok(!result.includes('ghp_example'));
});

test('explicit reconnect invokes official authorization even if an existing identity works', async () => {
  const f = fixture(); await f.controller.initialize();
  await f.controller.action('connectGithub');
  assert.deepEqual(f.calls, ['login']);
});
test('missing workflow permission requests authorization and resumes the same captured login once', async () => {
  let attempts = 0; let captures = 0;
  const f = fixture({ captureLogin: async () => { captures++; return { ...credential }; }, github: {
    deploy: async () => {
      if (++attempts === 1) { const error = new Error('workflow authorization required'); error.code = 'WORKFLOW_AUTH_REQUIRED'; throw error; }
      return { repository: 'example/glados-quick-deploy', accountKey, runId: 50, status: 'completed', conclusion: 'success', result: { accounts: [{ accountKey, outcome: 'already_checked' }] } };
    },
  } });
  await f.controller.initialize();
  const state = await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(captures, 1); assert.equal(attempts, 2); assert.deepEqual(f.calls, ['login']);
  assert.equal(state.accounts[0].conclusion, 'already_checked_in');
});
test('aggregate results preserve cancelled run status even when this account has accepted check-in evidence', () => {
  const f = fixture();
  f.controller.recordResult({ accountKey, repository: 'example/glados-quick-deploy', runId: 71, status: 'completed', conclusion: 'cancelled', result: { accounts: [{ accountKey: '0000000000000000', outcome: 'checked', pointsAdded: 99 }, { accountKey, outcome: 'already_checked', pointsAdded: 2 }] } });
  assert.equal(f.controller.state.accounts[0].pointsAdded, 2);
  assert.equal(f.controller.state.accounts[0].conclusion, 'cancelled');
});
test('manual refresh requests latest applicable account run instead of the initial saved run', async () => {
  let args;
  const f = fixture({ github: { refresh: async input => { args = input; return { repository: input.repository, runId: 99, status: 'completed', conclusion: 'success', result: { accounts: [{ accountKey, outcome: 'already_checked' }] } }; } } });
  f.controller.upsert({ accountKey, repository: 'example/glados-quick-deploy', runId: 42 });
  await f.controller.action('refreshRun', { accountKey });
  assert.equal(args.runId, undefined); assert.equal(args.accountKey, accountKey);
  assert.equal(f.controller.state.accounts[0].runId, 99);
});
test('a delayed background read is cancelled and cannot overwrite a new foreground deployment', async () => {
  let release; let started; const hasStarted = new Promise(resolve => { started = resolve; });
  const f = fixture({ github: { refresh: args => new Promise(resolve => { release = () => resolve({ repository: args.repository, runId: 41, status: 'completed', conclusion: 'failure' }); started(); }) } });
  await f.controller.initialize();
  f.controller.upsert({ accountKey, repository: 'example/glados-quick-deploy', runId: 41, status: 'queued', conclusion: 'queued' });
  const background = f.controller.refreshPending();
  await hasStarted;
  assert.equal(f.controller.refreshPending(), background);
  const foreground = f.controller.action('startDeploy', { browserId: 'embedded' });
  release(); await background; await foreground;
  assert.equal(f.controller.state.currentRun.runId, 42);
  assert.equal(f.controller.state.accounts[0].conclusion, 'checkin_success');
});
test('an old running task does not mark a newly logged-in account as deployed', () => {
  const f = fixture(); f.controller.pendingAccount = { accountKey, email: 'person@example.com' };
  f.controller.onGitHubEvent({ type: 'run', repository: 'example/glados-quick-deploy', runId: 42, credentialUpdated: false });
  assert.equal(f.controller.state.accounts.length, 0);
});
test('shutdown waits for asynchronous login cleanup after cancellation', async () => {
  let cleaned = false;
  const f = fixture({ captureLogin: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
    setTimeout(() => { cleaned = true; reject(new DOMException('Aborted', 'AbortError')); }, 5);
  }, { once: true })) });
  await f.controller.initialize();
  const action = f.controller.action('startDeploy', { browserId: 'embedded' });
  await new Promise(resolve => setImmediate(resolve));
  await f.controller.shutdown(); await action;
  assert.equal(cleaned, true); assert.equal(f.controller.secrets.length, 0);
});

function unverifiedRun(readError = 'INCOMPLETE_RESULTS') {
  return { accountKey, repository: 'example/glados-quick-deploy', runId: 42,
    runUrl: 'https://github.com/example/glados-quick-deploy/actions/runs/42', status: 'completed', conclusion: 'success',
    result: { status: 'unverified', readError, accounts: [] } };
}

test('missing result keeps deployment usable and one read of the original run completes every status with zero points', async () => {
  let now = 0; let captures = 0; let deploys = 0;
  const reads = [];
  const f = fixture({ now: () => now, captureLogin: async () => { captures++; return { ...credential }; }, github: {
    deploy: async () => { deploys++; return unverifiedRun(); },
    refresh: async args => {
      reads.push(args);
      return { ...unverifiedRun(), result: { status: 'checked', accounts: [{ accountKey, outcome: 'checked', pointsAdded: 0, exchange: 'not_needed' }] } };
    },
  } });
  await f.controller.initialize();
  const pending = await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(pending.resumeTasks.length, 0);
  assert.equal(pending.accounts[0].deploymentStatus, 'deployed');
  assert.equal(pending.accounts[0].conclusion, 'unverified');
  assert.equal(pending.accounts[0].resultReadError, 'INCOMPLETE_RESULTS');
  assert.match(pending.accounts[0].message, /暂未读到该账号完整/);
  assert.equal(pending.currentRun.conclusion, 'unverified');
  assert.deepEqual(pending.progress.completed, [0, 1, 2]);
  await f.controller.refreshPending(); assert.equal(reads.length, 0);
  now += 30000; await f.controller.refreshPending();
  const completed = f.controller.snapshot();
  assert.equal(reads.length, 1); assert.equal(reads[0].runId, 42); assert.equal(reads[0].accountKey, accountKey);
  assert.equal(captures, 1); assert.equal(deploys, 1);
  assert.equal(completed.accounts[0].conclusion, 'checkin_success');
  assert.equal(completed.accounts[0].pointsAdded, 0);
  assert.equal(completed.accounts[0].resultReadError, ''); assert.equal(completed.accounts[0].lastRefreshError, '');
  assert.equal(completed.currentRun.conclusion, 'checkin_success'); assert.equal(completed.currentRun.accountKey, accountKey);
  assert.deepEqual(completed.progress.completed, [0, 1, 2, 3]);
  assert.equal(completed.stage, 'complete'); assert.doesNotMatch(completed.message, /待核实|暂未读到/);
});

test('unverified background reads stop after five attempts and manual refresh starts a new bounded round', async () => {
  let now = 0;
  const reads = [];
  const f = fixture({ now: () => now, github: { refresh: async args => { reads.push(args); return unverifiedRun(); } } });
  f.controller.recordResult({ ...unverifiedRun(), deploymentStatus: 'deployed' });
  for (let i = 0; i < 8; i++) { now += 30000; await f.controller.refreshPending(); }
  assert.equal(reads.length, 5);
  assert.match(f.controller.state.accounts[0].message, /已暂停自动补读/);
  assert.equal(f.controller.state.currentRun.conclusion, 'unverified');
  assert.deepEqual(f.controller.state.progress.completed, [0, 1, 2]);
  await f.controller.action('refreshRun', { accountKey });
  assert.equal(reads.length, 6); assert.equal(reads[5].runId, 42);
  assert.doesNotMatch(f.controller.state.accounts[0].message, /已暂停自动补读/);
  now += 30000; await f.controller.refreshPending();
  assert.equal(reads.length, 7); assert.ok(reads.every(args => args.runId === 42));
});

test('background network failures are bounded and expose only controlled result-read messages', async () => {
  let now = 0; let reads = 0;
  const f = fixture({ now: () => now, github: { refresh: async () => {
    reads++; throw Object.assign(new Error('PRIVATE_RAW_LOG_SHOULD_NOT_APPEAR'), { code: 'NETWORK_ERROR' });
  } } });
  f.controller.recordResult({ ...unverifiedRun(), deploymentStatus: 'deployed' });
  for (let i = 0; i < 8; i++) { now += 30000; await f.controller.refreshPending(); }
  assert.equal(reads, 5);
  assert.match(f.controller.state.accounts[0].lastRefreshError, /无法连接 GitHub/);
  assert.match(f.controller.state.accounts[0].lastRefreshError, /已暂停自动补读/);
  assert.doesNotMatch(JSON.stringify(f.controller.snapshot()), /PRIVATE_RAW_LOG/);
});

test('another account failure or incomplete log cannot replace this account accepted result', async () => {
  const otherKey = '0000000000000000';
  const result = { ...unverifiedRun(), conclusion: 'failure', result: { status: 'unverified', readError: 'INCOMPLETE_RESULTS', accounts: [
    { accountKey, outcome: 'checked', pointsAdded: 0, exchange: 'not_needed' },
    { accountKey: otherKey, outcome: 'failed', errorKind: 'execution' },
  ] } };
  const f = fixture({ github: { refresh: async () => result } });
  f.controller.upsert({ accountKey: otherKey, repository: result.repository, runId: 42, conclusion: 'failure', status: 'completed', message: 'Other account error' });
  f.controller.upsert({ accountKey, repository: result.repository, runId: 42, conclusion: 'unverified', status: 'completed' });
  const state = await f.controller.action('refreshRun', { accountKey });
  const accepted = state.accounts.find(account => account.accountKey === accountKey);
  assert.equal(accepted.conclusion, 'checkin_success'); assert.equal(accepted.resultReadError, '');
  assert.equal(state.accounts.find(account => account.accountKey === otherKey).message, 'Other account error');
  assert.equal(state.currentRun.conclusion, 'checkin_success'); assert.deepEqual(state.progress.completed, [0, 1, 2, 3]);
  assert.equal(state.stage, 'complete'); assert.equal(state.error, '');
});

test('unknown remote read-error details are replaced before entering persisted account state', () => {
  const f = fixture();
  f.controller.recordResult(unverifiedRun('PRIVATE_RAW_REMOTE_ERROR'));
  assert.equal(f.saved().accounts[0].resultReadError, 'RESULTS_UNAVAILABLE');
  assert.match(f.saved().accounts[0].message, /签到结果暂时无法读取/);
  assert.doesNotMatch(JSON.stringify(f.saved()), /PRIVATE_RAW_REMOTE_ERROR/);
});

test('another account failing cannot stop readback for an account whose own result is still missing', async () => {
  let now = 0; let reads = 0;
  const missing = { ...unverifiedRun('NETWORK_ERROR'), conclusion: 'failure', result: { status: 'unverified', readError: 'NETWORK_ERROR', requestedAccountMissing: true,
    accounts: [{ accountKey: '0000000000000000', outcome: 'failed' }] } };
  const f = fixture({ now: () => now, github: {
    deploy: async () => missing,
    refresh: async input => { reads++; assert.equal(input.runId, 42); return { ...missing, result: { accounts: [{ accountKey, outcome: 'checked', pointsAdded: 0 }, { accountKey: '0000000000000000', outcome: 'failed' }] } }; },
  } });
  await f.controller.initialize();
  const waiting = await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(waiting.stage, 'awaiting_result'); assert.equal(waiting.accounts[0].conclusion, 'unverified');
  assert.equal(waiting.accounts[0].resultReadError, 'NETWORK_ERROR'); assert.deepEqual(waiting.progress.completed, [0, 1, 2]);
  now += 30000; await f.controller.refreshPending();
  assert.equal(reads, 1); assert.equal(f.controller.state.accounts[0].conclusion, 'checkin_success');
  assert.equal(f.controller.state.stage, 'complete');
});

test('a queued run has a waiting overview instead of claiming that verification completed', async () => {
  const f = fixture({ github: { deploy: async () => ({ ...unverifiedRun(), status: 'in_progress', conclusion: null, result: { status: 'pending', accounts: [] } }) } });
  await f.controller.initialize();
  const state = await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(state.stage, 'awaiting_result'); assert.equal(state.accounts[0].conclusion, 'in_progress');
  assert.deepEqual(state.progress.completed, [0, 1, 2]); assert.equal(state.error, '');
});

test('an accepted run with failed readback stays pending across restart and resumes its original run', async () => {
  const checkpoint = { schemaVersion: 1, githubLogin: 'example', accountKey, repository: 'example/glados-quick-deploy', branch: 'main',
    secretStored: true, configured: true, configSha: 'a'.repeat(40), run: { repository: 'example/glados-quick-deploy', runId: 42, status: 'queued' } };
  const f = fixture({ github: { deploy: async args => {
    await args.onCheckpoint(checkpoint);
    throw Object.assign(new Error('RAW_BODY_MUST_NOT_REACH_PENDING_MESSAGE'), { code: 'NETWORK_ERROR', stage: 'verification', reason: 'network_eof', method: 'GET', endpointKind: 'actions-run', body: 'SECRET' });
  } } });
  await f.controller.initialize();
  const waiting = await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(waiting.stage, 'awaiting_result'); assert.equal(waiting.errorInfo.severity, 'warning');
  assert.match(waiting.error, /已接收验证任务.*42.*结果待确认/); assert.equal(waiting.resumeTasks[0].resultPending, true);
  assert.doesNotMatch(JSON.stringify(waiting), /RAW_BODY|SECRET/);
  const task = f.saved().pendingDeployments[0];
  assert.equal(task.lastError.resultPending, true); assert.equal(task.lastError.diagnostic.reason, 'network_eof');
  let resumed;
  const fresh = fixture({ restored: f.saved(), captureLogin: async () => { throw new Error('Must not repeat account login'); }, github: { deploy: async args => {
    resumed = args; return { ...unverifiedRun(), result: { accounts: [{ accountKey, outcome: 'checked' }] } };
  } } });
  await fresh.controller.initialize();
  assert.equal(fresh.controller.state.stage, 'awaiting_result');
  const complete = await fresh.controller.action('resumeDeploy', { taskId: task.id });
  assert.equal(resumed.checkpoint.run.runId, 42); assert.equal(resumed.credential, undefined);
  assert.equal(complete.stage, 'complete'); assert.equal(complete.resumeTasks.length, 0);
});

test('an uncertain dispatch reports unconfirmed acceptance instead of declaring a failed check-in', async () => {
  const f = fixture({ github: { deploy: async args => {
    await args.onCheckpoint({ schemaVersion: 1, githubLogin: 'example', accountKey, repository: 'example/glados-quick-deploy', branch: 'main', secretStored: true, configured: true,
      dispatch: { nonce: 'b'.repeat(32), branch: 'main', accountKey, submittedAt: Date.now() } });
    throw Object.assign(new Error('unknown CLI response'), { code: 'GITHUB_COMMAND_FAILED', stage: 'verification' });
  } } });
  await f.controller.initialize();
  const state = await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(state.stage, 'awaiting_result'); assert.match(state.error, /是否被 GitHub 接收仍待确认/);
  assert.doesNotMatch(state.error, /已接收|签到失败/); assert.equal(state.resumeTasks[0].needsLogin, false);
});

test('successful authorization with failed identity readback retries identity before opening authorization again', async () => {
  let logins = 0; let identityUnavailable = false;
  const f = fixture({ github: {
    whoami: async () => { if (identityUnavailable) throw Object.assign(new Error('identity still unavailable'), { code: 'NETWORK_ERROR', stage: 'identity' }); return { login: 'example' }; },
    login: async () => { logins++; identityUnavailable = true; throw Object.assign(new Error('identity read unavailable'), { code: 'NETWORK_ERROR', stage: 'auth-verify' }); },
  } });
  await f.controller.initialize();
  const waiting = await f.controller.action('connectGithub');
  assert.equal(waiting.stage, 'awaiting_result'); assert.equal(waiting.errorInfo.severity, 'warning');
  assert.match(waiting.error, /授权流程已完成.*连接仍待确认/);
  const stillWaiting = await f.controller.action('connectGithub');
  assert.equal(stillWaiting.stage, 'awaiting_result'); assert.equal(stillWaiting.errorInfo.severity, 'warning');
  assert.equal(stillWaiting.errorInfo.stage, 'auth-verify'); assert.equal(logins, 1);
  identityUnavailable = false;
  const verified = await f.controller.action('connectGithub');
  assert.equal(logins, 1); assert.equal(verified.github.login, 'example'); assert.equal(verified.error, '');
});

test('manual result read failure keeps previously confirmed success and identifies only the readback as pending', async () => {
  const f = fixture({ github: { refresh: async () => { throw Object.assign(new Error('RAW_SERVICE_BODY'), { code: 'NETWORK_ERROR', stage: 'verification' }); } } });
  f.controller.recordResult({ ...unverifiedRun(), result: { accounts: [{ accountKey, outcome: 'checked', pointsAdded: 2 }] } });
  const state = await f.controller.action('refreshRun', { accountKey });
  assert.equal(state.accounts[0].conclusion, 'checkin_success'); assert.equal(state.accounts[0].pointsAdded, 2);
  assert.equal(state.stage, 'awaiting_result'); assert.equal(state.errorInfo.severity, 'warning');
  assert.equal(state.errorInfo.action, 'refreshRun'); assert.match(state.error, /保留上次已核实/);
  assert.doesNotMatch(JSON.stringify(state), /RAW_SERVICE_BODY/);
});

test('deployment, management and maintenance keep independent feedback and event provenance', async () => {
  const f = fixture();
  await f.controller.exclusive(async () => { throw Object.assign(new Error('Deployment setup rejected'), { code: 'INVALID_SETTINGS' }); });
  const deployment = JSON.parse(JSON.stringify(f.controller.state.feedback.deployment));
  await f.controller.exclusive(async () => { f.controller.state.stage = 'complete'; f.controller.note('Account query finished'); }, { scope: 'management' });
  assert.deepEqual(f.controller.state.feedback.deployment, deployment);
  assert.equal(f.controller.state.feedback.management.error, ''); assert.equal(f.controller.state.feedback.management.message, 'Account query finished');
  await f.controller.exclusive(async () => { throw Object.assign(new Error('Retention read unavailable'), { code: 'NETWORK_ERROR', stage: 'upgrade-retention' }); }, { scope: 'maintenance' });
  assert.equal(f.controller.state.feedback.maintenance.error, 'Retention read unavailable');
  assert.equal(f.controller.state.feedback.management.message, 'Account query finished');
  assert.equal(f.controller.state.feedback.deployment.error, 'Deployment setup rejected');
  assert.deepEqual(f.saved().events.map(x => x.scope), ['deployment', 'management', 'maintenance']);
});

test('background deployment readback cannot replace maintenance feedback or attribute its result to maintenance', async () => {
  const f = fixture();
  f.controller.recordResult({ ...unverifiedRun(), status: 'queued', conclusion: 'queued', result: { status: 'pending', accounts: [] } });
  await f.controller.exclusive(async () => { throw Object.assign(new Error('Maintenance requires attention'), { code: 'PERMISSION_DENIED' }); }, { scope: 'maintenance' });
  const maintenance = JSON.parse(JSON.stringify(f.controller.state.feedback.maintenance));
  await f.controller.refreshPending();
  assert.equal(f.controller.state.accounts[0].conclusion, 'already_checked_in');
  assert.deepEqual(f.controller.state.feedback.maintenance, maintenance);
  assert.equal(f.controller.state.feedback.deployment.currentRun.conclusion, 'already_checked_in');
  assert.equal(f.controller.state.error, 'Maintenance requires attention');
});

test('a rejected duplicate click cannot leave a failure banner over the original successful operation', async () => {
  const f = fixture(); let release;
  const latch = new Promise(resolve => { release = resolve; });
  const original = f.controller.exclusive(async () => { await latch; f.controller.state.stage = 'complete'; f.controller.note('Original operation verified'); });
  try { await f.controller.exclusive(async () => assert.fail('Duplicate work must never start')); }
  catch (error) { assert.equal(error.code, 'BUSY'); f.controller.reportActionError(error, 'startDeploy'); }
  assert.equal(f.controller.state.error, ''); assert.equal(f.controller.state.errorInfo, null);
  release(); await original;
  assert.equal(f.controller.state.feedback.deployment.stage, 'complete'); assert.equal(f.controller.state.feedback.deployment.error, '');
  assert.equal(f.controller.state.feedback.deployment.message, 'Original operation verified');
});

function deployedFixtureAccount(overrides = {}) {
  return { accountKey, email: 'person@example.com', browser: 'embedded', repository: 'example/glados-quick-deploy', githubLogin: 'example',
    runId: 91, runUrl: 'https://github.com/example/glados-quick-deploy/actions/runs/91', status: 'completed', conclusion: 'checkin_success',
    deploymentStatus: 'deployed', pointsAdded: 2, paused: false, updatedAt: '2026-10-08T08:00:00.000Z', message: '已核实今日签到',
    settings: { repoName: 'glados-quick-deploy', time: '07:35', exchangePlan: 'off' }, resultReadError: '', lastRefreshError: '', ...overrides };
}

function loginUpdateTask(overrides = {}) {
  return { id: 'a'.repeat(32), purpose: 'login_update', loginUpdateStage: 'local', phase: 'browser_login', revision: 2,
    createdAt: '2026-10-08T08:05:00.000Z', updatedAt: '2026-10-08T08:05:00.000Z', githubLogin: 'example', browserId: 'embedded',
    expectedAccountKey: accountKey, account: { accountKey, email: 'person@example.com', browser: 'embedded' },
    settings: { repoName: 'glados-quick-deploy', time: '07:35', exchangePlan: 'off' }, ...overrides };
}

test('closing, cancelling or quitting an unsubmitted login update preserves the whole deployed account and leaves no deployment todo', async t => {
  for (const ending of ['window-close', 'cancel-button', 'app-quit']) await t.test(ending, async () => {
    const original = deployedFixtureAccount();
    let ready; const opened = new Promise(resolve => { ready = resolve; });
    let closeWindow;
    const f = fixture({ restored: { accounts: [original], pendingDeployments: [] }, captureLogin: ({ signal }) => new Promise((_resolve, reject) => {
      closeWindow = () => reject(Object.assign(new Error('Login window was closed'), { code: 'LOGIN_CANCELLED' }));
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); ready();
    }) });
    await f.controller.initialize();
    await f.controller.exclusive(async () => { f.controller.state.stage = 'complete'; f.controller.note('Earlier new-account deployment completed'); });
    const deploymentFeedback = structuredClone(f.controller.state.feedback.deployment);
    const operation = f.controller.action('reloginAccount', { accountKey, browserId: 'embedded' });
    await opened;
    assert.deepEqual(f.controller.state.accounts, [original]);
    assert.equal(f.controller.state.actionScope, 'management');
    assert.equal(f.controller.state.resumeTasks[0].purpose, 'login_update');
    assert.equal(f.controller.state.resumeTasks[0].loginUpdateStage, 'local');
    assert.equal(f.controller.snapshot().executingTaskId, f.controller.state.resumeTasks[0].id);
    if (ending === 'window-close') closeWindow();
    else if (ending === 'cancel-button') await f.controller.action('cancel', { taskId: f.controller.snapshot().executingTaskId });
    else await f.controller.shutdown();
    const state = await operation;
    assert.equal(state.stage, 'cancelled'); assert.equal(state.error, '');
    assert.match(state.message, /已取消更新登录，原账号和定时任务保持原状/);
    assert.deepEqual(state.accounts, [original]); assert.deepEqual(f.saved().accounts, [original]);
    assert.equal(state.resumeTasks.length, 0); assert.equal(f.saved().pendingDeployments.length, 0);
    assert.equal(state.executingTaskId, ''); assert.equal(f.saved().executingTaskId, undefined);
    assert.equal(f.calls.length, 0); assert.equal(f.controller.secrets.length, 0);
    assert.deepEqual(state.feedback.deployment, deploymentFeedback);
    const restarted = fixture({ restored: f.saved() }); await restarted.controller.initialize();
    assert.deepEqual(restarted.controller.state.accounts, [original]); assert.equal(restarted.controller.tasks.size, 0);
  });
});

test('a new account still resumes its cancelled browser login after restart', async () => {
  const f = fixture({ captureLogin: async () => { throw Object.assign(new Error('closed'), { code: 'LOGIN_CANCELLED' }); } });
  await f.controller.initialize();
  const cancelled = await f.controller.action('startDeploy', { browserId: 'embedded' });
  assert.equal(cancelled.resumeTasks.length, 1); assert.equal(cancelled.resumeTasks[0].purpose, 'deployment');
  assert.equal(cancelled.resumeTasks[0].needsLogin, true); assert.equal(cancelled.accounts.length, 0); assert.equal(f.calls.length, 0);
  const taskId = cancelled.resumeTasks[0].id;
  const restarted = fixture({ restored: f.saved() }); await restarted.controller.initialize();
  assert.equal(restarted.controller.state.resumeTasks[0].id, taskId);
  const complete = await restarted.controller.action('resumeDeploy', { taskId });
  assert.equal(complete.actionScope, 'deployment'); assert.equal(complete.stage, 'complete');
  assert.equal(complete.resumeTasks.length, 0); assert.equal(restarted.calls.length, 1);
});

test('cancelling a login update before submission does not discard older genuine recovery checkpoints', async () => {
  const previous = loginUpdateTask({ purpose: 'deployment', loginUpdateStage: undefined, phase: 'deploying',
    checkpoint: { schemaVersion: 1, githubLogin: 'example', accountKey, repository: 'example/glados-quick-deploy', branch: 'main',
      secretStored: true, configured: true, configSha: 'd'.repeat(40) } });
  const f = fixture({ restored: { accounts: [deployedFixtureAccount({ pendingTaskId: previous.id })], pendingDeployments: [previous], activeTaskId: previous.id },
    captureLogin: async () => { throw Object.assign(new Error('closed'), { code: 'LOGIN_CANCELLED' }); } });
  await f.controller.initialize();
  const original = structuredClone(f.controller.state.accounts);
  const priorTasks = f.saved().pendingDeployments;
  const state = await f.controller.action('reloginAccount', { accountKey });
  assert.deepEqual(state.accounts, original); assert.deepEqual(f.saved().pendingDeployments, priorTasks);
  assert.equal(state.resumeTasks.length, 1); assert.equal(state.resumeTasks[0].id, previous.id);
  assert.equal(f.calls.length, 0);
});

test('cancellation while persisting the remote boundary still stops before any adapter call and restores the original account', async () => {
  const original = deployedFixtureAccount(); let cancelledAtBoundary = false;
  const f = fixture({ restored: { accounts: [original], pendingDeployments: [] }, resumeStore: {
    load: async () => ({ tasks: [], durable: true, warning: '' }),
    save: async tasks => {
      if (tasks.some(task => task.loginUpdateStage === 'remote_started')) { cancelledAtBoundary = true; await f.controller.action('cancel'); }
      return { durable: true, warning: '' };
    },
  } });
  await f.controller.initialize();
  const state = await f.controller.action('reloginAccount', { accountKey });
  assert.equal(cancelledAtBoundary, true); assert.equal(f.calls.length, 0);
  assert.deepEqual(state.accounts, [original]); assert.equal(state.resumeTasks.length, 0);
  assert.match(state.message, /原账号和定时任务保持原状/);
});

test('an interrupted remote login update preserves its durable boundary and checkpoints instead of claiming rollback', async t => {
  for (const stage of ['unknown-write', 'secret-stored', 'accepted-run']) await t.test(stage, async () => {
    const original = deployedFixtureAccount(); let ready; const processing = new Promise(resolve => { ready = resolve; });
    let deployCalls = 0;
    const f = fixture({ restored: { accounts: [original], pendingDeployments: [] }, github: { deploy: async args => {
      deployCalls++;
      const task = f.saved().pendingDeployments.find(task => task.purpose === 'login_update');
      assert.equal(task.loginUpdateStage, 'remote_started');
      if (stage !== 'unknown-write') {
        const checkpoint = { schemaVersion: 1, githubLogin: 'example', accountKey, repository: original.repository, branch: 'main', secretStored: true,
          configured: stage === 'accepted-run', ...(stage === 'accepted-run' ? { run: { repository: original.repository, runId: 92, status: 'queued' } } : {}) };
        await args.onCheckpoint(checkpoint);
        if (stage === 'accepted-run') f.controller.onGitHubEvent({ type: 'run', repository: original.repository, runId: 92, status: 'queued', credentialUpdated: true });
      }
      assert.deepEqual(f.controller.state.accounts, [original]); ready();
      return new Promise((_resolve, reject) => args.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    } } });
    await f.controller.initialize();
    const operation = f.controller.action('reloginAccount', { accountKey });
    await processing; await f.controller.action('cancel'); const state = await operation;
    assert.equal(deployCalls, 1); assert.equal(state.stage, 'awaiting_result'); assert.equal(state.errorInfo.severity, 'warning');
    assert.doesNotMatch(state.message, /原账号和定时任务保持原状/);
    assert.equal(state.resumeTasks.length, 1); assert.equal(state.resumeTasks[0].purpose, 'login_update');
    assert.equal(state.resumeTasks[0].loginUpdateStage, 'remote_started'); assert.equal(state.resumeTasks[0].resultPending, true);
    assert.deepEqual(state.accounts, [original]);
    const task = f.saved().pendingDeployments[0];
    if (stage === 'accepted-run') assert.equal(task.checkpoint.run.runId, 92);
    if (stage === 'secret-stored') assert.equal(task.checkpoint.secretStored, true);
    const fresh = fixture({ restored: f.saved(), captureLogin: async () => assert.fail('Restart must not open a browser') });
    await fresh.controller.initialize();
    assert.equal(fresh.controller.state.actionScope, 'management'); assert.equal(fresh.controller.state.resumeTasks[0].id, task.id);
    assert.deepEqual(fresh.controller.state.accounts, [original]); assert.equal(fresh.calls.length, 0);
    if (stage === 'accepted-run') {
      const complete = await fresh.controller.action('resumeDeploy', { taskId: task.id });
      assert.equal(complete.actionScope, 'management'); assert.equal(complete.stage, 'complete'); assert.equal(complete.resumeTasks.length, 0);
    }
  });
});

test('a lost remote login-update response is explicitly unconfirmed without replacing prior account success', async () => {
  const original = deployedFixtureAccount();
  const f = fixture({ restored: { accounts: [original], pendingDeployments: [] }, github: { deploy: async () => {
    throw Object.assign(new Error('RAW_UNCERTAIN_WRITE_RESPONSE'), { code: 'NETWORK_ERROR', stage: 'secrets' });
  } } });
  await f.controller.initialize();
  const result = await f.controller.action('reloginAccount', { accountKey });
  assert.equal(result.stage, 'awaiting_result'); assert.equal(result.resumeTasks[0].resultPending, true);
  assert.match(result.error, /更新登录已进入云端处理，尚未完成核对/);
  assert.deepEqual(result.accounts, [original]); assert.doesNotMatch(JSON.stringify(result), /RAW_UNCERTAIN/);
});

test('successful login update only replaces the account after a verified result and keeps its settings', async () => {
  const original = deployedFixtureAccount();
  const f = fixture({ restored: { accounts: [original], pendingDeployments: [] }, captureLogin: async () => {
    assert.deepEqual(f.controller.state.accounts, [original]); return { ...credential };
  }, github: { deploy: async args => {
    assert.deepEqual(f.controller.state.accounts, [original]); assert.equal(args.time, original.settings.time); assert.equal(args.exchangePlan, 'off');
    return { ...unverifiedRun(), runId: 92, runUrl: 'https://github.com/example/glados-quick-deploy/actions/runs/92',
      result: { accounts: [{ accountKey, outcome: 'already_checked', pointsAdded: 0 }] } };
  } } });
  await f.controller.initialize();
  const state = await f.controller.action('reloginAccount', { accountKey });
  assert.equal(state.actionScope, 'management'); assert.equal(state.stage, 'complete'); assert.equal(state.resumeTasks.length, 0);
  assert.equal(state.accounts[0].runId, 92); assert.equal(state.accounts[0].conclusion, 'already_checked_in');
  assert.deepEqual(state.accounts[0].settings, original.settings); assert.equal(state.accounts[0].pendingTaskId, '');
});

test('restart cleans only proven unsubmitted login updates and retains new deployments or ambiguous cloud progress', async t => {
  const candidates = [
    ['explicit-local', loginUpdateTask(), true],
    ['explicit-local-captured', loginUpdateTask({ phase: 'deploying', credentialVersion: 'c'.repeat(32) }), true],
    ['explicit-remote', loginUpdateTask({ loginUpdateStage: 'remote_started' }), false],
    ['unknown-stage', loginUpdateTask({ loginUpdateStage: 'unrecognized' }), false],
    ['contradictory-write-evidence', loginUpdateTask({ checkpoint: { secretStored: true } }), false],
    ['legacy-unused', loginUpdateTask({ purpose: undefined, loginUpdateStage: undefined }), true],
    ['legacy-captured', loginUpdateTask({ purpose: undefined, loginUpdateStage: undefined, credentialVersion: 'c'.repeat(32) }), false],
    ['legacy-checkpoint', loginUpdateTask({ purpose: undefined, loginUpdateStage: undefined, checkpoint: { secretStored: false, configured: false } }), false],
    ['legacy-other-repository', loginUpdateTask({ purpose: undefined, loginUpdateStage: undefined, settings: { repoName: 'other-repository', time: '07:35', exchangePlan: 'off' } }), false],
    ['explicit-deployment', loginUpdateTask({ purpose: 'deployment', loginUpdateStage: undefined }), false],
    ['new-account', loginUpdateTask({ purpose: undefined, loginUpdateStage: undefined, account: undefined, expectedAccountKey: undefined }), false],
  ];
  for (const [name, task, remove] of candidates) await t.test(name, async () => {
    const original = deployedFixtureAccount({ pendingTaskId: task.id });
    const f = fixture({ restored: { accounts: [original], pendingDeployments: [task], activeTaskId: task.id },
      captureLogin: async () => assert.fail('Restoration must not log in') });
    await f.controller.initialize();
    assert.equal(f.controller.tasks.size, remove ? 0 : 1); assert.equal(f.calls.length, 0);
    assert.equal(f.controller.state.accounts[0].runId, original.runId); assert.equal(f.controller.state.accounts[0].conclusion, original.conclusion);
    if (remove) {
      assert.deepEqual(f.controller.state.accounts, [{ ...original, pendingTaskId: '' }]);
      assert.equal(f.saved().pendingDeployments.length, 0);
    }
  });
  const task = loginUpdateTask({ purpose: undefined, loginUpdateStage: undefined });
  const pending = fixture({ restored: { accounts: [{ accountKey, email: 'new@example.com', deploymentStatus: 'pending', pendingTaskId: task.id }], pendingDeployments: [task] } });
  await pending.controller.initialize();
  assert.equal(pending.controller.tasks.size, 1, 'An unfinished first deployment must survive');
});

test('the public state whitelist preserves login-update recovery markers without copying credentials or arbitrary fields', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gqd-login-update-state-'));
  try {
    const task = loginUpdateTask({ loginUpdateStage: 'remote_started', credential: { ...credential }, originalAccount: { cookie: credential.cookie } });
    saveState(directory, { accounts: [deployedFixtureAccount()], pendingDeployments: [task] });
    const saved = loadState(directory).pendingDeployments[0];
    assert.equal(saved.purpose, 'login_update'); assert.equal(saved.loginUpdateStage, 'remote_started');
    assert.equal(saved.credential, undefined); assert.equal(saved.originalAccount, undefined);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'deployment-state.json'), 'utf8'), /private-session|private-signature/);
    assert.equal(cleanPendingTask(loginUpdateTask({ loginUpdateStage: 'unknown' })).loginUpdateStage, 'remote_started');
    assert.equal(cleanPendingTask(loginUpdateTask({ purpose: 'unexpected' })).purpose, undefined);
    assert.equal(cleanPendingTask(task, { includeCredential: true }).credential.cookie, credential.cookie);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a selected login-update todo is not reported as executing during a different management operation', async () => {
  const task = loginUpdateTask({ loginUpdateStage: 'remote_started' });
  const f = fixture({ restored: { accounts: [deployedFixtureAccount()], pendingDeployments: [task], activeTaskId: task.id } });
  await f.controller.initialize();
  assert.equal(f.controller.snapshot().executingTaskId, '');
  await f.controller.exclusive(async () => {
    assert.equal(f.controller.state.activeTaskId, task.id);
    assert.equal(f.controller.snapshot().executingTaskId, '');
    f.controller.note('Independent account query completed');
  }, { scope: 'management' });
  assert.equal(f.controller.snapshot().executingTaskId, ''); assert.equal(f.controller.tasks.size, 1);
  assert.equal(f.saved().executingTaskId, undefined);
});

test('a stale task-scoped cancel cannot stop another management operation or change its feedback', async () => {
  const task = loginUpdateTask({ loginUpdateStage: 'remote_started' });
  const f = fixture({ restored: { accounts: [deployedFixtureAccount()], pendingDeployments: [task], activeTaskId: task.id } });
  await f.controller.initialize();
  let release; const waiting = new Promise(resolve => { release = resolve; });
  let activeSignal;
  const operation = f.controller.exclusive(async signal => {
    activeSignal = signal; f.controller.state.stage = 'verifying'; f.controller.note('Reading current account information');
    await waiting;
  }, { scope: 'management' });
  const before = f.controller.snapshot();
  assert.equal(before.executingTaskId, ''); assert.equal(before.activeTaskId, task.id);
  for (const taskId of [task.id, '', null]) {
    assert.deepEqual(snapshotData(await f.controller.action('cancel', { taskId })), snapshotData(before));
    assert.equal(activeSignal.aborted, false);
  }
  release(); await operation;
  const completed = f.controller.snapshot();
  assert.deepEqual(snapshotData(await f.controller.action('cancel', { taskId: task.id })), snapshotData(completed));
});

test('task-scoped cancel stops only the currently executing task while unscoped cancel remains available', async () => {
  let ready; const opened = new Promise(resolve => { ready = resolve; }); let captureSignal;
  const f = fixture({ captureLogin: ({ signal }) => new Promise((_resolve, reject) => {
    captureSignal = signal; signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); ready();
  }) });
  await f.controller.initialize();
  const operation = f.controller.action('startDeploy', { browserId: 'embedded' });
  await opened;
  const before = f.controller.snapshot(); assert.ok(before.executingTaskId);
  assert.deepEqual(snapshotData(await f.controller.action('cancel', { taskId: 'b'.repeat(32) })), snapshotData(before));
  assert.equal(captureSignal.aborted, false);
  await f.controller.action('cancel');
  const cancelled = await operation;
  assert.equal(captureSignal.aborted, true); assert.equal(cancelled.stage, 'cancelled');
  assert.equal(cancelled.resumeTasks[0].id, before.executingTaskId);
});

test('snapshot ordering is monotonic across reads, events and replies without mutating or persisting account state', async () => {
  const original = deployedFixtureAccount();
  const f = fixture({ restored: { accounts: [original], pendingDeployments: [], snapshotSequence: 900 } });
  const before = structuredClone(f.controller.state);
  const first = f.controller.snapshot(); const second = f.controller.snapshot();
  assert.equal(first.snapshotSequence, 1); assert.equal(second.snapshotSequence, 2);
  assert.deepEqual(snapshotData(first), snapshotData(second)); assert.deepEqual(f.controller.state, before);
  assert.equal(f.saved(), undefined, 'Reading snapshots must not write state');
  const events = []; f.controller.on('state', state => events.push(state));
  f.controller.changed();
  assert.ok(events[0].snapshotSequence > second.snapshotSequence);
  const reply = await f.controller.action('saveSettings', {});
  assert.ok(events.at(-1).snapshotSequence > events[0].snapshotSequence);
  assert.ok(reply.snapshotSequence > events.at(-1).snapshotSequence);
  assert.deepEqual(reply.accounts, [original]); assert.deepEqual(f.saved().accounts, [original]);
  assert.equal(f.controller.state.snapshotSequence, undefined); assert.equal(f.saved().snapshotSequence, undefined);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gqd-snapshot-order-'));
  try {
    saveState(directory, reply);
    const raw = JSON.parse(fs.readFileSync(path.join(directory, 'deployment-state.json'), 'utf8'));
    assert.equal(raw.snapshotSequence, undefined); assert.equal(raw.executingTaskId, undefined);
    assert.deepEqual(loadState(directory).accounts, [original]);
    const restarted = fixture({ restored: loadState(directory) });
    assert.equal(restarted.controller.snapshot().snapshotSequence, 1, 'Ordering belongs only to this controller lifetime');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
