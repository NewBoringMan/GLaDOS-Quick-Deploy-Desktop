'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  GitHubClient, GitHubError, accountKeyFor, validateCredential, parseResults,
  parseHTTPOutput, classifyCommandFailure, renderWorkflow, renderRunner, scheduleToCron, WORKFLOW_FILE,
  WORKFLOW_PATH, KEEPALIVE_PATH, MANIFEST_PATH, MARKER_PATH, UPSTREAM_SHA,
} = require('../src/github.cjs');

function credential(email = 'first@example.test', extra = {}) {
  const record = { cookie: 'gld:sess=fake-session-one; gld:sess.sig=fake-signature', userAgent: 'Mozilla/5.0 Test Browser', origin: 'https://glados.cloud', email, capturedAt: new Date().toISOString(), ...extra };
  record.accountKey = accountKeyFor(record);
  return record;
}
function http(body, status = 200) { return `HTTP/2.0 ${status} OK\r\nContent-Type: application/json\r\n\r\n${body === null ? '' : JSON.stringify(body)}`; }
function fakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    const call = { executable, args, options, input: undefined, killed: false };
    calls.push(call);
    child.kill = () => { call.killed = true; queueMicrotask(() => child.emit('close', 143)); };
    child.stdin.end = input => { call.input = input === undefined ? undefined : Buffer.from(input).toString('utf8'); queueMicrotask(() => handler(child, call)); };
    return child;
  };
  return { spawnImpl, calls };
}

class MemoryGitHub extends GitHubClient {
  constructor() {
    const events = [];
    super({ ghPath: '/fake/gh', onEvent: event => events.push(event), waitTimeoutMs: 0, sleepImpl: async () => {}, spawnImpl: () => { throw new Error('Real processes are forbidden in this mock.'); } });
    this.events = events;
    this.repositories = new Map();
    this.secrets = new Map();
    this.calls = [];
    this.runs = new Map();
    this.dispatchCount = 0;
    this.version = 0;
    this.dispatchResponse = 'modern';
    this.runStatus = 'completed';
    this.currentLogin = 'tester';
    this.currentId = 42;
    this.workflowScope = true;
  }
  sha() { return (++this.version).toString(16).padStart(40, '0'); }
  addRepo(name, managed = false) {
    const full = `tester/${name}`;
    const record = { id: this.repositories.size + 1, full_name: full, owner: { login: 'tester', id: 42 }, permissions: { admin: true }, default_branch: 'main', private: false, files: new Map(), head: this.sha(), tree: this.sha(), trees: new Map(), commits: new Map() };
    record.commits.set(record.head, { tree: { sha: record.tree }, parents: [] });
    if (managed) record.files.set(MARKER_PATH, JSON.stringify({ appId: 'glados-quick-deploy', schemaVersion: 1, repositoryId: record.id }));
    this.repositories.set(full, record);
    return record;
  }
  async _runGh(args, { input, stage } = {}) {
    assert.equal(args[0], 'secret');
    assert.equal(args[1], 'set');
    assert.equal(stage, 'secrets');
    const value = Buffer.from(input).toString('utf8');
    this.secrets.set(`${args[4]}/${args[2]}`, value);
    this.calls.push({ kind: 'secret', args: [...args] });
    return { stdout: '', stderr: '' };
  }
  async _api(endpoint, options = {}) {
    this.calls.push({ endpoint, method: options.method || 'GET', body: options.body, raw: options.raw });
    if (endpoint === 'user') {
      const data = { login: this.currentLogin, id: this.currentId, name: 'Tester', avatar_url: 'https://avatars.githubusercontent.com/u/1' };
      return options.metadata ? { data, workflowScope: this.workflowScope } : data;
    }
    if (endpoint === 'user/repos') {
      const repo = this.addRepo(options.body.name);
      // Deliberately omit permissions, as creation is verified with a subsequent GET.
      return { id: repo.id, full_name: repo.full_name, default_branch: 'main' };
    }
    const match = endpoint.match(/^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/);
    assert.ok(match, `Unexpected endpoint: ${endpoint}`);
    const full = match[1];
    const route = match[2] || '';
    const repo = this.repositories.get(full);
    if (!repo) throw new GitHubError('NOT_FOUND', 'not found', 'repository', { httpStatus: 404 });
    if (!route) return repo;
    if (route.startsWith('contents/')) {
      const filename = route.slice('contents/'.length).split('?')[0];
      const content = repo.files.get(filename);
      if (content === undefined) throw new GitHubError('NOT_FOUND', 'not found', 'configuration', { httpStatus: 404 });
      return { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) };
    }
    if (route.startsWith('git/ref/heads/')) return { object: { sha: repo.head } };
    if (route.startsWith('git/commits/')) return repo.commits.get(route.slice('git/commits/'.length));
    if (route === 'git/trees') {
      const sha = this.sha();
      const files = new Map(repo.files);
      for (const entry of options.body.tree) files.set(entry.path, entry.content);
      repo.trees.set(sha, files);
      return { sha };
    }
    if (route === 'git/commits') {
      const sha = this.sha();
      repo.commits.set(sha, { tree: { sha: options.body.tree }, parents: options.body.parents });
      return { sha };
    }
    if (route.startsWith('git/refs/heads/')) {
      assert.equal(options.body.force, false);
      const commit = repo.commits.get(options.body.sha);
      if (commit.parents[0] !== repo.head) throw new GitHubError('CONFLICT', 'conflict', 'configuration', { httpStatus: 409 });
      repo.head = options.body.sha;
      repo.tree = commit.tree.sha;
      repo.files = repo.trees.get(repo.tree);
      return { object: { sha: repo.head } };
    }
    if (route === 'actions/permissions') return { enabled: true, allowed_actions: 'selected' };
    if (route.startsWith('actions/secrets/')) {
      const name = route.slice('actions/secrets/'.length);
      if (!this.secrets.has(`${full}/${name}`)) throw new GitHubError('NOT_FOUND', 'not found', 'secrets');
      return { name, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
    }
    if (/actions\/workflows\/[^/]+\/(enable|disable)$/.test(route)) return null;
    if (route === `actions/workflows/${WORKFLOW_FILE}/dispatches`) {
      this.dispatchCount++;
      const id = 1000 + this.dispatchCount;
      const keys = options.body.inputs.account_key ? [options.body.inputs.account_key] : JSON.parse(repo.files.get(MANIFEST_PATH)).accounts.map(a => a.accountKey);
      this.runs.set(id, { id, repository: full, path: WORKFLOW_PATH, head_sha: repo.head, event: 'workflow_dispatch', display_title: `GLaDOS Quick Deploy · ${options.body.inputs.deployment_id} · ${options.body.inputs.account_key || 'all'}`, status: this.runStatus, conclusion: this.runStatus === 'completed' ? 'success' : null, run_attempt: 1, keys });
      if (this.dispatchResponse === 'lost') throw new GitHubError('NETWORK_ERROR', 'network failure', 'dispatch', { retryable: true });
      return this.dispatchResponse === 'modern' ? { workflow_run_id: id } : null;
    }
    if (route.startsWith(`actions/workflows/${WORKFLOW_FILE}/runs?`)) return { workflow_runs: [...this.runs.values()].filter(r => r.repository === full).reverse() };
    const jobMatch = route.match(/^actions\/jobs\/(\d+)\/logs$/);
    if (jobMatch) {
      const id = Number(jobMatch[1]);
      const run = this.runs.get(Math.floor(id / 100));
      const key = run.keys[id % 100 - 1];
      assert.equal(options.raw, true);
      return `upstream private diagnostics are never forwarded\n2026-01-01 QUICK_DEPLOY_RESULT=${JSON.stringify({ accountKey: key, outcome: 'checked', pointsAdded: 2, message: 'raw server text MUST NOT REACH UI', exchange: 'not_needed' })}\n`;
    }
    const runMatch = route.match(/^actions\/runs\/(\d+)(\/jobs\?per_page=100(?:&page=\d+)?)?$/);
    if (runMatch) {
      const run = this.runs.get(Number(runMatch[1]));
      if (!run) throw new GitHubError('NOT_FOUND', 'not found', 'verification');
      const jobs = [{ id: run.id * 100, name: 'prepare', status: 'completed' }, ...run.keys.map((key, index) => ({ id: run.id * 100 + index + 1, name: `Account ${key}`, status: 'completed' }))];
      const page = Number(route.match(/[?&]page=(\d+)/)?.[1] || 1);
      return runMatch[2] ? { jobs: jobs.slice((page - 1) * 100, page * 100), total_count: jobs.length } : run;
    }
    throw new Error(`Unexpected mock endpoint: ${endpoint}`);
  }
}

