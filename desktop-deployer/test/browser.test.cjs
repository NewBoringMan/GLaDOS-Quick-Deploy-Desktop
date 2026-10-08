'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const {
  discoverBrowsers, captureLogin, validateCredential, cleanupOwnedProfiles, __test,
} = require('../src/browser.cjs');

function credential(overrides = {}) {
  const identity = { email: 'person@example.com', userId: '12345' };
  return {
    cookie: 'gld:sess=session-value; gld:sess.sig=signature-value',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36',
    origin: 'https://glados.cloud', ...identity,
    accountKey: __test.keyForIdentity(identity), browser: 'Brave',
    capturedAt: '2026-10-07T09:00:00.000Z', ...overrides,
  };
}

const acceptedStatus = { code: 0, data: { email: 'person@example.com', userId: 12345 } };

async function captureFixture(t, { surface, failAt = 'status', closed = false, errorCode, navigationBlocked = false, status = { httpStatus: 200, body: acceptedStatus } }) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'gqd-capture-fixture-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const state = { closed: false, connected: true, storageCleared: false, browserClosed: false };
  const handlers = new Map();
  const cookies = [{ name: 'gld:sess', value: 'fixture', domain: 'glados.cloud', path: '/' }, { name: 'gld:sess.sig', value: 'fixture', domain: 'glados.cloud', path: '/' }];
  const read = async (step, value) => {
    if (step !== failAt) return value;
    if (navigationBlocked) handlers.get('will-navigate')?.({ url: 'https://untrusted.invalid/', preventDefault() {} });
    if (closed === 'browser') state.connected = false;
    else if (closed) state.closed = true;
    const error = new Error('Fixture browser read rejected');
    if (errorCode) error.code = errorCode;
    throw error;
  };
  const session = {
    setPermissionRequestHandler() {}, on() {}, cookies: { get: () => read('cookies', cookies) },
    clearStorageData: async () => { state.storageCleared = true; }, clearCache: async () => {},
  };
  class LoginWindow {
    constructor() {
      this.webContents = {
        on: (name, callback) => handlers.set(name, callback), setWindowOpenHandler() {},
        getURL: () => 'https://glados.cloud/console/checkin',
        executeJavaScript: () => read('status', status), getUserAgent: () => read('userAgent', 'Fixture browser agent'),
      };
    }
    setMenuBarVisibility() {} show() {} loadURL() { return Promise.resolve(); }
    isDestroyed() { return state.closed; } destroy() { state.closed = true; }
  }
  const page = {
    setRequestInterception: () => read('setup'), on() {}, goto: async () => {},
    isClosed: () => state.closed, url: () => 'https://glados.cloud/console/checkin',
    browserContext: () => ({ cookies: () => read('cookies', cookies) }), evaluate: () => read('status', status),
  };
  const browser = {
    get connected() { return state.connected; }, process: () => null,
    pages: () => read('pages', [page]), newPage: async () => page,
    userAgent: () => read('userAgent', 'Fixture browser agent'),
    close: async () => { state.connected = false; state.browserClosed = true; },
  };
  const electron = { BrowserWindow: LoginWindow, session: { fromPartition: () => session }, app: { whenReady: async () => {} } };
  const filename = path.resolve(__dirname, '../src/browser.cjs');
  const original = await fsp.readFile(filename, 'utf8');
  assert.ok(original.includes("await import('puppeteer-core')"));
  // Keep the capture implementation intact; replace only its browser dependency
  // boundary so this test cannot launch a browser, load a site or access an account.
  const source = original.replace("await import('puppeteer-core')", 'await fixturePuppeteer()')
    + '\nmodule.exports.fixtureCapture = { captureEmbedded, captureExternal };';
  const moduleFixture = { exports: {} };
  vm.runInNewContext(source, {
    require: name => name === 'electron' ? electron : require(name), module: moduleFixture, exports: moduleFixture.exports,
    process, Buffer, URL, AbortController, setTimeout, clearTimeout,
    fixturePuppeteer: async () => ({ launch: async () => browser }),
  }, { filename });
  const options = { signal: new AbortController().signal, profileRoot: directory, onProgress() {} };
  const promise = surface === 'embedded'
    ? moduleFixture.exports.fixtureCapture.captureEmbedded(options)
    : moduleFixture.exports.fixtureCapture.captureExternal({ family: 'chromium', name: 'Fixture', executablePath: 'fixture-only' }, options);
  return { promise, state, directory };
}

