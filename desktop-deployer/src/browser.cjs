'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ORIGIN = 'https://glados.cloud';
const LOGIN_URL = `${ORIGIN}/console/checkin`;
const STATUS_URL = `${ORIGIN}/api/user/status`;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const PROFILE_PREFIX = 'gqd-session-';
const PROFILE_MARKER = '.gqd-owned-profile.json';
const ownedProfiles = new Map();
let activeCapture = false;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortReason(signal) {
  return signal?.reason?.code === 'LOGIN_TIMEOUT'
    ? signal.reason
    : failure('LOGIN_CANCELLED', '已取消登录。');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function wait(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortReason(signal)); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function cancellable(promise, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    function abort() { reject(abortReason(signal)); }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}

function safeProgress(callback, message) {
  try { if (typeof callback === 'function') callback({ message }); } catch { /* The UI cannot interrupt cleanup. */ }
}

function parseCookie(cookie) {
  if (typeof cookie !== 'string' || !cookie || cookie.length > 65536 || /[^\x21-\x7e]/.test(cookie.replace(/; /g, ';'))) {
    throw failure('INVALID_COOKIE', '登录会话格式无效，不能包含空白或控制字符。');
  }
  const values = new Map();
  for (const part of cookie.split(';')) {
    const entry = part.trim();
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (separator < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z:\-]+$/.test(name) || /[\s;,"\\\x00-\x1f\x7f]/.test(value)) {
      throw failure('INVALID_COOKIE', '登录会话中包含无效的 Cookie 项。');
    }
    if (values.has(name)) throw failure('INVALID_COOKIE', '登录会话包含重复的 Cookie 名称，请重新登录。');
    values.set(name, value);
  }
  if (!values.get('gld:sess') || !values.get('gld:sess.sig')) {
    throw failure('INCOMPLETE_SESSION', '尚未取得完整的新版 GLaDOS 登录会话，请完成网页登录。');
  }
  const legacyCount = Number(values.has('koa:sess')) + Number(values.has('koa:sess.sig'));
  if (legacyCount === 1 || (legacyCount === 2 && (!values.get('koa:sess') || !values.get('koa:sess.sig')))) {
    throw failure('INCOMPLETE_SESSION', '登录会话中的旧版签名对不完整，请重新登录。');
  }
  return values;
}

function normalizeEmail(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) {
    throw failure('INVALID_IDENTITY', 'GLaDOS 未返回有效的账号邮箱。');
  }
  const email = value.trim();
  if (email.length > 254 || !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(email)) throw failure('INVALID_IDENTITY', 'GLaDOS 未返回有效的账号邮箱。');
  return email.toLowerCase();
}

function normalizeUserId(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw failure('INVALID_IDENTITY', 'GLaDOS 返回的账号标识无效。');
  }
  if (!['string', 'number'].includes(typeof value)) throw failure('INVALID_IDENTITY', 'GLaDOS 返回的账号标识无效。');
  const id = String(value).trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9_.:@-]+$/.test(id) || /^(unknown|undefined|null|nan)$/i.test(id)) {
    throw failure('INVALID_IDENTITY', 'GLaDOS 返回的账号标识无效。');
  }
  return id;
}

function identityFromStatus(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.code !== 0) {
    const description = `${typeof payload?.reason === 'string' ? payload.reason : ''} ${typeof payload?.message === 'string' ? payload.message : ''}`.toLowerCase();
    if (/device.?mismatch|automated|automation|自动签到|设备不匹配/.test(description)) {
      throw failure('AUTOMATION_REJECTED', 'GLaDOS 拒绝了当前登录环境。请按官网提示处理；程序不会更换身份或绕过验证。');
    }
    throw failure('SESSION_REJECTED', 'GLaDOS 未接受当前登录会话。请完成官网要求的登录或验证后重试。');
  }
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('INVALID_IDENTITY', 'GLaDOS 状态响应缺少账号身份。');
  const user = data.user && typeof data.user === 'object' && !Array.isArray(data.user) ? data.user : {};
  // A generic data.id can identify a subscription/plan shared by many users.
  // Only explicitly named user identifiers or an explicit user object are
  // account identity evidence; data.id must never participate in the key.
  const emails = [...new Set([data.email, user.email].filter(value => value != null && value !== '').map(normalizeEmail))];
  const userIds = [...new Set([data.userId, data.user_id, data.uid, user.id, user.userId].filter(value => value != null && value !== '').map(normalizeUserId))];
  if (emails.length > 1 || userIds.length > 1) throw failure('IDENTITY_MISMATCH', 'GLaDOS 状态响应包含相互冲突的账号身份。');
  const email = emails[0] ?? null;
  const userId = userIds[0] ?? null;
  if (!email && !userId) throw failure('INVALID_IDENTITY', 'GLaDOS 状态响应没有可核验的邮箱或账号标识。');
  return { email, userId };
}

