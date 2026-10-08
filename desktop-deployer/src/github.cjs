'use strict';

const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { stripVTControlCharacters } = require('node:util');
const {
  APP_ID, UPSTREAM_REPOSITORY, UPSTREAM_SHA, WORKFLOW_FILE, WORKFLOW_PATH,
  KEEPALIVE_FILE, KEEPALIVE_PATH, MANIFEST_PATH, MARKER_PATH, ACCOUNT_KEY_RE,
  renderWorkflow, renderRunner, renderKeepAliveWorkflow, scheduleToCron, validatePlan,
} = require('./workflow.cjs');

const API_VERSION = '2026-03-10';
const LOGIN_RE = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[a-f0-9]{40}$/i;
const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
const RESULT_OUTCOMES = new Set(['checked', 'already_checked', 'authentication_required', 'failed']);
const RESULT_EXCHANGES = new Set(['disabled', 'not_run', 'completed', 'not_needed', 'points_unavailable', 'failed']);
const RESULT_ERRORS = new Set(['authentication', 'configuration', 'execution', 'rate_limited', 'request_failed', 'unexpected_response', 'exchange']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const DIAGNOSTIC_REASONS = new Set([
  'network_eof', 'http2_stream', 'network_transport', 'http_rejected', 'service_unavailable',
  'rate_limited', 'auth_required', 'workflow_scope', 'permission_denied', 'not_found',
  'conflict', 'validation_failed', 'auth_denied', 'auth_expired', 'wrong_account',
  'cli_failed', 'cli_unavailable', 'timeout', 'output_limit', 'aborted', 'invalid_response',
]);
const DIAGNOSTIC_STAGES = new Set([
  'github', 'actions', 'configuration', 'credential', 'deploy', 'dispatch', 'identity', 'login', 'auth-verify',
  'recovery', 'refresh', 'repository', 'results', 'secrets', 'verification', 'management', 'report',
  'github_auth', 'verifying', 'deploying', 'browser_login',
  'upgrade-inspect', 'upgrade-compare', 'upgrade-commit', 'upgrade-verify-config',
  'upgrade-workflows', 'upgrade-retention', 'upgrade-verify-maintenance', 'upgrade-completed',
]);
const ENDPOINT_KINDS = new Set([
  'identity', 'repository', 'repository-contents', 'git-reference', 'git-commit', 'git-tree',
  'actions-permissions', 'actions-retention', 'actions-workflows', 'actions-workflow-enable',
  'actions-workflow-disable', 'actions-dispatch', 'actions-workflow-runs', 'actions-run',
  'actions-jobs', 'actions-job-log', 'actions-artifacts', 'actions-secrets', 'other',
]);
const DIAGNOSTIC_CODES = new Set(`
  ABORTED ACCOUNT_ALREADY_PENDING ACCOUNT_LIMIT ACCOUNT_MISMATCH ACTIONS_DISABLED AMBIGUOUS_RUN
  AUTH_DENIED AUTH_EXPIRED AUTH_REQUIRED AUTOMATION_REJECTED BAD_REQUEST BATCH_OPERATION_MISMATCH BROWSER_UNAVAILABLE
  BUSY CHECKIN_UNVERIFIED CHECKPOINT_SAVE_FAILED CLOUD_BUSY CONFIGURATION_CHANGED
  CONFIGURATION_UNVERIFIED CONFLICT DEPLOYMENT_PENDING DISPATCH_UNCERTAIN GH_NOT_AVAILABLE
  GITHUB_COMMAND_FAILED GITHUB_UNAVAILABLE IDENTITY_MISMATCH IDENTITY_REQUIRED INVALID_ARTIFACT
  INVALID_CHECKPOINT INVALID_CONFIGURATION INVALID_CREDENTIAL INVALID_ENDPOINT INVALID_IDENTITY
  INVALID_METHOD INVALID_NOTE INVALID_OPERATION INVALID_REPORT INVALID_REPOSITORY
  INVALID_REPOSITORY_NAME INVALID_RESPONSE INVALID_RUN INVALID_SETTINGS LOGIN_REQUIRED MANAGEMENT_STATE_INVALID
  NETWORK_ERROR NOT_FOUND NO_ENABLED_ACCOUNTS OPERATION_CHANGED OPERATION_FAILED OUTPUT_LIMIT
  PAGINATION_LIMIT PERMISSION_DENIED PRIOR_DISPATCH_PENDING PRIOR_RUN_PENDING RATE_LIMITED
  REFRESH_FAILED REPOSITORY_CHANGED REPOSITORY_IDENTITY_CHANGED REPOSITORY_NAME_UNAVAILABLE
  REPOSITORY_NOT_READY REQUEST_DEFERRED REQUEST_REJECTED RESOURCE_GONE RESULTS_UNAVAILABLE
  RESULT_MISMATCH RETENTION_UNVERIFIED RETEST_PENDING RUN_EXPIRED RUN_FAILED SESSION_INCOMPLETE SESSION_REJECTED
  STORED_CREDENTIAL_MISSING TASK_LIMIT TASK_NOT_FOUND TIMEOUT UNKNOWN_ACCOUNT UNMANAGED_REPOSITORY
  UNSUPPORTED_MEDIA_TYPE UPGRADE_FAILED UPGRADE_REQUIRED VALIDATION_FAILED WORKFLOW_AUTH_REQUIRED
  WORKFLOWS_UNVERIFIED WRONG_ACCOUNT WRONG_WORKFLOW
`.trim().split(/\s+/));
const RETRYABLE_READ_CODES = new Set(['NETWORK_ERROR', 'TIMEOUT', 'GITHUB_UNAVAILABLE', 'RATE_LIMITED', 'REQUEST_DEFERRED']);
const READ_RETRY_DELAYS = [500, 1500];
const DEFINITE_DISPATCH_REJECTIONS = new Set([
  'AUTH_REQUIRED', 'WORKFLOW_AUTH_REQUIRED', 'PERMISSION_DENIED', 'NOT_FOUND', 'CONFLICT',
  'VALIDATION_FAILED', 'BAD_REQUEST', 'RESOURCE_GONE', 'UNSUPPORTED_MEDIA_TYPE', 'REQUEST_REJECTED',
  'GH_NOT_AVAILABLE',
]);

function safeGitHubDiagnostic(error) {
  const out = {
    code: DIAGNOSTIC_CODES.has(error?.code) ? error.code : 'OPERATION_FAILED',
    stage: DIAGNOSTIC_STAGES.has(error?.stage) ? error.stage : 'github',
  };
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) out.httpStatus = error.httpStatus;
  if (Number.isInteger(error?.exitCode) && error.exitCode >= -2147483648 && error.exitCode <= 4294967295) out.exitCode = error.exitCode;
  if (DIAGNOSTIC_REASONS.has(error?.reason)) out.reason = error.reason;
  if (HTTP_METHODS.has(error?.method)) out.method = error.method;
  if (ENDPOINT_KINDS.has(error?.endpointKind)) out.endpointKind = error.endpointKind;
  return out;
}