test('accepts complete signed session only after matching successful status identity', () => {
  const result = validateCredential(credential(), acceptedStatus);
  assert.equal(result.email, 'person@example.com');
  assert.equal(result.userId, '12345');
  assert.equal(result.accountKey, crypto.createHash('sha256').update('glados:user:12345').digest('hex').slice(0, 16).toUpperCase());
  assert.deepEqual(Object.keys(result).sort(), ['cookie', 'userAgent', 'origin', 'email', 'userId', 'accountKey', 'browser', 'capturedAt'].sort());
});

test('account identity remains stable across cookie rotation', () => {
  const first = validateCredential(credential());
  const rotated = validateCredential(credential({ cookie: 'gld:sess=rotated; gld:sess.sig=new-signature' }));
  assert.equal(first.accountKey, rotated.accountKey);
});

test('email-only identity has a stable case-insensitive key', () => {
  const identity = { email: 'Person@Example.com', userId: null };
  const result = validateCredential(credential({ ...identity, accountKey: __test.keyForIdentity(identity) }), { code: 0, data: { email: 'person@example.com' } });
  assert.equal(result.email, 'person@example.com');
  assert.equal(result.accountKey, crypto.createHash('sha256').update('glados:email:person@example.com').digest('hex').slice(0, 16).toUpperCase());
});

test('two accounts sharing the generic data.id plan cannot overwrite the same secret key', () => {
  const firstStatus = { code: 0, data: { id: 500, email: 'first@example.com' } };
  const secondStatus = { code: 0, data: { id: 500, email: 'second@example.com' } };
  const firstIdentity = __test.identityFromStatus(firstStatus);
  const secondIdentity = __test.identityFromStatus(secondStatus);
  assert.equal(firstIdentity.userId, null);
  assert.equal(secondIdentity.userId, null);
  const first = validateCredential(credential({ ...firstIdentity, accountKey: __test.keyForIdentity(firstIdentity) }), firstStatus);
  const second = validateCredential(credential({ ...secondIdentity, accountKey: __test.keyForIdentity(secondIdentity) }), secondStatus);
  assert.notEqual(first.accountKey, second.accountKey);
  assert.equal(first.accountKey, crypto.createHash('sha256').update('glados:email:first@example.com').digest('hex').slice(0, 16).toUpperCase());
});

test('a generic data.id or planId alone never establishes account identity', () => {
  for (const data of [{ id: 500 }, { planId: 500 }, { id: 'shared-plan', points: 500 }]) {
    assert.throws(() => __test.identityFromStatus({ code: 0, data }), { code: 'INVALID_IDENTITY' });
  }
});

test('explicit user identifiers and explicit nested user identity are accepted', () => {
  for (const data of [{ userId: 123 }, { user_id: 123 }, { uid: 123 }, { user: { id: 123 } }, { user: { userId: 123 } }]) {
    assert.deepEqual(__test.identityFromStatus({ code: 0, data }), { email: null, userId: '123' });
  }
  assert.deepEqual(__test.identityFromStatus({ code: 0, data: { id: 500, user: { email: 'Person@Example.com', id: 123 } } }), { email: 'person@example.com', userId: '123' });
});

