'use strict';

const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { DEFAULT_SETTINGS, cleanSettings, cleanAccount, cleanCheckpoint, cleanPendingTask } = require('./state.cjs');

const PENDING = new Set(['queued', 'pending', 'requested', 'waiting', 'in_progress']);
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const RESULT_READ_LIMIT = 5;
const RESULT_READ_INTERVAL = 30000;
const RESULT_READ_MESSAGES = Object.freeze({
  INCOMPLETE_RESULTS: '工作流已结束，但暂未读到该账号完整的签到结果。',
  ACCOUNT_RESULT_MISSING: '本次运行暂未返回该账号可核实的签到结果。',
  NETWORK_ERROR: '读取签到结果时无法连接 GitHub。',
  TIMEOUT: '读取 GitHub 签到结果超时。',
  GITHUB_UNAVAILABLE: 'GitHub 暂时无法提供签到结果。',
  RATE_LIMITED: 'GitHub 暂时限制了结果查询频率。',
  PERMISSION_DENIED: 'GitHub 拒绝读取运行日志，请检查仓库的 Actions 访问权限。',
  AUTH_REQUIRED: '读取运行结果需要重新连接 GitHub；无需重新登录 GLaDOS。',
  NOT_FOUND: 'GitHub 运行日志暂未就绪、已移除或当前授权无法读取。',
  INVALID_RESPONSE: 'GitHub 返回的运行日志格式暂时无法识别。',
  RESULTS_UNAVAILABLE: '工作流已结束，但签到结果暂时无法读取。',
});
const LOGIN_ERRORS = new Set(['INVALID_CREDENTIAL', 'SESSION_INCOMPLETE', 'SESSION_REJECTED', 'AUTOMATION_REJECTED', 'IDENTITY_MISMATCH', 'ACCOUNT_MISMATCH', 'LOGIN_REQUIRED', 'STORED_CREDENTIAL_MISSING']);

function operationError(code, message, stage = 'deploying') { return Object.assign(new Error(message), { code, stage }); }

function recoveryHint(code) {
  if (code === 'WORKFLOW_AUTH_REQUIRED') return '完成 GitHub 官方补充授权后，会接续当前步骤，已确认的 GLaDOS 登录无需重做。';
  if (code === 'AUTH_REQUIRED') return '重新连接 GitHub 后继续当前任务。';
  if (code === 'WRONG_ACCOUNT') return '此任务绑定原 GitHub 账号，请在官方授权页选择该账号后继续。';
  if (LOGIN_ERRORS.has(code)) return '在官方登录窗口登录卡片上的目标账号，成功后接续任务。';
  if (code === 'DISPATCH_UNCERTAIN') return '正在核对已经发出的验证请求。继续操作只查询原请求，不会重复发起签到。';
  if (code === 'PRIOR_DISPATCH_PENDING') return '同一仓库还有另一账号的验证请求待确认。先继续查询该原任务，再回到本次待办；各账号进度均已保留。';
  if (code === 'RATE_LIMITED') return '等待 GitHub 请求限制解除后继续，已完成步骤会保留。';
  if (['NETWORK_ERROR', 'TIMEOUT', 'GITHUB_UNAVAILABLE'].includes(code)) return '检查网络连接，恢复后点击继续；不必从头登录。';
  if (['REPOSITORY_CHANGED', 'CONFLICT'].includes(code)) return '仓库刚发生更新，继续时会重新读取远端配置，不覆盖其他更新。';
  if (code === 'CONFIGURATION_CHANGED') return '远端配置已改变，普通继续不会覆盖。请核对本任务保存的设置；选择“更新登录并重新部署”后会重新应用这些设置。同一仓库的签到时间和兑换计划由全部账号共享。';
  if (code === 'ACCOUNT_ALREADY_PENDING') return '该账号已有未完成任务。可继续原任务；如需改用其他仓库，请先移除原本地待办后再添加。';
  if (code === 'PERMISSION_DENIED') return '检查 GitHub 账号对目标仓库的管理权限和 Actions 设置，然后继续。';
  if (code === 'CHECKPOINT_SAVE_FAILED') return '检查应用数据目录是否可写，恢复后继续当前任务。';
  return '已完成的步骤会保留，处理提示的问题后可从当前步骤继续。';
}

function sameBinding(a, b) {
  return a.id === b.id && a.credentialVersion === b.credentialVersion && a.account?.accountKey === b.account?.accountKey
    && a.githubLogin?.toLowerCase() === b.githubLogin?.toLowerCase() && a.githubId === b.githubId && a.settings.repoName === b.settings.repoName;
}

function safeMessage(value, secrets = []) {
  let text = String(value || '').slice(0, 4000);
  for (const secret of secrets) if (secret && secret.length >= 8) text = text.split(secret).join('[已隐藏]');
  return text
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏授权]')
    .replace(/((?:gld|koa):sess(?:\.sig)?\s*=)[^;\s]+/gi, '$1[已隐藏]')
    .replace(/(authorization\s*[:=]\s*)(?:bearer|token)\s+\S+/gi, '$1[已隐藏]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, 800);
}

function aborted(error, signal) { return signal?.aborted || error?.name === 'AbortError' || ['ABORT_ERR', 'LOGIN_CANCELLED', 'CANCELLED'].includes(error?.code); }

