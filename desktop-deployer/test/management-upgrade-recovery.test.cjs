'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ManagementClient } = require('../src/management-client.cjs');
const { GitHubError, WORKFLOW_FILE, WORKFLOW_PATH, KEEPALIVE_FILE, MANIFEST_PATH, MARKER_PATH } = require('../src/github.cjs');
const { deploymentFiles, CLEANUP_FILE } = require('../src/cloud-workflows.cjs');
const { normalizeManifest } = require('../src/schedule-config.cjs');
const REPOSITORY = 'tester/glados-quick-deploy';
const ACCOUNT = 'A'.repeat(16);
const NOW = Date.parse('2026-10-08T13:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));

// Only the HTTP protocol boundary is replaced. Ownership checks, commit/ref
// updates, immutable-file comparisons, inspect and durable management state all
// execute through the real ManagementClient and GitHubClient implementations.
class GitHubProtocol {
  constructor({ outdated = false, retentionDays = 3, actionsEnabled = true } = {}) {
    this.calls = []; this.sequence = 0; this.retentionDays = retentionDays; this.actionsEnabled = actionsEnabled;
    this.trees = new Map(); this.commits = new Map(); this.runs = []; this.fault = () => null;
    this.config = normalizeManifest({ schemaVersion: 1, time: '12:30', exchangePlan: 'plan500', accounts: [{ accountKey: ACCOUNT }] });
    this.config.reporting = { keyId: 'test-public-key-id', publicKey: 'test-public-key' };
    const files = new Map(Object.entries(deploymentFiles(this.config)));
    files.set(MARKER_PATH, JSON.stringify({ appId: 'glados-quick-deploy', schemaVersion: 1, repositoryId: 42 }));
    if (outdated) files.set(WORKFLOW_PATH, files.get(WORKFLOW_PATH) + '\n# Previous managed revision\n');
    const tree = this.sha(); this.trees.set(tree, files);
    this.head = this.sha(); this.commits.set(this.head, { tree: { sha: tree }, parents: [] });
    this.initialHead = this.head;
    this.workflowStates = new Map([WORKFLOW_FILE, KEEPALIVE_FILE, CLEANUP_FILE].map(name => [name, 'active']));
  }
  sha() { return (++this.sequence).toString(16).padStart(40, '0'); }
  files(ref = this.head) {
    const commit = this.commits.get(ref === 'main' ? this.head : ref);
    assert.ok(commit, 'The fake must honor the requested immutable commit');
    return this.trees.get(commit.tree.sha);
  }
  writes() { return this.calls.filter(call => call.method !== 'GET'); }
  async request(endpoint, options = {}) {
    const call = { endpoint, method: options.method || 'GET', stage: options.stage, ...(options.body === undefined ? {} : { body: clone(options.body) }) };
    this.calls.push(call);
    const failure = this.fault(call); if (failure) throw failure;
    if (endpoint === 'user') {
      assert.equal(call.method, 'GET');
      const data = { login: 'tester', id: 42 };
      return options.metadata ? { data, workflowScope: true } : data;
    }
    const prefix = `repos/${REPOSITORY}`;
    assert.ok(endpoint === prefix || endpoint.startsWith(prefix + '/'), 'No unrelated repository requests are permitted');
    const suffix = endpoint.slice(prefix.length + 1);
    const [route, query = ''] = suffix.split('?'); const params = new URLSearchParams(query);
    if (endpoint === prefix) {
      assert.equal(call.method, 'GET');
      return { id: 42, full_name: REPOSITORY, owner: { login: 'tester', id: 42 }, permissions: { admin: true }, default_branch: 'main' };
    }
    if (route.startsWith('contents/')) {
      assert.equal(call.method, 'GET');
      const content = this.files(params.get('ref')).get(route.slice('contents/'.length));
      if (content === undefined) throw new GitHubError('NOT_FOUND', 'Missing test file', 'configuration', { httpStatus: 404 });
      return { type: 'file', encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') };
    }
    if (route === 'git/ref/heads/main') { assert.equal(call.method, 'GET'); return { object: { sha: this.head } }; }
    if (/^git\/commits\/[a-f0-9]{40}$/.test(route)) { assert.equal(call.method, 'GET'); return clone(this.commits.get(route.slice('git/commits/'.length))); }
    if (route === 'git/trees') {
      assert.equal(call.method, 'POST'); const sha = this.sha();
      const files = new Map(this.trees.get(call.body.base_tree));
      for (const item of call.body.tree) files.set(item.path, item.content);
      this.trees.set(sha, files); return { sha };
    }
    if (route === 'git/commits') {
      assert.equal(call.method, 'POST'); const sha = this.sha();
      this.commits.set(sha, { tree: { sha: call.body.tree }, parents: call.body.parents }); return { sha };
    }
    if (route === 'git/refs/heads/main') {
      assert.equal(call.method, 'PATCH'); assert.equal(call.body.force, false);
      assert.equal(this.commits.get(call.body.sha).parents[0], this.head, 'No force replacement of a newer head');
      this.head = call.body.sha; return { object: { sha: this.head } };
    }
    if (route === 'actions/permissions') { assert.equal(call.method, 'GET'); return { enabled: this.actionsEnabled }; }
    if (route === 'actions/permissions/artifact-and-log-retention') {
      if (call.method === 'PUT') { assert.deepEqual(call.body, { days: 3 }); this.retentionDays = 3; return null; }
      assert.equal(call.method, 'GET'); return { days: this.retentionDays, maximum_allowed_days: 90 };
    }
    if (route === 'actions/workflows') {
      assert.equal(call.method, 'GET');
      return { workflows: [...this.workflowStates].map(([name, state]) => ({ name, path: `.github/workflows/${name}`, state })) };
    }
    if (route === 'actions/secrets') { assert.equal(call.method, 'GET'); return { secrets: [{ name: 'GLADOS_ACCOUNT_' + ACCOUNT }] }; }
    const enable = route.match(/^actions\/workflows\/([^/]+)\/enable$/);
    if (enable) { assert.equal(call.method, 'PUT'); this.workflowStates.set(enable[1], 'active'); return null; }
    if (/^actions\/workflows\/[^/]+\/runs$/.test(route)) { assert.equal(call.method, 'GET'); return { workflow_runs: clone(this.runs) }; }
    if (route === `actions/workflows/${WORKFLOW_FILE}/dispatches`) {
      assert.equal(call.method, 'POST');
      return { workflow_run_id: 100 };
    }
    assert.fail(`Unexpected fake GitHub route: ${call.method} ${route}`);
  }
}

function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gqd-upgrade-protocol-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const github = new GitHubProtocol(options); let now = NOW;
  function start() {
    const client = new ManagementClient({ directory, now: () => now, ghPath: '/never-executed-gh',
      spawnImpl: () => { throw new Error('External processes are forbidden'); }, sleepImpl: async () => {}, reportVault: { ensure: async reporting => reporting } });
    client._api = github.request.bind(github);
    return client;
  }
  return { github, client: start(), start, advance: () => { now += 60000; } };
}

test('a current upgrade performs only GETs, skips active enables, and compares an immutable bundle once', async t => {
  const f = fixture(t); const result = await f.client.upgrade(REPOSITORY);
  assert.deepEqual(f.github.writes(), []);
  assert.equal(result.changed, false);
  assert.deepEqual(result.upgradeProgress, { stage: 'completed', configurationVerified: true, maintenanceVerified: true, commitSha: f.github.head });
  const files = Object.keys(deploymentFiles(f.github.config)).filter(filename => ![WORKFLOW_PATH, MANIFEST_PATH].includes(filename));
  for (const filename of files) {
    const reads = f.github.calls.filter(call => call.endpoint === `repos/${REPOSITORY}/contents/${filename}?ref=${f.github.head}`);
    assert.equal(reads.length, 1, 'Matching immutable files must not be read twice');
  }
  assert.equal(f.client.managed.repositories[REPOSITORY].upgradeAttempt.status, 'completed');
  assert.equal(result.upgradeVerifiedAt, new Date(NOW).toISOString());
});

test('written and verified configuration survives a final GET failure and restart recovers using GETs only', async t => {
  const f = fixture(t, { outdated: true });
  f.client.managed.repositories[REPOSITORY] = { repository: REPOSITORY, upgradeVerifiedAt: '2026-10-07T00:00:00Z' };
  const observed = new GitHubError('NETWORK_ERROR', 'Connection failed', 'github', { retryable: true, method: 'GET', endpointKind: 'repository', reason: 'network_transport', exitCode: 1 });
  f.github.fault = call => call.endpoint === `repos/${REPOSITORY}` && f.client.managed.repositories[REPOSITORY]?.upgradeAttempt?.stage === 'verify-maintenance' ? observed : null;
  await assert.rejects(f.client.upgrade(REPOSITORY), error => {
    assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.stage, 'upgrade-verify-maintenance');
    assert.equal(error.message, '配置已更新，后续核验待完成。');
    assert.deepEqual(error.upgradeProgress, { stage: 'verify-maintenance', configurationVerified: true, maintenanceVerified: false, commitSha: f.github.head });
    return true;
  });
  const row = f.client.managed.repositories[REPOSITORY];
  assert.equal(row.upgradeVerifiedAt, undefined, 'A prior verified timestamp is not proof of this attempt');
  assert.equal(row.upgradeAttempt.status, 'pending'); assert.equal(row.upgradeAttempt.diagnostic.code, 'NETWORK_ERROR');
  assert.equal(row.upgradeAttempt.diagnostic.stage, 'upgrade-verify-maintenance');
  assert.equal(row.upgradeAttempt.diagnostic.endpointKind, 'repository'); assert.equal(row.upgradeAttempt.diagnostic.method, 'GET');
  assert.notEqual(f.github.head, f.github.initialHead);
  assert.equal(f.github.calls.filter(call => call.method === 'PATCH').length, 1);
  for (const filename of Object.keys(deploymentFiles(f.github.config))) {
    assert.ok(f.github.calls.some(call => call.method === 'GET' && call.endpoint === `repos/${REPOSITORY}/contents/${filename}?ref=${f.github.head}`), 'Every newly written file must be read back');
  }
  f.github.fault = () => null; f.github.calls = []; f.advance();
  const resumed = f.start();
  assert.deepEqual(resumed.managed.repositories[REPOSITORY].upgradeAttempt, row.upgradeAttempt, 'Partial progress must survive restart');
  const result = await resumed.upgrade(REPOSITORY);
  assert.deepEqual(f.github.writes(), [], 'Recovery must not repeat the already successful configuration write or enables');
  assert.equal(result.changed, false); assert.equal(result.upgradeProgress.maintenanceVerified, true);
  assert.notEqual(result.upgradeAttempt.attemptId, row.upgradeAttempt.attemptId);
  assert.equal(result.upgradeVerifiedAt, new Date(NOW + 60000).toISOString());
});