test('conflicting explicit account identity fails closed', () => {
  assert.throws(() => __test.identityFromStatus({ code: 0, data: { userId: 123, user: { id: 456 } } }), { code: 'IDENTITY_MISMATCH' });
  assert.throws(() => __test.identityFromStatus({ code: 0, data: { email: 'one@example.com', user: { email: 'two@example.com' } } }), { code: 'IDENTITY_MISMATCH' });
});

test('website response projection omits generic plan ID and unrelated sensitive fields', async () => {
  const responseBody = {
    code: 0,
    data: { id: 500, planId: 500, uid: 123, token: 'must-stay-out', email: 'person@example.com', user: { id: 123, email: 'person@example.com', token: 'also-must-stay-out' } },
  };
  const result = await vm.runInNewContext(`(${__test.readStatusInPage.toString()})()`, {
    location: { origin: 'https://glados.cloud' }, AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ status: 200, text: async () => JSON.stringify(responseBody) }),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.data.uid, 123);
  assert.equal(result.body.data.user.id, 123);
  assert.equal(Object.hasOwn(result.body.data, 'id'), false);
  assert.equal(Object.hasOwn(result.body.data, 'planId'), false);
  assert.ok(!JSON.stringify(result).includes('must-stay-out'));
  assert.deepEqual(__test.identityFromStatus(result.body), { email: 'person@example.com', userId: '123' });
});

for (const suffix of ['\r\nAuthorization: leaked', '\0', '\t', '\x7f']) {
  test(`rejects cookie header control injection ${JSON.stringify(suffix)}`, () => {
    assert.throws(() => validateCredential(credential({ cookie: `gld:sess=secret${suffix}; gld:sess.sig=sig` })), { code: 'INVALID_COOKIE' });
  });
}

test('errors never echo cookie values', () => {
  assert.throws(() => validateCredential(credential({ cookie: 'gld:sess=top-secret-value\r\nInjected' })), error => {
    assert.ok(!error.message.includes('top-secret-value'));
    assert.ok(!error.message.includes('Injected'));
    return true;
  });
});

for (const cookie of ['gld:sess=only-session', 'gld:sess.sig=only-signature', 'gld:sess=; gld:sess.sig=sig', 'koa:sess=old; koa:sess.sig=old-signature']) {
  test(`does not accept incomplete or legacy-only session ${cookie.split('=')[0]}`, () => {
    assert.throws(() => validateCredential(credential({ cookie })), { code: 'INCOMPLETE_SESSION' });
  });
}

test('rejects ambiguous duplicate sessions and an incomplete legacy companion', () => {
  assert.throws(() => validateCredential(credential({ cookie: 'gld:sess=a; gld:sess=a; gld:sess.sig=b' })), { code: 'INVALID_COOKIE' });
  assert.throws(() => validateCredential(credential({ cookie: 'gld:sess=a; gld:sess.sig=b; koa:sess=c' })), { code: 'INCOMPLETE_SESSION' });
});

test('rejects user agent injection and untrusted origins', () => {
  assert.throws(() => validateCredential(credential({ userAgent: 'Chrome\r\nCookie: x' })), { code: 'INVALID_USER_AGENT' });
  for (const origin of ['http://glados.cloud', 'https://glados.cloud.evil.test', 'https://glados.rocks', 'https://evil.test@glados.cloud']) {
    assert.throws(() => validateCredential(credential({ origin })), { code: 'INVALID_ORIGIN' });
  }
});

test('rejects stale mismatched account keys and mismatched verified identity', () => {
  assert.throws(() => validateCredential(credential({ accountKey: '0'.repeat(16) })), { code: 'INVALID_ACCOUNT_KEY' });
  assert.throws(() => validateCredential(credential(), { code: 0, data: { email: 'someone-else@example.com', userId: 12345 } }), { code: 'IDENTITY_MISMATCH' });
  assert.throws(() => validateCredential(credential(), { code: 0, data: { email: 'person@example.com', userId: 98765 } }), { code: 'IDENTITY_MISMATCH' });
});

