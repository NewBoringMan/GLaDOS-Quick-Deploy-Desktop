'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { GitHubClient, GitHubError, classifyCommandFailure, safeGitHubDiagnostic, WORKFLOW_PATH } = require('../src/github.cjs');

// Exercise actual process pipes and HTTP responses without credentials, gh auth,
// or external traffic. This small child uses the app's real argv/stdin contract
// and emits gh-style included headers, exit statuses and connection diagnostics.
const HTTP_CHILD = String.raw`
  const http = require('node:http');
  const args = process.argv.slice(1);
  const method = args[args.indexOf('--method') + 1];
  const endpoint = args.find(value => value === 'user' || value === 'user/repos' || value.startsWith('repos/'));
  const target = new URL('/' + endpoint, process.env.GQD_TEST_HTTP_ORIGIN);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    const headers = args.includes('--input') ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(input) } : {};
    const request = http.request(target, { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        process.stdout.write('HTTP/1.1 ' + response.statusCode + ' fixture\r\nContent-Type: application/json\r\n\r\n');
        process.stdout.write(Buffer.concat(chunks));
        if (response.headers['x-fixture-cli-failure'] === '1') {
          process.stderr.write('PRIVATE_CLI_DETAIL_AFTER_RESPONSE\n');
          process.exitCode = 2;
        } else if (response.statusCode >= 400) {
          process.stderr.write('gh: fixture rejected request (HTTP ' + response.statusCode + ')\n');
          process.exitCode = 1;
        }
      });
    });
    request.on('error', error => {
      process.stderr.write(method + ' "' + target.href + '": ' + (error.code === 'ECONNRESET' ? 'EOF' : error.code) + '\n');
      process.exitCode = 1;
    });
    request.end(input);
  });
`;