function endpointKind(endpoint) {
  const route = endpoint.split('?')[0];
  if (route === 'user') return 'identity';
  if (route === 'user/repos' || /^repos\/[^/]+\/[^/]+$/.test(route)) return 'repository';
  const path = route.replace(/^repos\/[^/]+\/[^/]+\//, '');
  if (path.startsWith('contents/')) return 'repository-contents';
  if (/^git\/refs?\//.test(path)) return 'git-reference';
  if (/^git\/commits(?:\/|$)/.test(path)) return 'git-commit';
  if (/^git\/trees(?:\/|$)/.test(path)) return 'git-tree';
  if (path === 'actions/permissions/artifact-and-log-retention') return 'actions-retention';
  if (/^actions\/permissions(?:\/|$)/.test(path)) return 'actions-permissions';
  if (/^actions\/secrets(?:\/|$)/.test(path)) return 'actions-secrets';
  if (/^actions\/workflows\/[^/]+\/dispatches$/.test(path)) return 'actions-dispatch';
  if (/^actions\/workflows\/[^/]+\/enable$/.test(path)) return 'actions-workflow-enable';
  if (/^actions\/workflows\/[^/]+\/disable$/.test(path)) return 'actions-workflow-disable';
  if (/^actions\/workflows\/[^/]+\/runs$/.test(path)) return 'actions-workflow-runs';
  if (/^actions\/workflows(?:\/[^/]+)?$/.test(path)) return 'actions-workflows';
  if (/^actions\/jobs\/[1-9]\d*\/logs$/.test(path)) return 'actions-job-log';
  if (/^actions\/runs\/[1-9]\d*\/jobs$/.test(path)) return 'actions-jobs';
  if (/^actions\/(?:runs\/[1-9]\d*\/)?artifacts(?:\/|$)/.test(path)) return 'actions-artifacts';
  if (/^actions\/runs(?:\/[1-9]\d*)?$/.test(path)) return 'actions-run';
  return 'other';
}

class GitHubError extends Error {
  constructor(code, message, stage = 'github', details = {}) {
    super(message);
    this.name = code === 'ABORTED' ? 'AbortError' : 'GitHubError';
    this.code = code;
    this.stage = stage;
    this.retryable = Boolean(details.retryable);
    const diagnostic = safeGitHubDiagnostic(details);
    for (const key of ['httpStatus', 'exitCode', 'reason', 'method', 'endpointKind']) {
      if (diagnostic[key] !== undefined) this[key] = diagnostic[key];
    }
    // Only explicitly safe metadata may cross the main/renderer boundary.
    for (const key of ['repository', 'runId', 'runUrl', 'deploymentId']) {
      if (details[key] !== undefined) this[key] = details[key];
    }
  }
}

function aborted(stage = 'github') { return new GitHubError('ABORTED', '操作已取消。', stage, { reason: 'aborted' }); }
function checkAbort(signal, stage) { if (signal?.aborted) throw aborted(stage); }
function validRepository(repository) {
  if (typeof repository !== 'string') return false;
  const parts = repository.split('/');
  return parts.length === 2 && LOGIN_RE.test(parts[0]) && REPO_RE.test(parts[1]) && !['.', '..'].includes(parts[1]);
}
function cleanText(value, maxLength = 120) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLength) : '';
}
function accountKeyFor({ userId, email } = {}) {
  let identity;
  if (userId !== undefined && userId !== null && String(userId).trim()) {
    const id = String(userId).trim();
    if (id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) throw new GitHubError('INVALID_CREDENTIAL', '账号身份无效，请重新登录。', 'credential');
    identity = `glados:user:${id}`;
  } else if (typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.length <= 320) {
    identity = `glados:email:${email.trim().toLowerCase()}`;
  } else {
    throw new GitHubError('IDENTITY_REQUIRED', '未取得已验证的账号身份，请重新完成 GLaDOS 登录。', 'credential');
  }
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16).toUpperCase();
}
function validateCredential(credential) {
  if (!credential || typeof credential !== 'object') throw new GitHubError('INVALID_CREDENTIAL', '请先完成 GLaDOS 登录。', 'credential');
  const cookie = typeof credential.cookie === 'string' ? credential.cookie.trim().replace(/^cookie\s*:\s*/i, '') : '';
  const userAgent = typeof credential.userAgent === 'string' ? credential.userAgent.trim() : '';
  const origin = credential.origin || 'https://glados.cloud';
  if (!cookie || cookie.length > 32768 || !userAgent || userAgent.length > 2048 || /[^\x20-\x7e]/.test(cookie + userAgent) || origin !== 'https://glados.cloud') {
    throw new GitHubError('INVALID_CREDENTIAL', '登录信息格式或来源不正确，请重新登录获取。', 'credential');
  }
  const sessions = new Map();
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name === 'gld:sess' || name === 'gld:sess.sig') {
      if (sessions.has(name)) throw new GitHubError('INVALID_CREDENTIAL', '登录信息包含重复会话，请重新登录。', 'credential');
      sessions.set(name, part.slice(index + 1).trim());
    }
  }
  if (!sessions.get('gld:sess') || !sessions.get('gld:sess.sig')) {
    throw new GitHubError('SESSION_INCOMPLETE', '未取得完整的新版登录会话，请重新登录。', 'credential');
  }
  const key = accountKeyFor(credential);
  if (!ACCOUNT_KEY_RE.test(credential.accountKey || '') || credential.accountKey !== key) {
    throw new GitHubError('IDENTITY_MISMATCH', '登录会话与账号身份不一致，请重新登录。', 'credential');
  }
  return { accountKey: key, cookie, userAgent, origin };
}

function classifyCommandFailure(stdout, stderr, stage, exitCode) {
  // Inspect privately; never attach these strings, command arguments or headers to an error.
  const raw = `${stdout || ''}\n${stderr || ''}`;
  const matches = [...raw.matchAll(/(?:HTTP(?:\/[\d.]+)?\s+|HTTP\s*[:=]\s*)([1-5]\d\d)/gi)];
  const httpStatus = matches.length ? Number(matches[matches.length - 1][1]) : undefined;
  // --include emits granted/accepted scope headers even for normal 404/409 responses.
  // Only an explicit rejection in the body/CLI diagnostic identifies missing scope.
  let bodyDiagnostic = parseHTTPOutput(stdout || '').body;
  try { const body = JSON.parse(bodyDiagnostic); if (typeof body?.message === 'string') bodyDiagnostic = body.message; } catch { /* CLI/network failures are not necessarily JSON. */ }
  const diagnostic = `${bodyDiagnostic}\n${stderr || ''}`
    .split(/\r?\n/).filter(line => !/^\s*x-(?:oauth|accepted-oauth)-scopes\s*:/i.test(line)).join('\n');
  const lower = diagnostic.toLowerCase();
  const failure = (code, message, reason, details = {}) => new GitHubError(code, message, stage, { httpStatus, exitCode, reason, ...details });
  if (/refusing to allow[^\r\n]*workflow[^\r\n]*(?:without|missing)[^\r\n]*scope|(?:missing|required|insufficient)[^\r\n]{0,50}["'`]?workflow["'`]?\s+scope|["'`]?workflow["'`]?\s+scope[^\r\n]{0,35}(?:is required|is missing)/.test(lower)) return failure('WORKFLOW_AUTH_REQUIRED', 'GitHub 授权缺少管理工作流的权限，请补充当前账号的官方授权。', 'workflow_scope');
  if (lower.includes('rate limit') || httpStatus === 429) return failure('RATE_LIMITED', 'GitHub 暂时限制请求频率，请稍后继续。', 'rate_limited', { retryable: true });
  if (httpStatus === 401 || /not logged into|not logged in|please run:.*auth login|to get started with github cli/.test(lower)) return failure('AUTH_REQUIRED', '需要重新登录 GitHub。', 'auth_required');
  if (httpStatus === 400) return failure('BAD_REQUEST', 'GitHub 拒绝了当前请求（HTTP 400），请刷新后核对配置和诊断信息。', 'http_rejected');
  if (httpStatus === 403) return failure('PERMISSION_DENIED', 'GitHub 未允许此操作，请检查授权或仓库 Actions 限制。', 'permission_denied');
  if (httpStatus === 404) return failure('NOT_FOUND', 'GitHub 资源尚未就绪、不存在或当前账号无权访问。', 'not_found');
  if (httpStatus === 408) return failure('NETWORK_ERROR', 'GitHub 接收请求超时，请检查网络后继续核对。', 'timeout', { retryable: true });
  if (httpStatus === 409) return failure('CONFLICT', '仓库在操作期间发生变化，请重新执行配置。', 'conflict');
  if (httpStatus === 410) return failure('RESOURCE_GONE', 'GitHub 上的此项资源已被清理或移除（HTTP 410），请刷新后核对。', 'http_rejected');
  if (httpStatus === 415) return failure('UNSUPPORTED_MEDIA_TYPE', 'GitHub 不接受当前请求的数据格式（HTTP 415），请查看诊断信息。', 'http_rejected');
  if (httpStatus === 422) return failure('VALIDATION_FAILED', 'GitHub 拒绝了当前配置，请重试或检查仓库限制。', 'validation_failed');
  if (httpStatus === 425) return failure('REQUEST_DEFERRED', 'GitHub 暂时无法处理此请求，请稍后继续核对。', 'service_unavailable', { retryable: true });
  if (httpStatus >= 400 && httpStatus < 500) return failure('REQUEST_REJECTED', `GitHub 明确拒绝了当前请求（HTTP ${httpStatus}），请查看诊断信息。`, 'http_rejected');
  if (httpStatus >= 500) return failure('GITHUB_UNAVAILABLE', 'GitHub 服务暂时不可用，请稍后继续。', 'service_unavailable', { retryable: [500, 502, 503, 504].includes(httpStatus) });
  if (/access_denied|authorization.*denied|authentication.*denied/.test(lower)) return failure('AUTH_DENIED', 'GitHub 授权已取消或未获批准。', 'auth_denied');
  if (/expired_token|device.*expired|code.*expired/.test(lower)) return failure('AUTH_EXPIRED', 'GitHub 授权码已过期，请重新登录。', 'auth_expired');
  if (/error refreshing credentials for.+received credentials for/.test(lower)) return new GitHubError('WRONG_ACCOUNT', '请使用原 GitHub 账号完成权限补充。', 'identity', { exitCode, reason: 'wrong_account' });
  if (/(?:^|[:\s])eof(?:$|[\s.)])/m.test(lower)) return failure('NETWORK_ERROR', 'GitHub 连接在响应完成前中断，请检查网络后继续核对。', 'network_eof', { retryable: true });
  if (/\b(?:stream error|goaway|internal_error|refused_stream|http_1_1_required)\b/.test(lower)) return failure('NETWORK_ERROR', 'GitHub 网络连接中断，请检查网络或代理后继续核对。', 'http2_stream', { retryable: true });
  if (/timeout|timed out|dial tcp|no such host|enotfound|econn|network|tls|connection|unexpected eof|proxyconnect/.test(lower)) return failure('NETWORK_ERROR', '无法连接 GitHub，请检查网络后继续。', 'network_transport', { retryable: true });
  if (exitCode === 4) return failure('AUTH_REQUIRED', '需要重新登录 GitHub。', 'auth_required');
  return failure('GITHUB_COMMAND_FAILED', 'GitHub 操作未完成，请查看诊断信息后继续核对。', 'cli_failed');
}