test('a failed initial observation cannot inherit a previous attempt success', async t => {
  const f = fixture(t); await f.client.upgrade(REPOSITORY); f.advance();
  const previous = f.client.managed.repositories[REPOSITORY].upgradeAttempt.attemptId;
  f.github.calls = []; f.github.fault = () => new GitHubError('NETWORK_ERROR', 'Connection failed');
  await assert.rejects(f.client.upgrade(REPOSITORY), error => {
    assert.deepEqual(error.upgradeProgress, { stage: 'inspect', configurationVerified: false, maintenanceVerified: false }); return true;
  });
  const row = f.client.managed.repositories[REPOSITORY];
  assert.equal(row.upgradeVerifiedAt, undefined); assert.equal(row.upgradeAttempt.status, 'failed');
  assert.notEqual(row.upgradeAttempt.attemptId, previous); assert.equal(row.upgradeAttempt.commitSha, undefined);
  assert.deepEqual(f.github.writes(), []);
});

test('verified account-setting edits are reflected locally even when maintenance readback fails', async t => {
  const f = fixture(t);
  await f.client.inspect(REPOSITORY);
  const oldDigest = f.client.managed.repositories[REPOSITORY].configDigest;
  f.github.fault = call => call.endpoint === `repos/${REPOSITORY}` && f.client.managed.repositories[REPOSITORY]?.upgradeAttempt?.stage === 'verify-maintenance'
    ? new GitHubError('NETWORK_ERROR', 'Final observation failed') : null;
  await assert.rejects(f.client.upgrade(REPOSITORY, { expectedDigest: oldDigest, keys: [ACCOUNT], patch: { times: ['12:30', '21:17'], exchangePlan: 'off' } }), error => {
    assert.equal(error.upgradeProgress.configurationVerified, true); return true;
  });
  const row = f.client.managed.accounts[REPOSITORY + '/' + ACCOUNT];
  assert.deepEqual(row.settings.times, ['12:30', '21:17']); assert.equal(row.settings.exchangePlan, 'off');
  assert.notEqual(f.client.managed.repositories[REPOSITORY].configDigest, oldDigest);
  assert.equal(f.client.managed.repositories[REPOSITORY].head, f.github.head);
  f.github.fault = () => null; f.github.calls = [];
  const currentDigest = f.client.managed.repositories[REPOSITORY].configDigest;
  const result = await f.client.upgrade(REPOSITORY, { expectedDigest: currentDigest, keys: [ACCOUNT], patch: { times: ['12:30', '21:17'], exchangePlan: 'off' } });
  assert.equal(result.changed, false); assert.deepEqual(f.github.writes(), []);
});