test('an error response containing an email is never identity evidence', () => {
  for (const payload of [{ data: { email: 'person@example.com' } }, { code: 200, data: { email: 'person@example.com' } }, { code: -2, data: { email: 'person@example.com' } }]) {
    assert.throws(() => __test.identityFromStatus(payload), { code: 'SESSION_REJECTED' });
  }
  assert.throws(() => __test.identityFromStatus({ code: -2, reason: 'device-mismatch', message: 'Automated check-in detected' }), { code: 'AUTOMATION_REJECTED' });
});

test('HTTP success or points are not proof of account identity', () => {
  for (const payload of [{ code: 0, points: 500 }, { code: 0, data: {} }, { code: 0, data: { email: 'Unknown' } }, { code: 0, data: { userId: {} } }]) {
    assert.throws(() => __test.identityFromStatus(payload), { code: 'INVALID_IDENTITY' });
  }
});

test('extracts only cookies applicable to the fixed status origin/path', () => {
  const cookies = [
    { name: 'gld:sess', value: 'good-session', domain: '.glados.cloud', path: '/' },
    { name: 'gld:sess.sig', value: 'good-signature', domain: 'glados.cloud', path: '/' },
    { name: 'outside', value: 'private-value', domain: 'example.com', path: '/' },
    { name: 'bad-parent', value: 'private-value', domain: '.cloud', path: '/' },
    { name: 'wrongpath', value: 'wrong', domain: 'glados.cloud', path: '/api/user/stat' },
    { name: 'expired', value: 'old', domain: 'glados.cloud', path: '/', expires: 1 },
    { name: 'rightpath', value: 'needed', domain: 'glados.cloud', path: '/api/user' },
  ];
  const header = __test.cookieHeaderForStatus(cookies);
  assert.ok(header.includes('gld:sess=good-session'));
  assert.ok(header.includes('rightpath=needed'));
  assert.ok(!header.includes('private-value'));
  assert.ok(!header.includes('wrongpath'));
  assert.ok(!header.includes('expired'));
  assert.doesNotThrow(() => __test.parseCookie(header));
});

test('conflicting session cookies in overlapping paths fail closed', () => {
  assert.throws(() => __test.cookieHeaderForStatus([
    { name: 'gld:sess', value: 'one', domain: 'glados.cloud', path: '/' },
    { name: 'gld:sess', value: 'two', domain: 'glados.cloud', path: '/api' },
  ]), { code: 'AMBIGUOUS_SESSION' });
});

test('navigation allowlist rejects deceptive URL forms', () => {
  for (const url of ['https://glados.cloud/console/checkin', 'about:blank']) assert.equal(__test.isTrustedNavigation(url), true);
  for (const url of ['javascript:alert(1)', 'file:///tmp/secret', 'http://glados.cloud', 'https://glados.cloud.evil.test/', 'https://glados.cloud@evil.test/', 'https://evil.test@glados.cloud/', 'https://glados.cloud:9999/', 'https://glados.rocks/']) assert.equal(__test.isTrustedNavigation(url), false);
});

test('discovers MacData Brave and Firefox without reading browser profiles', async () => {
  const checkedPaths = [];
  const present = new Set(['/Volumes/MacData/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Firefox.app/Contents/MacOS/firefox']);
  const found = await discoverBrowsers({ platform: 'darwin', homeDir: '/Users/test', env: {}, electronAvailable: true, exists: async executable => { checkedPaths.push(executable); return present.has(executable); } });
  assert.equal(found[0].id, 'brave');
  assert.equal(found[1].id, 'firefox');
  assert.equal(found[2].id, 'embedded');
  assert.ok(found.find(item => item.id === 'safari' && !item.available));
  assert.ok(checkedPaths.every(file => file.includes('.app/Contents/MacOS/')));
  assert.ok(checkedPaths.every(file => !file.includes('Cookies') && !file.includes('Application Support')));
});