function parseHTTPOutput(output, { metadata = false } = {}) {
  let rest = String(output || '');
  let status = 200;
  let workflowScope = null;
  for (let count = 0; count < 8 && /^HTTP\/\S+\s+\d{3}/.test(rest); count++) {
    const match = rest.match(/^HTTP\/\S+\s+(\d{3})[^\r\n]*\r?\n/);
    if (!match) break;
    status = Number(match[1]);
    const separator = rest.search(/\r?\n\r?\n/);
    if (separator === -1) return { status, body: '', ...(metadata ? { workflowScope } : {}) };
    if (metadata) {
      const scopes = rest.slice(0, separator).match(/^x-oauth-scopes:[ \t]*([^\r\n]*)/im);
      workflowScope = scopes ? scopes[1].split(',').map(value => value.trim().toLowerCase()).includes('workflow') : null;
    }
    const separatorLength = rest.slice(separator).startsWith('\r\n\r\n') ? 4 : 2;
    rest = rest.slice(separator + separatorLength);
  }
  return { status, body: rest, ...(metadata ? { workflowScope } : {}) };
}

function copyCheckpoint(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !LOGIN_RE.test(value.githubLogin || '') || !ACCOUNT_KEY_RE.test(value.accountKey || '')) throw new GitHubError('INVALID_CHECKPOINT', '部署断点格式无效，请重新开始该账号的部署。', 'recovery');
  const next = { schemaVersion: 1, githubLogin: value.githubLogin, accountKey: value.accountKey, secretStored: value.secretStored === true, configured: value.configured === true };
  if (value.githubId != null) {
    if (!Number.isSafeInteger(value.githubId) || value.githubId <= 0) throw new GitHubError('INVALID_CHECKPOINT', '部署断点中的 GitHub 身份无效。', 'recovery');
    next.githubId = value.githubId;
  }
  if (value.repository != null) {
    if (!validRepository(value.repository) || value.repository.split('/')[0].toLowerCase() !== value.githubLogin.toLowerCase() || !Number.isSafeInteger(value.repositoryId) || value.repositoryId <= 0 || typeof value.branch !== 'string' || !value.branch || value.branch.length > 200 || /[\x00-\x20\x7f]/.test(value.branch)) throw new GitHubError('INVALID_CHECKPOINT', '部署断点中的仓库无效。', 'recovery');
    Object.assign(next, { repository: value.repository, repositoryId: value.repositoryId, branch: value.branch });
  }
  if (value.createdRepository === true) next.createdRepository = true;
  if (value.configSha != null) {
    if (!SHA_RE.test(value.configSha)) throw new GitHubError('INVALID_CHECKPOINT', '部署断点中的配置版本无效。', 'recovery');
    next.configSha = value.configSha;
  }
  if (((next.secretStored || next.configured || next.createdRepository) && !next.repository) || (next.configured && !next.secretStored)) throw new GitHubError('INVALID_CHECKPOINT', '部署断点的步骤状态不一致。', 'recovery');
  if (value.dispatch != null) {
    const d = value.dispatch;
    if (!next.configured || !/^[a-f0-9]{32}$/.test(d.nonce || '') || d.accountKey !== next.accountKey || d.branch !== next.branch || !Number.isFinite(d.submittedAt) || d.submittedAt < 0) throw new GitHubError('INVALID_CHECKPOINT', '部署断点中的验证请求无效。', 'recovery');
    next.dispatch = { nonce: d.nonce, accountKey: d.accountKey, branch: d.branch, submittedAt: d.submittedAt };
  }
  if (value.run != null) {
    const run = value.run;
    if (!next.configured || run.repository !== next.repository || !Number.isSafeInteger(run.runId) || run.runId <= 0) throw new GitHubError('INVALID_CHECKPOINT', '部署断点中的运行记录无效。', 'recovery');
    next.run = { repository: next.repository, runId: run.runId, runUrl: `https://github.com/${next.repository}/actions/runs/${run.runId}`, status: ACTIVE_STATUSES.has(run.status) || run.status === 'completed' ? run.status : 'queued', conclusion: ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure', 'neutral'].includes(run.conclusion) ? run.conclusion : null };
  }
  return next;
}

function safeResult(payload) {
  if (!payload || !ACCOUNT_KEY_RE.test(payload.accountKey || '') || !RESULT_OUTCOMES.has(payload.outcome)) return null;
  const result = { accountKey: payload.accountKey, outcome: payload.outcome };
  if (typeof payload.pointsAdded === 'number' && Number.isFinite(payload.pointsAdded) && payload.pointsAdded >= 0 && payload.pointsAdded <= 1000000) result.pointsAdded = payload.pointsAdded;
  if (RESULT_EXCHANGES.has(payload.exchange)) result.exchange = payload.exchange;
  if (RESULT_ERRORS.has(payload.errorKind)) result.errorKind = payload.errorKind;
  // Regenerate UI wording; never forward a message field found in remote logs.
  if (result.outcome === 'authentication_required') result.message = '登录授权被拒绝，请重新登录后更新。';
  else if (result.outcome === 'failed') result.message = '服务端未确认签到成功。';
  else if (result.exchange === 'failed') result.message = '签到已完成，但积分兑换未成功。';
  else if (result.pointsAdded > 0) result.message = '签到已完成，观测到积分增加。';
  else if (result.outcome === 'already_checked') result.message = '今日已签到。';
  else result.message = '服务端已接受签到；本次未核实新增积分。';
  return result;
}

function parseResults(logText) {
  const results = new Map();
  const plainText = stripVTControlCharacters(String(logText));
  for (const match of plainText.matchAll(/QUICK_DEPLOY_RESULT=(\{[^\r\n]*\})/g)) {
    try {
      const result = safeResult(JSON.parse(match[1]));
      if (result) results.set(result.accountKey, result);
    } catch { /* An incomplete line is not a verified result. */ }
  }
  return [...results.values()];
}