function restartClient(previous) {
  const next = new MemoryGitHub();
  for (const key of ['repositories', 'secrets', 'runs', 'dispatchCount', 'version', 'currentId', 'currentLogin', 'workflowScope']) next[key] = previous[key];
  return next;
}

const snapshotCopy = value => JSON.parse(JSON.stringify(value));

test('verified identity is stable across cookie and browser changes and rejects missing identity', () => {
  const one = credential();
  const two = credential('FIRST@EXAMPLE.TEST', { cookie: 'gld:sess=updated; gld:sess.sig=updated-sig', userAgent: 'Other Browser' });
  assert.equal(one.accountKey, two.accountKey);
  assert.equal(validateCredential(two).accountKey, one.accountKey);
  assert.throws(() => accountKeyFor({}), { code: 'IDENTITY_REQUIRED' });
  assert.throws(() => validateCredential({ ...one, accountKey: '0'.repeat(16) }), { code: 'IDENTITY_MISMATCH' });
  assert.throws(() => validateCredential({ ...one, cookie: one.cookie + '\nInjected: yes' }), { code: 'INVALID_CREDENTIAL' });
  assert.throws(() => validateCredential({ ...one, origin: 'https://glados.rocks' }), { code: 'INVALID_CREDENTIAL' });
  assert.throws(() => validateCredential({ ...one, cookie: 'koa:sess=old; koa:sess.sig=old' }), { code: 'SESSION_INCOMPLETE' });
});

test('Taipei schedule crosses UTC day correctly and invalid schedule cannot enter YAML', () => {
  assert.equal(scheduleToCron('09:30'), '30 1 * * *');
  assert.equal(scheduleToCron('00:05'), '5 16 * * *');
  assert.equal(scheduleToCron('23:59'), '59 15 * * *');
  assert.throws(() => scheduleToCron('24:00'));
  assert.throws(() => scheduleToCron("09:30'\nrun: dangerous"));
  const rendered = renderWorkflow({ accounts: [credential().accountKey] });
  assert.ok(rendered.includes(UPSTREAM_SHA));
  assert.match(rendered, /max-parallel: 1/);
  assert.match(rendered, /account_key:/);
  assert.match(rendered, /matrix: \$\{\{ fromJSON\(needs\.prepare\.outputs\.matrix\) \}\}/);
  assert.match(rendered, /persist-credentials: false/);
});

test('official gh non-TTY login opens exactly the verified device URL without stdin Enter', async () => {
  const emitted = [];
  const opened = [];
  const fake = fakeSpawn((child, call) => {
    if (call.args[0] === 'auth') {
      child.stderr.emit('data', Buffer.from('! First copy your one-time co'));
      child.stderr.emit('data', Buffer.from('de: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n'));
      child.stderr.emit('data', Buffer.from('Authentication complete.\n'));
    } else child.stdout.emit('data', Buffer.from(http({ login: 'tester', id: 42, name: 'Test', avatar_url: 'https://avatars.githubusercontent.com/u/1' })));
    child.emit('close', 0);
  });
  const client = new GitHubClient({ ghPath: '/bundled/gh', spawnImpl: fake.spawnImpl, onEvent: e => emitted.push(e), openExternal: async url => opened.push(url) });
  const user = await client.login();
  assert.equal(user.login, 'tester');
  assert.deepEqual(opened, ['https://github.com/login/device']);
  assert.equal(fake.calls[0].input, undefined);
  assert.equal(fake.calls[0].options.stdio[0], 'pipe');
  assert.equal(fake.calls[0].options.env.GH_PROMPT_DISABLED, '1');
  assert.equal(fake.calls[0].args.includes('--insecure-storage'), false);
  assert.equal(fake.calls.some(c => c.args.includes('logout')), false);
  assert.equal(emitted.filter(e => e.type === 'auth-code').length, 1);
});