function pauseFor(ms, signal) {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function evidenceFor(result) {
  if (Array.isArray(result.result?.accounts)) return result.result.accounts.find(account => account.accountKey === result.accountKey) || {};
  return result.result || {};
}

function resultReadCode(value) { return Object.hasOwn(RESULT_READ_MESSAGES, value || '') ? value : 'RESULTS_UNAVAILABLE'; }

function accountConclusion(result) {
  const evidence = evidenceFor(result);
  const status = result.status || '';
  if (PENDING.has(status)) return status;
  if (status === 'not_started') return 'not_started';
  if (evidence.outcome === 'authentication_required') return 'authentication_required';
  if (evidence.outcome === 'failed' || evidence.exchange === 'failed') return 'failure';
  // Cancellation and other whole-run interruptions remain visible even when an
  // account checked in before the interruption. Another account's failure does
  // not erase this account's own accepted result.
  if (FAILED.has(result.conclusion) && result.conclusion !== 'failure') return result.conclusion;
  if (['already', 'already_checked'].includes(evidence.outcome)) return 'already_checked_in';
  if (evidence.outcome === 'checked') return 'checkin_success';
  if (FAILED.has(result.conclusion)) return result.conclusion;
  if (result.result?.status === 'unverified' || Array.isArray(result.result?.accounts) || result.conclusion === 'success') {
    // Retain compatibility with pre-structured adapters that reported a numeric
    // credit result, but never borrow another account's aggregate evidence.
    if (!Array.isArray(result.result?.accounts) && evidence.pointsAdded > 0) return 'checkin_success';
    return 'unverified';
  }
  return result.conclusion || status || 'queued';
}

function accountFailed(conclusion) { return FAILED.has(conclusion) || conclusion === 'authentication_required'; }

class Controller extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.github = options.github;
    this.captureLogin = options.captureLogin;
    this.secrets = [];
    this.abort = null;
    this.pendingAccount = null;
    this.closing = false;
    this.activity = 0;
    this.backgroundAbort = null;
    this.backgroundTask = null;
    this.resultReadAttempts = new Map();
    this.now = options.now || Date.now;
    this.operationDone = Promise.resolve();
    this.initializeAbort = null;
    this.initializeTask = null;
    const restored = options.restored || {};
    this.metadataAuthoritative = Array.isArray(restored.pendingDeployments);
    this.tasks = new Map((restored.pendingDeployments || []).map(task => cleanPendingTask(task)).filter(Boolean).map(task => [task.id, task]));
    this.activeTask = null;
    this.state = {
      version: options.version || '1.1.1', platform: options.platform || process.platform,
      dataDirectory: options.dataDirectory || '', busy: false, stage: 'idle',
      message: '完成登录后，软件会自动部署到你的 GitHub。', error: '', github: null,
      browsers: [], selectedBrowser: restored.selectedBrowser || '',
      settings: cleanSettings(restored.settings || DEFAULT_SETTINGS), authCode: null,
      accounts: (restored.accounts || []).map(cleanAccount).filter(Boolean), events: (restored.events || []).slice(-100), currentRun: null,
      resumeTasks: [], activeTaskId: restored.activeTaskId || '', errorInfo: null, storageWarning: '', progress: { completed: [], current: 0 },
    };
    this.syncTaskSummaries();
  }

  snapshot() { return JSON.parse(JSON.stringify(this.state)); }
  changed() { this.emit('state', this.snapshot()); }
  persist() { this.options.save?.({ ...this.state, pendingDeployments: [...this.tasks.values()].map(task => cleanPendingTask(task)).filter(Boolean) }); }
  needsLogin(task) { return !task.credential && !task.checkpoint?.secretStored && !task.checkpoint?.dispatch && !task.checkpoint?.run; }
  progressFor(task) {
    const completed = [];
    if (task?.githubLogin) completed.push(0);
    if (task && (task.credential || task.checkpoint?.secretStored || task.checkpoint?.run || task.checkpoint?.dispatch)) completed.push(1);
    if (task?.checkpoint?.configured || task?.checkpoint?.run || task?.checkpoint?.dispatch) completed.push(2);
    // A workflow completing does not by itself verify the account result.
    const current = Math.min(3, ['github_auth', 'browser_login', 'deploying', 'verifying'].indexOf(task?.phase || 'github_auth'));
    return { completed, current };
  }
  syncTaskSummaries() {
    this.state.resumeTasks = [...this.tasks.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(task => {
      const needsLogin = this.needsLogin(task);
      const code = task.lastError?.code || '';
      let actionLabel = task.checkpoint?.run || task.checkpoint?.dispatch ? '继续查询原任务' : needsLogin ? '登录并继续' : '继续未完成任务';
      if (code === 'WORKFLOW_AUTH_REQUIRED') actionLabel = '补充 GitHub 授权并继续';
      else if (code === 'WRONG_ACCOUNT') actionLabel = '登录原 GitHub 账号并继续';
      else if (code === 'CONFIGURATION_CHANGED') actionLabel = '重新核对远端配置';
      return { id: task.id, accountKey: task.account?.accountKey || task.expectedAccountKey || '', email: task.account?.email || '',
        repository: task.checkpoint?.repository || (task.githubLogin ? `${task.githubLogin}/${task.settings.repoName}` : ''),
        githubLogin: task.githubLogin || '', browserId: task.browserId, phase: task.phase, settings: { ...task.settings },
        updatedAt: task.updatedAt, errorCode: code, lastError: task.lastError?.message || '', needsLogin,
        canResume: true, savedAcrossRestart: !task.credential || Boolean(task.savedAcrossRestart), actionLabel };
    });
    if (!this.state.activeTaskId) this.state.activeTaskId = this.state.resumeTasks[0]?.id || '';
    const active = this.activeTask || this.tasks.get(this.state.activeTaskId);
    if (active) this.state.progress = this.progressFor(active);
  }
  async saveTasks() {
    this.syncTaskSummaries();
    // Non-secret progress, including dispatch intent, must be durable before another cloud mutation.
    this.persist();
    if (this.options.resumeStore) {
      const result = await this.options.resumeStore.save([...this.tasks.values()].map(task => cleanPendingTask(task, { includeCredential: true })).filter(Boolean));
      this.state.storageWarning = result.warning || '';
      for (const task of this.tasks.values()) task.savedAcrossRestart = Boolean(result.durable);
    }
    this.syncTaskSummaries(); this.persist(); this.changed();
  }
  async saveTask(task) {
    task.revision = (task.revision || 0) + 1; task.updatedAt = new Date().toISOString();
    this.tasks.set(task.id, task); await this.saveTasks();
  }
  async restoreTasks() {
    if (this.options.resumeStore) {
      const loaded = await this.options.resumeStore.load();
      this.state.storageWarning = loaded.warning || '';
      for (const raw of loaded.tasks || []) {
        const encrypted = cleanPendingTask(raw, { includeCredential: true });
        if (!encrypted) continue;
        const metadata = this.tasks.get(encrypted.id);
        // Metadata is saved before the encrypted envelope. A missing task in a valid
        // metadata file is a completed/discarded task, not an invitation to resurrect it.
        if (this.metadataAuthoritative && !metadata) continue;
        // A public checkpoint may be written immediately before its revision is
        // incremented. For equal revisions, metadata is therefore authoritative.
        let task = !metadata || encrypted.revision > metadata.revision ? encrypted : { ...metadata };
        if (!task.credential && encrypted.credential && sameBinding(task, encrypted) && !task.checkpoint?.secretStored && !task.credentialExpired) task.credential = encrypted.credential;
        if (encrypted.credentialExpired && sameBinding(task, encrypted)) { delete task.credential; task.credentialExpired = true; }
        task.savedAcrossRestart = Boolean(loaded.durable);
        this.tasks.set(task.id, task);
      }
    }
    if (!this.tasks.has(this.state.activeTaskId)) this.state.activeTaskId = '';
    this.syncTaskSummaries();
    for (const task of this.tasks.values()) if (task.account) this.upsertPending(task);
    if (this.tasks.size) {
      this.state.stage = 'resume_available';
      this.state.message = `已恢复 ${this.tasks.size} 个未完成任务，选择继续即可接续已保存的步骤。`;
      const active = this.tasks.get(this.state.activeTaskId);
      if (active?.lastError) this.setError(active.lastError, active);
    }
  }
  setError(error, task = this.activeTask, action) {
    const code = /^[A-Z_]{1,60}$/.test(error?.code || '') ? error.code : 'OPERATION_FAILED';
    const message = safeMessage(error?.message || '当前操作未完成。', this.secrets);
    this.state.error = message;
    const summary = task && this.state.resumeTasks.find(item => item.id === task.id);
    const nextAction = task && code === 'CONFIGURATION_CHANGED' && task.account
      ? { taskId: task.id, accountKey: task.account.accountKey, action: 'reloginAccount', actionLabel: '更新登录并重新部署' }
      : task ? { taskId: task.id, action: 'resumeDeploy', actionLabel: summary?.actionLabel || '继续未完成任务' } : action || {};
    this.state.errorInfo = { code, stage: String(error?.stage || task?.phase || this.state.stage).slice(0, 80), message, hint: recoveryHint(code), ...nextAction };
  }
  upsertPending(task) {
    if (!task.account) return;
    const old = this.state.accounts.find(item => item.accountKey === task.account.accountKey);
    this.upsert({ ...old, ...task.account, ...(task.checkpoint?.repository ? { repository: task.checkpoint.repository } : {}),
      githubLogin: task.githubLogin, settings: task.settings, pendingTaskId: task.id, deploymentStatus: old?.deploymentStatus === 'deployed' || old?.runId ? 'deployed' : 'pending' });
  }
  note(message, level = 'info') {
    const safe = safeMessage(message, this.secrets);
    if (!safe) return;
    this.state.events.push({ time: new Date().toISOString(), level, message: safe });
    this.state.events = this.state.events.slice(-150);
    this.state.message = safe;
    this.changed();
  }

  onGitHubEvent(event = {}) {
    if (this.closing) return;
    if (event.type === 'auth-code' && /^[A-Z0-9-]{4,20}$/.test(event.code || '')) {
      this.state.authCode = { code: event.code, url: 'https://github.com/login/device' };
      this.state.stage = 'github_auth';
    }
    if (event.type === 'run' && event.repository && event.runId) {
      this.state.stage = 'verifying';
      this.state.currentRun = {
        repository: event.repository, runId: event.runId,
        runUrl: event.runUrl || `https://github.com/${event.repository}/actions/runs/${event.runId}`,
        status: event.status || 'queued', conclusion: event.conclusion || null,
      };
      if (this.pendingAccount && event.credentialUpdated !== false) this.upsert({ ...this.pendingAccount, ...this.state.currentRun, conclusion: event.conclusion || event.status || 'queued' });
    }
    this.note(event.message || (event.type === 'run' ? 'GitHub 已接收验证任务，正在等待实际结果。' : ''), event.level || 'info');
    this.changed();
  }

  initialize() {
    if (this.initializeTask) return this.initializeTask;
    this.initializeAbort = new AbortController();
    const signal = this.initializeAbort.signal;
    this.initializeTask = (async () => {
      this.state.browsers = await this.options.discoverBrowsers();
      if (!this.state.browsers.some(b => b.id === this.state.selectedBrowser && b.available)) {
        this.state.selectedBrowser = this.state.browsers.find(b => b.available && b.id !== 'embedded')?.id || 'embedded';
      }
      await this.restoreTasks();
      for (const account of this.state.accounts) if (account.conclusion === 'unverified' || account.lastRefreshError) this.scheduleResultRead(account);
      if (signal.aborted) return;
      try { this.state.github = await this.github.whoami({ signal }); } catch { this.state.github = null; }
      if (!this.closing) this.changed();
    })().finally(() => { this.initializeAbort = null; this.initializeTask = null; });
    return this.initializeTask;
  }

  upsert(account) {
    const record = cleanAccount({ ...account, updatedAt: new Date().toISOString() });
    if (!record) throw new Error('账号记录不完整，未写入本地配置。');
    const index = this.state.accounts.findIndex(item => item.accountKey === record.accountKey);
    if (index >= 0) this.state.accounts[index] = { ...this.state.accounts[index], ...record };
    else this.state.accounts.push(record);
    this.persist();
    this.changed();
  }

  async exclusive(work) {
    if (this.closing) throw new Error('软件正在退出，请重新打开后继续。');
    if (this.state.busy) throw new Error('当前任务仍在进行，请等待完成或点击取消。');
    this.activity++;
    this.backgroundAbort?.abort();
    const priorBackground = this.backgroundTask;
    let finishOperation;
    this.operationDone = new Promise(resolve => { finishOperation = resolve; });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.state.busy = true; this.state.error = ''; this.state.errorInfo = null; this.state.authCode = null;
    this.changed();
    try {
      if (priorBackground) await priorBackground.catch(() => {});
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await work(signal);
    }
    catch (error) {
      if (aborted(error, signal)) {
        this.state.stage = 'cancelled';
        this.note(this.activeTask ? '已停止当前操作，完成的步骤已保留，可稍后继续。' : this.state.currentRun ? '已停止本机等待；已提交的 GitHub 任务仍可在账号卡片中查看。' : '已取消当前操作。', 'warning');
      } else {
        this.state.stage = 'error';
        if (this.activeTask) {
          if (LOGIN_ERRORS.has(error?.code)) { delete this.activeTask.credential; this.activeTask.needsLogin = true; }
          if (error?.code === 'STORED_CREDENTIAL_MISSING' && this.activeTask.checkpoint && !this.activeTask.checkpoint.dispatch && !this.activeTask.checkpoint.run) {
            this.activeTask.checkpoint.secretStored = false; this.activeTask.checkpoint.configured = false; delete this.activeTask.checkpoint.configSha;
          }
          this.activeTask.lastError = { code: error?.code || 'OPERATION_FAILED', message: safeMessage(error?.message, this.secrets), stage: error?.stage || this.activeTask.phase };
          this.syncTaskSummaries();
        }
        this.setError(error);
        this.note(this.state.error, 'error');
      }
      if (this.activeTask) {
        try { await this.saveTask(this.activeTask); }
        catch { this.state.storageWarning = '进度暂时无法保存到磁盘；请保持应用打开，检查数据目录权限后继续。'; }
      }
    } finally {
      this.secrets.length = 0; this.abort = null; this.pendingAccount = null; this.activeTask = null;
      this.state.busy = false; this.state.authCode = null;
      this.syncTaskSummaries();
      try { this.persist(); } catch { this.state.storageWarning = '进度暂时无法保存到磁盘，请保持应用打开并检查数据目录。'; }
      this.changed();
      finishOperation();
    }
    return this.snapshot();
  }

  async ensureGitHub(signal, forceLogin = false, { refresh = false, requireWorkflow = true } = {}) {
    let identity;
    try { identity = await this.github.whoami({ signal }); }
    catch (error) {
      if (error.code !== 'AUTH_REQUIRED' && error.status !== 401) throw error;
    }
    if (!identity || forceLogin) {
      this.state.stage = 'github_auth';
      this.note('请在浏览器中完成 GitHub 登录和官方授权。');
      identity = await this.github.login({ signal, refresh: Boolean(refresh && identity) });
    }
    if (!identity?.login || !/^[A-Za-z0-9-]+$/.test(identity.login)) throw new Error('没有取得有效的 GitHub 账号身份。');
    if (requireWorkflow && identity.workflowScope === false) {
      const previous = identity;
      this.state.stage = 'github_auth';
      this.note('GitHub 已连接，需要补充工作流权限。请完成官方授权，随后自动继续。');
      identity = await this.github.login({ signal, refresh: true });
      if (identity?.login?.toLowerCase() !== previous.login.toLowerCase() || (previous.id && identity.id && previous.id !== identity.id)) throw operationError('WRONG_ACCOUNT', '补充授权的 GitHub 账号与当前账号不同，请选择原账号。', 'github_auth');
      if (identity.workflowScope === false) throw operationError('WORKFLOW_AUTH_REQUIRED', 'GitHub 尚未授予工作流管理权限，请完成官方补充授权。', 'github_auth');
    }
    this.state.github = identity; this.state.authCode = null; this.changed();
    return identity;
  }

  createTask(settings, browserId, account) {
    if (this.tasks.size >= 100) throw operationError('TASK_LIMIT', '未完成任务已达 100 个，请先完成或移除已有任务。');
    const now = new Date().toISOString();
    return { id: randomBytes(16).toString('hex'), revision: 0, createdAt: now, updatedAt: now, settings: { ...settings }, browserId,
      phase: 'github_auth', ...(account ? { account: { accountKey: account.accountKey, email: account.email || '', browser: account.browser || browserId }, expectedAccountKey: account.accountKey } : {}) };
  }

  selectTask(task) {
    this.activeTask = task; this.state.activeTaskId = task.id; this.state.currentRun = task.checkpoint?.run || null;
    this.pendingAccount = task.account || null; this.state.stage = task.phase; this.syncTaskSummaries(); this.changed();
  }

  rememberCredential(credential) {
    this.secrets.push(credential.cookie);
    for (const segment of String(credential.cookie).split(';')) {
      const i = segment.indexOf('='); if (i >= 0) this.secrets.push(segment.slice(i + 1).trim());
    }
  }

  bindGitHub(task, identity) {
    if ((task.githubLogin && task.githubLogin.toLowerCase() !== identity.login.toLowerCase()) || (task.githubId && identity.id && task.githubId !== identity.id)) {
      throw operationError('WRONG_ACCOUNT', '此任务属于 GitHub 账号 ' + task.githubLogin + '，请登录该账号后继续。', 'github_auth');
    }
    task.githubLogin = identity.login;
    if (Number.isSafeInteger(identity.id)) task.githubId = identity.id;
  }

  async startDeploy(payload = {}) {
    // Existing callers also get a real resume instead of accidentally starting another login.
    if (!payload.newTask && this.tasks.size) return this.resumeDeploy({ taskId: this.tasks.has(this.state.activeTaskId) ? this.state.activeTaskId : this.tasks.keys().next().value });
    return this.exclusive(async signal => {
      const requested = { ...this.state.settings, ...payload };
      const settings = cleanSettings(requested);
      if (requested.repoName !== settings.repoName || requested.time !== settings.time || requested.exchangePlan !== settings.exchangePlan) throw operationError('INVALID_SETTINGS', '仓库名称、签到时间或兑换计划格式不正确。');
      const browserId = payload.browserId || payload.selectedBrowser || this.state.selectedBrowser;
      if (!this.state.browsers.some(b => b.id === browserId && b.available)) throw operationError('BROWSER_UNAVAILABLE', '所选浏览器不可用，请使用内置登录窗口。');
      this.state.settings = settings; this.state.selectedBrowser = browserId;
      const task = this.createTask(settings, browserId);
      this.selectTask(task); await this.saveTask(task);
      await this.continueDeploy(task, signal);
    });
  }

  async resumeDeploy(payload = {}) {
    return this.exclusive(async signal => {
      const task = this.tasks.get(payload.taskId);
      if (!task) throw operationError('TASK_NOT_FOUND', '该任务已完成或已移除，请查看账号列表。');
      this.selectTask(task);
      await this.continueDeploy(task, signal);
    });
  }

  async continueDeploy(task, signal) {
    const previousError = task.lastError?.code;
    const readOnly = Boolean(task.checkpoint?.run || task.checkpoint?.dispatch);
    const identity = await this.ensureGitHub(signal, previousError === 'WRONG_ACCOUNT', { requireWorkflow: !readOnly && !task.checkpoint?.configured });
    this.bindGitHub(task, identity);
    if (!readOnly) {
      const repository = (task.checkpoint?.repository || `${task.githubLogin}/${task.settings.repoName}`).toLowerCase();
      const unresolved = [...this.tasks.values()].find(other => other.id !== task.id && other.checkpoint?.dispatch && !other.checkpoint?.run
        && other.checkpoint.repository?.toLowerCase() === repository);
      if (unresolved) {
        await this.saveTask(task);
        this.selectTask(unresolved);
        throw operationError('PRIOR_DISPATCH_PENDING', '同一仓库中 ' + (unresolved.account?.email || unresolved.account?.accountKey || '另一账号') + ' 的验证请求仍待确认，请先继续查询原任务。本次待办已保留。', 'verifying');
      }
    }
    delete task.lastError;
    await this.saveTask(task);
    if (this.needsLogin(task)) {
      task.phase = 'browser_login'; this.state.stage = task.phase;
      if (!this.state.browsers.some(b => b.id === task.browserId && b.available)) task.browserId = this.state.selectedBrowser;
      if (!this.state.browsers.some(b => b.id === task.browserId && b.available)) task.browserId = 'embedded';
      await this.saveTask(task);
      this.note(task.account?.email ? '请在专用窗口登录 ' + task.account.email + '，完成后继续此账号的任务。' : '请在专用窗口登录 GLaDOS，登录成功后自动继续。');
      const credential = await this.captureLogin({ browserId: task.browserId, signal, profileRoot: this.options.profileRoot,
        parentWindow: this.options.parentWindow?.(), onProgress: event => this.note(event.message || event) });
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!credential || !/^[A-F0-9]{16}$/.test(credential.accountKey || '')) throw operationError('INVALID_CREDENTIAL', '未取得有效的 GLaDOS 账号身份，请重新登录。', 'browser_login');
      if (task.expectedAccountKey && task.expectedAccountKey !== credential.accountKey) throw operationError('ACCOUNT_MISMATCH', '登录的 GLaDOS 账号与目标账号不同。请登录卡片上的账号，原账号未被修改。', 'browser_login');
      const sameTarget = other => {
        if (other.githubLogin?.toLowerCase() !== task.githubLogin?.toLowerCase() || (other.githubId && task.githubId && other.githubId !== task.githubId)) return false;
        if (other.checkpoint?.repository && task.checkpoint?.repository) return other.checkpoint.repository.toLowerCase() === task.checkpoint.repository.toLowerCase();
        return other.settings.repoName.toLowerCase() === task.settings.repoName.toLowerCase();
      };
      const otherTasks = [...this.tasks.values()].filter(other => other.id !== task.id && (other.account?.accountKey || other.expectedAccountKey) === credential.accountKey);
      const conflicting = otherTasks.find(other => !sameTarget(other));
      const existing = conflicting || otherTasks.find(other => other.checkpoint?.dispatch || other.checkpoint?.run) || otherTasks[0];
      if (existing) {
        this.tasks.delete(task.id);
        if (!conflicting && !existing.checkpoint?.secretStored && !existing.checkpoint?.dispatch && !existing.checkpoint?.run) {
          existing.credential = { ...credential }; existing.credentialVersion = randomBytes(16).toString('hex');
          existing.needsLogin = false; existing.credentialExpired = false;
          existing.account = { accountKey: credential.accountKey, email: existing.account?.email || credential.email || '', browser: credential.browser || task.browserId };
          existing.expectedAccountKey = credential.accountKey;
        }
        this.selectTask(existing); this.upsertPending(existing); await this.saveTasks();
        if (conflicting) throw operationError('ACCOUNT_ALREADY_PENDING', '此 GLaDOS 账号已有绑定其他 GitHub 账号或仓库的未完成任务。已保留原目标；请继续原任务，或先移除其本地待办后再创建新目标。', 'browser_login');
        this.note('此账号已有未完成任务，已合并到原任务并沿用原设置。');
        return this.continueDeploy(existing, signal);
      }
      this.rememberCredential(credential);
      task.credential = { ...credential }; task.credentialVersion = randomBytes(16).toString('hex');
      task.needsLogin = false; task.credentialExpired = false;
      task.account = { accountKey: credential.accountKey, email: credential.email || '', browser: credential.browser || task.browserId };
      task.expectedAccountKey = credential.accountKey;
      this.pendingAccount = task.account;
      task.phase = 'deploying';
      this.upsertPending(task); await this.saveTask(task);
    } else if (task.credential) this.rememberCredential(task.credential);
    this.pendingAccount = task.account;
    task.phase = readOnly ? 'verifying' : 'deploying'; this.state.stage = task.phase;
    this.note(readOnly ? '正在接续查询原验证任务，不会重复提交签到。' : '继续已保存的部署步骤，正在配置该账号的云端任务。');
    await this.saveTask(task);
    let renewedAuthorization = false;
    const deploy = async () => {
      try {
        return await this.github.deploy({ credential: task.credential, ...task.settings, signal, checkpoint: task.checkpoint,
          onCheckpoint: async checkpoint => {
            const saved = cleanCheckpoint(checkpoint);
            if (!saved) throw operationError('CHECKPOINT_SAVE_FAILED', '部署进度格式不正确，已停止后续操作。');
            if (saved.githubLogin && saved.githubLogin.toLowerCase() !== task.githubLogin.toLowerCase()) throw operationError('WRONG_ACCOUNT', 'GitHub 账号在部署期间发生变化，请登录原账号继续。');
            if (saved.accountKey && saved.accountKey !== task.account?.accountKey) throw operationError('ACCOUNT_MISMATCH', '部署检查点与目标账号不一致，已停止操作。');
            task.checkpoint = saved;
            if (saved.secretStored) delete task.credential;
            task.phase = saved.run || saved.dispatch ? 'verifying' : 'deploying';
            this.state.stage = task.phase;
            if (saved.run) this.state.currentRun = saved.run;
            this.upsertPending(task);
            await this.saveTask(task);
          },
        });
      } catch (error) {
        if (renewedAuthorization || !['WORKFLOW_AUTH_REQUIRED', 'AUTH_REQUIRED'].includes(error.code)) throw error;
        renewedAuthorization = true;
        this.note('GitHub 需要完成官方授权；当前 GLaDOS 登录和部署进度已保留。');
        const renewed = await this.ensureGitHub(signal, true, { refresh: error.code === 'WORKFLOW_AUTH_REQUIRED', requireWorkflow: true });
        this.bindGitHub(task, renewed); this.state.stage = task.phase;
        return deploy();
      }
    };
    let result = await deploy();
    const waitingSince = Date.now();
    while (result.deploymentPending) {
      if (Date.now() - waitingSince > 15 * 60 * 1000) throw operationError('PRIOR_RUN_PENDING', '先前的 GitHub 任务仍未结束，当前进度已保存，可稍后继续。');
      this.state.stage = 'deploying';
      this.note('同一仓库的先前任务仍在运行，结束后会自动继续当前账号。');
      await pauseFor(15000, signal); result = await deploy();
    }
    if (result.checkpoint) task.checkpoint = cleanCheckpoint(result.checkpoint);
    const account = this.recordResult({ ...task.account, ...result, settings: task.settings, githubLogin: task.githubLogin, deploymentStatus: 'deployed', pendingTaskId: '' });
    this.tasks.delete(task.id); this.activeTask = null; await this.saveTasks();
    const failed = accountFailed(account.conclusion);
    this.state.stage = failed ? 'error' : 'complete';
    this.state.progress = { completed: account.conclusion === 'unverified' || PENDING.has(account.conclusion) || failed ? [0, 1, 2] : [0, 1, 2, 3], current: 3 };
    if (failed) {
      const evidence = evidenceFor({ ...task.account, ...result });
      this.setError(operationError(evidence.outcome === 'authentication_required' ? 'LOGIN_REQUIRED' : 'RUN_FAILED', this.resultMessage({ ...task.account, ...result }), 'verifying'), null,
        { action: evidence.outcome === 'authentication_required' ? 'reloginAccount' : 'refreshRun', actionLabel: evidence.outcome === 'authentication_required' ? '更新此账号登录' : '刷新此账号结果', accountKey: task.account.accountKey });
    }
    this.note(this.resultMessage({ ...task.account, ...result }), failed ? 'error' : account.conclusion === 'unverified' ? 'warning' : 'info');
  }

  async reloginAccount(payload = {}) {
    return this.exclusive(async signal => {
      const account = this.findAccount(payload.accountKey);
      const previousTasks = [...this.tasks.values()].filter(task => (task.account?.accountKey || task.expectedAccountKey) === account.accountKey);
      const submitted = previousTasks.find(task => task.checkpoint?.dispatch || task.checkpoint?.run);
      if (submitted) {
        this.selectTask(submitted);
        throw operationError('DISPATCH_UNCERTAIN', '此账号还有待确认的验证请求，请先继续查询原任务。', 'verifying');
      }
      const selected = this.tasks.get(this.state.activeTaskId);
      const previous = previousTasks.find(task => task.id === account.pendingTaskId) || previousTasks.find(task => task.id === selected?.id) || previousTasks[0];
      const settings = cleanSettings(previous?.settings || account.settings || this.state.settings);
      if (!previous && account.repository) settings.repoName = account.repository.split('/')[1];
      const task = this.createTask(settings, payload.browserId || this.state.selectedBrowser, account);
      if (account.repository) task.githubLogin = account.repository.split('/')[0];
      else if (account.githubLogin) task.githubLogin = account.githubLogin;
      if (previous) {
        task.githubLogin = previous.githubLogin || previous.checkpoint?.githubLogin || task.githubLogin;
        if (previous.githubId || previous.checkpoint?.githubId) task.githubId = previous.githubId || previous.checkpoint.githubId;
      }
      if (previous?.checkpoint) {
        task.checkpoint = { ...previous.checkpoint, secretStored: false, configured: false };
        delete task.checkpoint.configSha;
      }
      for (const old of previousTasks) this.tasks.delete(old.id);
      this.selectTask(task); this.upsertPending(task); await this.saveTask(task);
      await this.continueDeploy(task, signal);
    });
  }

  resultMessage(result) {
    const status = result.status || result.conclusion || '';
    const evidence = evidenceFor(result);
    const conclusion = accountConclusion(result);
    if (accountFailed(conclusion)) return safeMessage(evidence.message || result.message || '部署已建立，但运行未通过，请查看具体结果。', this.secrets);
    if (conclusion === 'unverified') return this.unverifiedMessage(result);
    if (evidence.pointsAdded > 0) return `部署完成，首次签到已增加 ${evidence.pointsAdded} 积分。以后由 GitHub 定时运行。`;
    if (conclusion === 'already_checked_in') return '部署完成，已确认今天签过到。以后由 GitHub 定时运行。';
    if (PENDING.has(status)) return '部署配置已完成，验证任务仍在排队或运行。软件会继续刷新结果。';
    if (conclusion === 'checkin_success') return '部署完成，已确认服务端接受该账号签到。新增积分以账号卡片中的实际结果为准。';
    return safeMessage(evidence.message || result.message || '部署已建立，但首次验证未通过；请查看账号卡片中的具体结果。', this.secrets);
  }

  resultReadKey(account) { return `${account.repository || ''}/${account.accountKey || ''}/${account.runId || ''}`; }

  resetResultReads(account) {
    const prefix = `${account.repository || ''}/${account.accountKey || ''}/`;
    for (const key of this.resultReadAttempts.keys()) if (key.startsWith(prefix)) this.resultReadAttempts.delete(key);
  }

  scheduleResultRead(account) {
    const key = this.resultReadKey(account);
    if (!this.resultReadAttempts.has(key)) this.resultReadAttempts.set(key, { attempts: 0, nextAt: this.now() + RESULT_READ_INTERVAL });
    return this.resultReadAttempts.get(key);
  }

  unverifiedMessage(result) {
    const code = resultReadCode(result.result?.readError || result.resultReadError || (result.result?.requestedAccountMissing ? 'ACCOUNT_RESULT_MISSING' : 'INCOMPLETE_RESULTS'));
    const exhausted = this.resultReadAttempts.get(this.resultReadKey(result))?.attempts >= RESULT_READ_LIMIT;
    return RESULT_READ_MESSAGES[code] + (exhausted ? ' 已暂停自动补读，可点击“刷新结果”重新查询；无需重新登录 GLaDOS。' : ' 将自动补读原运行结果，也可点击“刷新结果”；无需重新登录 GLaDOS。');
  }

  recordResult(result, { background = false } = {}) {
    const evidence = evidenceFor(result);
    const conclusion = accountConclusion(result);
    const unverified = conclusion === 'unverified';
    if (unverified) this.scheduleResultRead(result);
    else this.resetResultReads(result);
    const resultReadError = unverified ? resultReadCode(result.result?.readError || (result.result?.requestedAccountMissing ? 'ACCOUNT_RESULT_MISSING' : 'INCOMPLETE_RESULTS')) : '';
    const record = { ...result, status: result.status || 'completed', lastRefreshError: '', resultReadError,
      pointsAdded: Number.isFinite(evidence.pointsAdded) ? evidence.pointsAdded : null,
      message: unverified ? this.unverifiedMessage({ ...result, resultReadError }) : safeMessage(evidence.message || result.message || '', this.secrets), conclusion };
    const current = this.state.currentRun;
    const updateOverview = !background || (!this.tasks.has(this.state.activeTaskId) && (!current || current.accountKey === record.accountKey || (!current.accountKey && current.runId === record.runId && current.repository === record.repository)));
    if (updateOverview) {
      this.state.currentRun = { accountKey: record.accountKey, repository: record.repository, runId: record.runId, runUrl: record.runUrl, status: record.status, conclusion, pointsAdded: record.pointsAdded, message: record.message };
      this.state.progress = { completed: unverified || PENDING.has(conclusion) || conclusion === 'not_started' || accountFailed(conclusion) ? [0, 1, 2] : [0, 1, 2, 3], current: 3 };
      if (background) {
        this.state.stage = accountFailed(conclusion) ? 'error' : 'complete';
        this.state.message = this.resultMessage({ ...result, resultReadError });
      }
    }
    this.upsert(record);
    return this.findAccount(record.accountKey);
  }

  findAccount(key) {
    const account = this.state.accounts.find(item => item.accountKey === key);
    if (!account) throw new Error('未找到该账号的部署记录。');
    return account;
  }

  async refreshAccount(account, signal, latest = false) {
    if (!account.repository) throw operationError('DEPLOYMENT_PENDING', '该账号尚未完成部署，请先继续未完成任务。');
    this.resetResultReads(account);
    if (account.conclusion === 'unverified') this.scheduleResultRead(account);
    // An unverified result belongs to a particular run. Manual refresh recovers
    // that run instead of silently switching to a newer account execution.
    const result = await this.github.refresh({ repository: account.repository, accountKey: account.accountKey, ...(latest && account.conclusion !== 'unverified' ? {} : { runId: account.runId }), signal });
    if (signal?.aborted || this.closing) return;
    this.recordResult({ ...account, ...result });
    return result;
  }

  refreshPending() {
    if (this.closing || this.state.busy) return Promise.resolve();
    if (this.backgroundTask) return this.backgroundTask;
    const activity = this.activity;
    const backgroundAbort = new AbortController();
    this.backgroundAbort = backgroundAbort;
    const signal = backgroundAbort.signal;
    const accounts = this.state.accounts.filter(a => PENDING.has(a.conclusion) || PENDING.has(a.status) || a.conclusion === 'unverified').map(a => ({ ...a }));
    this.backgroundTask = (async () => {
      for (const account of accounts) {
        if (signal.aborted || this.closing || this.state.busy || activity !== this.activity) return;
        const bounded = account.conclusion === 'unverified' || Boolean(account.lastRefreshError);
        let retry = this.resultReadAttempts.get(this.resultReadKey(account));
        if (bounded) {
          retry = retry || this.scheduleResultRead(account);
          if (retry.attempts >= RESULT_READ_LIMIT || this.now() < retry.nextAt) continue;
          retry.attempts++; retry.nextAt = this.now() + RESULT_READ_INTERVAL;
        }
        try {
          const result = await this.github.refresh({ repository: account.repository, accountKey: account.accountKey, runId: account.runId, signal });
          if (signal.aborted || this.closing || this.state.busy || activity !== this.activity) return;
          this.recordResult({ ...account, ...result }, { background: true });
        } catch (error) {
          if (signal.aborted || this.closing || this.state.busy || activity !== this.activity) return;
          if (!bounded) {
            retry = this.scheduleResultRead(account);
            retry.attempts++; retry.nextAt = this.now() + RESULT_READ_INTERVAL;
          }
          const message = RESULT_READ_MESSAGES[resultReadCode(error?.code)] + (retry.attempts >= RESULT_READ_LIMIT ? ' 已暂停自动补读，可点击“刷新结果”重新查询。' : ' 稍后会自动重试，也可点击“刷新结果”。');
          this.upsert({ ...account, lastRefreshError: message });
        }
      }
    })().finally(() => {
      if (this.backgroundAbort === backgroundAbort) { this.backgroundAbort = null; this.backgroundTask = null; }
    });
    return this.backgroundTask;
  }

  async shutdown() {
    this.closing = true;
    this.activity++;
    this.abort?.abort();
    this.backgroundAbort?.abort();
    this.initializeAbort?.abort();
    await Promise.allSettled([this.operationDone, this.backgroundTask, this.initializeTask].filter(Boolean));
  }

  async action(name, payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('操作参数不正确。');
    if (name === 'cancel') { this.abort?.abort(); if (this.state.busy) { this.state.stage = 'cancelling'; this.note('正在关闭本次操作，请稍候。'); } return this.snapshot(); }
    if (name === 'connectGithub') return this.exclusive(async signal => { await this.ensureGitHub(signal, true); this.state.stage = this.tasks.size ? 'resume_available' : 'idle'; this.note(`已连接 GitHub：${this.state.github.login}。${this.tasks.size ? '可以继续已保存的任务。' : ''}`); });
    if (name === 'startDeploy') return this.startDeploy(payload);
    if (name === 'resumeDeploy') return this.resumeDeploy(payload);
    if (name === 'reloginAccount') return this.reloginAccount(payload);
    if (name === 'discardResume') return this.exclusive(async () => {
      const task = this.tasks.get(payload.taskId);
      if (!task) return;
      this.tasks.delete(task.id);
      if (this.state.activeTaskId === task.id) { this.state.activeTaskId = ''; this.state.currentRun = null; this.state.progress = { completed: [], current: 0 }; }
      this.state.accounts = this.state.accounts.filter(account => account.pendingTaskId !== task.id || account.runId || account.deploymentStatus === 'deployed');
      for (const account of this.state.accounts) if (account.pendingTaskId === task.id) account.pendingTaskId = '';
      await this.saveTasks(); this.state.stage = this.tasks.size ? 'resume_available' : 'idle';
      this.note('已移除这项本地待办。已经建立的 GitHub 仓库和云端任务仍保留。');
    });
    if (name === 'refreshAll') return this.exclusive(async signal => {
      const accounts = this.state.accounts.filter(account => account.repository && (account.runId || account.deploymentStatus === 'deployed'));
      let successful = 0; let failed = 0;
      for (const account of accounts) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        try { await this.refreshAccount({ ...account }, signal, true); successful++; }
        catch (error) {
          if (aborted(error, signal)) throw error;
          failed++; const message = safeMessage(error?.message, this.secrets);
          this.upsert({ ...account, lastRefreshError: message });
          this.note((account.email || account.accountKey) + '：' + message, 'warning');
        }
      }
      this.state.stage = failed && !successful ? 'error' : 'complete';
      if (!accounts.length) this.note('还没有已部署账号。请先继续待办或添加账号。');
      else this.note('已刷新 ' + successful + ' 个账号' + (failed ? '；' + failed + ' 个账号暂未刷新，可在各自卡片查看原因。' : '，各账号的结果已分别更新。'), failed ? 'warning' : 'info');
      if (failed && !successful) this.setError(operationError('REFRESH_FAILED', '暂时未能刷新账号，请检查各账号提示后重试。'), null, { action: 'refreshAll', actionLabel: '重新刷新全部' });
    });
    if (name === 'refreshRun') return this.exclusive(async signal => {
      const result = await this.refreshAccount(this.findAccount(payload.accountKey), signal, true);
      const account = this.findAccount(payload.accountKey);
      const failed = accountFailed(account.conclusion);
      this.state.stage = failed ? 'error' : 'complete';
      if (failed) {
        const authentication = evidenceFor({ ...this.findAccount(payload.accountKey), ...result }).outcome === 'authentication_required';
        this.setError(operationError(authentication ? 'LOGIN_REQUIRED' : 'RUN_FAILED', this.resultMessage({ ...this.findAccount(payload.accountKey), ...result }), 'verifying'), null,
          { action: authentication ? 'reloginAccount' : 'refreshRun', actionLabel: authentication ? '更新此账号登录' : '刷新此账号结果', accountKey: payload.accountKey });
      }
      this.note(failed ? this.state.error : this.resultMessage({ ...account, ...result }), failed ? 'error' : account.conclusion === 'unverified' ? 'warning' : 'info');
    });
    if (name === 'pause') return this.exclusive(async signal => {
      const account = this.findAccount(payload.accountKey);
      if (typeof payload.paused !== 'boolean') throw new Error('暂停状态不正确。');
      await this.github.pause({ repository: account.repository, paused: payload.paused, signal });
      for (const item of this.state.accounts.filter(a => a.repository === account.repository)) item.paused = payload.paused;
      this.persist(); this.state.stage = 'complete'; this.note(payload.paused ? '此仓库的定时签到已暂停。' : '此仓库的定时签到已恢复。');
    });
    if (name === 'openRun' || name === 'openRepository') {
      const account = this.findAccount(payload.accountKey);
      const url = name === 'openRun' ? account.runUrl : account.repository ? `https://github.com/${account.repository}` : null;
      if (url) await this.options.openExternal(url);
    } else if (name === 'copyAuthCode') {
      if (this.state.authCode?.code) this.options.copyAuthCode?.(this.state.authCode.code);
    } else if (name === 'saveSettings') {
      if (this.state.busy) throw new Error('任务执行期间不能修改部署设置。');
      this.state.settings = cleanSettings({ ...this.state.settings, ...payload });
      if (this.state.browsers.some(b => b.id === payload.selectedBrowser && b.available)) this.state.selectedBrowser = payload.selectedBrowser;
      this.persist(); this.changed();
    } else throw new Error('不支持的操作。');
    return this.snapshot();
  }
}

module.exports = { Controller, safeMessage, PENDING };