async function boundary(t, respond) {
  const requests = [];
  const invocations = [];
  const sleeps = [];
  const server = http.createServer((request, response) => {
    let input = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { input += chunk; });
    request.on('end', () => {
      const record = { method: request.method, path: request.url, input };
      requests.push(record);
      respond({ request, response, record, count: requests.length });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new GitHubClient({
    ghPath: 'isolated-http-child',
    sleepImpl: async delay => { sleeps.push(delay); },
    spawnImpl: (_executable, args, options) => {
      invocations.push({ args: [...args], shell: options.shell, stdio: options.stdio });
      if (args[0] === 'auth') {
        return spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.stderr.write('Authentication complete.\\n'));"], options);
      }
      return spawn(process.execPath, ['-e', HTTP_CHILD, ...args], {
        ...options, env: { ...options.env, GQD_TEST_HTTP_ORIGIN: origin },
      });
    },
  });
  return { client, requests, invocations, sleeps };
}

function jsonResponse(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

test('bare EOF and HTTP2 resets are network failures with safe reasons', () => {
  const cases = [
    ['Get "https://api.github.com/repos/PRIVATE_OWNER/PRIVATE_REPO": EOF', 'network_eof'],
    ['EOF', 'network_eof'],
    ['stream error: stream ID 1; INTERNAL_ERROR; received from peer', 'http2_stream'],
    ['http2: server sent GOAWAY and closed the connection', 'http2_stream'],
    ['INTERNAL_ERROR', 'http2_stream'],
  ];
  for (const [stderr, reason] of cases) {
    const error = classifyCommandFailure('', stderr, 'upgrade-inspect', 1);
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.retryable, true);
    assert.deepEqual(safeGitHubDiagnostic(error), { code: 'NETWORK_ERROR', stage: 'upgrade-inspect', exitCode: 1, reason });
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|api\.github\.com|stream ID/);
  }
});

test('safe diagnostics reject unknown values, raw fields and identifiers', () => {
  const unsafe = { code: 'PRIVATE_TOKEN', stage: 'PRIVATE_STAGE', httpStatus: 1000, exitCode: 1.5,
    reason: 'PRIVATE_REASON', method: 'PRIVATE_METHOD', endpointKind: 'repos/PRIVATE_OWNER/PRIVATE_REPO',
    stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR', body: 'PRIVATE_BODY', url: 'https://PRIVATE_HOST', token: 'PRIVATE_TOKEN' };
  assert.deepEqual(safeGitHubDiagnostic(unsafe), { code: 'OPERATION_FAILED', stage: 'github' });
  const safe = new GitHubError('BAD_REQUEST', 'safe fixed message', 'dispatch', {
    httpStatus: 400, exitCode: 1, reason: 'http_rejected', method: 'POST', endpointKind: 'actions-dispatch',
    token: 'PRIVATE_TOKEN', stdout: 'PRIVATE_STDOUT', body: 'PRIVATE_BODY',
  });
  assert.deepEqual(safeGitHubDiagnostic(safe), { code: 'BAD_REQUEST', stage: 'dispatch', httpStatus: 400,
    exitCode: 1, reason: 'http_rejected', method: 'POST', endpointKind: 'actions-dispatch' });
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_/);
});

test('a GET survives a dropped connection and a 503 across real child and HTTP boundaries', async t => {
  const fixture = await boundary(t, ({ request, response, count }) => {
    if (count === 1) request.socket.destroy();
    else if (count === 2) jsonResponse(response, 503, { message: 'PRIVATE_SERVER_MESSAGE' });
    else jsonResponse(response, 200, { workflows: [{ state: 'active' }] });
  });
  const result = await fixture.client._api('repos/PRIVATE_OWNER/PRIVATE_REPO/actions/workflows', { stage: 'upgrade-inspect' });
  assert.deepEqual(result, { workflows: [{ state: 'active' }] });
  assert.equal(fixture.requests.length, 3);
  assert.deepEqual(fixture.sleeps, [500, 1500]);
  assert.ok(fixture.requests.every(request => request.method === 'GET'));
  assert.ok(fixture.invocations.every(call => call.shell === false && call.stdio.join(',') === 'pipe,pipe,pipe'));
});

test('a persistently unavailable GET stops at three attempts and retains safe diagnostics', async t => {
  const fixture = await boundary(t, ({ response }) => jsonResponse(response, 503, { message: 'PRIVATE_SERVER_BODY' }));
  await assert.rejects(fixture.client._api('repos/PRIVATE_OWNER/PRIVATE_REPO/actions/permissions/artifact-and-log-retention', {
    stage: 'upgrade-retention',
  }), error => {
    assert.deepEqual(safeGitHubDiagnostic(error), {
      code: 'GITHUB_UNAVAILABLE', stage: 'upgrade-retention', httpStatus: 503, exitCode: 1,
      reason: 'service_unavailable', method: 'GET', endpointKind: 'actions-retention',
    });
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|127\.0\.0\.1|https?:/);
    return true;
  });
  assert.equal(fixture.requests.length, 3);
  assert.deepEqual(fixture.sleeps, [500, 1500]);
});

test('POST dispatch and other writes are sent once even when the accepted connection drops', async t => {
  const cases = [
    ['POST', 'actions/workflows/glados-quick-deploy.yml/dispatches', 'actions-dispatch'],
    ['PUT', 'actions/permissions/artifact-and-log-retention', 'actions-retention'],
    ['PATCH', 'git/refs/heads/main', 'git-reference'],
    ['DELETE', 'actions/runs/123', 'actions-run'],
  ];
  for (const [method, path, kind] of cases) {
    await t.test(method, async subtest => {
      const fixture = await boundary(subtest, ({ request }) => request.socket.destroy());
      const body = { ref: 'main', inputs: { deployment_id: 'PRIVATE_NONCE', token: 'PRIVATE_BODY' } };
      await assert.rejects(fixture.client._api(`repos/PRIVATE_OWNER/PRIVATE_REPO/${path}`, {
        method, body, stage: 'dispatch',
      }), error => {
        assert.deepEqual(safeGitHubDiagnostic(error), {
          code: 'NETWORK_ERROR', stage: 'dispatch', exitCode: 1, reason: 'network_eof', method, endpointKind: kind,
        });
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|127\.0\.0\.1|https?:/);
        return true;
      });
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.invocations.length, 1);
      assert.equal(fixture.requests[0].input, JSON.stringify(body));
      assert.equal(fixture.invocations[0].args.includes('--input'), true);
      assert.doesNotMatch(fixture.invocations[0].args.join(' '), /PRIVATE_NONCE|PRIVATE_BODY/);
      assert.deepEqual(fixture.sleeps, []);
    });
  }
});