test('credential JSON is sent on stdin as one secret and never in argv or events', async () => {
  const fake = fakeSpawn(child => child.emit('close', 0));
  const events = [];
  const client = new GitHubClient({ ghPath: '/bundled/gh', spawnImpl: fake.spawnImpl, onEvent: e => events.push(e) });
  const captured = validateCredential(credential());
  await client._putCredential('tester/glados-quick-deploy', captured);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].args[2], `GLADOS_ACCOUNT_${captured.accountKey}`);
  assert.equal(JSON.parse(fake.calls[0].input).cookie, captured.cookie);
  assert.equal(fake.calls[0].args.join(' ').includes(captured.cookie), false);
  assert.equal(JSON.stringify(events).includes(captured.cookie), false);
  assert.equal(Object.hasOwn(JSON.parse(fake.calls[0].input), 'email'), false);
});

test('abort kills the child and raw GitHub failures never cross the error boundary', async () => {
  const fake = fakeSpawn(() => {});
  const client = new GitHubClient({ ghPath: '/bundled/gh', spawnImpl: fake.spawnImpl });
  const controller = new AbortController();
  const pending = client._runGh(['api', 'user'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.equal(fake.calls[0].killed, true);
  const rejection = fakeSpawn(child => {
    child.stderr.emit('data', Buffer.from('cookie=gld:sess=VERY_PRIVATE (HTTP 401)'));
    child.emit('close', 1);
  });
  const rejected = new GitHubClient({ ghPath: '/bundled/gh', spawnImpl: rejection.spawnImpl });
  await assert.rejects(rejected.whoami(), error => error.code === 'AUTH_REQUIRED' && !JSON.stringify(error).includes('VERY_PRIVATE') && !error.message.includes('VERY_PRIVATE'));
});

test('modern and legacy HTTP output parse without relying on a 204-only dispatch', () => {
  assert.deepEqual(parseHTTPOutput(http(null, 204)), { status: 204, body: '' });
  assert.equal(JSON.parse(parseHTTPOutput(http({ workflow_run_id: 123 })).body).workflow_run_id, 123);
});

test('granted and accepted scope headers never turn normal HTTP failures into missing workflow authorization', () => {
  for (const [status, expected] of [[404, 'NOT_FOUND'], [409, 'CONFLICT'], [422, 'VALIDATION_FAILED'], [403, 'PERMISSION_DENIED']]) {
    const output = `HTTP/2 ${status}\r\nX-OAuth-Scopes: gist, read:org, repo, workflow\r\nX-Accepted-OAuth-Scopes: repo, workflow\r\n\r\n${JSON.stringify({ message: 'Ordinary request failure' })}`;
    assert.equal(classifyCommandFailure(output, `gh: Ordinary request failure (HTTP ${status})`, 'configuration', 1).code, expected);
  }
  const denied = 'refusing to allow an OAuth App to create or update workflow `.github/workflows/checkin.yml` without `workflow` scope';
  assert.equal(classifyCommandFailure(http({ message: denied }, 403), '', 'configuration', 1).code, 'WORKFLOW_AUTH_REQUIRED');
  assert.equal(classifyCommandFailure('', 'missing required workflow scope', 'identity', 1).code, 'WORKFLOW_AUTH_REQUIRED');
  assert.equal(classifyCommandFailure(http({ message: 'Missing required "workflow" scope' }, 403), '', 'configuration', 1).code, 'WORKFLOW_AUTH_REQUIRED');
});

test('whoami exposes only safe identity and an explicit nullable workflow scope', async () => {
  for (const [header, expected] of [['X-OAuth-Scopes: repo, workflow\r\n', true], ['X-OAuth-Scopes: repo\r\n', false], ['X-OAuth-Scopes:\r\n', false], ['', null]]) {
    const fake = fakeSpawn(child => {
      child.stdout.emit('data', Buffer.from(`HTTP/2 200\r\n${header}X-Private: NEVER_FORWARD\r\n\r\n${JSON.stringify({ login: 'tester', id: 42, name: 'Test', private: 'NEVER_FORWARD' })}`));
      child.emit('close', 0);
    });
    const user = await new GitHubClient({ ghPath: '/fake/gh', spawnImpl: fake.spawnImpl }).whoami();
    assert.deepEqual(user, { login: 'tester', id: 42, workflowScope: expected, name: 'Test', avatarUrl: '' });
    assert.equal(JSON.stringify(user).includes('NEVER_FORWARD'), false);
  }
});

test('scope repair uses official refresh, verifies the same immutable GitHub identity and does not prompt on stdin', async () => {
  for (const changed of [false, true]) {
    let userReads = 0;
    const fake = fakeSpawn((child, call) => {
      if (call.args[0] === 'auth') {
        assert.deepEqual(call.args, ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'workflow', '--clipboard=false']);
        child.stderr.emit('data', Buffer.from('First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n'));
      } else {
        userReads++;
        child.stdout.emit('data', Buffer.from(`HTTP/2 200\r\nX-OAuth-Scopes: repo${userReads > 1 ? ', workflow' : ''}\r\n\r\n${JSON.stringify({ login: 'tester', id: changed && userReads > 1 ? 99 : 42 })}`));
      }
      child.emit('close', 0);
    });
    const client = new GitHubClient({ ghPath: '/fake/gh', spawnImpl: fake.spawnImpl });
    if (changed) await assert.rejects(client.login({ refresh: true }), { code: 'WRONG_ACCOUNT' });
    else assert.equal((await client.login({ refresh: true })).workflowScope, true);
    assert.equal(fake.calls.filter(call => call.args[0] === 'auth').length, 1);
    assert.ok(fake.calls.every(call => call.input === undefined));
  }
});

test('a confirmed missing workflow scope stops deployment before creating or writing anything', async () => {
  const client = new MemoryGitHub();
  client.workflowScope = false;
  await assert.rejects(client.deploy({ credential: credential() }), { code: 'WORKFLOW_AUTH_REQUIRED' });
  assert.equal(client.calls.length, 1);
  assert.equal(client.repositories.size, 0);
  assert.equal(client.secrets.size, 0);
});

test('deployment creates an isolated repository, uses atomic non-force commit and verifies only selected account', async () => {
  const client = new MemoryGitHub();
  const unrelated = client.addRepo('glados-quick-deploy');
  unrelated.files.set('important.txt', 'Do not touch');
  const first = credential();
  const outcome = await client.deploy({ credential: first });
  assert.equal(outcome.repository, 'tester/glados-quick-deploy-2');
  assert.equal(outcome.result.status, 'points_increased');
  assert.equal(outcome.result.accounts[0].accountKey, first.accountKey);
  assert.equal(outcome.result.accounts[0].pointsAdded, 2);
  assert.equal(client.dispatchCount, 1);
  assert.equal(unrelated.files.size, 1);
  const managed = client.repositories.get(outcome.repository);
  assert.ok(managed.files.has(WORKFLOW_PATH));
  assert.ok(managed.files.has(KEEPALIVE_PATH));
  assert.equal(managed.files.has('checkin.py'), false);
  assert.equal([...managed.files.values()].join('\n').includes(first.cookie), false);
  assert.equal([...managed.files.values()].join('\n').includes(first.email), false);
  assert.equal(JSON.stringify(outcome).includes('raw server text'), false);
  const beforeRun = client.calls.findIndex(call => call.endpoint?.endsWith('/dispatches'));
  const secretWrite = client.calls.findIndex(call => call.kind === 'secret');
  assert.ok(secretWrite > 0 && secretWrite < beforeRun);
  assert.ok(client.calls.filter(call => call.endpoint?.includes('/git/refs/heads/')).every(call => call.body.force === false));
  const second = credential('second@example.test');
  const next = await client.deploy({ credential: second });
  assert.equal(next.repository, outcome.repository);
  assert.equal(client.dispatchCount, 2);
  assert.deepEqual(next.result.accounts.map(a => a.accountKey), [second.accountKey]);
  const manifest = JSON.parse(managed.files.get(MANIFEST_PATH));
  assert.deepEqual(manifest.accounts.map(a => a.accountKey), [first.accountKey, second.accountKey]);
  assert.equal(client.calls.filter(call => call.endpoint?.endsWith('/dispatches')).at(-1).body.inputs.account_key, second.accountKey);
  assert.equal(client.events.filter(e => e.type === 'run' && e.runId === next.runId).length >= 1, true);
});

test('legacy 204 or a lost dispatch response is matched by nonce without re-dispatch', async () => {
  for (const mode of ['legacy', 'lost']) {
    const client = new MemoryGitHub();
    client.dispatchResponse = mode;
    const result = await client.deploy({ credential: credential() });
    assert.equal(result.runId, 1001);
    assert.equal(result.result.status, 'points_increased');
    assert.equal(client.dispatchCount, 1);
  }
});

test('a running workflow blocks replacement credentials and a second verification dispatch', async () => {
  const client = new MemoryGitHub();
  client.runStatus = 'in_progress';
  const first = credential();
  const initial = await client.deploy({ credential: first });
  assert.equal(initial.status, 'in_progress');
  const secretWrites = client.calls.filter(c => c.kind === 'secret').length;
  const again = await client.deploy({ credential: credential('second@example.test') });
  assert.equal(again.runId, initial.runId);
  assert.equal(again.credentialUpdated, false);
  assert.equal(again.deploymentPending, true);
  assert.equal(client.dispatchCount, 1);
  assert.equal(client.calls.filter(c => c.kind === 'secret').length, secretWrites);
});

test('a ref conflict never forces or silently overwrites an intervening commit', async () => {
  const client = new MemoryGitHub();
  const repo = client.addRepo('glados-quick-deploy', true);
  const oldHead = { sha: repo.head, tree: repo.tree };
  repo.head = client.sha();
  await assert.rejects(client._commitFiles(repo.full_name, 'main', oldHead, { 'ours.txt': 'ours' }, 'configure', undefined), { code: 'REPOSITORY_CHANGED' });
  assert.equal(repo.files.has('ours.txt'), false);
  const writes = client.calls.filter(c => c.endpoint?.includes('/git/refs/heads/'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.force, false);
});

test('result parsing discards untrusted messages and rejects forged identifiers or outcomes', () => {
  const key = credential().accountKey;
  const parsed = parseResults(`noise SECRET\nQUICK_DEPLOY_RESULT=${JSON.stringify({ accountKey: key, outcome: 'checked', pointsAdded: 1, message: 'SECRET_COOKIE', cookie: 'SECRET_COOKIE', exchange: 'not_needed' })}\nQUICK_DEPLOY_RESULT={"accountKey":"../../outside","outcome":"checked"}\n`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].pointsAdded, 1);
  assert.equal(JSON.stringify(parsed).includes('SECRET'), false);
  assert.equal(parseResults(`QUICK_DEPLOY_RESULT=${JSON.stringify({ accountKey: key, outcome: 'pretend_success' })}`).length, 0);
});

test('result parsing strips console formatting and still accepts only complete safe JSON records', () => {
  const key = credential().accountKey;
  const payload = JSON.stringify({ accountKey: key, outcome: 'already_checked', pointsAdded: 0, message: 'PRIVATE_SERVER_TEXT' });
  const parsed = parseResults(`\u001b[36m2026-10-07T12:59:34Z\u001b[0m QUICK_DEPLOY_RESULT=\u001b[32m${payload}\u001b[0m\n`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].outcome, 'already_checked');
  assert.equal(parsed[0].pointsAdded, 0);
  assert.equal(JSON.stringify(parsed).includes('PRIVATE_SERVER_TEXT'), false);
  assert.equal(JSON.stringify(parsed).includes('\u001b'), false);
  assert.equal(parseResults(`\u001b[31mQUICK_DEPLOY_RESULT={"accountKey":"${key}","outcome":"checked"\u001b[0m`).length, 0);
});