function summarizeResults(accounts, conclusion) {
  const checked = accounts.filter(a => ['checked', 'already_checked'].includes(a.outcome));
  const rejected = accounts.filter(a => a.outcome === 'authentication_required');
  const failed = accounts.filter(a => a.outcome === 'failed' || a.exchange === 'failed');
  const credited = checked.filter(a => a.pointsAdded > 0);
  let status = 'unverified';
  if (accounts.length) {
    if (checked.length === accounts.length && failed.length === 0 && conclusion === 'success') {
      status = credited.length ? 'points_increased' : (accounts.every(a => a.outcome === 'already_checked') ? 'already_checked' : 'checked');
    } else if (checked.length > 0) status = 'partial_failure';
    else status = rejected.length === accounts.length ? 'authentication_required' : 'failed';
  }
  return { status, checkedCount: checked.length, creditedCount: credited.length, failedCount: failed.length + rejected.length, accounts };
}

class GitHubClient {
  constructor({ ghPath, onEvent = () => {}, openExternal = async () => {}, spawnImpl = spawn,
    pollIntervalMs = 5000, waitTimeoutMs = 180000, now = Date.now, sleepImpl } = {}) {
    if (typeof ghPath !== 'string' || !ghPath) throw new TypeError('GitHub CLI 路径缺失。');
    this.ghPath = ghPath;
    this.onEvent = onEvent;
    this.openExternal = openExternal;
    this.spawnImpl = spawnImpl;
    this.pollIntervalMs = Math.max(0, pollIntervalMs);
    this.waitTimeoutMs = Math.max(0, Math.min(waitTimeoutMs, 180000));
    this.now = now;
    this.sleepImpl = sleepImpl;
    this._busy = false;
    this._pendingDispatches = new Map();
    this._completedResults = new Map();
  }

  _emit(event) { try { this.onEvent(event); } catch { /* UI listeners cannot alter a GitHub operation. */ } }
  _progress(stage, message, extra = {}) { this._emit({ type: 'progress', stage, message, ...extra }); }