test('explicit request rejection is classified and is never retried, including a dispatch rejection', async t => {
  const cases = [[400, 'BAD_REQUEST'], [410, 'RESOURCE_GONE'], [415, 'UNSUPPORTED_MEDIA_TYPE'], [405, 'REQUEST_REJECTED'], [403, 'PERMISSION_DENIED']];
  let status = 400;
  const fixture = await boundary(t, ({ response }) => jsonResponse(response, status, { message: 'PRIVATE_REJECTION' }));
  for (const [nextStatus, code] of cases) {
    status = nextStatus;
    const before = fixture.requests.length;
    await assert.rejects(fixture.client._api('repos/PRIVATE_OWNER/PRIVATE_REPO/actions/workflows', { stage: 'upgrade-inspect' }), error => {
      assert.equal(error.code, code);
      assert.equal(error.httpStatus, status);
      assert.equal(error.exitCode, 1);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(fixture.requests.length, before + 1);
  }
  status = 400;
  await assert.rejects(fixture.client._api('repos/PRIVATE_OWNER/PRIVATE_REPO/actions/workflows/glados-quick-deploy.yml/dispatches', {
    method: 'POST', body: { ref: 'main' }, stage: 'dispatch',
  }), { code: 'BAD_REQUEST', httpStatus: 400, method: 'POST', endpointKind: 'actions-dispatch' });
  assert.equal(fixture.requests.length, cases.length + 1);
  assert.deepEqual(fixture.sleeps, []);
});

test('unknown CLI failures do not suggest reauthorization or automatically retry', async () => {
  let spawned = 0;
  const client = new GitHubClient({
    ghPath: 'isolated-failing-child',
    sleepImpl: async () => assert.fail('unknown failures must not be retried'),
    spawnImpl: (_executable, _args, options) => {
      spawned++;
      return spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('PRIVATE_CLI_DETAIL'); process.exitCode = 2; });"], options);
    },
  });
  await assert.rejects(client._api('user'), error => {
    assert.deepEqual(safeGitHubDiagnostic(error), { code: 'GITHUB_COMMAND_FAILED', stage: 'github', exitCode: 2,
      reason: 'cli_failed', method: 'GET', endpointKind: 'identity' });
    assert.doesNotMatch(error.message, /授权|登录/);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_/);
    return true;
  });
  assert.equal(spawned, 1);
});

test('abort during GET backoff preserves native AbortError and starts no second child', async t => {
  const fixture = await boundary(t, ({ request }) => request.socket.destroy());
  const controller = new AbortController();
  const original = new DOMException('Cancelled fixture', 'AbortError');
  fixture.client.sleepImpl = async () => { controller.abort(); throw original; };
  await assert.rejects(fixture.client._api('user', { signal: controller.signal }), error => {
    assert.equal(error, original);
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 20);
    return true;
  });
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.invocations.length, 1);
});

test('abort during an injected backoff is checked even when the sleeper returns normally', async t => {
  const fixture = await boundary(t, ({ request }) => request.socket.destroy());
  const controller = new AbortController();
  fixture.client.sleepImpl = async () => { controller.abort(); };
  await assert.rejects(fixture.client._api('user', { signal: controller.signal }), { code: 'ABORTED', method: 'GET', endpointKind: 'identity' });
  assert.equal(fixture.invocations.length, 1);
});

test('accepted but malformed write responses preserve response metadata without replay', async t => {
  const fixture = await boundary(t, ({ response }) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"PRIVATE_BODY":');
  });
  await assert.rejects(fixture.client._api('repos/tester/project/actions/workflows/glados-quick-deploy.yml/dispatches', {
    method: 'POST', body: { ref: 'main' }, stage: 'dispatch',
  }), error => {
    assert.deepEqual(safeGitHubDiagnostic(error), {
      code: 'INVALID_RESPONSE', stage: 'dispatch', httpStatus: 200, exitCode: 0,
      reason: 'invalid_response', method: 'POST', endpointKind: 'actions-dispatch',
    });
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_/);
    return true;
  });
  assert.equal(fixture.invocations.length, 1);
  assert.deepEqual(fixture.sleeps, []);
});