test('completed account results survive the real gh raw-log escape guard through the child-process boundary', async () => {
  const key = credential().accountKey;
  const events = [];
  const fake = fakeSpawn((child, call) => {
    const endpoint = call.args.find(arg => arg.startsWith('repos/'));
    assert.equal(call.args[0], 'api');
    assert.equal(call.args[call.args.indexOf('--method') + 1], 'GET');
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(call.options.shell, false);
    if (endpoint === 'repos/tester/glados-quick-deploy/actions/runs/1000') {
      child.stdout.emit('data', Buffer.from(http({ id: 1000, path: WORKFLOW_PATH, status: 'completed', conclusion: 'success', run_attempt: 1 })));
    } else if (endpoint === 'repos/tester/glados-quick-deploy/actions/runs/1000/jobs?per_page=100&page=1') {
      child.stdout.emit('data', Buffer.from(http({ total_count: 2, jobs: [{ id: 100, name: 'prepare', status: 'completed' }, { id: 101, name: `Account ${key}`, status: 'completed' }] })));
    } else if (endpoint === 'repos/tester/glados-quick-deploy/actions/jobs/101/logs') {
      child.stdout.emit('data', Buffer.from('HTTP/2 200 OK\r\nContent-Type: text/plain\r\n\r\n'));
      if (!call.args.includes('--allow-escape-sequences')) {
        // gh 2.102 stops copying at terminal escape sequences and exits nonzero,
        // before the structured record near the end of a real Actions job log.
        child.stdout.emit('data', Buffer.from('Set up job\n'));
        child.stderr.emit('data', Buffer.from('the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway\n'));
        child.emit('close', 1);
        return;
      }
      child.stdout.emit('data', Buffer.from('\u001b[36;1mRun Python\u001b[0m\nPRIVATE_RAW_LOG\n'));
      child.stdout.emit('data', Buffer.from(`2026-10-07T12:59:34.1515834Z QUICK_DEPLOY_RESULT=\u001b[32m${JSON.stringify({ accountKey: key, outcome: 'checked', exchange: 'not_needed', pointsAdded: 0, message: 'PRIVATE_SERVER_TEXT', cookie: 'PRIVATE_COOKIE' })}\u001b[0m\n`));
    } else assert.fail(`Unexpected endpoint: ${endpoint}`);
    child.emit('close', 0);
  });
  const client = new GitHubClient({ ghPath: '/bundled/gh', spawnImpl: fake.spawnImpl, onEvent: event => events.push(event) });
  const result = await client._readRun('tester/glados-quick-deploy', 1000);
  assert.equal(result.conclusion, 'success');
  assert.equal(result.result.status, 'checked');
  assert.equal(result.result.accounts[0].pointsAdded, 0);
  assert.equal(result.result.readError, undefined);
  assert.equal(result.result.accounts[0].message, '服务端已接受签到；本次未核实新增积分。');
  assert.equal(JSON.stringify({ result, events }).includes('PRIVATE_'), false);
  assert.equal(fake.calls.filter(call => call.args.includes('--allow-escape-sequences')).length, 1);
  assert.equal(client._completedResults.size, 1);
});