function keyForIdentity({ email, userId }) {
  const basis = userId != null ? `glados:user:${String(userId).trim()}` : `glados:email:${email.trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16).toUpperCase();
}

/** Pure shape/integrity validation; online acceptance is established by captureLogin. */
function validateCredential(candidate, verifiedStatus) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw failure('INVALID_CREDENTIAL', '登录凭据无效。');
  parseCookie(candidate.cookie);
  if (typeof candidate.userAgent !== 'string' || !candidate.userAgent.trim() || candidate.userAgent.length > 4096 || /[\x00-\x1f\x7f]/.test(candidate.userAgent)) {
    throw failure('INVALID_USER_AGENT', '缺少本次真实登录浏览器的信息。');
  }
  if (candidate.origin !== ORIGIN) throw failure('INVALID_ORIGIN', '登录会话必须来自 https://glados.cloud。');
  const identity = { email: normalizeEmail(candidate.email), userId: normalizeUserId(candidate.userId) };
  if (!identity.email && !identity.userId) throw failure('INVALID_IDENTITY', '无法确定此登录会话所属的账号。');
  if (verifiedStatus !== undefined) {
    const verified = identityFromStatus(verifiedStatus);
    if (identity.email !== verified.email || identity.userId !== verified.userId) {
      throw failure('IDENTITY_MISMATCH', '登录会话与官网确认的账号身份不一致。');
    }
  }
  const accountKey = keyForIdentity(identity);
  if (candidate.accountKey !== accountKey) throw failure('INVALID_ACCOUNT_KEY', '账号标识与已核验身份不一致。');
  if (typeof candidate.browser !== 'string' || !candidate.browser || candidate.browser.length > 100 || /[\x00-\x1f\x7f]/.test(candidate.browser)) {
    throw failure('INVALID_BROWSER', '登录浏览器信息无效。');
  }
  if (typeof candidate.capturedAt !== 'string' || !Number.isFinite(Date.parse(candidate.capturedAt))) {
    throw failure('INVALID_CAPTURE_TIME', '登录会话的取得时间无效。');
  }
  return {
    cookie: candidate.cookie, userAgent: candidate.userAgent, origin: ORIGIN,
    email: identity.email, userId: identity.userId, accountKey,
    browser: candidate.browser, capturedAt: candidate.capturedAt,
  };
}

function isTrustedNavigation(url) {
  if (url === 'about:blank') return true;
  try { const parsed = new URL(url); return parsed.origin === ORIGIN && !parsed.username && !parsed.password; } catch { return false; }
}

function cookieHeaderForStatus(cookies, now = Date.now()) {
  const pairs = new Map();
  const requestPath = '/api/user/status';
  const sorted = [...cookies].sort((a, b) => String(b.path || '/').length - String(a.path || '/').length);
  for (const item of sorted) {
    if (!item || typeof item !== 'object' || typeof item.domain !== 'string') continue;
    if (item.domain.toLowerCase().replace(/^\./, '') !== 'glados.cloud') continue;
    const cookiePath = item.path || '/';
    if (typeof cookiePath !== 'string' || !requestPath.startsWith(cookiePath) || (!cookiePath.endsWith('/') && requestPath.length > cookiePath.length && requestPath[cookiePath.length] !== '/')) continue;
    const expires = item.expirationDate ?? item.expires;
    if (typeof expires === 'number' && expires >= 0 && expires * 1000 <= now) continue;
    if (typeof item.name !== 'string' || typeof item.value !== 'string') continue;
    if (pairs.has(item.name)) {
      if (/^(gld|koa):sess(?:\.sig)?$/.test(item.name) && pairs.get(item.name) !== item.value) {
        throw failure('AMBIGUOUS_SESSION', '官网存在相互冲突的登录会话，请重新登录。');
      }
      continue;
    }
    pairs.set(item.name, item.value);
  }
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

function browserDefinitions(platform, env, home) {
  const macRoots = ['/Applications', path.join(home, 'Applications'), '/Volumes/MacData/Applications'];
  const windowsRoots = [...new Set([env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean))];
  const win = (...parts) => windowsRoots.map(root => path.win32.join(root, ...parts));
  const mac = (bundle, binary) => macRoots.map(root => path.posix.join(root, `${bundle}.app`, 'Contents', 'MacOS', binary));
  const definitions = [
    ['brave', 'Brave', 'chromium', mac('Brave Browser', 'Brave Browser'), win('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
    ['chrome', 'Google Chrome', 'chromium', mac('Google Chrome', 'Google Chrome'), win('Google', 'Chrome', 'Application', 'chrome.exe')],
    ['edge', 'Microsoft Edge', 'chromium', mac('Microsoft Edge', 'Microsoft Edge'), win('Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['firefox', 'Firefox', 'firefox', mac('Firefox', 'firefox'), [...win('Mozilla Firefox', 'firefox.exe'), ...win('Programs', 'Mozilla Firefox', 'firefox.exe')]],
    ['opera', 'Opera', 'chromium', mac('Opera', 'Opera'), [...win('Programs', 'Opera', 'opera.exe'), ...win('Opera', 'opera.exe')]],
    ['vivaldi', 'Vivaldi', 'chromium', mac('Vivaldi', 'Vivaldi'), win('Vivaldi', 'Application', 'vivaldi.exe')],
    ['chromium', 'Chromium', 'chromium', mac('Chromium', 'Chromium'), win('Chromium', 'Application', 'chrome.exe')],
    ['arc', 'Arc', 'chromium', mac('Arc', 'Arc'), []],
  ];
  return definitions.map(([id, name, family, macPaths, winPaths]) => ({ id, name, family, paths: platform === 'darwin' ? macPaths : platform === 'win32' ? winPaths : [] }));
}

/** Optional arguments exist solely for deterministic platform discovery tests. */
async function discoverBrowsers(options = {}) {
  const platform = options.platform || process.platform;
  const exists = options.exists || (async executable => {
    try { await fsp.access(executable, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return (await fsp.stat(executable)).isFile(); } catch { return false; }
  });
  const definitions = browserDefinitions(platform, options.env || process.env, options.homeDir || os.homedir());
  const results = await Promise.all(definitions.map(async definition => {
    let executablePath = null;
    for (const candidate of definition.paths) if (await exists(candidate)) { executablePath = candidate; break; }
    return {
      id: definition.id, name: definition.name, family: definition.family, executablePath,
      available: executablePath !== null,
      details: executablePath ? (definition.family === 'firefox' ? '独立登录窗口 · WebDriver BiDi' : '独立登录窗口 · 与日常浏览器数据隔离') : '未在常见安装位置找到',
    };
  }));
  const embedded = {
    id: 'embedded', name: '应用内登录窗口', family: 'electron', executablePath: null,
    available: options.electronAvailable ?? Boolean(process.versions.electron),
    details: '独立内存会话；无需安装浏览器扩展',
  };
  if (platform === 'darwin') results.push({ id: 'safari', name: 'Safari', family: 'safari', executablePath: null, available: false, details: '可用于 GitHub 网页授权；GLaDOS 自动获取会话请使用上列浏览器或应用内窗口' });
  return [...results.filter(item => item.available), embedded, ...results.filter(item => !item.available)];
}

async function createOwnedProfile(profileRoot) {
  if (typeof profileRoot !== 'string' || !path.isAbsolute(profileRoot)) throw failure('INVALID_PROFILE_ROOT', '临时登录目录必须是应用管理的绝对路径。');
  await fsp.mkdir(profileRoot, { recursive: true, mode: 0o700 });
  const root = await fsp.realpath(profileRoot);
  const directory = await fsp.mkdtemp(path.join(root, PROFILE_PREFIX));
  const nonce = crypto.randomBytes(24).toString('hex');
  const record = { app: 'glados-quick-deploy', version: 1, name: path.basename(directory), nonce, pid: process.pid, createdAt: new Date().toISOString() };
  try { await fsp.writeFile(path.join(directory, PROFILE_MARKER), JSON.stringify(record), { mode: 0o600, flag: 'wx' }); }
  catch (error) { await fsp.rmdir(directory).catch(() => {}); throw error; }
  ownedProfiles.set(directory, { nonce, active: true });
  return directory;
}

async function removeOwnedProfile(directory, expectedNonce) {
  const base = path.basename(directory);
  if (!/^gqd-session-[A-Za-z0-9]{6}$/.test(base)) return false;
  try {
    const directoryInfo = await fsp.lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return false;
    const markerPath = path.join(directory, PROFILE_MARKER);
    const markerInfo = await fsp.lstat(markerPath);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 2048) return false;
    const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
    if (marker.app !== 'glados-quick-deploy' || marker.version !== 1 || marker.name !== base || !/^[a-f0-9]{48}$/.test(marker.nonce) || marker.nonce !== expectedNonce) return false;
    await fsp.rm(directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 150 });
    ownedProfiles.delete(directory);
    return true;
  } catch { return false; }
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** Only removes our marked, inactive directories; never scans browser defaults. */
async function cleanupOwnedProfiles(profileRoot) {
  const results = { removed: 0, retained: 0 };
  for (const [directory, record] of ownedProfiles) {
    if (!record.active) (await removeOwnedProfile(directory, record.nonce)) ? results.removed++ : results.retained++;
  }
  if (!profileRoot || !path.isAbsolute(profileRoot)) return results;
  let entries;
  try { entries = await fsp.readdir(profileRoot, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^gqd-session-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const directory = path.join(profileRoot, entry.name);
    if (ownedProfiles.has(directory)) continue;
    try {
      const markerPath = path.join(directory, PROFILE_MARKER);
      const markerInfo = await fsp.lstat(markerPath);
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 2048) continue;
      const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
      if (pidIsAlive(marker.pid) || (marker.browserPid != null && pidIsAlive(marker.browserPid))) continue;
      (await removeOwnedProfile(directory, marker.nonce)) ? results.removed++ : results.retained++;
    } catch { /* Foreign/unreadable directories are left untouched. */ }
  }
  return results;
}

// This function executes in the isolated website renderer, never with Node access.
async function readStatusInPage() {
  if (location.origin !== 'https://glados.cloud') return { transport: 'origin' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/user/status', { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
    if (response.status !== 200) return { httpStatus: response.status };
    const text = await response.text();
    if (text.length > 1024 * 1024) return { transport: 'format' };
    const body = JSON.parse(text);
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : null;
    const user = data?.user && typeof data.user === 'object' && !Array.isArray(data.user) ? data.user : null;
    return {
      httpStatus: 200,
      body: {
        code: body.code, reason: body.reason, message: body.message,
        data: data ? {
          email: data.email, userId: data.userId, user_id: data.user_id, uid: data.uid,
          user: user ? { email: user.email, id: user.id, userId: user.userId } : null,
        } : null,
      },
    };
  } catch { return { transport: 'request' }; }
  finally { clearTimeout(timer); }
}

async function pollForCredential(adapter, browserName, onProgress, signal) {
  safeProgress(onProgress, '请在 GLaDOS 官方页面完成登录及其要求的验证。登录成功后会自动继续。');
  for (;;) {
    throwIfAborted(signal);
    adapter.check();
    const currentUrl = adapter.url();
    if (currentUrl !== 'about:blank' && isTrustedNavigation(currentUrl)) {
      const cookie = cookieHeaderForStatus(await cancellable(adapter.cookies(), signal));
      let ready = false;
      try { parseCookie(cookie); ready = true; } catch (error) { if (error.code !== 'INCOMPLETE_SESSION' && cookie) throw error; }
      if (ready) {
        safeProgress(onProgress, '已取得登录会话，正在通过同一浏览器会话核验账号身份。');
        const response = await cancellable(adapter.status(), signal);
        adapter.check();
        if (!isTrustedNavigation(adapter.url()) || adapter.url() === 'about:blank') throw failure('INVALID_ORIGIN', '登录页面已离开 GLaDOS 官方域名。');
        if (!response || response.transport || response.httpStatus !== 200) {
          throw failure('STATUS_UNAVAILABLE', '无法从 GLaDOS 取得可核验的账号状态。程序未保存或上传此次会话。');
        }
        const identity = identityFromStatus(response.body);
        const credential = validateCredential({
          cookie: cookieHeaderForStatus(await cancellable(adapter.cookies(), signal)),
          userAgent: await cancellable(adapter.userAgent(), signal), origin: ORIGIN,
          ...identity, accountKey: keyForIdentity(identity), browser: browserName,
          capturedAt: new Date().toISOString(),
        }, response.body);
        throwIfAborted(signal);
        safeProgress(onProgress, '账号身份已由 GLaDOS 确认，可以继续部署。');
        return credential;
      }
    }
    await wait(1200, signal);
  }
}

async function captureEmbedded({ parentWindow, onProgress, signal }) {
  const electron = require('electron');
  if (!electron.BrowserWindow || !electron.session) throw failure('ELECTRON_UNAVAILABLE', '应用内登录窗口需要从桌面应用中打开。');
  await electron.app.whenReady();
  throwIfAborted(signal);
  const loginSession = electron.session.fromPartition(`gqd-login-${crypto.randomUUID()}`, { cache: false });
  loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  loginSession.on('will-download', event => event.preventDefault());
  const loginWindow = new electron.BrowserWindow({
    width: 1040, height: 790, minWidth: 680, minHeight: 560,
    title: 'GLaDOS 官方登录 · glados.cloud', show: false,
    ...(parentWindow && !parentWindow.isDestroyed() ? { parent: parentWindow } : {}),
    webPreferences: { session: loginSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false, spellcheck: false },
  });
  loginWindow.setMenuBarVisibility(false);
  let navigationError = null;
  const guard = (event, url, _inPlace, isMainFrame) => {
    // Current Electron exposes details on the event; retain compatibility with
    // the older positional arguments without relying on them being present.
    const targetUrl = event.url ?? url;
    const mainFrame = event.isMainFrame ?? isMainFrame;
    if (mainFrame === false || isTrustedNavigation(targetUrl)) return;
    event.preventDefault();
    navigationError = failure('NAVIGATION_BLOCKED', '登录页面尝试前往未支持的域名，已停止自动获取会话。');
  };
  loginWindow.webContents.on('will-navigate', guard);
  loginWindow.webContents.on('will-redirect', guard);
  loginWindow.webContents.on('page-title-updated', event => event.preventDefault());
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const closeOnAbort = () => { if (!loginWindow.isDestroyed()) loginWindow.destroy(); };
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    loginWindow.show();
    // Do not await all page resources: the user can complete a visible challenge.
    loginWindow.loadURL(LOGIN_URL).catch(() => {
      if (!signal.aborted && !loginWindow.isDestroyed()) safeProgress(onProgress, '网页登录仍在加载；如官网显示验证，请直接在登录窗口完成。');
    });
    const adapter = {
      check() { if (navigationError) throw navigationError; if (loginWindow.isDestroyed()) throw failure('LOGIN_CANCELLED', '登录窗口已关闭。'); },
      url: () => loginWindow.isDestroyed() ? 'about:blank' : loginWindow.webContents.getURL() || 'about:blank',
      cookies: () => loginSession.cookies.get({ url: STATUS_URL }),
      status: () => loginWindow.webContents.executeJavaScript(`(${readStatusInPage.toString()})()`),
      userAgent: async () => loginWindow.webContents.getUserAgent(),
    };
    return await pollForCredential(adapter, '应用内登录窗口', onProgress, signal);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error.code) throw error;
    throw failure('LOGIN_FAILED', '登录页面未能完成账号核验，请重新打开官方登录窗口。');
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    if (!loginWindow.isDestroyed()) loginWindow.destroy();
    await loginSession.clearStorageData().catch(() => {});
    await loginSession.clearCache().catch(() => {});
  }
}

async function closeOwnedBrowser(browser) {
  if (!browser) return true;
  let child;
  try { child = browser.process(); } catch { return false; }
  let timer;
  try {
    await Promise.race([browser.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('close timeout')), 4500); })]);
  } catch {
    // This is the exact child created by this launch, never a PID/name lookup.
    if (child && child.exitCode == null && child.signalCode == null) { try { child.kill('SIGTERM'); } catch { /* Leave busy data for next startup. */ } }
  } finally { clearTimeout(timer); }
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  for (let count = 0; count < 10; count++) { await wait(100); if (child.exitCode != null || child.signalCode != null) return true; }
  return false;
}

async function captureExternal(browserInfo, { onProgress, signal, profileRoot }) {
  const profile = await createOwnedProfile(profileRoot);
  let browser;
  let stopped = true;
  try {
    const imported = await import('puppeteer-core');
    const puppeteer = imported.default || imported;
    throwIfAborted(signal);
    safeProgress(onProgress, `正在打开 ${browserInfo.name} 的独立登录窗口。`);
    browser = await puppeteer.launch({
      browser: browserInfo.family === 'firefox' ? 'firefox' : 'chrome',
      executablePath: browserInfo.executablePath, userDataDir: profile,
      headless: false, pipe: browserInfo.family === 'chromium',
      signal, timeout: 45000, dumpio: false,
    });
    stopped = false;
    const child = browser.process();
    if (child?.pid) {
      const markerPath = path.join(profile, PROFILE_MARKER);
      const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
      if (marker.nonce !== ownedProfiles.get(profile)?.nonce) throw failure('PROFILE_CHANGED', '登录临时目录的归属验证失败。');
      await fsp.writeFile(markerPath, JSON.stringify({ ...marker, browserPid: child.pid }), { mode: 0o600 });
    }
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    let navigationError = null;
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.isInterceptResolutionHandled()) return;
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !isTrustedNavigation(request.url())) {
        navigationError = failure('NAVIGATION_BLOCKED', '登录页面尝试前往未支持的域名，已停止自动获取会话。');
        request.abort('blockedbyclient').catch(() => {});
      } else request.continue().catch(() => {});
    });
    page.on('popup', popup => { popup.close().catch(() => {}); });
    page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {
      if (!signal.aborted && !page.isClosed()) safeProgress(onProgress, '网页登录仍在加载；请按官网提示完成登录。');
    });
    const adapter = {
      check() { if (navigationError) throw navigationError; if (!browser.connected || page.isClosed()) throw failure('LOGIN_CANCELLED', '登录浏览器已关闭。'); },
      url: () => page.isClosed() ? 'about:blank' : page.url(),
      cookies: () => page.browserContext().cookies(),
      status: () => page.evaluate(readStatusInPage),
      userAgent: () => browser.userAgent(),
    };
    return await pollForCredential(adapter, browserInfo.name, onProgress, signal);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error.code && !['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error.code)) throw error;
    throw failure('BROWSER_LOGIN_FAILED', '此浏览器未能完成独立登录，请使用应用内登录窗口或其他已安装浏览器。');
  } finally {
    if (browser) stopped = await closeOwnedBrowser(browser);
    const record = ownedProfiles.get(profile);
    if (record) {
      record.active = !stopped;
      if (stopped && !(await removeOwnedProfile(profile, record.nonce))) {
        safeProgress(onProgress, '临时登录目录暂时被系统占用，将在下次启动时清理。');
      }
    }
  }
}

async function captureLogin(options = {}) {
  if (activeCapture) throw failure('LOGIN_BUSY', '请先完成或取消当前登录。');
  const { browserId = 'embedded', parentWindow, onProgress, signal, profileRoot } = options;
  throwIfAborted(signal);
  activeCapture = true;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(failure('LOGIN_CANCELLED', '已取消登录。'));
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  const timer = setTimeout(() => controller.abort(failure('LOGIN_TIMEOUT', '登录等待超过 10 分钟，已关闭本次登录会话。请重新打开登录。')), LOGIN_TIMEOUT_MS);
  try {
    const browsers = await discoverBrowsers();
    throwIfAborted(controller.signal);
    const selected = browsers.find(browser => browser.id === browserId && browser.available);
    if (!selected) throw failure('BROWSER_UNAVAILABLE', '所选浏览器当前不可用，请选择已检测到的浏览器或应用内登录窗口。');
    const parameters = { parentWindow, onProgress, signal: controller.signal, profileRoot };
    return selected.family === 'electron' ? await captureEmbedded(parameters) : await captureExternal(selected, parameters);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
    activeCapture = false;
  }
}

module.exports = {
  discoverBrowsers, captureLogin, validateCredential, cleanupOwnedProfiles,
  __test: { ORIGIN, identityFromStatus, keyForIdentity, cookieHeaderForStatus, isTrustedNavigation, parseCookie, createOwnedProfile, removeOwnedProfile, pollForCredential, readStatusInPage },
};