test('restart marks an interrupted upgrade as pending without resuming any cloud request', async t => {
  const f = fixture(t); await f.client.upgrade(REPOSITORY);
  const row = f.client.managed.repositories[REPOSITORY];
  row.upgradeAttempt = { ...row.upgradeAttempt, stage: 'workflows', status: 'running', maintenanceVerified: false };
  delete row.upgradeAttempt.finishedAt; delete row.upgradeVerifiedAt; f.client.saveManagement();
  f.github.calls = []; f.advance();
  const resumed = f.start(); const attempt = resumed.managed.repositories[REPOSITORY].upgradeAttempt;
  assert.equal(attempt.status, 'pending'); assert.equal(attempt.interrupted, true); assert.equal(attempt.configurationVerified, true);
  assert.equal(attempt.stage, 'workflows'); assert.equal(attempt.attemptId, row.upgradeAttempt.attemptId);
  assert.equal(attempt.startedAt, row.upgradeAttempt.startedAt); assert.deepEqual(f.github.calls, []);
  const result = await resumed.upgrade(REPOSITORY);
  assert.equal(result.upgradeAttempt.status, 'completed'); assert.equal(result.upgradeAttempt.interrupted, undefined);
  assert.deepEqual(f.github.writes(), []);
});

test('only inactive workflows are enabled, and a lost maintenance write response is recovered without another PUT', async t => {
  const f = fixture(t, { retentionDays: 90 }); f.github.workflowStates.set(CLEANUP_FILE, 'disabled_inactivity');
  f.github.fault = call => {
    if (call.method !== 'PUT' || !call.endpoint.endsWith('/artifact-and-log-retention')) return null;
    f.github.retentionDays = 3;
    return new GitHubError('NETWORK_ERROR', 'Lost write response', 'github', { retryable: true });
  };
  await assert.rejects(f.client.upgrade(REPOSITORY), error => {
    assert.equal(error.message, '配置已一致，后续核验待完成。');
    assert.deepEqual(error.upgradeProgress, { stage: 'retention', configurationVerified: true, maintenanceVerified: false, commitSha: f.github.head }); return true;
  });
  assert.deepEqual(f.github.writes().map(call => call.endpoint), [
    `repos/${REPOSITORY}/actions/workflows/${CLEANUP_FILE}/enable`,
    `repos/${REPOSITORY}/actions/permissions/artifact-and-log-retention`,
  ]);
  f.github.fault = () => null; f.github.calls = []; f.advance();
  const result = await f.start().upgrade(REPOSITORY);
  assert.equal(result.upgradeProgress.maintenanceVerified, true); assert.deepEqual(f.github.writes(), []);
});