test('raw escape output is enabled only for GET requests to exact job-log endpoints', async () => {
  const fake = fakeSpawn(child => {
    child.stdout.emit('data', Buffer.from(http({ ok: true })));
    child.emit('close', 0);
  });
  const client = new GitHubClient({ ghPath: '/bundled/gh', spawnImpl: fake.spawnImpl });
  const scenarios = [
    ['user', {}, false],
    ['user', { raw: true }, false],
    ['repos/tester/project/actions/jobs/123/logs', {}, false],
    ['repos/tester/project/actions/jobs/123/logs', { raw: true }, true],
    ['repos/tester/project/actions/jobs/123/logs', { raw: true, method: 'POST' }, false],
    ['repos/tester/project/actions/runs/123/logs', { raw: true }, false],
    ['repos/tester/project/actions/jobs/123/logs?extra=true', { raw: true }, false],
  ];
  for (const [endpoint, options, expected] of scenarios) {
    await client._api(endpoint, options);
    assert.equal(fake.calls.at(-1).args.includes('--allow-escape-sequences'), expected, endpoint);
  }
});

test('an account job cannot supply a missing result for another account job', async () => {
  const first = credential().accountKey;
  const second = credential('second@example.test').accountKey;
  const fake = fakeSpawn((child, call) => {
    const endpoint = call.args.find(arg => arg.startsWith('repos/'));
    if (endpoint.endsWith('/jobs?per_page=100&page=1')) {
      child.stdout.emit('data', Buffer.from(http({ total_count: 2, jobs: [{ id: 101, name: `Account ${first}`, status: 'completed' }, { id: 102, name: `Account ${second}`, status: 'completed' }] })));
    } else if (endpoint.endsWith('/jobs/101/logs')) {
      child.stdout.emit('data', Buffer.from(`HTTP/2 200 OK\r\nContent-Type: text/plain\r\n\r\nQUICK_DEPLOY_RESULT=${JSON.stringify({ accountKey: first, outcome: 'checked' })}\nQUICK_DEPLOY_RESULT=${JSON.stringify({ accountKey: second, outcome: 'checked' })}\n`));
    } else if (endpoint.endsWith('/jobs/102/logs')) {
      child.stdout.emit('data', Buffer.from('HTTP/2 200 OK\r\nContent-Type: text/plain\r\n\r\nNo account result was produced.\n'));
    } else if (endpoint.endsWith('/actions/runs/1000')) {
      child.stdout.emit('data', Buffer.from(http({ id: 1000, path: WORKFLOW_PATH, status: 'completed', conclusion: 'success' })));
    } else assert.fail(`Unexpected endpoint: ${endpoint}`);
    child.emit('close', 0);
  });
  const client = new GitHubClient({ ghPath: '/bundled/gh', spawnImpl: fake.spawnImpl });
  const result = await client._readRun('tester/glados-quick-deploy', 1000);
  assert.equal(result.result.status, 'unverified');
  assert.equal(result.result.readError, 'INCOMPLETE_RESULTS');
  assert.deepEqual(result.result.accounts.map(account => account.accountKey), [first]);
  assert.equal(client._completedResults.size, 0);
});