test('deployment retains a nonce after an accepted but unreadable dispatch and resolves it after restart', async t => {
  for (const responseFailure of ['malformed-json', 'unknown-cli-failure']) {
    await t.test(responseFailure, async subtest => {
      let lookupReady = false;
      let submittedNonce;
      let intent;
      let rejected = 0;
      const key = 'A'.repeat(16);
      const repository = 'tester/project';
      const fixture = await boundary(subtest, ({ record, response }) => {
        if (record.method === 'POST') {
          submittedNonce = JSON.parse(record.input).inputs.deployment_id;
          const headers = { 'Content-Type': 'application/json' };
          if (responseFailure === 'unknown-cli-failure') headers['X-Fixture-Cli-Failure'] = '1';
          response.writeHead(200, headers);
          response.end(responseFailure === 'malformed-json' ? '{"workflow_run_id":' : JSON.stringify({ workflow_run_id: 900 }));
        } else if (!lookupReady) jsonResponse(response, 503, { message: 'PRIVATE_TEMPORARY_LOOKUP_FAILURE' });
        else jsonResponse(response, 200, { workflow_runs: [{
          id: 900, event: 'workflow_dispatch', display_title: `GLaDOS Quick Deploy · ${submittedNonce} · ${key}`,
          status: 'completed', conclusion: 'success',
        }] });
      });
      await assert.rejects(fixture.client._startVerification(repository, 'main', undefined, key, {
        onIntent: value => { intent = { ...value }; }, onRejected: () => { rejected++; },
      }), { code: 'GITHUB_UNAVAILABLE' });
      assert.equal(rejected, 0);
      assert.match(intent.nonce, /^[a-f0-9]{32}$/);
      assert.equal(fixture.client._pendingDispatches.get(repository).nonce, intent.nonce);
      assert.equal(intent.nonce, submittedNonce);
      assert.equal(fixture.requests.filter(request => request.method === 'POST').length, 1);

      lookupReady = true;
      const restarted = new GitHubClient({ ghPath: 'isolated-http-child',
        spawnImpl: fixture.client.spawnImpl, sleepImpl: fixture.client.sleepImpl });
      const result = await restarted._startVerification(repository, 'main', undefined, key, {
        dispatch: intent, onRejected: () => { rejected++; },
      });
      assert.equal(result.runId, 900);
      assert.equal(result.status, 'completed');
      assert.equal(result.conclusion, 'success');
      assert.equal(rejected, 0);
      assert.equal(fixture.requests.filter(request => request.method === 'POST').length, 1);
      assert.equal(restarted._pendingDispatches.size, 0);
    });
  }
});

