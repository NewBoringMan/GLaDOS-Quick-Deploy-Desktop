'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, Menu, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { safeMessage } = require('./controller.cjs');
const { ManagementController: Controller } = require('./management-controller.cjs');
const { ReportVault } = require('./report-vault.cjs');
const { selectDataDirectory } = require('./data-location.cjs');
const { loadState, saveState } = require('./state.cjs');

const smoke = process.argv.includes('--smoke-test');
const smokeDirectory = process.argv.find(arg => arg.startsWith('--smoke-output='))?.slice('--smoke-output='.length);
let window = null;
let controller = null;
let timer = null;
let browserModule = null;
let captureClosePromise = Promise.resolve();
let quitting = false;
let allowQuit = false;
const smokeActions = [];
const uiFile = path.join(__dirname, '..', 'renderer', 'index.html');
const uiURL = pathToFileURL(uiFile).href;

function dataDirectory() {
  if (smoke) return fs.mkdtempSync(path.join(os.tmpdir(), 'glados-quickdeploy-smoke-'));
  return selectDataDirectory({ standard: app.getPath('userData') });
}

const dataRoot = dataDirectory();
app.setPath('userData', dataRoot);
const profileRoot = path.join(dataRoot, 'temporary-login-profiles');

function ghPath() {
  const executable = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const root = app.isPackaged ? path.join(process.resourcesPath, 'gh') : path.join(__dirname, '..', 'vendor', 'gh');
  return path.join(root, `${process.platform}-${process.arch}`, executable);
}

async function openExternal(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('外部链接不正确。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) throw new Error('只允许打开 GitHub 官方 HTTPS 页面。');
  await shell.openExternal(url.href, { activate: true });
}

function verifyIPC(event) {
  let frameURL;
  try { frameURL = new URL(event.senderFrame?.url); frameURL.hash = ''; } catch { throw new Error('无效的界面请求。'); }
  const frame = event.senderFrame;
  const mainFrame = window?.webContents.mainFrame;
  if (quitting || !window || event.sender.id !== window.webContents.id || frame?.routingId !== mainFrame?.routingId || frame?.processId !== mainFrame?.processId || frameURL.href !== uiURL) throw new Error('无效的界面请求。');
}

function createWindow() {
  window = new BrowserWindow({
    width: 1240, height: 940, minWidth: 1000, minHeight: 760,
    title: 'GLaDOS Quick Deploy', backgroundColor: '#f3f6f8',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, ...(smoke ? { backgroundThrottling: false } : {}) },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url).catch(() => {}); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiURL) { event.preventDefault(); openExternal(url).catch(() => {}); } });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.once('ready-to-show', () => { if (!smoke) window.show(); });
  window.on('closed', () => { window = null; controller?.abort?.abort(); });
  return window.loadFile(uiFile);
}