const FAKE_UPSTREAM = `import json, os
DOMAINS = ['https://untrusted.invalid']
def log(*args): print(*args)
class GLaDOS:
    def __init__(self, cookie):
        assert DOMAINS == ['https://glados.cloud']
        assert os.environ['GLADOS_USER_AGENT'] == 'Mozilla/5.0 Test Browser'
        self.cookie = cookie
        self.points = '?'
        self.reads = 0
    def get_points(self):
        self.reads += 1
        print('HIDDEN_COOKIE ' + self.cookie)
        self.points = '100' if self.reads == 1 else '102'
        return True
    def checkin(self):
        with open('calls.txt', 'a') as out: out.write('checkin\\n')
        if os.environ.get('FAKE_MODE') == 'exception':
            raise ValueError('HIDDEN_COOKIE ' + self.cookie)
        return json.loads(os.environ['FAKE_RESPONSE'])
def is_normal_checkin_result(value):
    return isinstance(value, dict) and (value.get('code') == 0 or 'checkin repeats' in value.get('message', '').lower())
def auto_exchange(client, plan):
    with open('exchange.txt', 'a') as out: out.write(plan + '\\n')
    return '🎁 兑换成功 +100天'
`;

function runAdapter(t, response, { mode = '', plan = 'plan500' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-adapter-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'upstream'));
  fs.writeFileSync(path.join(directory, 'upstream', 'checkin.py'), FAKE_UPSTREAM);
  fs.writeFileSync(path.join(directory, 'runner.py'), renderRunner());
  const captured = credential();
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  // A fresh Windows CI worker may need more time to start Python; the fixture
  // still makes one local attempt and keeps every side-effect assertion below.
  const output = spawnSync(python, ['runner.py'], { cwd: directory, encoding: 'utf8', timeout: process.platform === 'win32' ? 30000 : 10000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', GLADOS_ACCOUNT_KEY: captured.accountKey, GLADOS_ACCOUNT_JSON: JSON.stringify({ cookie: captured.cookie, userAgent: captured.userAgent, origin: captured.origin }), EXCHANGE_PLAN: plan, FAKE_RESPONSE: JSON.stringify(response), FAKE_MODE: mode },
  });
  assert.ifError(output.error);
  assert.equal(output.stderr, '');
  assert.equal(output.stdout.includes(captured.cookie), false);
  assert.equal(output.stdout.includes('HIDDEN_COOKIE'), false);
  assert.equal(output.stdout.trim().split('\n').length, 1);
  const result = JSON.parse(output.stdout.trim().slice('QUICK_DEPLOY_RESULT='.length));
  return { output, result, directory };
}

test('adapter attempts once, stops device/permission rejection, and never exchanges on failure', t => {
  const { output, result, directory } = runAdapter(t, { code: -2, reason: 'device-mismatch', message: 'Automated check-in detected. HIDDEN_COOKIE' });
  assert.equal(output.status, 1);
  assert.equal(result.outcome, 'authentication_required');
  assert.equal(result.errorKind, 'authentication');
  assert.equal(fs.readFileSync(path.join(directory, 'calls.txt'), 'utf8').replace(/\r\n/g, '\n'), 'checkin\n');
  assert.equal(fs.existsSync(path.join(directory, 'exchange.txt')), false);
  assert.equal(Object.hasOwn(result, 'pointsAdded'), false);
});

test('adapter measures credit before redemption and accepts already-checked without claiming a new check-in', t => {
  const accepted = runAdapter(t, { code: 0, message: 'Checkin! Got 2 points.' });
  assert.equal(accepted.output.status, 0);
  assert.equal(accepted.result.outcome, 'checked');
  assert.equal(accepted.result.pointsAdded, 2);
  assert.equal(accepted.result.exchange, 'completed');
  assert.equal(fs.readFileSync(path.join(accepted.directory, 'exchange.txt'), 'utf8').replace(/\r\n/g, '\n'), 'plan500\n');
  const repeated = runAdapter(t, { code: 1, message: 'Checkin repeats! Please try tomorrow' }, { plan: 'off' });
  assert.equal(repeated.output.status, 0);
  assert.equal(repeated.result.outcome, 'already_checked');
  assert.equal(repeated.result.exchange, 'disabled');
  assert.equal(fs.existsSync(path.join(repeated.directory, 'exchange.txt')), false);
});

test('upstream exceptions stay private and cannot turn a failed job green', t => {
  const { output, result } = runAdapter(t, { code: 0 }, { mode: 'exception' });
  assert.equal(output.status, 1);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorKind, 'execution');
});

test('wrong GitHub identity cannot pause another account deployment', async () => {
  const client = new MemoryGitHub();
  client.addRepo('glados-quick-deploy', true);
  client.currentLogin = 'someone-else';
  await assert.rejects(client.pause({ repository: 'tester/glados-quick-deploy', paused: true }), { code: 'WRONG_ACCOUNT' });
  assert.equal(client.calls.some(c => c.endpoint?.endsWith('/disable')), false);
});

test('account refresh selects that account run and a mismatched pinned run stays unverified', async () => {
  const client = new MemoryGitHub();
  const first = credential();
  const second = credential('second@example.test');
  const initial = await client.deploy({ credential: first });
  const later = await client.deploy({ credential: second });
  const eventCount = client.events.filter(e => e.type === 'run').length;
  const refreshed = await client.refresh({ repository: initial.repository, accountKey: first.accountKey });
  assert.equal(refreshed.runId, initial.runId);
  assert.equal(refreshed.result.status, 'points_increased');
  const wrong = await client.refresh({ repository: initial.repository, accountKey: first.accountKey, runId: later.runId });
  assert.equal(wrong.result.status, 'unverified');
  assert.equal(wrong.result.requestedAccountMissing, true);
  assert.equal(client.events.filter(e => e.type === 'run').length, eventCount);
});