test('discovers per-user Edge on Windows and does not assume browsers exist', async () => {
  const target = 'C:\\Users\\test\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe';
  const found = await discoverBrowsers({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, homeDir: 'C:\\Users\\test', electronAvailable: true, exists: async candidate => candidate === target });
  assert.equal(found[0].id, 'edge');
  assert.equal(found[0].executablePath, target);
  assert.equal(found.filter(item => item.available).length, 2);
  assert.equal(found.find(item => item.id === 'brave').available, false);
});

test('an already-cancelled request launches no browser', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureLogin({ browserId: 'embedded', signal: controller.signal }), { code: 'LOGIN_CANCELLED' });
});

test('poll capture proves identity with same-session status and keeps credentials out of progress', async () => {
  const updates = [];
  let statusRequests = 0;
  const adapter = {
    check() {}, url: () => 'https://glados.cloud/console/checkin',
    cookies: async () => [
      { name: 'gld:sess', value: 'sensitive-session', domain: 'glados.cloud', path: '/' },
      { name: 'gld:sess.sig', value: 'sensitive-signature', domain: 'glados.cloud', path: '/' },
    ],
    userAgent: async () => 'Actual Browser Agent',
    status: async () => { statusRequests++; return { httpStatus: 200, body: acceptedStatus }; },
  };
  const captured = await __test.pollForCredential(adapter, 'Test Browser', update => updates.push(update), new AbortController().signal);
  assert.equal(statusRequests, 1);
  assert.equal(captured.email, 'person@example.com');
  assert.equal(captured.userAgent, 'Actual Browser Agent');
  assert.equal(captured.cookie, 'gld:sess=sensitive-session; gld:sess.sig=sensitive-signature');
  assert.ok(!JSON.stringify(updates).includes('sensitive'));
  assert.ok(!JSON.stringify(updates).includes('person@example.com'));
});

test('server rejection causes one status request and no automated retries', async () => {
  let requests = 0;
  const adapter = {
    check() {}, url: () => 'https://glados.cloud/console/checkin',
    cookies: async () => [
      { name: 'gld:sess', value: 's', domain: 'glados.cloud', path: '/' },
      { name: 'gld:sess.sig', value: 't', domain: 'glados.cloud', path: '/' },
    ],
    status: async () => { requests++; return { httpStatus: 200, body: { code: -2, reason: 'device-mismatch' } }; },
    userAgent: async () => 'unchanged',
  };
  await assert.rejects(__test.pollForCredential(adapter, 'Test', () => {}, new AbortController().signal), { code: 'AUTOMATION_REJECTED' });
  assert.equal(requests, 1);
});

test('status transport failure never returns a credential', async () => {
  const adapter = {
    check() {}, url: () => 'https://glados.cloud/console/checkin',
    cookies: async () => [{ name: 'gld:sess', value: 's', domain: 'glados.cloud', path: '/' }, { name: 'gld:sess.sig', value: 't', domain: 'glados.cloud', path: '/' }],
    status: async () => ({ httpStatus: 403 }), userAgent: async () => 'unchanged',
  };
  await assert.rejects(__test.pollForCredential(adapter, 'Test', () => {}, new AbortController().signal), { code: 'STATUS_UNAVAILABLE' });
});

