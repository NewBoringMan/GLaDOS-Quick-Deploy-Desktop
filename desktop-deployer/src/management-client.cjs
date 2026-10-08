'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { stripVTControlCharacters } = require('node:util');
const { GitHubClient, GitHubError, validRepository, safeGitHubDiagnostic } = require('./github.cjs');
const { VERSION, normalizeManifest, updateAccounts, businessDate, retainedHistory, TIME, KEY } = require('./schedule-config.cjs');
const { deploymentFiles, CLEANUP_FILE } = require('./cloud-workflows.cjs');
const { MANIFEST_PATH, WORKFLOW_PATH, WORKFLOW_FILE, KEEPALIVE_FILE } = require('./workflow.cjs');
const { atomicJSON, readJSON } = require('./report-vault.cjs');
const ACTIVE = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
const fail = (code, message) => new GitHubError(code, message, 'management');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordKey = (repository, accountKey) => repository.toLowerCase() + '/' + accountKey;
const ISO = /^\d{4}-\d\d-\d\dT/;
const OPERATION_STAGES = new Set(['dispatch', 'run', 'receipts', 'details']);
const RUN_CONCLUSIONS = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']);

function upgradeProgress(attempt) {
  return { stage: attempt.stage, configurationVerified: attempt.configurationVerified === true, maintenanceVerified: attempt.maintenanceVerified === true,
    ...(/^[a-f0-9]{40}$/i.test(attempt.commitSha || '') ? { commitSha: attempt.commitSha } : {}) };
}
function operationProgress(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return { submission: value.submission === 'accepted' ? 'accepted' : 'uncertain', stage: OPERATION_STAGES.has(value.stage) ? value.stage : 'run',
    ...(Number.isSafeInteger(Number(value.runId)) && Number(value.runId) > 0 ? { runId: Number(value.runId) } : {}),
    ...(ACTIVE.has(value.runStatus) || value.runStatus === 'completed' ? { runStatus: value.runStatus } : {}),
    ...(RUN_CONCLUSIONS.has(value.runConclusion) ? { runConclusion: value.runConclusion } : {}),
    resultVerified: value.resultVerified === true, detailsVerified: value.detailsVerified === true };
}

function receiptProjection(value) {
  if (!value || value.schemaVersion !== 2 || value.phase !== 'final' || !/^\d{4}-\d{2}-\d{2}$/.test(value.businessDate || '') || !KEY.test(value.accountKey || '') || !ISO.test(value.observedAt || '') || !Number.isFinite(Date.parse(value.observedAt))) return null;
  const out = { accountKey: value.accountKey, observedAt: value.observedAt, businessDate: value.businessDate };
  for (const k of ['outcome', 'exchange', 'errorKind', 'operation', 'checkinBusinessDate', 'checkinConfirmedAt', 'exchangeConfirmedAt', 'reportError']) if (typeof value[k] === 'string' && /^[A-Za-z0-9_:T.+-]{0,100}$/.test(value[k])) out[k] = value[k];
  for (const k of ['checkinConfirmed', 'authenticationRequired', 'exchangeUncertain', 'checkinUncertain']) if (typeof value[k] === 'boolean') out[k] = value[k];
  return out;
}
function detailsProjection(value) {
  const out = {};
  for (const k of ['points', 'leftDays']) if (typeof value?.[k] === 'number' && Number.isFinite(value[k]) && value[k] >= 0 && value[k] <= 1e9) out[k] = value[k];
  if (typeof value?.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) && value.email.length <= 320) out.email = value.email;
  if (value?.receipt && Number.isFinite(value.receipt.pointsAdded) && value.receipt.pointsAdded >= 0 && value.receipt.pointsAdded <= 1e6) out.pointsAdded = value.receipt.pointsAdded;
  out.statusFresh = value?.statusFresh === true;
  out.exchangePlans = (Array.isArray(value?.exchangePlans) ? value.exchangePlans : []).filter(x => ['plan100', 'plan200', 'plan500'].includes(x.id) && Number.isFinite(x.points) && Number.isFinite(x.days)).slice(0, 3).map(x => ({ id: x.id, points: x.points, days: x.days }));
  return out;
}