test('successful authorization followed by an unavailable identity is marked as awaiting verification', async t => {
  let available = false;
  const events = [];
  const fixture = await boundary(t, ({ response }) => jsonResponse(response, available ? 200 : 503,
    available ? { login: 'tester', id: 42 } : { message: 'PRIVATE_IDENTITY_LOOKUP_FAILURE' }));
  fixture.client.onEvent = event => events.push(event);
  await assert.rejects(fixture.client.login(), error => {
    assert.deepEqual(safeGitHubDiagnostic(error), {
      code: 'GITHUB_UNAVAILABLE', stage: 'auth-verify', httpStatus: 503, exitCode: 1,
      reason: 'service_unavailable', method: 'GET', endpointKind: 'identity',
    });
    return true;
  });
  assert.equal(fixture.invocations.filter(call => call.args[0] === 'auth').length, 1);
  assert.equal(fixture.requests.length, 3);
  assert.equal(events.some(event => event.stage === 'auth-verify'), true);
  assert.equal(events.some(event => event.type === 'auth-complete'), false);
  assert.equal(fixture.client._busy, false);
  available = true;
  assert.equal((await fixture.client.whoami()).login, 'tester');
  assert.equal(fixture.invocations.filter(call => call.args[0] === 'auth').length, 1);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test('a failed identity read before authorization never claims the authorization command completed', async t => {
  const events = [];
  const fixture = await boundary(t, ({ response }) => jsonResponse(response, 503, { message: 'PRIVATE_INITIAL_LOOKUP_FAILURE' }));
  fixture.client.onEvent = event => events.push(event);
  await assert.rejects(fixture.client.login({ refresh: true }), { code: 'GITHUB_UNAVAILABLE', stage: 'identity' });
  assert.equal(fixture.invocations.filter(call => call.args[0] === 'auth').length, 0);
  assert.equal(events.some(event => event.stage === 'auth-verify' || event.type === 'auth-complete'), false);
});

test('one unavailable account log preserves healthy evidence in this and subsequent batches without caching incomplete results', async t => {
  const keys = ['A', 'B', 'C', 'D'].map(letter => letter.repeat(16));
  let allReadable = false;
  const fixture = await boundary(t, ({ record, response }) => {
    const path = record.path.split('?')[0];
    if (path.endsWith('/actions/runs/500')) {
      jsonResponse(response, 200, { id: 500, path: WORKFLOW_PATH, run_attempt: 1, status: 'completed', conclusion: 'failure' });
    } else if (path.endsWith('/actions/runs/500/jobs')) {
      jsonResponse(response, 200, { total_count: 4, jobs: keys.map((key, index) => ({ id: 101 + index, name: `Account ${key}`, status: 'completed' })) });
    } else {
      const index = Number(path.match(/\/actions\/jobs\/(\d+)\/logs$/)?.[1]) - 101;
      if (index < 0 || index > 3 || !Number.isInteger(index)) return jsonResponse(response, 404, {});
      if (index === 1 && !allReadable) return jsonResponse(response, 503, { message: 'PRIVATE_ONE_ACCOUNT_READ_FAILURE' });
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('QUICK_DEPLOY_RESULT=' + JSON.stringify({ accountKey: keys[index], outcome: index === 1 ? 'failed' : 'checked' }) + '\n');
    }
  });
  const first = await fixture.client._readRun('tester/project', 500);
  assert.equal(first.result.status, 'unverified');
  assert.equal(first.result.readError, 'GITHUB_UNAVAILABLE');
  assert.deepEqual(first.result.accounts.map(account => account.accountKey), [keys[0], keys[2], keys[3]]);
  assert.equal(fixture.client._completedResults.size, 0);
  assert.equal(fixture.requests.filter(request => request.path.endsWith('/actions/jobs/102/logs')).length, 3);
  assert.equal(fixture.requests.some(request => request.path.endsWith('/actions/jobs/104/logs')), true);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_/);

  allReadable = true;
  const second = await fixture.client._readRun('tester/project', 500);
  assert.equal(second.result.readError, undefined);
  assert.deepEqual(second.result.accounts.map(account => account.accountKey), keys);
  assert.equal(second.result.accounts[1].outcome, 'failed');
  assert.equal(fixture.client._completedResults.size, 1);
  assert.ok(fixture.requests.every(request => request.method === 'GET'));
});

test('account log cancellation and authentication failures retain immediate interruption semantics', async () => {
  for (const interrupt of [new DOMException('Cancelled', 'AbortError'), new GitHubError('AUTH_REQUIRED', 'Login required', 'results')]) {
    const client = new GitHubClient({ ghPath: 'no-real-cli-used' });
    const keys = ['A'.repeat(16), 'B'.repeat(16)];
    let secondRead;
    let releaseSecond;
    const other = new Promise(resolve => { releaseSecond = resolve; });
    client._api = async endpoint => {
      if (endpoint.endsWith('/actions/runs/500')) return { id: 500, path: WORKFLOW_PATH, status: 'completed', conclusion: 'success' };
      if (endpoint.includes('/jobs?')) return { total_count: 2, jobs: keys.map((key, index) => ({ id: index + 1, name: `Account ${key}`, status: 'completed' })) };
      if (endpoint.endsWith('/actions/jobs/1/logs')) throw interrupt;
      secondRead = true;
      return other;
    };
    try {
      await assert.rejects(client._readRun('tester/project', 500), error => error === interrupt);
      assert.equal(secondRead, true);
      assert.equal(client._completedResults.size, 0);
    } finally { releaseSecond(''); }
  }
});