test('abort interrupts an empty-cookie login without making a status request', async () => {
  const controller = new AbortController();
  let requests = 0;
  const promise = __test.pollForCredential({ check() {}, url: () => 'https://glados.cloud/login', cookies: async () => [], status: async () => { requests++; }, userAgent: async () => '' }, 'Test', () => {}, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(promise, { code: 'LOGIN_CANCELLED' });
  assert.equal(requests, 0);
});

test('closing a login window during a browser read is cancellation and still cleans up', async t => {
  for (const sample of [
    { surface: 'embedded', failAt: 'cookies', closed: 'window' },
    { surface: 'embedded', failAt: 'status', closed: 'window' },
    { surface: 'embedded', failAt: 'userAgent', closed: 'window' },
    { surface: 'external', failAt: 'setup', closed: 'page' },
    { surface: 'external', failAt: 'setup', closed: 'page', errorCode: 'ERR_TARGET_CLOSED' },
    { surface: 'external', failAt: 'pages', closed: 'browser' },
    { surface: 'external', failAt: 'pages', closed: 'browser', errorCode: -32000 },
    { surface: 'external', failAt: 'cookies', closed: 'browser' },
    { surface: 'external', failAt: 'status', closed: 'page' },
    { surface: 'external', failAt: 'userAgent', closed: 'page', errorCode: 'ERR_TARGET_CLOSED' },
  ]) await t.test(`${sample.surface} ${sample.failAt} ${sample.closed}${sample.errorCode ? ' ' + sample.errorCode : ''}`, async t => {
    const fixture = await captureFixture(t, sample);
    await assert.rejects(fixture.promise, { code: 'LOGIN_CANCELLED' });
    if (sample.surface === 'embedded') assert.equal(fixture.state.storageCleared, true);
    else {
      assert.equal(fixture.state.browserClosed, true);
      assert.deepEqual(await fsp.readdir(fixture.directory), []);
    }
  });
});

test('transport, navigation and identity failures remain distinct from cancellation without evidence of a closed browser read', async t => {
  for (const sample of [
    { surface: 'embedded', expected: 'LOGIN_FAILED' },
    { surface: 'external', expected: 'BROWSER_LOGIN_FAILED' },
    { surface: 'embedded', errorCode: 'ECONNRESET', expected: 'ECONNRESET' },
    { surface: 'external', errorCode: 'ECONNRESET', expected: 'ECONNRESET' },
    { surface: 'embedded', navigationBlocked: true, closed: 'window', expected: 'NAVIGATION_BLOCKED' },
    { surface: 'embedded', failAt: 'none', status: { httpStatus: 403 }, expected: 'STATUS_UNAVAILABLE' },
    { surface: 'external', failAt: 'none', status: { httpStatus: 200, body: { code: -2, reason: 'device-mismatch' } }, expected: 'AUTOMATION_REJECTED' },
  ]) await t.test(`${sample.surface} ${sample.expected}`, async t => {
    const fixture = await captureFixture(t, sample);
    await assert.rejects(fixture.promise, { code: sample.expected });
  });
});

test('owned profile cleanup verifies marker nonce and leaves foreign data intact', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gqd-browser-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const profile = await __test.createOwnedProfile(root);
  await fsp.writeFile(path.join(profile, 'temporary-browser-data'), 'disposable');
  const marker = JSON.parse(await fsp.readFile(path.join(profile, '.gqd-owned-profile.json'), 'utf8'));
  assert.equal(await __test.removeOwnedProfile(profile, 'wrong-nonce'), false);
  assert.ok((await fsp.stat(profile)).isDirectory());
  const foreign = path.join(root, 'my-browser-data');
  await fsp.mkdir(foreign);
  await fsp.writeFile(path.join(foreign, 'keep'), 'important');
  assert.equal(await __test.removeOwnedProfile(profile, marker.nonce), true);
  await cleanupOwnedProfiles(root);
  assert.equal(await fsp.readFile(path.join(foreign, 'keep'), 'utf8'), 'important');
  await assert.rejects(fsp.stat(profile), { code: 'ENOENT' });
});

test('cleanup does not follow a forged profile symlink', { skip: process.platform === 'win32' ? 'Symlink creation requires optional Windows privilege.' : false }, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gqd-browser-link-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'private');
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'keep'), 'important');
  const link = path.join(root, 'gqd-session-ABC123');
  await fsp.symlink(outside, link, 'dir');
  assert.equal(await __test.removeOwnedProfile(link, 'a'.repeat(48)), false);
  await cleanupOwnedProfiles(root);
  assert.equal(await fsp.readFile(path.join(outside, 'keep'), 'utf8'), 'important');
});