test('results paginate 100 accounts plus prepare and never treat missing records as verified', async () => {
  const client = new GitHubClient({ ghPath: '/fake/gh' });
  const keys = Array.from({ length: 100 }, (_, i) => accountKeyFor({ email: `account${i}@example.test` }));
  const jobs = [{ id: 1, name: 'prepare', status: 'completed' }, ...keys.map((key, i) => ({ id: i + 2, name: `Account ${key}`, status: 'completed' }))];
  const pages = [];
  client._api = async (endpoint) => {
    if (endpoint.includes('/jobs?')) {
      const page = Number(endpoint.match(/page=(\d+)$/)[1]);
      pages.push(page);
      return { total_count: 101, jobs: jobs.slice((page - 1) * 100, page * 100) };
    }
    if (endpoint.endsWith('/logs')) {
      const id = Number(endpoint.match(/jobs\/(\d+)/)[1]);
      return 'QUICK_DEPLOY_RESULT=' + JSON.stringify({ accountKey: keys[id - 2], outcome: 'checked', pointsAdded: 0, exchange: 'disabled' });
    }
    return { id: 1, status: 'completed', conclusion: 'success', path: WORKFLOW_PATH };
  };
  const complete = await client._readRun('tester/glados-quick-deploy', 1);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(complete.result.accounts.length, 100);
  assert.equal(complete.result.accounts.at(-1).accountKey, keys.at(-1));
  assert.equal(complete.result.status, 'checked');
  client._completedResults.clear();
  const originalApi = client._api;
  client._api = async endpoint => endpoint.includes('/jobs/101/logs') ? 'No structured result' : originalApi(endpoint);
  const incomplete = await client._readRun('tester/glados-quick-deploy', 1);
  assert.equal(incomplete.conclusion, 'success');
  assert.equal(incomplete.result.status, 'unverified');
  assert.equal(incomplete.result.readError, 'INCOMPLETE_RESULTS');
});

test('resolving a previous uncertain dispatch never marks current credentials as deployed', async () => {
  const events = [];
  const client = new GitHubClient({ ghPath: '/fake/gh', onEvent: e => events.push(e) });
  const record = credential();
  client._pendingDispatches.set('tester/glados-quick-deploy', { nonce: 'previous-nonce', branch: 'main', accountKey: record.accountKey });
  client._api = async (endpoint, options) => {
    assert.equal(options.method, undefined);
    assert.ok(endpoint.includes('/runs?'));
    return { workflow_runs: [{ id: 23, event: 'workflow_dispatch', status: 'in_progress', display_title: `GLaDOS Quick Deploy · previous-nonce · ${record.accountKey}` }] };
  };
  const snapshot = await client._startVerification('tester/glados-quick-deploy', 'main');
  assert.equal(snapshot.runId, 23);
  assert.equal(events[0].credentialUpdated, false);
  assert.equal(events[0].resumed, true);
});

test('initial auto-init 409 is bounded and retryable only for the newly created repository', async () => {
  const client = new MemoryGitHub();
  const originalHead = client._head.bind(client);
  let calls = 0;
  client._head = async (...args) => {
    if (++calls === 1) throw new GitHubError('CONFLICT', 'initializing', 'configuration', { httpStatus: 409 });
    return originalHead(...args);
  };
  const outcome = await client.deploy({ credential: credential() });
  assert.equal(outcome.result.status, 'points_increased');
  assert.ok(calls >= 2);
});

test('verification deadline returns the known queued run and cancels an outstanding request', async () => {
  const client = new GitHubClient({ ghPath: '/fake/gh', waitTimeoutMs: 15 });
  let requestAborted = false;
  client._readRun = async (_repository, _id, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { requestAborted = true; reject(new GitHubError('ABORTED', 'cancelled')); }, { once: true });
  });
  const snapshot = { repository: 'tester/glados-quick-deploy', runId: 999, status: 'queued', conclusion: null };
  const outcome = await client._waitForRun(snapshot);
  assert.equal(outcome.runId, 999);
  assert.equal(outcome.status, 'queued');
  assert.equal(requestAborted, true);
});

test('a persisted uploaded secret resumes after restart without a cookie or a second secret write', async () => {
  const original = new MemoryGitHub();
  const captured = credential();
  let saved;
  await assert.rejects(original.deploy({ credential: captured, onCheckpoint: async next => {
    saved = snapshotCopy(next);
    assert.equal(JSON.stringify(next).includes(captured.cookie), false);
    assert.equal(JSON.stringify(next).includes(captured.email), false);
    if (next.secretStored) throw new Error('Simulated application interruption');
  } }), { code: 'CHECKPOINT_SAVE_FAILED' });
  assert.equal(saved.secretStored, true);
  assert.equal(saved.configured, false);
  assert.equal(original.dispatchCount, 0);
  const restarted = restartClient(original);
  const result = await restarted.deploy({ checkpoint: saved, onCheckpoint: async next => { saved = snapshotCopy(next); } });
  assert.equal(result.result.status, 'points_increased');
  assert.equal(restarted.calls.some(call => call.kind === 'secret'), false);
  assert.equal(restarted.repositories.size, 1);
  assert.equal(saved.run.runId, result.runId);
});

test('checkpoint persistence failure stops before the next side effect including dispatch', async () => {
  const untouched = new MemoryGitHub();
  await assert.rejects(untouched.deploy({ credential: credential(), onCheckpoint: async () => { throw new Error('DISK_SECRET_DO_NOT_LEAK'); } }), error => error.code === 'CHECKPOINT_SAVE_FAILED' && !error.message.includes('DISK_SECRET'));
  assert.equal(untouched.repositories.size, 0);
  assert.equal(untouched.secrets.size, 0);
  const client = new MemoryGitHub();
  let saved;
  await assert.rejects(client.deploy({ credential: credential(), onCheckpoint: async next => {
    if (next.dispatch) throw new Error('Disk full');
    saved = snapshotCopy(next);
  } }), { code: 'CHECKPOINT_SAVE_FAILED' });
  assert.equal(saved.configured, true);
  assert.equal(saved.dispatch, undefined);
  assert.equal(client.dispatchCount, 0);
});

test('creation checkpoint adopts only the exact newly created repository and never overwrites a foreign marker', async () => {
  for (const foreignMarker of [undefined, null, { appId: 'foreign', schemaVersion: 1, repositoryId: 1 }]) {
    const original = new MemoryGitHub();
    let saved;
    await assert.rejects(original.deploy({ credential: credential(), onCheckpoint: async next => {
      saved = snapshotCopy(next);
      if (next.createdRepository) throw new Error('Crash before marker');
    } }), { code: 'CHECKPOINT_SAVE_FAILED' });
    assert.equal(original.repositories.size, 1);
    const repo = original.repositories.get(saved.repository);
    assert.equal(repo.files.has(MARKER_PATH), false);
    repo.files.set('unrelated.txt', 'Preserve this file');
    if (foreignMarker !== undefined) repo.files.set(MARKER_PATH, JSON.stringify(foreignMarker));
    const restarted = restartClient(original);
    const parameters = { checkpoint: saved, credential: credential(), onCheckpoint: async next => { saved = snapshotCopy(next); } };
    if (foreignMarker !== undefined) {
      await assert.rejects(restarted.deploy(parameters), { code: 'UNMANAGED_REPOSITORY' });
      assert.equal(restarted.calls.some(call => call.method === 'POST' || call.kind === 'secret'), false);
    } else {
      await restarted.deploy(parameters);
      assert.equal(saved.createdRepository, undefined);
      assert.equal(restarted.repositories.size, 1);
      assert.equal(repo.files.get('unrelated.txt'), 'Preserve this file');
    }
  }
});

