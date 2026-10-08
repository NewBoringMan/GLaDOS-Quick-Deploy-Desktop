'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeGitHubDiagnostic } = require('./github.cjs');

const DEFAULT_SETTINGS = Object.freeze({ repoName: 'glados-quick-deploy', exchangePlan: 'plan500', time: '09:30' });
const ACCOUNT_FIELDS = ['accountKey', 'email', 'browser', 'repository', 'runId', 'runUrl', 'conclusion', 'updatedAt', 'pointsAdded', 'message', 'paused', 'status', 'pendingTaskId', 'deploymentStatus', 'githubLogin', 'lastRefreshError', 'resultReadError'];
const RESULT_READ_ERRORS = new Set(['', 'INCOMPLETE_RESULTS', 'ACCOUNT_RESULT_MISSING', 'NETWORK_ERROR', 'TIMEOUT', 'GITHUB_UNAVAILABLE', 'RATE_LIMITED', 'PERMISSION_DENIED', 'AUTH_REQUIRED', 'NOT_FOUND', 'INVALID_RESPONSE', 'RESULTS_UNAVAILABLE']);
const TASK_ID = /^[a-f0-9]{32}$/;
const ACCOUNT_KEY = /^[A-F0-9]{16}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const PHASES = new Set(['github_auth', 'browser_login', 'deploying', 'verifying']);

function cleanEvent(event) {
  return { time: cleanText(event.time, 50), level: ['error', 'warning', 'info', 'success'].includes(event.level) ? event.level : 'info', message: cleanText(event.message),
    ...(['deployment', 'management', 'maintenance'].includes(event.scope) ? { scope: event.scope } : {}) };
}

function cleanText(value, limit = 800) {
  return String(value || '').replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏授权]')
    .replace(/((?:gld|koa):sess(?:\.sig)?\s*=)[^;\s]+/gi, '$1[已隐藏]')
    .replace(/(authorization\s*[:=]\s*)(?:bearer|token)\s+\S+/gi, '$1[已隐藏]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, limit);
}

function cleanCheckpoint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { schemaVersion: 1 };
  for (const key of ['githubLogin', 'accountKey', 'repository', 'branch', 'configSha']) {
    if (typeof raw[key] === 'string' && raw[key].length <= 320 && !/[\x00-\x1f\x7f]/.test(raw[key])) out[key] = raw[key];
  }
  if (out.githubLogin && !LOGIN.test(out.githubLogin)) return null;
  if (out.accountKey && !ACCOUNT_KEY.test(out.accountKey)) return null;
  if (out.repository && !REPOSITORY.test(out.repository)) return null;
  if (out.configSha && !/^[a-f0-9]{40}$/i.test(out.configSha)) return null;
  for (const key of ['githubId', 'repositoryId']) if (Number.isSafeInteger(raw[key]) && raw[key] > 0) out[key] = raw[key];
  for (const key of ['secretStored', 'configured', 'createdRepository']) if (typeof raw[key] === 'boolean') out[key] = raw[key];
  if (raw.dispatch && /^[a-f0-9]{32}$/.test(raw.dispatch.nonce || '') && ACCOUNT_KEY.test(raw.dispatch.accountKey || '') && typeof raw.dispatch.branch === 'string') {
    out.dispatch = { nonce: raw.dispatch.nonce, accountKey: raw.dispatch.accountKey, branch: raw.dispatch.branch.slice(0, 200), submittedAt: Number.isFinite(raw.dispatch.submittedAt) ? raw.dispatch.submittedAt : 0 };
  }
  if (raw.run && Number.isSafeInteger(raw.run.runId) && raw.run.runId > 0 && REPOSITORY.test(raw.run.repository || '')) {
    out.run = { repository: raw.run.repository, runId: raw.run.runId, runUrl: `https://github.com/${raw.run.repository}/actions/runs/${raw.run.runId}`, status: cleanText(raw.run.status, 40), conclusion: raw.run.conclusion ? cleanText(raw.run.conclusion, 40) : null };
  }
  return out;
}