  async _sleep(ms, signal) {
    checkAbort(signal);
    if (this.sleepImpl) return this.sleepImpl(ms, signal);
    await new Promise((resolve, reject) => {
      const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
      const timer = setTimeout(done, ms);
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(aborted()); };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  _runGh(args, { input, signal, stage = 'github', timeoutMs = 60000, maxBuffer = 8 * 1024 * 1024, onStderr } = {}) {
    checkAbort(signal, stage);
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_PAGER: '' };
    // Use the official gh session. Do not import a surrounding tool's token.
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_FORCE_TTY']) delete env[key];
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let stdout = '';
      let stderr = '';
      let size = 0;
      let timer;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const fail = error => { if (!settled) { settled = true; cleanup(); reject(error); } };
      const cancel = () => { try { child?.kill(); } catch {} fail(aborted(stage)); };
      try {
        child = this.spawnImpl(this.ghPath, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
      } catch { fail(new GitHubError('GH_NOT_AVAILABLE', 'GitHub 组件无法启动，请重新打开或重新安装软件。', stage, { reason: 'cli_unavailable' })); return; }
      timer = setTimeout(() => { try { child.kill(); } catch {} fail(new GitHubError('TIMEOUT', 'GitHub 操作等待超时；可稍后继续检查。', stage, { retryable: true, reason: 'timeout' })); }, timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const collect = (kind, chunk) => {
        if (settled) return;
        const value = chunk.toString('utf8');
        size += Buffer.byteLength(value);
        if (size > maxBuffer) { try { child.kill(); } catch {} fail(new GitHubError('OUTPUT_LIMIT', 'GitHub 返回的数据超过读取上限。', stage, { reason: 'output_limit' })); return; }
        if (kind === 'stdout') stdout += value;
        else { stderr += value; if (onStderr) onStderr(value); }
      };
      child.stdout?.on('data', chunk => collect('stdout', chunk));
      child.stderr?.on('data', chunk => collect('stderr', chunk));
      child.on('error', () => fail(new GitHubError('GH_NOT_AVAILABLE', 'GitHub 组件无法启动，请检查安装是否完整。', stage, { reason: 'cli_unavailable' })));
      child.on('close', code => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code === 0) resolve({ stdout, stderr });
        else reject(classifyCommandFailure(stdout, stderr, stage, code));
      });
      child.stdin?.on('error', () => { /* Child failure is reported through close/error. */ });
      try { child.stdin?.end(input); } catch { cancel(); }
    });
  }

  async _api(endpoint, { method = 'GET', body, signal, stage = 'github', raw = false, metadata = false } = {}) {
    if (typeof endpoint !== 'string' || !/^(?:user(?:\/repos)?|repos\/[A-Za-z0-9_.%\/-]+(?:\?.*)?)$/.test(endpoint)) throw new GitHubError('INVALID_ENDPOINT', 'GitHub 请求地址无效。', stage);
    method = typeof method === 'string' ? method.toUpperCase() : '';
    if (!HTTP_METHODS.has(method)) throw new GitHubError('INVALID_METHOD', 'GitHub 请求方法无效。', stage);
    const args = ['api', '--hostname', 'github.com', '--include', '-H', 'Accept: application/vnd.github+json', '-H', `X-GitHub-Api-Version: ${API_VERSION}`, '--method', method, endpoint];
    // gh 2.102 guards non-JSON output even when stdout is a pipe. Actions logs
    // contain ANSI formatting; allow it only here, then parse sanitized records.
    // _runGh always captures this output in pipes and never displays raw logs.
    if (raw && method === 'GET' && /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/jobs\/[1-9]\d*\/logs$/.test(endpoint)) args.push('--allow-escape-sequences');
    let input;
    if (body !== undefined) { args.push('--input', '-'); input = Buffer.from(JSON.stringify(body), 'utf8'); }
    try {
      let output;
      for (let attempt = 0; ; attempt++) {
        checkAbort(signal, stage);
        try { output = await this._runGh(args, { input, signal, stage }); break; }
        catch (error) {
          // A write can have succeeded before its response was lost. Only GET
          // transport/service failures may be retried here; POST intents stay
          // with their caller's durable nonce and are never blindly replayed.
          if (method !== 'GET' || attempt >= READ_RETRY_DELAYS.length || signal?.aborted ||
              !error.retryable || !RETRYABLE_READ_CODES.has(error.code)) throw error;
          await this._sleep(READ_RETRY_DELAYS[attempt], signal);
        }
      }
      const response = parseHTTPOutput(output.stdout, { metadata });
      if (raw) return response.body;
      if (!response.body.trim()) return null;
      try { const data = JSON.parse(response.body); return metadata ? { data, workflowScope: response.workflowScope } : data; }
      catch { throw new GitHubError('INVALID_RESPONSE', 'GitHub 返回的数据无法解析。', stage, { reason: 'invalid_response', httpStatus: response.status, exitCode: 0 }); }
    } catch (error) {
      // Keep the original error (including native AbortError's read-only code).
      // Diagnostic projection is for storage/UI, not for rewriting exceptions.
      try { Object.assign(error, { method, endpointKind: endpointKind(endpoint) }); } catch { /* Frozen errors still retain their original identity. */ }
      throw error;
    }
  }

  async whoami({ signal } = {}) {
    const response = await this._api('user', { signal, stage: 'identity', metadata: true });
    const user = response?.data;
    if (!user || !LOGIN_RE.test(user.login || '') || !Number.isSafeInteger(user.id) || user.id <= 0) throw new GitHubError('INVALID_IDENTITY', '未能确认当前 GitHub 账号。', 'identity');
    return { login: user.login, id: user.id, workflowScope: response.workflowScope === true ? true : response.workflowScope === false ? false : null, name: cleanText(user.name, 80), avatarUrl: typeof user.avatar_url === 'string' && /^https:\/\/avatars\.githubusercontent\.com\//.test(user.avatar_url) ? user.avatar_url : '' };
  }

  async login({ signal, refresh = false } = {}) {
    if (this._busy) throw new GitHubError('BUSY', '已有操作正在进行，请等待完成。', 'login');
    this._busy = true;
    try {
      const previous = refresh ? await this.whoami({ signal }) : null;
      this._progress('login', '请在浏览器中完成 GitHub 官方授权。');
      let buffer = '';
      let opened = false;
      let code;
      let url;
      const args = refresh
        ? ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'workflow', '--clipboard=false']
        : ['auth', 'login', '--hostname', 'github.com', '--web', '--skip-ssh-key', '--clipboard=false', '--scopes', 'workflow'];
      await this._runGh(args, {
        signal, stage: 'login', timeoutMs: 16 * 60 * 1000,
        onStderr: chunk => {
          buffer = (buffer + chunk).replace(/\x1b\[[0-9;]*m/g, '').slice(-32768);
          code ||= buffer.match(/one-time code(?:\s*\([^)]*\))?\s*:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1]?.toUpperCase();
          if (/https:\/\/github\.com\/login\/device(?:[\s?#]|$)/.test(buffer)) url = 'https://github.com/login/device';
          if (!opened && code && url) {
            opened = true;
            this._emit({ type: 'auth-code', code, url, message: '在 GitHub 官方页面输入此授权码并登录。' });
            Promise.resolve().then(() => this.openExternal(url)).catch(() => this._progress('login', '请打开显示的 GitHub 授权链接继续。'));
          }
        },
      });
      this._progress('auth-verify', 'GitHub 官方授权流程已完成，正在确认账号和权限。');
      let user;
      try { user = await this.whoami({ signal }); }
      catch (error) {
        if (error.code !== 'ABORTED' && error.name !== 'AbortError') error.stage = 'auth-verify';
        throw error;
      }
      if (previous && (user.id !== previous.id || user.login.toLowerCase() !== previous.login.toLowerCase())) throw new GitHubError('WRONG_ACCOUNT', '请使用原 GitHub 账号完成权限补充。', 'identity');
      if (user.workflowScope === false) throw new GitHubError('WORKFLOW_AUTH_REQUIRED', 'GitHub 尚未授予工作流权限，请完成当前账号的官方授权。', 'identity');
      this._emit({ type: 'auth-complete', login: user.login });
      return user;
    } finally { this._busy = false; }
  }

  async _readFile(repository, path, ref, signal, optional = false) {
    try {
      const file = await this._api(`repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`, { signal, stage: 'configuration' });
      if (file?.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || file.size > 256 * 1024) throw new GitHubError('INVALID_CONFIGURATION', '部署仓库的配置文件不符合预期。', 'configuration');
      return JSON.parse(Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    } catch (error) {
      if (optional && error.code === 'NOT_FOUND') return null;
      if (error instanceof GitHubError) throw error;
      throw new GitHubError('INVALID_CONFIGURATION', '部署仓库的配置无法读取，请保留仓库并重试。', 'configuration');
    }
  }

  async _head(repository, branch, signal) {
    const ref = await this._api(`repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`, { signal, stage: 'configuration' });
    if (!SHA_RE.test(ref?.object?.sha || '')) throw new GitHubError('REPOSITORY_NOT_READY', 'GitHub 仓库仍在准备中，请稍后继续。', 'configuration', { retryable: true });
    const commit = await this._api(`repos/${repository}/git/commits/${ref.object.sha}`, { signal, stage: 'configuration' });
    if (!SHA_RE.test(commit?.tree?.sha || '')) throw new GitHubError('INVALID_CONFIGURATION', '无法读取部署仓库版本。', 'configuration');
    return { sha: ref.object.sha, tree: commit.tree.sha };
  }

  async _commitFiles(repository, branch, head, files, message, signal) {
    const tree = await this._api(`repos/${repository}/git/trees`, { method: 'POST', signal, stage: 'configuration', body: {
      base_tree: head.tree, tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
    } });
    if (!SHA_RE.test(tree?.sha || '')) throw new GitHubError('INVALID_RESPONSE', 'GitHub 未确认配置文件写入。', 'configuration');
    const commit = await this._api(`repos/${repository}/git/commits`, { method: 'POST', signal, stage: 'configuration', body: { message, tree: tree.sha, parents: [head.sha] } });
    if (!SHA_RE.test(commit?.sha || '')) throw new GitHubError('INVALID_RESPONSE', 'GitHub 未确认配置版本。', 'configuration');
    try {
      await this._api(`repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false }, signal, stage: 'configuration' });
    } catch (error) {
      if (['CONFLICT', 'VALIDATION_FAILED'].includes(error.code)) throw new GitHubError('REPOSITORY_CHANGED', '仓库同时有其他更新，本次未覆盖。重新部署会读取最新配置。', 'configuration', { repository });
      throw error;
    }
    return commit.sha;
  }

  async _ensureRepository(login, repoName, signal, onCreated) {
    const base = repoName || 'glados-quick-deploy';
    if (!REPO_RE.test(base) || ['.', '..'].includes(base)) throw new GitHubError('INVALID_REPOSITORY_NAME', '仓库名称只能包含英文字母、数字、点、横线和下划线。', 'repository');
    for (let suffix = 1; suffix <= 30; suffix++) {
      checkAbort(signal, 'repository');
      const name = suffix === 1 ? base : `${base.slice(0, 94)}-${suffix}`;
      const fullName = `${login}/${name}`;
      let repo;
      try { repo = await this._api(`repos/${fullName}`, { signal, stage: 'repository' }); }
      catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
      let created = false;
      if (!repo) {
        try {
          repo = await this._api('user/repos', { method: 'POST', signal, stage: 'repository', body: { name, description: 'Managed by GLaDOS Quick Deploy. Credentials are stored only in GitHub Actions Secrets.', private: false, auto_init: true, has_issues: false, has_projects: false, has_wiki: false } });
          created = true;
        } catch (error) {
          if (error.code === 'VALIDATION_FAILED') continue;
          throw error;
        }
        if (!Number.isSafeInteger(repo?.id) || repo.id <= 0 || repo.full_name?.toLowerCase() !== fullName.toLowerCase() || typeof repo.default_branch !== 'string' || !repo.default_branch) throw new GitHubError('INVALID_REPOSITORY', 'GitHub 未返回可恢复的新建仓库身份。', 'repository');
        if (onCreated) await onCreated({ repository: fullName, repositoryId: repo.id, branch: repo.default_branch, createdRepository: true });
      }
      if (created) {
        // Creation responses need not include the computed permission block.
        for (let attempt = 0; attempt < 8; attempt++) {
          try { repo = await this._api(`repos/${fullName}`, { signal, stage: 'repository' }); break; }
          catch (error) { if (error.code !== 'NOT_FOUND' || attempt === 7) throw error; await this._sleep(1000, signal); }
        }
      }
      if (repo?.full_name?.toLowerCase() !== fullName.toLowerCase() || repo?.owner?.login?.toLowerCase() !== login.toLowerCase() || !repo?.permissions?.admin || repo.archived || repo.disabled || repo.private) {
        if (!created) continue;
        throw new GitHubError('INVALID_REPOSITORY', '新建仓库未满足部署条件，请检查 GitHub 账号限制。', 'repository');
      }
      const branch = repo.default_branch;
      if (typeof branch !== 'string' || !branch || branch.length > 200) throw new GitHubError('INVALID_REPOSITORY', 'GitHub 未返回有效默认分支。', 'repository');
      let marker = null;
      if (!created) {
        try { marker = await this._readFile(fullName, MARKER_PATH, branch, signal, true); }
        catch (error) { if (error.code !== 'INVALID_CONFIGURATION') throw error; }
        if (!marker || marker.appId !== APP_ID || marker.schemaVersion !== 1 || marker.repositoryId !== repo.id) continue;
      }
      let head;
      for (let attempt = 0; attempt < 12; attempt++) {
        try { head = await this._head(fullName, branch, signal); break; }
        catch (error) {
          if (!created || !['NOT_FOUND', 'REPOSITORY_NOT_READY', 'CONFLICT'].includes(error.code) || attempt === 11) throw error;
          await this._sleep(Math.min(1000 * (attempt + 1), 5000), signal);
        }
      }
      if (created) {
        marker = { appId: APP_ID, schemaVersion: 1, repositoryId: repo.id, createdAt: new Date(this.now()).toISOString(), upstreamRepository: UPSTREAM_REPOSITORY, upstreamSHA: UPSTREAM_SHA };
        await this._commitFiles(fullName, branch, head, { [MARKER_PATH]: JSON.stringify(marker, null, 2) + '\n' }, 'Initialize GLaDOS Quick Deploy', signal);
        head = await this._head(fullName, branch, signal);
      }
      this._progress('repository', created ? '专用部署仓库已创建。' : '已找到本软件管理的部署仓库。', { repository: fullName });
      return { repository: fullName, branch, id: repo.id, head, marker, created };
    }
    throw new GitHubError('REPOSITORY_NAME_UNAVAILABLE', '无法选出可用的专用仓库名称，请更换名称。', 'repository');
  }

  async _resumeRepository(checkpoint, user, signal) {
    const { repository, repositoryId, branch } = checkpoint;
    const repo = await this._api(`repos/${repository}`, { signal, stage: 'repository' });
    if (repo?.id !== repositoryId || repo?.full_name?.toLowerCase() !== repository.toLowerCase() || repo?.owner?.login?.toLowerCase() !== user.login.toLowerCase() || repo?.owner?.id !== user.id) throw new GitHubError('REPOSITORY_IDENTITY_CHANGED', '原部署仓库的身份发生变化，已停止续做。', 'recovery');
    if (!repo?.permissions?.admin || repo.archived || repo.disabled || repo.private || repo.default_branch !== branch) throw new GitHubError('INVALID_REPOSITORY', '原部署仓库的权限或默认分支已改变，请检查后继续。', 'recovery');
    let head;
    for (let attempt = 0; attempt < 12; attempt++) {
      try { head = await this._head(repository, branch, signal); break; }
      catch (error) {
        if (!checkpoint.createdRepository || !['NOT_FOUND', 'REPOSITORY_NOT_READY', 'CONFLICT'].includes(error.code) || attempt === 11) throw error;
        await this._sleep(Math.min(1000 * (attempt + 1), 5000), signal);
      }
    }
    let marker;
    let markerMissing = false;
    try { marker = await this._readFile(repository, MARKER_PATH, head.sha, signal); }
    catch (error) { if (error.code === 'NOT_FOUND') markerMissing = true; else throw error; }
    if (markerMissing && checkpoint.createdRepository && !checkpoint.secretStored && !checkpoint.configured) {
      marker = { appId: APP_ID, schemaVersion: 1, repositoryId, createdAt: new Date(this.now()).toISOString(), upstreamRepository: UPSTREAM_REPOSITORY, upstreamSHA: UPSTREAM_SHA };
      await this._commitFiles(repository, branch, head, { [MARKER_PATH]: JSON.stringify(marker, null, 2) + '\n' }, 'Initialize GLaDOS Quick Deploy', signal);
      head = await this._head(repository, branch, signal);
    }
    if (!marker || marker.appId !== APP_ID || marker.schemaVersion !== 1 || marker.repositoryId !== repositoryId) throw new GitHubError('UNMANAGED_REPOSITORY', '原部署仓库的归属标记不符，已停止续做。', 'recovery');
    return { repository, branch, id: repositoryId, head, marker, created: false };
  }

  async _filesMatch(repository, files, ref, signal) {
    for (const [path, expected] of Object.entries(files)) {
      let file;
      try { file = await this._api(`repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`, { signal, stage: 'configuration' }); }
      catch (error) { if (error.code === 'NOT_FOUND') return false; throw error; }
      if (file?.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || file.size > 256 * 1024) return false;
      if (Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8') !== expected) return false;
    }
    return true;
  }

  async _ownedRepository(repository, signal) {
    if (!validRepository(repository)) throw new GitHubError('INVALID_REPOSITORY', '部署仓库地址无效。', 'repository');
    const user = await this.whoami({ signal });
    if (repository.split('/')[0].toLowerCase() !== user.login.toLowerCase()) throw new GitHubError('WRONG_ACCOUNT', '请登录创建此部署的 GitHub 账号。', 'identity');
    const repo = await this._api(`repos/${repository}`, { signal, stage: 'repository' });
    if (!repo?.permissions?.admin || repo.archived || repo.disabled) throw new GitHubError('PERMISSION_DENIED', '当前账号无法管理此部署仓库。', 'repository');
    const marker = await this._readFile(repository, MARKER_PATH, repo.default_branch, signal);
    if (marker?.appId !== APP_ID || marker.schemaVersion !== 1 || marker.repositoryId !== repo.id) throw new GitHubError('UNMANAGED_REPOSITORY', '此仓库不是本软件创建的专用部署仓库。', 'repository');
    return { repository, branch: repo.default_branch, id: repo.id };
  }

  _validateManifest(manifest) {
    if (!manifest) return { schemaVersion: 1, accounts: [] };
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.accounts) || manifest.accounts.length > 100) throw new GitHubError('INVALID_CONFIGURATION', '账号清单格式不兼容，请保留现有仓库。', 'configuration');
    const keys = manifest.accounts.map(a => a?.accountKey);
    if (keys.some(k => !ACCOUNT_KEY_RE.test(k || '')) || new Set(keys).size !== keys.length) throw new GitHubError('INVALID_CONFIGURATION', '部署仓库的匿名账号清单无效。', 'configuration');
    return manifest;
  }

  async _putCredential(repository, credential, signal) {
    const secret = `GLADOS_ACCOUNT_${credential.accountKey}`;
    const input = Buffer.from(JSON.stringify({ cookie: credential.cookie, userAgent: credential.userAgent, origin: credential.origin }), 'utf8');
    try {
      await this._runGh(['secret', 'set', secret, '--repo', repository, '--app', 'actions'], { input, signal, stage: 'secrets' });
    } finally { input.fill(0); }
  }

  async configurationFiles({ accounts, exchangePlan, time }) {
    const nextManifest = { schemaVersion: 1, accounts, exchangePlan, time, timezone: 'Asia/Taipei', upstreamRepository: UPSTREAM_REPOSITORY, upstreamSHA: UPSTREAM_SHA };
    return {
      [MANIFEST_PATH]: JSON.stringify(nextManifest, null, 2) + '\n',
      [WORKFLOW_PATH]: renderWorkflow({ accounts, exchangePlan, time }),
      [KEEPALIVE_PATH]: renderKeepAliveWorkflow(),
    };
  }

  async _enableWorkflows(repository, signal) {
    const policy = await this._api(`repos/${repository}/actions/permissions`, { signal, stage: 'actions' });
    if (policy?.enabled === false) await this._api(`repos/${repository}/actions/permissions`, { method: 'PUT', body: { enabled: true }, signal, stage: 'actions' });
    for (const filename of [WORKFLOW_FILE, KEEPALIVE_FILE]) {
      for (let attempt = 0; attempt < 12; attempt++) {
        try { await this._api(`repos/${repository}/actions/workflows/${filename}/enable`, { method: 'PUT', signal, stage: 'actions' }); break; }
        catch (error) { if (error.code !== 'NOT_FOUND' || attempt === 11) throw error; await this._sleep(2000, signal); }
      }
    }
  }

  _runSnapshot(repository, run) {
    const runId = Number(run?.id ?? run?.workflow_run_id);
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new GitHubError('INVALID_RUN', 'GitHub 未返回可核实的运行编号。', 'verification');
    const status = ACTIVE_STATUSES.has(run.status) || run.status === 'completed' ? run.status : 'queued';
    const conclusions = new Set(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure', 'neutral']);
    return { repository, runId, runUrl: `https://github.com/${repository}/actions/runs/${runId}`, status, conclusion: conclusions.has(run.conclusion) ? run.conclusion : null };
  }

  async _findRun(repository, branch, nonce, signal, accountKey) {
    const data = await this._api(`repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=50&branch=${encodeURIComponent(branch)}`, { signal, stage: 'verification' });
    const title = `GLaDOS Quick Deploy · ${nonce}`;
    const matches = (data?.workflow_runs || []).filter(r => r.event === 'workflow_dispatch' && (r.display_title === title || r.display_title === `${title} · ${accountKey || 'all'}`));
    if (matches.length > 1) throw new GitHubError('AMBIGUOUS_RUN', '发现多个相同验证标识的任务，请在 GitHub 查看运行记录。', 'verification', { repository });
    return matches[0] || null;
  }

  async _startVerification(repository, branch, signal, accountKey, recovery = {}) {
    if (recovery.dispatch) {
      const remembered = this._pendingDispatches.get(repository);
      if (remembered && remembered.nonce !== recovery.dispatch.nonce) throw new GitHubError('AMBIGUOUS_RUN', '同一仓库还有另一条尚未确认的验证请求，请先恢复该请求。', 'verification', { repository });
      this._pendingDispatches.set(repository, { ...recovery.dispatch });
    }
    const existing = recovery.dispatch || this._pendingDispatches.get(repository);
    const nonce = existing?.nonce || randomBytes(16).toString('hex');
    let response;
    if (!existing) {
      // Remember before submitting; a dropped response must never cause a second POST.
      const intent = { nonce, branch, accountKey, submittedAt: this.now() };
      if (recovery.onIntent) await recovery.onIntent(intent);
      checkAbort(signal, 'dispatch');
      this._pendingDispatches.set(repository, intent);
      try { response = await this._api(`repos/${repository}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { method: 'POST', body: { ref: branch, inputs: { deployment_id: nonce, account_key: accountKey || '' } }, signal, stage: 'dispatch' }); }
      catch (error) {
        if (DEFINITE_DISPATCH_REJECTIONS.has(error.code)) {
          if (recovery.onRejected) await recovery.onRejected();
          this._pendingDispatches.delete(repository); throw error;
        }
        if (error.code === 'ABORTED' || error.name === 'AbortError') throw error;
        // Unknown CLI failures and malformed responses can follow an accepted
        // dispatch. Keep its durable nonce and only look for that original run.
      }
    }
    let run = response?.workflow_run_id ? { id: response.workflow_run_id, status: 'queued' } : null;
    if (!run) {
      for (let attempt = 0; attempt < 12; attempt++) {
        checkAbort(signal, 'verification');
        run = await this._findRun(repository, branch, nonce, signal, existing?.accountKey || accountKey);
        if (run) break;
        if (attempt < 11) await this._sleep(2500, signal);
      }
    }
    if (!run) throw new GitHubError('DISPATCH_UNCERTAIN', '验证请求已提交，但尚未找到运行记录。请继续刷新；软件不会重复提交。', 'verification', { repository, deploymentId: nonce });
    const snapshot = this._runSnapshot(repository, run);
    if (recovery.onRun) await recovery.onRun(snapshot);
    this._pendingDispatches.delete(repository);
    checkAbort(signal, 'verification');
    this._emit({ type: 'run', ...snapshot, credentialUpdated: recovery.credentialUpdated ?? !existing, resumed: Boolean(existing) });
    return snapshot;
  }

  async _readRun(repository, runId, signal) {
    const run = await this._api(`repos/${repository}/actions/runs/${runId}`, { signal, stage: 'verification' });
    if (run?.path && !run.path.startsWith(WORKFLOW_PATH)) throw new GitHubError('WRONG_WORKFLOW', '运行记录不属于本软件的签到任务。', 'verification');
    const snapshot = this._runSnapshot(repository, run);
    checkAbort(signal, 'verification');
    if (snapshot.status !== 'completed') return { ...snapshot, result: { status: 'pending', accounts: [] } };
    const cacheKey = `${repository}/${runId}/${run.run_attempt || 1}`;
    if (this._completedResults.has(cacheKey)) return { ...snapshot, result: this._completedResults.get(cacheKey) };
    let records = [];
    let readError;
    try {
      const jobList = [];
      let total = Infinity;
      for (let page = 1; page <= 10 && jobList.length < total; page++) {
        const jobs = await this._api(`repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=${page}`, { signal, stage: 'results' });
        if (!Array.isArray(jobs?.jobs)) throw new GitHubError('INVALID_RESPONSE', 'GitHub 未返回完整的执行结果。', 'results');
        jobList.push(...jobs.jobs);
        total = Number.isSafeInteger(jobs.total_count) ? jobs.total_count : (jobs.jobs.length < 100 ? jobList.length : Infinity);
        if (!jobs.jobs.length) break;
      }
      if (jobList.length < total) readError = 'INCOMPLETE_RESULTS';
      const allJobs = jobList.filter(job => /^Account [A-F0-9]{16}$/.test(job.name || ''));
      for (let offset = 0; offset < allJobs.length; offset += 3) {
        const batch = await Promise.all(allJobs.slice(offset, offset + 3).map(async job => {
          if (!Number.isSafeInteger(job.id) || job.id <= 0 || job.status !== 'completed') return { records: [] };
          try {
            const text = await this._api(`repos/${repository}/actions/jobs/${job.id}/logs`, { signal, stage: 'results', raw: true });
            return { records: parseResults(text).filter(record => record.accountKey === job.name.slice('Account '.length)) };
          } catch (error) {
            // Settle ordinary failures per account so a different account's
            // readable evidence survives. Cancellation/auth still fail fast.
            if (error.code === 'ABORTED' || error.name === 'AbortError' || error.code === 'AUTH_REQUIRED') throw error;
            return { records: [], readError: error instanceof GitHubError ? error.code : 'RESULTS_UNAVAILABLE' };
          }
        }));
        for (const item of batch) {
          records.push(...item.records);
          readError ||= item.readError;
        }
      }
      const expected = new Set(allJobs.map(job => job.name.slice('Account '.length)));
      records = records.filter(record => expected.has(record.accountKey));
      const received = new Set(records.map(record => record.accountKey));
      if (!allJobs.length || allJobs.some(job => !received.has(job.name.slice('Account '.length)))) readError ||= 'INCOMPLETE_RESULTS';
    } catch (error) {
      if (error.code === 'ABORTED' || error.name === 'AbortError' || error.code === 'AUTH_REQUIRED') throw error;
      readError = error instanceof GitHubError ? error.code : 'RESULTS_UNAVAILABLE';
    }
    records = [...new Map(records.map(record => [record.accountKey, record])).values()];
    const result = summarizeResults(records, snapshot.conclusion);
    if (readError) { result.readError = readError; result.status = 'unverified'; }
    if (!readError && records.length > 0) this._completedResults.set(cacheKey, result);
    return { ...snapshot, result };
  }

  async _waitForRun(snapshot, signal) {
    if (this.waitTimeoutMs === 0) return this._readRun(snapshot.repository, snapshot.runId, signal);
    const deadline = this.now() + this.waitTimeoutMs;
    let latest = snapshot;
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.waitTimeoutMs);
    try {
      do {
        latest = await this._readRun(snapshot.repository, snapshot.runId, controller.signal);
        if (latest.status === 'completed' || this.now() >= deadline) return latest;
        await this._sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - this.now())), controller.signal);
      } while (this.now() < deadline);
      return latest;
    } catch (error) {
      if (timedOut && !signal?.aborted && error.code === 'ABORTED') return latest;
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }

  async deploy({ credential, repoName = 'glados-quick-deploy', exchangePlan = 'plan500', time = '09:30', signal, checkpoint, onCheckpoint } = {}) {
    if (this._busy) throw new GitHubError('BUSY', '已有操作正在进行，请等待完成。', 'deploy');
    let saved = checkpoint == null ? null : copyCheckpoint(checkpoint);
    const captured = credential == null && saved?.secretStored ? null : validateCredential(credential);
    if (captured && saved && captured.accountKey !== saved.accountKey) throw new GitHubError('IDENTITY_MISMATCH', '登录会话与原部署账号不一致，未修改任何仓库。', 'credential');
    if (onCheckpoint !== undefined && typeof onCheckpoint !== 'function') throw new GitHubError('INVALID_CHECKPOINT', '部署断点保存接口无效。', 'recovery');
    const save = async patch => {
      const next = copyCheckpoint({ ...saved, ...patch });
      if (onCheckpoint) {
        try { await onCheckpoint(copyCheckpoint(next)); }
        catch { throw new GitHubError('CHECKPOINT_SAVE_FAILED', '部署断点未能保存，已停止下一步操作。请检查存储后继续。', 'recovery', { repository: next.repository }); }
      }
      saved = next;
      checkAbort(signal, 'recovery');
    };
    try { validatePlan(exchangePlan); scheduleToCron(time); }
    catch { throw new GitHubError('INVALID_SETTINGS', '签到时间或积分兑换设置无效。', 'configuration'); }
    this._busy = true;
    try {
      this._progress('identity', '正在确认 GitHub 授权和部署账号。');
      const user = await this.whoami({ signal });
      if (saved && (saved.githubLogin.toLowerCase() !== user.login.toLowerCase() || saved.githubId != null && saved.githubId !== user.id)) throw new GitHubError('WRONG_ACCOUNT', '请连接原部署绑定的 GitHub 账号后继续。', 'identity');
      if (user.workflowScope === false && !saved?.configured) throw new GitHubError('WORKFLOW_AUTH_REQUIRED', 'GitHub 授权缺少管理工作流的权限，请补充当前账号的官方授权。', 'identity');
      await save({ schemaVersion: 1, githubLogin: user.login, githubId: user.id, accountKey: saved?.accountKey || captured.accountKey });
      const target = saved.repository
        ? await this._resumeRepository(saved, user, signal)
        : await this._ensureRepository(user.login, repoName, signal, created => save(created));
      await save({ repository: target.repository, repositoryId: target.id, branch: target.branch, createdRepository: false });
      const accountKey = saved.accountKey;
      const finishRun = async snapshot => {
        const completed = await this._waitForRun(snapshot, signal);
        if (completed.status === 'completed' && !completed.result?.accounts?.some(account => account.accountKey === accountKey)) {
          completed.result = { ...completed.result, status: 'unverified', requestedAccountMissing: true };
        }
        await save({ run: completed });
        return { ...completed, accountKey, credentialUpdated: true, checkpoint: copyCheckpoint(saved) };
      };
      // Already submitted work needs no credentials, scope expansion, configuration writes or POST.
      if (saved.run) return await finishRun(saved.run);
      const verificationRecovery = {
        dispatch: saved.dispatch, credentialUpdated: true,
        onIntent: dispatch => save({ dispatch }),
        onRejected: () => save({ dispatch: undefined }),
        onRun: run => save({ run }),
      };
      if (saved.dispatch) {
        const snapshot = await this._startVerification(target.repository, target.branch, signal, accountKey, verificationRecovery);
        return await finishRun(snapshot);
      }
      // A previous request with an unknown response is resolved before any new submission.
      if (this._pendingDispatches.has(target.repository)) {
        const previous = await this._startVerification(target.repository, target.branch, signal);
        return { ...(await this._waitForRun(previous, signal)), accountKey, resumed: true, credentialUpdated: false, deploymentPending: true, checkpoint: copyCheckpoint(saved) };
      }
      if (!target.created) {
        let runs;
        try { runs = await this._api(`repos/${target.repository}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=50`, { signal, stage: 'verification' }); }
        catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
        const active = (runs?.workflow_runs || []).find(run => ACTIVE_STATUSES.has(run.status));
        if (active) {
          const snapshot = this._runSnapshot(target.repository, active);
          this._emit({ type: 'run', ...snapshot, resumed: true, credentialUpdated: false });
          this._progress('verification', '已有签到任务正在运行；待完成后再提交新的登录信息。');
          return { ...snapshot, accountKey, resumed: true, credentialUpdated: false, deploymentPending: true, result: { status: 'pending', accounts: [] }, checkpoint: copyCheckpoint(saved) };
        }
      }
      const manifest = this._validateManifest(await this._readFile(target.repository, MANIFEST_PATH, target.head.sha, signal, true));
      const accounts = manifest.accounts.map(a => ({ accountKey: a.accountKey }));
      if (!accounts.some(a => a.accountKey === accountKey)) accounts.push({ accountKey });
      if (accounts.length > 100) throw new GitHubError('ACCOUNT_LIMIT', '单个部署最多支持 100 个账号。', 'configuration');
      if (!saved.secretStored) {
        this._progress('secrets', '正在加密保存此账号的登录会话。');
        await this._putCredential(target.repository, captured, signal);
        await save({ secretStored: true });
      } else {
        // This API returns only name/timestamps, never the secret value.
        let secret;
        try { secret = await this._api(`repos/${target.repository}/actions/secrets/GLADOS_ACCOUNT_${accountKey}`, { signal, stage: 'secrets' }); }
        catch (error) { if (error.code === 'NOT_FOUND') throw new GitHubError('STORED_CREDENTIAL_MISSING', '原部署的登录信息已被移除，请为此账号重新登录。', 'secrets'); throw error; }
        if (secret?.name !== `GLADOS_ACCOUNT_${accountKey}`) throw new GitHubError('STORED_CREDENTIAL_MISSING', '无法确认原部署的登录信息，请为此账号重新登录。', 'secrets');
      }
      this._progress('configuration', '正在配置云端签到与维护任务。');
      const files = await this.configurationFiles({ manifest, accounts, exchangePlan, time, accountKey, target, signal });
      const matches = await this._filesMatch(target.repository, files, target.head.sha, signal);
      if (saved.configured && !matches) throw new GitHubError('CONFIGURATION_CHANGED', '已完成的部署配置发生变化，未覆盖远端内容。请核对设置后选择是否重新部署。', 'configuration', { repository: target.repository });
      let configSha = target.head.sha;
      if (!matches) configSha = await this._commitFiles(target.repository, target.branch, target.head, files, 'Configure GLaDOS Quick Deploy', signal);
      await save({ configured: true, configSha });
      await this._enableWorkflows(target.repository, signal);
      this._progress('verification', '部署已就绪，正在启动一次真实签到验证。');
      const snapshot = await this._startVerification(target.repository, target.branch, signal, accountKey, verificationRecovery);
      return await finishRun(snapshot);
    } finally { if (captured) { captured.cookie = ''; captured.userAgent = ''; } this._busy = false; }
  }

  async refresh({ repository, runId, accountKey, signal } = {}) {
    const target = await this._ownedRepository(repository, signal);
    if (accountKey !== undefined && !ACCOUNT_KEY_RE.test(accountKey)) throw new GitHubError('INVALID_CREDENTIAL', '账号标识无效。', 'verification');
    if (runId === undefined || runId === null) {
      const pending = this._pendingDispatches.get(repository);
      if (pending && (!accountKey || pending.accountKey === accountKey)) {
        const snapshot = await this._startVerification(repository, target.branch, signal);
        runId = snapshot.runId;
      } else {
        const runs = await this._api(`repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=${accountKey ? 100 : 1}`, { signal, stage: 'verification' });
        const latest = (runs?.workflow_runs || []).find(run => !accountKey || run.event === 'schedule' || run.display_title?.endsWith(` · ${accountKey}`) || run.display_title?.endsWith(' · all'));
        if (!latest) return { repository, accountKey, runId: null, runUrl: `https://github.com/${repository}/actions`, status: 'not_started', conclusion: null, result: { status: 'unverified', accounts: [] } };
        runId = latest.id;
      }
    }
    if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) throw new GitHubError('INVALID_RUN', '运行编号无效。', 'verification');
    const snapshot = await this._readRun(repository, Number(runId), signal);
    if (accountKey && snapshot.status === 'completed' && !snapshot.result.accounts.some(account => account.accountKey === accountKey)) {
      return { ...snapshot, accountKey, result: { ...snapshot.result, status: 'unverified', requestedAccountMissing: true } };
    }
    return { ...snapshot, ...(accountKey ? { accountKey } : {}) };
  }

  async pause({ repository, paused, signal } = {}) {
    if (typeof paused !== 'boolean') throw new GitHubError('INVALID_SETTINGS', '任务状态设置无效。', 'actions');
    await this._ownedRepository(repository, signal);
    await this._api(`repos/${repository}/actions/workflows/${WORKFLOW_FILE}/${paused ? 'disable' : 'enable'}`, { method: 'PUT', signal, stage: 'actions' });
    this._progress('actions', paused ? '每日签到已暂停。' : '每日签到已恢复。', { repository, paused });
    return { repository, paused };
  }
}

module.exports = { GitHubClient, GitHubError, accountKeyFor, validateCredential, validRepository, parseResults,
  safeResult, summarizeResults, parseHTTPOutput, classifyCommandFailure, safeGitHubDiagnostic, renderWorkflow, renderRunner,
  renderKeepAliveWorkflow, scheduleToCron, WORKFLOW_FILE, WORKFLOW_PATH, KEEPALIVE_FILE,
  KEEPALIVE_PATH, MANIFEST_PATH, MARKER_PATH, UPSTREAM_REPOSITORY, UPSTREAM_SHA };