test('configured checkpoints verify remote files and do not commit again; modified configurations stop safely', async () => {
  for (const changed of [false, true]) {
    const original = new MemoryGitHub();
    let saved;
    await assert.rejects(original.deploy({ credential: credential(), onCheckpoint: async next => {
      saved = snapshotCopy(next);
      if (next.configured) throw new Error('Crash after configuration');
    } }), { code: 'CHECKPOINT_SAVE_FAILED' });
    const repo = original.repositories.get(saved.repository);
    if (changed) repo.files.set(WORKFLOW_PATH, 'External modification');
    const restarted = restartClient(original);
    if (changed) await assert.rejects(restarted.deploy({ checkpoint: saved }), { code: 'CONFIGURATION_CHANGED' });
    else assert.equal((await restarted.deploy({ checkpoint: saved })).result.status, 'points_increased');
    assert.equal(restarted.calls.some(call => call.endpoint?.endsWith('/git/trees') || call.kind === 'secret'), false);
    assert.equal(restarted.dispatchCount, changed ? 0 : 1);
  }
});

test('a dropped dispatch response survives restart and recovers the exact nonce without another POST', async () => {
  const original = new MemoryGitHub();
  original.dispatchResponse = 'lost';
  original._findRun = async () => { throw new GitHubError('NETWORK_ERROR', 'disconnected', 'verification', { retryable: true }); };
  let saved;
  await assert.rejects(original.deploy({ credential: credential(), onCheckpoint: async next => { saved = snapshotCopy(next); } }), { code: 'NETWORK_ERROR' });
  assert.equal(original.dispatchCount, 1);
  assert.ok(saved.dispatch?.nonce);
  assert.equal(saved.run, undefined);
  const restarted = restartClient(original);
  restarted.workflowScope = false;
  const result = await restarted.deploy({ checkpoint: saved, onCheckpoint: async next => { saved = snapshotCopy(next); } });
  assert.equal(result.runId, 1001);
  assert.equal(result.result.status, 'points_increased');
  assert.equal(restarted.dispatchCount, 1);
  assert.ok(restarted.calls.every(call => call.method === 'GET'));
  assert.equal(restarted.events.find(event => event.type === 'run').credentialUpdated, true);
  const onceMore = restartClient(restarted);
  const again = await onceMore.deploy({ checkpoint: saved });
  assert.equal(again.runId, 1001);
  assert.ok(onceMore.calls.every(call => call.method === 'GET'));
  assert.equal(onceMore.dispatchCount, 1);
});

test('an unresolved durable dispatch intent remains available and is never reposted', async () => {
  const original = new MemoryGitHub();
  let saved;
  await assert.rejects(original.deploy({ credential: credential(), onCheckpoint: async next => {
    saved = snapshotCopy(next);
    if (next.dispatch) throw new Error('Crash after durable intent but before HTTP');
  } }), { code: 'CHECKPOINT_SAVE_FAILED' });
  const restarted = restartClient(original);
  await assert.rejects(restarted.deploy({ checkpoint: saved }), { code: 'DISPATCH_UNCERTAIN' });
  assert.equal(restarted.dispatchCount, 0);
  assert.ok(saved.dispatch.nonce);
  assert.equal(restarted._pendingDispatches.get(saved.repository).nonce, saved.dispatch.nonce);
  assert.ok(restarted.calls.every(call => call.method === 'GET'));
});

test('resume rejects changed immutable GitHub or repository identity before any writes', async () => {
  for (const change of ['user-id', 'login', 'repository-id', 'owner-id']) {
    const original = new MemoryGitHub();
    let saved;
    await assert.rejects(original.deploy({ credential: credential(), onCheckpoint: async next => {
      saved = snapshotCopy(next);
      if (next.secretStored) throw new Error('Stop after upload');
    } }), { code: 'CHECKPOINT_SAVE_FAILED' });
    const restarted = restartClient(original);
    if (change === 'user-id') restarted.currentId = 99;
    if (change === 'login') restarted.currentLogin = 'different-user';
    if (change === 'repository-id') restarted.repositories.get(saved.repository).id = 99;
    if (change === 'owner-id') restarted.repositories.get(saved.repository).owner.id = 99;
    await assert.rejects(restarted.deploy({ checkpoint: saved }), { code: ['repository-id', 'owner-id'].includes(change) ? 'REPOSITORY_IDENTITY_CHANGED' : 'WRONG_ACCOUNT' });
    assert.ok(restarted.calls.every(call => call.method === 'GET'));
    assert.equal(restarted.dispatchCount, 0);
  }
});

test('resuming configuration merges the fresh remote accounts instead of overwriting a later addition', async () => {
  const original = new MemoryGitHub();
  let saved;
  const first = credential();
  const second = credential('second@example.test');
  await assert.rejects(original.deploy({ credential: first, onCheckpoint: async next => {
    saved = snapshotCopy(next);
    if (next.secretStored) throw new Error('Interrupt first account configuration');
  } }), { code: 'CHECKPOINT_SAVE_FAILED' });
  const otherDeployment = restartClient(original);
  await otherDeployment.deploy({ credential: second });
  const restarted = restartClient(otherDeployment);
  const result = await restarted.deploy({ checkpoint: saved });
  const manifest = JSON.parse(restarted.repositories.get(saved.repository).files.get(MANIFEST_PATH));
  assert.deepEqual(new Set(manifest.accounts.map(account => account.accountKey)), new Set([first.accountKey, second.accountKey]));
  assert.equal(result.result.accounts[0].accountKey, first.accountKey);
  assert.equal(restarted.calls.some(call => call.kind === 'secret'), false);
});