test('final retention observation failure cannot be swallowed into a fully verified upgrade', async t => {
  const f = fixture(t);
  f.github.fault = call => call.endpoint.endsWith('/artifact-and-log-retention') && f.client.managed.repositories[REPOSITORY]?.upgradeAttempt?.stage === 'verify-maintenance'
    ? new GitHubError('NETWORK_ERROR', 'Observation lost', 'github', { retryable: true, method: 'GET', endpointKind: 'actions-retention', reason: 'network_transport' }) : null;
  await assert.rejects(f.client.upgrade(REPOSITORY), { code: 'NETWORK_ERROR' });
  assert.equal(f.client.managed.repositories[REPOSITORY].upgradeAttempt.configurationVerified, true);
  assert.equal(f.client.managed.repositories[REPOSITORY].upgradeAttempt.maintenanceVerified, false);
  assert.equal(f.client.managed.repositories[REPOSITORY].upgradeAttempt.diagnostic.endpointKind, 'actions-retention');
  assert.equal(f.client.managed.repositories[REPOSITORY].upgradeVerifiedAt, undefined);
  assert.deepEqual(f.github.writes(), []);
});

test('a head change invalidates an earlier immutable-bundle comparison without performing a write', async t => {
  const f = fixture(t); let changed = false;
  f.github.fault = call => {
    if (!changed && call.endpoint.endsWith('/git/ref/heads/main') && f.client.managed.repositories[REPOSITORY]?.upgradeAttempt?.stage === 'verify-config') {
      changed = true; const previous = f.github.head; f.github.head = f.github.sha();
      f.github.commits.set(f.github.head, { tree: clone(f.github.commits.get(previous).tree), parents: [previous] });
    }
    return null;
  };
  await assert.rejects(f.client.upgrade(REPOSITORY), { code: 'CONFIGURATION_UNVERIFIED' });
  assert.equal(changed, true); assert.equal(f.client.managed.repositories[REPOSITORY].upgradeAttempt.configurationVerified, false);
  assert.equal(f.client.managed.repositories[REPOSITORY].upgradeVerifiedAt, undefined); assert.deepEqual(f.github.writes(), []);
});