class ManagementClient extends GitHubClient {
  constructor(options) {
    super(options); this.vault = options.reportVault; this.directory = options.directory; this.reportCache = new Map();
    this.managementFile = path.join(this.directory, 'management-state.v2.json');
    this.managed = readJSON(this.managementFile, { version: 1, repositories: {}, accounts: {}, operations: {}, history: [] });
    if (this.managed.version !== 1 || !this.managed.repositories || !this.managed.accounts || !this.managed.operations) throw fail('MANAGEMENT_STATE_INVALID', '账号管理记录格式异常，原数据已保留。');
    if (!this.managed.checkinBlocks) this.managed.checkinBlocks = {};
    if (typeof this.managed.checkinBlocks !== 'object' || Array.isArray(this.managed.checkinBlocks)) throw fail('MANAGEMENT_STATE_INVALID', '账号操作保护记录格式异常，原数据已保留。');
    this.managed.history = retainedHistory(this.managed.history, this.now());
    this.onManagement = () => {};
    let interrupted = false;
    for (const row of Object.values(this.managed.repositories)) {
      if (row?.upgradeAttempt?.status !== 'running') continue;
      row.upgradeAttempt = { ...row.upgradeAttempt, status: 'pending', interrupted: true };
      delete row.upgradeVerifiedAt; interrupted = true;
    }
    // Restoring a checkpoint only corrects its local display state; it never
    // resumes an unfinished cloud write or treats old timestamps as completion.
    if (interrupted) this.saveManagement();
  }
  saveManagement() { this.managed.history = retainedHistory(this.managed.history, this.now()); atomicJSON(this.managementFile, this.managed); this.onManagement(); }
  snapshotManagement() { return JSON.parse(JSON.stringify(this.managed)); }
  _validateManifest(raw) { if (raw?.schemaVersion === 2) return normalizeManifest(raw); return super._validateManifest(raw); }
  async configurationFiles({ manifest, accounts, exchangePlan, time, accountKey }) {
    let config = normalizeManifest(manifest?.accounts?.length ? manifest : { schemaVersion: 1, accounts: [], time, exchangePlan });
    for (const item of accounts) if (!config.accounts.some(a => a.accountKey === item.accountKey)) config.accounts.push({ accountKey: item.accountKey, times: [time], exchangePlan, enabled: true });
    config.reporting = await this.vault.ensure(config.reporting);
    return deploymentFiles(config);
  }
  async _enableWorkflows(repository, signal) {
    await super._enableWorkflows(repository, signal);
    for (let attempt = 0; attempt < 8; attempt++) {
      try { await this._api(`repos/${repository}/actions/workflows/${CLEANUP_FILE}/enable`, { method: 'PUT', signal }); break; }
      catch (e) { if (e.code !== 'NOT_FOUND' || attempt === 7) throw e; await this._sleep(1500, signal); }
    }
  }
  async textFile(repository, filename, ref, signal, optional = false) {
    try {
      const file = await this._api(`repos/${repository}/contents/${filename}?ref=${encodeURIComponent(ref)}`, { signal });
      if (file?.encoding !== 'base64' || file.size > 256 * 1024 || file.type !== 'file') throw fail('INVALID_CONFIGURATION', '云端文件格式不符合预期。');
      return { text: Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8'), sha: file.sha };
    } catch (e) { if (optional && e.code === 'NOT_FOUND') return null; throw e; }
  }
  async pages(endpoint, field, signal, limit = 50) {
    let out = [];
    for (let page = 1; page <= limit; page++) {
      const result = await this._api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { signal });
      const list = field ? result?.[field] : result;
      if (!Array.isArray(list)) throw fail('INVALID_RESPONSE', 'GitHub 列表无法完整读取。');
      out.push(...list); if (list.length < 100) return out;
    }
    throw fail('PAGINATION_LIMIT', '记录数量超过安全读取上限，未继续执行变更。');
  }
  async inspect(repository, { signal, knownAccounts = [], requireRetention = false } = {}) {
    const target = await this._ownedRepository(repository, signal);
    const head = await this._head(repository, target.branch, signal);
    const raw = await this._readFile(repository, MANIFEST_PATH, head.sha, signal);
    const config = normalizeManifest(raw);
    const workflows = await this.pages(`repos/${repository}/actions/workflows`, 'workflows', signal);
    const policy = await this._api(`repos/${repository}/actions/permissions`, { signal });
    const runs = await this.pages(`repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs`, 'workflow_runs', signal, 20);
    const latestSchedule = runs.find(x => x.event === 'schedule' && x.head_branch === target.branch);
    const maintenance = {};
    for (const [kind, name] of [['keepalive', KEEPALIVE_FILE], ['cleanup', CLEANUP_FILE]]) {
      const found = workflows.find(w => w.path === `.github/workflows/${name}`);
      if (found) {
        const history = await this._api(`repos/${repository}/actions/workflows/${name}/runs?per_page=1`, { signal });
        const last = history?.workflow_runs?.[0];
        maintenance[kind] = { state: found.state, lastRun: last ? { id: last.id, status: last.status, conclusion: last.conclusion, createdAt: last.created_at } : null };
      }
    }
    let retention;
    try { retention = await this._api(`repos/${repository}/actions/permissions/artifact-and-log-retention`, { signal }); }
    catch (error) { if (signal?.aborted || requireRetention) throw error; retention = { error: error.code || 'UNAVAILABLE' }; }
    const row = { ...(this.managed.repositories[repository.toLowerCase()] || {}), repository, branch: target.branch, head: head.sha, configDigest: digest(raw), schemaVersion: raw.schemaVersion, config,
      checkedAt: new Date(this.now()).toISOString(), actionsEnabled: policy?.enabled === true,
      workflows: workflows.filter(x => [WORKFLOW_FILE, KEEPALIVE_FILE, CLEANUP_FILE].some(n => x.path === `.github/workflows/${n}`)).map(x => ({ name: x.name, path: x.path, state: x.state })),
      lastScheduledRun: latestSchedule ? { id: latestSchedule.id, createdAt: latestSchedule.created_at, status: latestSchedule.status, conclusion: latestSchedule.conclusion } : null,
      maintenance, nativeRetentionDays: Number.isInteger(retention?.days) ? retention.days : null, retentionError: retention?.error || '', upgraded: raw.schemaVersion === 2 };
    for (const [k, account] of Object.entries(this.managed.accounts)) if (account.repository?.toLowerCase() === repository.toLowerCase() && !config.accounts.some(a => a.accountKey === account.accountKey)) delete this.managed.accounts[k];
    this.managed.repositories[repository.toLowerCase()] = row;
    for (const account of config.accounts) {
      const k = recordKey(repository, account.accountKey); const known = knownAccounts.find(a => a.repository?.toLowerCase() === repository.toLowerCase() && a.accountKey === account.accountKey);
      this.managed.accounts[k] = { ...(this.managed.accounts[k] || {}), repository, accountKey: account.accountKey, settings: account,
        ...(known?.email ? { email: known.email } : {}), githubLogin: repository.split('/')[0] };
    }
    this.saveManagement();
    return { ...row, target, headObject: head, raw, runs };
  }
  async upgrade(repository, { signal, expectedDigest, patch, keys, maintenance, enableExisting = false } = {}) {
    if (!validRepository(repository)) throw fail('INVALID_REPOSITORY', '部署仓库地址无效。');
    const key = repository.toLowerCase();
    const attempt = { attemptId: randomBytes(16).toString('hex'), startedAt: new Date(this.now()).toISOString(), status: 'running', stage: 'inspect', configurationVerified: false, maintenanceVerified: false };
    const checkpoint = patch => {
      Object.assign(attempt, patch, { updatedAt: new Date(this.now()).toISOString() });
      const row = this.managed.repositories[key] || { repository };
      row.upgradeAttempt = { ...attempt };
      // This timestamp describes only a fully verified current attempt.
      if (attempt.status !== 'completed') delete row.upgradeVerifiedAt;
      this.managed.repositories[key] = row; this.saveManagement();
    };
    try {
      checkpoint({});
      const current = await this.inspect(repository, { signal });
      if (expectedDigest && expectedDigest !== current.configDigest) throw fail('CONFIGURATION_CHANGED', '云端配置已被其他操作修改，请刷新后重新保存；未覆盖他人的更新。');
      if (current.runs.some(x => ACTIVE.has(x.status))) throw fail('CLOUD_BUSY', '已有云端账号任务正在执行，请完成后再更新配置。');
      checkpoint({ stage: 'compare' });
      const existing = await this.textFile(repository, WORKFLOW_PATH, current.head, signal, true);
      if (existing?.text.includes('TEMP-SCHEDULE-RETEST-')) throw fail('RETEST_PENDING', '独立定时复测尚未收尾，暂不覆盖它的临时配置；稍后再更新。');
      let config = patch ? updateAccounts(current.config, keys, patch) : current.config;
      if (maintenance) {
        if (Object.keys(maintenance).some(k => !['cleanupTime', 'cleanupEnabled', 'keepaliveEnabled'].includes(k))) throw fail('INVALID_SETTINGS', '不支持的维护设置。');
        config = normalizeManifest({ ...config, maintenance: { ...config.maintenance, ...maintenance } });
      }
      config.reporting = await this.vault.ensure(config.reporting);
      const files = deploymentFiles(config);
      const secrets = await this.pages(`repos/${repository}/actions/secrets`, 'secrets', signal);
      const missing = config.accounts.filter(a => !secrets.some(s => s.name === `GLADOS_ACCOUNT_${a.accountKey}`));
      if (missing.length) throw fail('STORED_CREDENTIAL_MISSING', `有 ${missing.length} 个账号的云端登录记录缺失，请在对应账号更新登录；未覆盖配置。`);
      const matches = await this._filesMatch(repository, files, current.head, signal);
      let sha = current.head;
      checkpoint({ stage: matches ? 'verify-config' : 'commit', changed: !matches });
      if (!matches) sha = await this._commitFiles(repository, current.branch, current.headObject, files, `Upgrade managed GLaDOS configuration to ${VERSION}`, signal);
      checkpoint({ stage: 'verify-config', commitSha: sha });
      const latestHead = await this._head(repository, current.branch, signal);
      // A commit is immutable. A matching bundle at the same head needs no second
      // identical eight-file read; newly written files always need readback.
      if (latestHead.sha !== sha || !matches && !await this._filesMatch(repository, files, sha, signal)) throw fail('CONFIGURATION_UNVERIFIED', '云端配置尚未核对一致，请刷新核实；不会把未核实的提交当成完成。');
      const verifiedRaw = JSON.parse(files[MANIFEST_PATH]);
      Object.assign(this.managed.repositories[key], { head: sha, config: normalizeManifest(verifiedRaw), configDigest: digest(verifiedRaw), schemaVersion: 2, upgraded: true });
      for (const account of config.accounts) {
        const row = this.managed.accounts[recordKey(repository, account.accountKey)];
        if (row) row.settings = { ...account };
      }
      checkpoint({ stage: 'workflows', configurationVerified: true });
      // Upgrading files must not silently override a user's repository-wide pause.
      const checkinState = current.workflows.find(w => w.path === WORKFLOW_PATH)?.state;
      const enableWorkflows = current.actionsEnabled && (checkinState === 'active' || enableExisting);
      if (enableWorkflows) {
        for (const name of [WORKFLOW_FILE, KEEPALIVE_FILE, CLEANUP_FILE]) {
          if (current.workflows.some(w => w.path === `.github/workflows/${name}` && w.state === 'active')) continue;
          for (let n = 0; n < 8; n++) {
            try { await this._api(`repos/${repository}/actions/workflows/${name}/enable`, { method: 'PUT', signal, stage: 'upgrade-workflows' }); break; }
            catch (e) { if (e.code !== 'NOT_FOUND' || n === 7) throw e; await this._sleep(1500, signal); }
          }
        }
      }
      checkpoint({ stage: 'retention' });
      if (current.nativeRetentionDays !== 3) {
        await this._api(`repos/${repository}/actions/permissions/artifact-and-log-retention`, { method: 'PUT', body: { days: 3 }, signal, stage: 'upgrade-retention' });
        const retention = await this._api(`repos/${repository}/actions/permissions/artifact-and-log-retention`, { signal, stage: 'upgrade-retention' });
        if (retention?.days !== 3) throw fail('RETENTION_UNVERIFIED', '3 天原生保留期尚未确认生效，请重新核对。');
      }
      checkpoint({ stage: 'verify-maintenance' });
      const verified = await this.inspect(repository, { signal, requireRetention: true });
      if (verified.head !== sha) {
        checkpoint({ configurationVerified: false });
        throw fail('CONFIGURATION_CHANGED', '配置核对后云端又有更新，请刷新后重新核对。');
      }
      if (verified.nativeRetentionDays !== 3) throw fail('RETENTION_UNVERIFIED', '最后一次核验未能确认 3 天原生保留期，请重新核对。');
      if (enableWorkflows && (!verified.actionsEnabled || [WORKFLOW_FILE, KEEPALIVE_FILE, CLEANUP_FILE].some(name => !verified.workflows.some(w => w.path === `.github/workflows/${name}` && w.state === 'active')))) throw fail('WORKFLOWS_UNVERIFIED', '最后一次核验未能确认工作流已启用，请重新核对。');
      const finishedAt = new Date(this.now()).toISOString();
      this.managed.repositories[key].upgradeVerifiedAt = finishedAt;
      checkpoint({ stage: 'completed', status: 'completed', maintenanceVerified: true, finishedAt });
      return { ...verified, upgradeVerifiedAt: finishedAt, upgradeAttempt: { ...attempt }, upgradeProgress: upgradeProgress(attempt), changed: !matches };
    } catch (error) {
      const failure = error instanceof Error ? error : fail('UPGRADE_FAILED', '云端升级尚未完成，请重新核对。');
      failure.stage = `upgrade-${attempt.stage}`;
      failure.upgradeProgress = upgradeProgress(attempt);
      if (attempt.configurationVerified) failure.message = attempt.changed ? '配置已更新，后续核验待完成。' : '配置已一致，后续核验待完成。';
      // Preserve verified progress even when the final observation or a later
      // maintenance step fails. Never persist the raw CLI response or headers.
      try { checkpoint({ status: attempt.configurationVerified ? 'pending' : 'failed', diagnostic: safeGitHubDiagnostic(failure) }); } catch { /* Keep the original failure if local persistence also fails. */ }
      throw failure;
    }
  }
  _operationProgress(saved, stage = 'run', extra = {}) {
    return operationProgress({ ...saved?.operationProgress, submission: saved?.submission === 'accepted' || saved?.runId ? 'accepted' : 'uncertain',
      runId: saved?.runId, runStatus: saved?.status, runConclusion: saved?.conclusion, stage, ...extra });
  }
  _saveOperationReadback(saved, progress, { pending = true, error } = {}) {
    if (!saved) return;
    saved.operationProgress = operationProgress(progress); saved.submission = saved.operationProgress.submission;
    if (saved.operationProgress.runStatus) { saved.status = saved.operationProgress.runStatus; delete saved.conclusion; }
    if (saved.operationProgress.runConclusion) saved.conclusion = saved.operationProgress.runConclusion;
    saved.observationPending = pending;
    if (!pending && saved.operationProgress.detailsVerified) saved.requireDetails = false;
    saved.readback = { pending, observedAt: new Date(this.now()).toISOString(), ...(error ? { diagnostic: safeGitHubDiagnostic(error) } : {}) };
    this.saveManagement();
  }
  _observationFailure(error, saved, stage, extra = {}) {
    const progress = this._operationProgress(saved, stage, extra);
    error.operationProgress = progress;
    try { this._saveOperationReadback(saved, progress, { error }); } catch { /* Preserve the original observation failure. */ }
    return error;
  }
  async runOperation(repository, operation, { accountKey = '', signal, requestId } = {}) {
    if (requestId !== undefined && !/^[a-f0-9]{32}$/.test(requestId)) throw fail('INVALID_OPERATION', '批量任务标识无效。');
    if (!['checkin', 'status', 'cleanup'].includes(operation)) throw fail('INVALID_OPERATION', '操作无效。');
    if (!validRepository(repository)) throw fail('INVALID_REPOSITORY', '部署仓库地址无效。');
    const workflow = operation === 'cleanup' ? CLEANUP_FILE : WORKFLOW_FILE;
    const scope = repository.toLowerCase() + ':' + workflow;
    let saved = this.managed.operations[scope];
    const resumeSaved = () => saved && saved.status !== 'ended' && (saved.status !== 'completed' || saved.observationPending || requestId && saved.requestId === requestId);
    let current;
    try { current = await this.inspect(repository, { signal }); }
    catch (error) { if (resumeSaved()) throw this._observationFailure(error, saved, 'run'); throw error; }
    if (current.schemaVersion !== 2) throw fail('UPGRADE_REQUIRED', '请先点击“一键升级全部云端配置”，现有账号无需重新登录。');
    if (!current.actionsEnabled) throw fail('ACTIONS_DISABLED', '此仓库的 Actions 已被关闭，未擅自重新开启。');
    const block = this.managed.checkinBlocks[repository.toLowerCase()];
    if (operation === 'checkin' && block) {
      if (!/^\d{4}-\d\d-\d\d$/.test(block.day || '') || block.day >= businessDate(this.now())) throw fail('CHECKIN_UNVERIFIED', '此仓库的前次签到结果尚未核实，今天不会重复提交。可查询信息，或明天明确发起新的签到；其他仓库不受影响。');
      delete this.managed.checkinBlocks[repository.toLowerCase()];
    }
    if (accountKey && !current.config.accounts.some(a => a.accountKey === accountKey)) throw fail('UNKNOWN_ACCOUNT', '账号不存在。');
    if (operation === 'checkin' && !current.config.accounts.some(a => a.enabled && (!accountKey || a.accountKey === accountKey))) throw fail('NO_ENABLED_ACCOUNTS', '没有启用的账号，暂停账号不会被手动签到。');
    let runs;
    try { runs = await this.pages(`repos/${repository}/actions/workflows/${workflow}/runs`, 'workflow_runs', signal, 20); }
    catch (error) { if (resumeSaved()) throw this._observationFailure(error, saved, 'run'); throw error; }
    if (resumeSaved()) {
      let match = saved.runId ? runs.find(x => x.id === saved.runId) : runs.find(x => x.head_branch === current.branch && x.event === 'workflow_dispatch' && x.display_title?.includes(saved.nonce));
      if (!match && saved.runId) {
        try { match = await this._api(`repos/${repository}/actions/runs/${saved.runId}`, { signal }); }
        catch (error) { throw this._observationFailure(error.code === 'NOT_FOUND' ? fail('RUN_EXPIRED', '原运行已被清理或当前无法访问；未把它当成成功，也不会自动重发。') : error, saved, 'run'); }
      }
      if (match) {
        saved.runId = match.id; saved.status = match.status;
        if (RUN_CONCLUSIONS.has(match.conclusion)) saved.conclusion = match.conclusion;
        this.saveManagement();
        const result = await this.waitOperation(repository, match, { signal, decrypt: true });
        if ((saved.operation || 'checkin') === operation && (!saved.accountKey || saved.accountKey === accountKey)) return result;
        if (result.status !== 'completed' || result.observationPending) return { ...result, deferredRequest: true };
      } else if (saved.submittedAt) throw this._observationFailure(fail('DISPATCH_UNCERTAIN', '上次请求的响应不确定，尚未找到原运行；不会重复提交，请稍后刷新。'), saved, 'run');
    }
    const active = runs.find(x => ACTIVE.has(x.status) && x.id !== saved?.runId);
    if (active) {
      const result = await this.waitOperation(repository, active, { signal, decrypt: true });
      if (result.status !== 'completed' || result.observationPending) return { ...result, deferredRequest: true };
      // The completed run may cover a different account or operation. Now submit
      // the user's original request; cloud receipt guards prevent duplicate effects.
    }
    const nonce = randomBytes(16).toString('hex');
    saved = { repository, workflow, nonce, requestId: requestId || randomBytes(16).toString('hex'), operation, accountKey,
      accountKeys: operation === 'cleanup' ? [] : current.config.accounts.filter(a => (!accountKey || a.accountKey === accountKey) && (operation === 'status' || a.enabled)).map(a => a.accountKey),
      submittedAt: new Date(this.now()).toISOString(), status: 'submitting' };
    this.managed.operations[scope] = saved; this.saveManagement();
    let response;
    try {
      response = await this._api(`repos/${repository}/actions/workflows/${workflow}/dispatches`, { method: 'POST', signal, stage: 'dispatch',
        body: { ref: current.branch, inputs: operation === 'cleanup' ? { deployment_id: nonce } : { deployment_id: nonce, account_key: accountKey, operation } } });
    } catch (error) {
      // A malformed/lost response can follow an accepted POST. Only a definite
      // rejection or a CLI that could not start permits a later fresh request.
      if (['AUTH_REQUIRED', 'PERMISSION_DENIED', 'NOT_FOUND', 'VALIDATION_FAILED', 'WORKFLOW_AUTH_REQUIRED', 'CONFLICT', 'GH_NOT_AVAILABLE', 'BAD_REQUEST', 'RESOURCE_GONE', 'UNSUPPORTED_MEDIA_TYPE', 'REQUEST_REJECTED'].includes(error.code)) {
        delete this.managed.operations[scope]; this.saveManagement();
        throw error;
      }
      throw this._observationFailure(error, saved, 'dispatch', { submission: error.httpStatus >= 200 && error.httpStatus < 300 ? 'accepted' : 'uncertain' });
    }
    saved.submission = 'accepted'; this._saveOperationReadback(saved, this._operationProgress(saved, 'run'));
    let found = Number.isSafeInteger(Number(response?.workflow_run_id)) && Number(response.workflow_run_id) > 0
      ? { id: Number(response.workflow_run_id), status: 'queued', path: `.github/workflows/${workflow}`, event: 'workflow_dispatch', created_at: saved.submittedAt } : null;
    try {
      for (let n = 0; !found && n < 16; n++) {
        const list = await this._api(`repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=50`, { signal });
        const matches = (list?.workflow_runs || []).filter(x => x.display_title?.includes(nonce));
        if (matches.length > 1) throw fail('AMBIGUOUS_RUN', '找到多个相同请求标识的任务，请核实；不会重复提交。');
        found = matches[0]; if (!found) await this._sleep(2000, signal);
      }
      if (!found) throw fail('DISPATCH_UNCERTAIN', '请求已提交，运行编号尚未确认；稍后刷新会接续原请求。');
    } catch (error) {
      throw this._observationFailure(error, saved, 'run');
    }
    saved.runId = Number(found.id); saved.status = found.status; this.saveManagement();
    return this.waitOperation(repository, found, { signal, decrypt: true });
  }
  async endOperation(repository, { workflow, expectedNonce, signal } = {}) {
    if (![WORKFLOW_FILE, CLEANUP_FILE].includes(workflow)) throw fail('INVALID_OPERATION', '请选择有效的云端请求。');
    const scope = repository.toLowerCase() + ':' + workflow;
    const saved = this.managed.operations[scope];
    if (!saved || saved.status === 'ended' || saved.status === 'completed' && !saved.observationPending) throw fail('OPERATION_CHANGED', '请求已结束或已变化，请刷新后核对。');
    if (!/^[a-f0-9]{32}$/.test(expectedNonce || '') || expectedNonce !== saved.nonce) throw fail('OPERATION_CHANGED', '请求已变化，未结束其他请求；请刷新后再操作。');
    const current = await this.inspect(repository, { signal });
    const runs = await this.pages(`repos/${repository}/actions/workflows/${workflow}/runs`, 'workflow_runs', signal, 20);
    if (runs.some(run => ACTIVE.has(run.status))) throw fail('CLOUD_BUSY', '此仓库仍有云端运行，不能结束其本机跟踪。请等待云端完成；本机批次已停止。');
    let matches = saved.runId ? runs.filter(run => run.id === saved.runId) : runs.filter(run => run.head_branch === current.branch && run.event === 'workflow_dispatch' && run.display_title?.includes(saved.nonce));
    if (!matches.length && saved.runId) {
      try { matches = [await this._api(`repos/${repository}/actions/runs/${saved.runId}`, { signal })]; }
      catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    }
    if (matches.some(run => run.status !== 'completed')) throw fail('CLOUD_BUSY', '原云端请求尚未结束，已保留跟踪记录。');
    if (matches.length === 1) {
      const record = await this.readOperation(repository, matches[0].id, { signal, decrypt: false });
      saved.runId = Number(matches[0].id);
      if (!record?.observationPending || record.operationProgress?.resultVerified) {
        saved.status = 'completed'; saved.resolvedAt = new Date(this.now()).toISOString(); saved.observationPending = false;
        if (saved.readback) saved.readback.pending = false;
        this.saveManagement(); return { checkinBlocked: false };
      }
    }
    // Ending tracking never means the previous service-side effect failed. Keep
    // a separate daily guard so a later status-only request cannot erase it.
    const checkinBlocked = workflow === WORKFLOW_FILE && (saved.operation || 'checkin') === 'checkin';
    if (checkinBlocked) this.managed.checkinBlocks[repository.toLowerCase()] = {
      day: businessDate(this.now()), nonce: saved.nonce, requestId: saved.requestId,
      endedAt: new Date(this.now()).toISOString(), reason: 'ended_unconfirmed',
    };
    saved.status = 'ended'; saved.endedAt = new Date(this.now()).toISOString(); saved.outcome = 'unverified';
    this.saveManagement(); return { checkinBlocked };
  }
  async waitOperation(repository, first, { signal, decrypt = false } = {}) {
    let run = first; const start = this.now();
    try {
      while (true) {
        // readOperation already reads the current run. Use its confirmed result
        // directly; an extra status GET must not undo a completed observation.
        run = await this.readOperation(repository, run.id, { signal, decrypt });
        if (run.status === 'completed') return run;
        if (this.now() - start >= this.waitTimeoutMs) return { ...run, observationPending: true, waitTimedOut: true };
        this._progress('verifying', '云端正在逐个处理账号，完成结果会分别显示。');
        await this._sleep(Math.min(this.pollIntervalMs || 5000, this.waitTimeoutMs - (this.now() - start)), signal);
      }
    } catch (error) {
      if (error.operationProgress) throw error;
      const saved = Object.values(this.managed.operations).find(op => op.repository === repository && op.runId === Number(run.id));
      throw this._observationFailure(error, saved, 'run', { submission: 'accepted', runId: Number(run.id), runStatus: run.status, runConclusion: run.conclusion });
    }
  }
  async readOperation(repository, runId, { signal, decrypt = false } = {}) {
    if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) throw fail('INVALID_RUN', '运行编号无效。');
    const saved = Object.values(this.managed.operations).find(op => op.repository === repository && op.runId === Number(runId));
    if (saved && decrypt) saved.requireDetails = true;
    const requireDetails = decrypt || saved?.requireDetails === true;
    let progress = this._operationProgress(saved, 'run', { submission: 'accepted', runId: Number(runId) });
    try {
    const run = await this._api(`repos/${repository}/actions/runs/${runId}`, { signal });
    const known = this.managed.repositories[repository.toLowerCase()];
    const filename = run.path?.split('@')[0];
    if (![WORKFLOW_PATH, `.github/workflows/${CLEANUP_FILE}`, `.github/workflows/${KEEPALIVE_FILE}`].includes(filename) || run.head_branch !== known?.branch) throw fail('WRONG_WORKFLOW', '运行记录不属于该部署的默认分支任务。');
    const record = { id: Number(runId), repository, event: run.event, status: run.status, conclusion: run.conclusion, createdAt: run.created_at,
      startedAt: run.run_started_at, updatedAt: run.updated_at, url: `https://github.com/${repository}/actions/runs/${runId}`, workflow: filename };
    progress = operationProgress({ ...progress, stage: 'receipts', runStatus: run.status, runConclusion: run.conclusion });
    // The workflow status is real evidence even if jobs, artifacts or encrypted
    // details cannot subsequently be downloaded. Persist it before those reads.
    for (const key of saved?.accountKeys || (saved?.accountKey ? [saved.accountKey] : [])) {
      const row = this.managed.accounts[recordKey(repository, key)];
      if (row && !(Date.parse(row.latestRun?.createdAt || '') > Date.parse(record.createdAt || ''))) row.latestRun = { ...record };
    }
    this._saveOperationReadback(saved, progress);
    const receiptKeys = new Set(); const detailKeys = new Set(); let readbackError;
    const jobs = await this.pages(`repos/${repository}/actions/runs/${runId}/jobs`, 'jobs', signal);
    const expectedKeys = new Set(jobs.map(job => job.name?.match(/^Account ([A-F0-9]{16})$/)?.[1]).filter(key => key && this.managed.accounts[recordKey(repository, key)]));
    for (const key of saved?.accountKeys || (saved?.accountKey ? [saved.accountKey] : [])) if (KEY.test(key)) expectedKeys.add(key);
    if (filename === WORKFLOW_PATH) {
      for (const job of jobs) {
        const key = job.name?.match(/^Account ([A-F0-9]{16})$/)?.[1]; if (!key) continue;
        const k = recordKey(repository, key); if (!this.managed.accounts[k]) continue;
        const target = this.managed.accounts[k];
        if (Date.parse(target.latestRun?.createdAt || '') > Date.parse(record.createdAt || '')) continue;
        target.latestRun = { ...record, jobStatus: job.status, jobConclusion: job.conclusion };
      }
      const artifacts = await this.pages(`repos/${repository}/actions/runs/${runId}/artifacts`, 'artifacts', signal);
      const results = artifacts.filter(x => !x.expired && /^gqd-result-[A-F0-9]{16}-\d+-\d+$/.test(x.name) && x.size_in_bytes < 4 * 1024 * 1024);
      for (const artifact of results) {
        if (run.run_attempt && !artifact.name.endsWith('-' + run.run_attempt)) continue;
        const key = artifact.name.split('-')[2]; const k = recordKey(repository, key); if (!this.managed.accounts[k]) continue;
        const row = this.managed.accounts[k];
        const newerResult = Date.parse(row.result?.observedAt || '') > Date.parse(artifact.created_at);
        try {
          const cacheKey = repository.toLowerCase() + ':' + artifact.id;
          let output = this.reportCache.get(cacheKey);
          if (!output) { output = await this.downloadReport(repository, runId, artifact.name, { signal }); this.reportCache.set(cacheKey, output); }
          while (this.reportCache.size > 400) this.reportCache.delete(this.reportCache.keys().next().value);
          if (output.receipt.repository !== repository || String(output.receipt.runId) !== String(runId) || output.receipt.accountKey !== key) throw fail('RESULT_MISMATCH', '报告身份不匹配。');
          const receipt = receiptProjection(output.receipt); if (!receipt) throw fail('INVALID_REPORT', '报告格式无效。');
          receiptKeys.add(key);
          // A newer scheduled result can arrive while an old nonce awaits
          // readback. Verify the old request without rolling back the panel.
          if (newerResult) {
            if (output.report && (decrypt || this.vault?.cache?.has(output.report.keyId))) {
              await this.vault.decrypt(output.report, { repository, runId, accountKey: key }); detailKeys.add(key);
            }
            continue;
          }
          row.result = receipt; row.latestRun = record; row.lastError = '';
          row.readback = { pending: false, observedAt: new Date(this.now()).toISOString() };
          if (output.report && (decrypt || this.vault?.cache?.has(output.report.keyId))) {
            try {
              const detail = await this.vault.decrypt(output.report, { repository, runId, accountKey: key });
              const projected = detailsProjection(detail);
              if (Number.isFinite(projected.pointsAdded) && receipt.checkinBusinessDate) row.dailyCredit = { day: receipt.checkinBusinessDate, pointsAdded: projected.pointsAdded };
              if (!Number.isFinite(projected.pointsAdded) && receipt.checkinBusinessDate && row.dailyCredit?.day === receipt.checkinBusinessDate) projected.pointsAdded = row.dailyCredit.pointsAdded;
              row.details = { ...projected, observedAt: detail.observedAt, businessDate: detail.businessDate }; row.detailError = '';
              detailKeys.add(key);
              if (!row.email && projected.email) row.email = projected.email;
            }
            catch (error) {
              if (signal?.aborted || error.name === 'AbortError') throw error;
              readbackError ||= error; row.detailError = '账号详情尚未读回，已确认的签到结果保留。';
              row.readback = { pending: true, stage: 'details', observedAt: new Date(this.now()).toISOString(), diagnostic: safeGitHubDiagnostic(error) };
            }
          } else if (requireDetails) {
            row.detailError = output.report ? '账号详情尚待解锁读取，签到回执已保留。' : '账号详情报告尚未取得，已确认的签到结果保留。';
            readbackError ||= fail('RESULTS_UNAVAILABLE', row.detailError);
            row.readback = { pending: true, stage: 'details', observedAt: new Date(this.now()).toISOString(), diagnostic: safeGitHubDiagnostic(readbackError) };
          }
          const history = { ...receipt, repository, runId: Number(runId), runAttempt: run.run_attempt || 1, event: run.event };
          this.managed.history = this.managed.history.filter(x => !(x.repository === repository && x.runId === Number(runId) && x.accountKey === key));
          this.managed.history.push(history);
        } catch (error) {
          if (signal?.aborted || error.name === 'AbortError') throw error;
          readbackError ||= error; row.lastError = '账号回执尚未读回，已有签到证据保留，请继续核对原运行。';
          row.readback = { pending: true, stage: 'receipts', observedAt: new Date(this.now()).toISOString(), diagnostic: safeGitHubDiagnostic(error) };
        }
      }
      const resultVerified = expectedKeys.size > 0 && [...expectedKeys].every(key => receiptKeys.has(key));
      const detailsVerified = expectedKeys.size > 0 && [...expectedKeys].every(key => detailKeys.has(key));
      progress = operationProgress({ ...progress, stage: resultVerified && requireDetails && !detailsVerified ? 'details' : 'receipts', resultVerified, detailsVerified });
    } else if (filename.endsWith(CLEANUP_FILE) && run.status === 'completed') {
      let summary = null;
      for (const job of jobs) {
        const logs = await this._api(`repos/${repository}/actions/jobs/${job.id}/logs`, { signal, raw: true });
        for (const match of stripVTControlCharacters(logs).matchAll(/QUICK_DEPLOY_CLEANUP=(\{[^\r\n]*\})/g)) {
          try {
            const raw = JSON.parse(match[1]); if (raw.retentionHours !== 72) continue;
            summary = { observedAt: raw.observedAt, errors: Array.isArray(raw.errors) ? raw.errors.length : 0 };
            for (const name of ['deletedRuns', 'deletedArtifacts', 'artifactBytes', 'deletedCaches', 'cacheBytes', 'skippedChanged']) if (Number.isFinite(raw[name]) && raw[name] >= 0) summary[name] = raw[name];
          } catch { /* Invalid summary is not success evidence. */ }
        }
      }
      if (summary) known.cleanupSummary = summary;
      progress = operationProgress({ ...progress, resultVerified: Boolean(summary), detailsVerified: Boolean(summary) });
    } else if (filename.endsWith(KEEPALIVE_FILE)) {
      progress = operationProgress({ ...progress, resultVerified: run.status === 'completed', detailsVerified: run.status === 'completed' });
    }
    record.observationPending = run.status !== 'completed' || !progress.resultVerified || requireDetails && !progress.detailsVerified;
    record.operationProgress = progress;
    if (readbackError) record.diagnostic = safeGitHubDiagnostic(readbackError);
    record.verifiedAccounts = [...receiptKeys];
    this._saveOperationReadback(saved, progress, { pending: record.observationPending, error: readbackError });
    if (run.event === 'schedule' && filename === WORKFLOW_PATH) known.lastScheduledRun = { id: run.id, createdAt: run.created_at, status: run.status, conclusion: run.conclusion };
    this.saveManagement(); return record;
    } catch (error) {
      throw this._observationFailure(error, saved, progress.stage, progress);
    }
  }
  async downloadReport(repository, runId, name, { signal } = {}) {
    if (!/^gqd-result-[A-F0-9]{16}-\d+-\d+$/.test(name)) throw fail('INVALID_ARTIFACT', '报告名称无效。');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = fs.mkdtempSync(path.join(this.directory, 'report-read-'));
    try {
      await this._runGh(['run', 'download', String(runId), '--repo', repository, '--name', name, '--dir', temp], { signal, stage: 'report', timeoutMs: 90000 });
      const entries = fs.readdirSync(temp);
      if (!entries.includes('receipt.json') || entries.some(n => !['receipt.json', 'report.json'].includes(n))) throw fail('INVALID_ARTIFACT', '报告文件清单不符合预期。');
      return { receipt: readJSON(path.join(temp, 'receipt.json')), report: readJSON(path.join(temp, 'report.json'), null) };
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  async refreshRepository(repository, { signal, decrypt = false, knownAccounts = [] } = {}) {
    const current = await this.inspect(repository, { signal, knownAccounts });
    const cutoff = this.now() - 72 * 3600000;
    const recent = current.runs.filter(x => Date.parse(x.created_at) >= cutoff).slice(0, 40);
    const seen = new Set(); const pending = [];
    for (const run of recent) {
      if (run.status === 'completed' && seen.size >= current.config.accounts.length) break;
      try {
        const record = await this.readOperation(repository, run.id, { signal, decrypt });
        if (record.observationPending) pending.push({ runId: Number(run.id), operationProgress: record.operationProgress, ...(record.diagnostic ? { diagnostic: record.diagnostic } : {}) });
        for (const key of record.verifiedAccounts || []) seen.add(key);
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        pending.push({ runId: Number(run.id), operationProgress: operationProgress(error.operationProgress), diagnostic: safeGitHubDiagnostic(error) });
      }
    }
    const readback = { pending: pending.length > 0, observedAt: new Date(this.now()).toISOString(), pendingRuns: pending };
    this.managed.repositories[repository.toLowerCase()].readback = readback; this.saveManagement();
    return { ...current, observationPending: readback.pending, readback };
  }
  noteAccount(repository, accountKey, note) {
    const row = this.managed.accounts[recordKey(repository, accountKey)]; if (!row) throw fail('UNKNOWN_ACCOUNT', '账号不存在。');
    if (typeof note !== 'string' || note.length > 200 || /[\x00-\x1f]/.test(note)) throw fail('INVALID_NOTE', '备注最长 200 字，不能包含控制字符。');
    row.note = note; this.saveManagement();
  }
}
module.exports = { ManagementClient, receiptProjection, detailsProjection, recordKey, digest, operationProgress };