async function smokeCheck() {
  await new Promise(resolve => setTimeout(resolve, 700));
  const inspection = await window.webContents.executeJavaScript(`(() => ({
    title: document.title,
    text: document.body.innerText.slice(0, 2000),
    hasBridge: typeof window.quickDeploy?.getState === 'function',
    nodeBlocked: typeof window.require === 'undefined' && typeof window.process === 'undefined',
    buttons: document.querySelectorAll('button').length,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2
  }))()`);
  if (!inspection.hasBridge || !inspection.nodeBlocked || inspection.buttons < 2 || inspection.horizontalOverflow || !inspection.text.includes('GLaDOS')) throw new Error('Desktop smoke inspection did not pass');
  const stateFromBridge = await window.webContents.executeJavaScript('window.quickDeploy.getState()');
  if (stateFromBridge.version !== app.getVersion()) throw new Error('IPC state bridge failed');
  const { captureSmokePage } = require('./smoke-capture.cjs');
  const screenshot = (await captureSmokePage(window, { label: 'desktop-smoke.png' })).toPNG();
  await window.webContents.executeJavaScript("location.hash = 'deploy-heading'");
  const stateWithFragment = await window.webContents.executeJavaScript('window.quickDeploy.getState()');
  if (stateWithFragment.version !== app.getVersion()) throw new Error('IPC bridge failed after local accessibility navigation');
  const puppeteer = await import('puppeteer-core');
  if (typeof puppeteer.launch !== 'function') throw new Error('Packaged browser automation component is unavailable');
  const ghVersion = execFileSync(ghPath(), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).split(/\r?\n/)[0];
  if (!ghVersion.startsWith('gh version 2.102.0')) throw new Error('Bundled GitHub CLI did not start at the verified version');
  const { runRendererRegression } = require('./smoke-fixtures.cjs');
  const { runStorageRegression } = require('./smoke-storage.cjs');
  const storage = await runStorageRegression({ directory: dataRoot, safeStorage });
  const recovery = await runRendererRegression({ window, controller, uiFile, actions: smokeActions, outputDirectory: smokeDirectory });
  const { runManagementRendererRegression } = require('./management-smoke.cjs');
  const management = await runManagementRendererRegression({ window, controller, actions: smokeActions, outputDirectory: smokeDirectory });
  const report = { ok: true, platform: process.platform, arch: process.arch, packaged: app.isPackaged, version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, ghExists: fs.existsSync(ghPath()), ghVersion, puppeteerLoaded: true, inspection, storage, recovery, management };
  if (!report.ghExists) throw new Error('Bundled GitHub CLI is missing');
  if (smokeDirectory) {
    fs.mkdirSync(smokeDirectory, { recursive: true });
    fs.writeFileSync(path.join(smokeDirectory, 'desktop-smoke.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(smokeDirectory, 'desktop-smoke.png'), screenshot);
  }
  console.log('QUICK_DEPLOY_SMOKE=' + JSON.stringify(report));
}

async function startup() {
  const { ManagementClient: GitHubClient } = require('./management-client.cjs');
  const { ResumeStore } = require('./resume-store.cjs');
  const browser = require('./browser.cjs');
  browserModule = browser;
  const reportVault = new ReportVault({ directory: dataRoot, safeStorage });
  const github = new GitHubClient({ directory: dataRoot, reportVault, ghPath: ghPath(), onEvent: event => controller?.onGitHubEvent(event), openExternal });
  controller = new Controller({
    github, captureLogin: args => {
      const work = browser.captureLogin(args);
      captureClosePromise = work.then(() => undefined, () => undefined);
      return work;
    }, discoverBrowsers: browser.discoverBrowsers,
    parentWindow: () => window, profileRoot, dataDirectory: dataRoot, version: app.getVersion(),
    platform: process.platform, restored: smoke ? {} : loadState(dataRoot),
    resumeStore: smoke ? undefined : new ResumeStore({ directory: dataRoot, safeStorage }),
    save: state => { if (!smoke) saveState(dataRoot, state); }, openExternal,
    copyAuthCode: value => clipboard.writeText(value),
  });
  if (smoke) {
    // Native renderer checks exercise the real preload/IPC path with fixture data.
    // Intercept before loading the page so no fixture action can reach an account.
    controller.action = async (name, payload = {}) => {
      smokeActions.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
      return controller.snapshot();
    };
  }
  controller.on('state', state => { if (window && !window.isDestroyed()) window.webContents.send('qd:state', state); });
  ipcMain.handle('qd:state', event => { verifyIPC(event); return controller.snapshot(); });
  ipcMain.handle('qd:action', async (event, name, payload) => {
    verifyIPC(event);
    if (typeof name !== 'string' || name.length > 40 || JSON.stringify(payload || {}).length > 12000) throw new Error('操作参数无效。');
    try { return await controller.action(name, payload); }
    catch (error) { controller.reportActionError(error, name, payload); return controller.snapshot(); }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(process.platform === 'darwin' ? [
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ] : [{ label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));
  await createWindow();
  if (smoke) {
    controller.state.browsers = [{ id: 'embedded', name: '内置登录窗口', family: 'electron', available: true, details: '随软件提供' }];
    controller.state.selectedBrowser = 'embedded'; controller.changed();
    let exitCode = 0;
    try { await smokeCheck(); }
    catch (error) { console.error(safeMessage(error.message)); exitCode = 1; }
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
    app.exit(exitCode);
  } else {
    controller.state.busy = true; controller.note('正在识别已安装浏览器和 GitHub 登录状态。');
    try {
      await browser.cleanupOwnedProfiles(profileRoot);
      if (quitting) return;
      await controller.initialize();
      if (!quitting && !controller.state.resumeTasks.length) controller.note('准备就绪。点击一键部署，只需完成登录。');
    }
    catch (error) { controller.state.error = safeMessage(error.message); }
    finally { controller.state.busy = false; controller.changed(); }
    if (quitting) return;
    timer = setInterval(() => controller.refreshPending().catch(() => {}), 30000);
    timer.unref?.();
  }
}

if (!smoke && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { /* Keep the existing window's focus unchanged. */ });
  app.whenReady().then(startup).catch(error => { console.error(safeMessage(error.message)); app.exit(1); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (allowQuit || smoke) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  if (timer) clearInterval(timer);
  let deadline;
  const cleanup = (async () => {
    await controller?.shutdown();
    await captureClosePromise;
    await browserModule?.cleanupOwnedProfiles(profileRoot);
  })();
  Promise.race([cleanup, new Promise(resolve => { deadline = setTimeout(resolve, 12000); })])
    .catch(() => {})
    .finally(() => { clearTimeout(deadline); allowQuit = true; app.quit(); });
});
app.on('will-quit', () => { if (smoke) { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {} } });