test('an acknowledged commit with failed readback remains unverified and keeps its exact commit for recovery', async t => {
  const f = fixture(t, { outdated: true });
  f.github.fault = call => call.endpoint.startsWith(`repos/${REPOSITORY}/contents/`) && f.client.managed.repositories[REPOSITORY]?.upgradeAttempt?.stage === 'verify-config'
    ? new GitHubError('NETWORK_ERROR', 'Readback unavailable', 'configuration', { method: 'GET', endpointKind: 'repository-contents' }) : null;
  await assert.rejects(f.client.upgrade(REPOSITORY), error => {
    assert.deepEqual(error.upgradeProgress, { stage: 'verify-config', configurationVerified: false, maintenanceVerified: false, commitSha: f.github.head }); return true;
  });
  assert.notEqual(f.github.head, f.github.initialHead);
  assert.equal(f.client.managed.repositories[REPOSITORY].upgradeAttempt.status, 'failed');
  assert.equal(f.client.managed.repositories[REPOSITORY].upgradeVerifiedAt, undefined);
  assert.equal(f.github.writes().length, 3, 'Only tree/commit/ref writes precede readback; maintenance must not start');
});

test('a repository-wide pause remains paused during configuration recovery', async t => {
  const f = fixture(t, { outdated: true, actionsEnabled: false });
  for (const name of f.github.workflowStates.keys()) f.github.workflowStates.set(name, 'disabled_manually');
  const result = await f.client.upgrade(REPOSITORY);
  assert.equal(result.upgradeProgress.maintenanceVerified, true);
  assert.equal(f.github.writes().some(call => call.endpoint.includes('/enable') || call.endpoint.endsWith('/actions/permissions')), false);
  assert.ok([...f.github.workflowStates.values()].every(state => state === 'disabled_manually'));
});

test('dispatch rejects clear only definite refusals while ambiguous failures preserve the nonce', async t => {
  const cases = [
    ['BAD_REQUEST', 400, true], ['RESOURCE_GONE', 410, true], ['UNSUPPORTED_MEDIA_TYPE', 415, true], ['REQUEST_REJECTED', 406, true],
    ['NETWORK_ERROR', undefined, false], ['INVALID_RESPONSE', undefined, false], ['GITHUB_UNAVAILABLE', 503, false],
  ];
  for (const [code, httpStatus, rejected] of cases) {
    await t.test(code, async t => {
      const f = fixture(t); const scope = REPOSITORY + ':' + WORKFLOW_FILE;
      f.github.fault = call => call.endpoint.endsWith('/dispatches') ? new GitHubError(code, 'Simulated dispatch failure', 'dispatch', { httpStatus }) : null;
      await assert.rejects(f.client.runOperation(REPOSITORY, 'checkin'), { code });
      assert.equal(f.github.writes().length, 1);
      if (rejected) {
        assert.equal(f.client.managed.operations[scope], undefined);
      } else {
        const nonce = f.client.managed.operations[scope].nonce;
        await assert.rejects(f.client.runOperation(REPOSITORY, 'checkin'), { code: 'DISPATCH_UNCERTAIN' });
        assert.equal(f.github.writes().length, 1); assert.equal(f.client.managed.operations[scope].nonce, nonce);
      }
    });
  }
});