function cleanPendingTask(raw, { includeCredential = false } = {}) {
  if (!raw || typeof raw !== 'object' || !TASK_ID.test(raw.id || '')) return null;
  const out = { id: raw.id, settings: cleanSettings(raw.settings), browserId: cleanText(raw.browserId, 80),
    phase: PHASES.has(raw.phase) ? raw.phase : 'github_auth', revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    createdAt: cleanText(raw.createdAt, 50), updatedAt: cleanText(raw.updatedAt, 50) };
  if (LOGIN.test(raw.githubLogin || '')) out.githubLogin = raw.githubLogin;
  if (Number.isSafeInteger(raw.githubId) && raw.githubId > 0) out.githubId = raw.githubId;
  if (ACCOUNT_KEY.test(raw.expectedAccountKey || '')) out.expectedAccountKey = raw.expectedAccountKey;
  if (TASK_ID.test(raw.credentialVersion || '')) out.credentialVersion = raw.credentialVersion;
  const account = cleanAccount(raw.account);
  if (account) out.account = { accountKey: account.accountKey, email: account.email || '', browser: account.browser || '' };
  const checkpoint = cleanCheckpoint(raw.checkpoint);
  if (checkpoint) out.checkpoint = checkpoint;
  if (raw.lastError && typeof raw.lastError === 'object') out.lastError = {
    code: /^[A-Z_]{1,60}$/.test(raw.lastError.code || '') ? raw.lastError.code : 'OPERATION_FAILED', message: cleanText(raw.lastError.message), stage: cleanText(raw.lastError.stage, 80),
    ...(raw.lastError.resultPending === true ? { resultPending: true } : {}),
    ...(raw.lastError.diagnostic ? { diagnostic: safeGitHubDiagnostic(raw.lastError.diagnostic) } : {}),
  };
  for (const key of ['needsLogin', 'credentialExpired', 'savedAcrossRestart']) if (typeof raw[key] === 'boolean') out[key] = raw[key];
  if (includeCredential && raw.credential && typeof raw.credential === 'object' && !checkpoint?.secretStored) {
    const credential = raw.credential;
    if (typeof credential.cookie === 'string' && credential.cookie.length <= 32768 && typeof credential.userAgent === 'string' && credential.userAgent.length <= 2048 && credential.origin === 'https://glados.cloud' && ACCOUNT_KEY.test(credential.accountKey || '')) {
      out.credential = { cookie: credential.cookie, userAgent: credential.userAgent, origin: credential.origin, accountKey: credential.accountKey, email: cleanText(credential.email, 320), browser: cleanText(credential.browser, 80) };
      if ((typeof credential.userId === 'string' && credential.userId.length <= 256) || (Number.isSafeInteger(credential.userId) && credential.userId > 0)) out.credential.userId = credential.userId;
    }
  }
  return out;
}

function cleanSettings(raw = {}) {
  const out = { ...DEFAULT_SETTINGS };
  if (typeof raw.repoName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(raw.repoName)) out.repoName = raw.repoName;
  if (['plan500', 'plan200', 'plan100', 'off'].includes(raw.exchangePlan)) out.exchangePlan = raw.exchangePlan;
  if (typeof raw.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.time)) out.time = raw.time;
  return out;
}

function cleanAccount(raw) {
  if (!raw || typeof raw !== 'object' || !/^[A-F0-9]{16}$/.test(raw.accountKey || '')) return null;
  const out = {};
  for (const key of ACCOUNT_FIELDS) {
    const value = raw[key];
    if (typeof value === 'string') out[key] = cleanText(value, key === 'message' || key === 'lastRefreshError' ? 500 : 320);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || value === null) out[key] = value;
  }
  if (out.repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(out.repository)) return null;
  if (out.runUrl && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/.test(out.runUrl)) delete out.runUrl;
  if (out.pendingTaskId && !TASK_ID.test(out.pendingTaskId)) delete out.pendingTaskId;
  if (out.resultReadError !== undefined && !RESULT_READ_ERRORS.has(out.resultReadError)) out.resultReadError = 'RESULTS_UNAVAILABLE';
  if (raw.settings && typeof raw.settings === 'object') out.settings = cleanSettings(raw.settings);
  return out;
}

function loadState(directory) {
  try {
    const file = path.join(directory, 'deployment-state.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('原账号文件不符合预期，已停止加载，未覆盖原记录。');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== undefined && ![1, 2].includes(raw.version)) throw new Error('账号数据版本不兼容，原记录已保留。');
    return {
      settings: cleanSettings(raw.settings),
      selectedBrowser: typeof raw.selectedBrowser === 'string' ? raw.selectedBrowser.slice(0, 80) : '',
      accounts: Array.isArray(raw.accounts) ? raw.accounts.map(cleanAccount).filter(Boolean).slice(0, 100) : [],
      pendingDeployments: Array.isArray(raw.pendingDeployments) ? raw.pendingDeployments.map(task => cleanPendingTask(task)).filter(Boolean).slice(0, 100) : [],
      activeTaskId: TASK_ID.test(raw.activeTaskId || '') ? raw.activeTaskId : '',
      events: Array.isArray(raw.events) ? raw.events.slice(-100).map(cleanEvent) : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('无法完整读取原账号数据，未以空记录覆盖。请保留 Data 目录并检查权限或文件完整性。');
  }
}

function saveState(directory, state) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const out = {
    version: 2,
    settings: cleanSettings(state.settings),
    selectedBrowser: String(state.selectedBrowser || '').slice(0, 80),
    accounts: (state.accounts || []).map(cleanAccount).filter(Boolean).slice(0, 100),
    pendingDeployments: (state.pendingDeployments || []).map(task => cleanPendingTask(task)).filter(Boolean).slice(0, 100),
    activeTaskId: TASK_ID.test(state.activeTaskId || '') ? state.activeTaskId : '',
    events: (state.events || []).slice(-100).map(cleanEvent),
  };
  const file = path.join(directory, 'deployment-state.json');
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

module.exports = { DEFAULT_SETTINGS, cleanSettings, cleanAccount, cleanCheckpoint, cleanPendingTask, loadState, saveState };
