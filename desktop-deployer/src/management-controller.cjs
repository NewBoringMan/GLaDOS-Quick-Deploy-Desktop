'use strict';
const { randomBytes } = require('node:crypto');
const { Controller, safeMessage } = require('./controller.cjs');
const { recordKey } = require('./management-client.cjs');

class ManagementController extends Controller {
  constructor(options) {
    super(options); this.managementAbort = null; this.managementTask = null; this.managementLastRead = 0;
    this.github.onManagement = () => this.changed();
    this.state.management = this.github.snapshotManagement();
  }
  changed() {
    if (this.github?.snapshotManagement && this.state) this.state.management = this.github.snapshotManagement();
    return super.changed();
  }
  findAccount(accountKey) {
    const existing = this.state.accounts.find(a => a.accountKey === accountKey);
    if (existing) return existing;
    const rows = Object.values(this.github.managed.accounts || {}).filter(a => a.accountKey === accountKey);
    if (rows.length !== 1) throw new Error(rows.length ? '账号存在于多个仓库，请先确认目标仓库。' : '账号不存在，请刷新云端配置。');
    const row = rows[0];
    const restored = { accountKey, repository: row.repository, email: row.email || '', githubLogin: row.githubLogin, deploymentStatus: 'deployed',
      paused: row.settings?.enabled === false, settings: { repoName: row.repository.split('/')[1], time: row.settings?.times?.[0] || '09:30', exchangePlan: row.settings?.exchangePlan || 'plan500' } };
    this.state.accounts.push(restored); this.persist();
    return restored;
  }
  repositories() {
    const names = new Set(this.state.accounts.filter(a => a.repository).map(a => a.repository));
    for (const r of Object.values(this.github.managed.repositories)) names.add(r.repository);
    return [...names].sort();
  }
  async initialize() {
    await super.initialize();
    if (!this.state.github || this.closing) return;
    for (const repository of this.repositories()) {
      try { await this.github.inspect(repository, { knownAccounts: this.state.accounts }); }
      catch (error) { this.note(repository + '：云端设置暂未同步，保留本机记录。' + safeMessage(error.message), 'warning'); }
    }
  }
  async exclusive(work) {
    this.managementAbort?.abort();
    if (this.managementTask) await this.managementTask.catch(() => {});
    return super.exclusive(work);
  }
  async continueDeploy(task, signal) {
    await super.continueDeploy(task, signal);
    const repository = task.checkpoint?.repository;
    if (repository && !signal.aborted && !this.closing) {
      try { await this.github.refreshRepository(repository, { signal, decrypt: true, knownAccounts: this.state.accounts }); }
      catch (error) { this.note('部署已保存，详细面板等待刷新：' + safeMessage(error.message), 'warning'); }
    }
  }
  async refreshManaged(signal, decrypt = false) {
    let failures = 0;
    for (const repository of this.repositories()) {
      if (signal?.aborted) return;
      try { await this.github.refreshRepository(repository, { signal, decrypt, knownAccounts: this.state.accounts }); }
      catch (error) { failures++; this.note(repository + '：' + safeMessage(error.message), 'warning'); }
    }
    return failures;
  }
  async continueBatch(signal) {
    const batch = this.github.managed.batch;
    if (!batch || batch.status === 'completed') return;
    if (!batch.requestId) { batch.requestId = randomBytes(16).toString('hex'); this.github.saveManagement(); }
    while (batch.index < batch.repositories.length) {
      if (signal.aborted || this.closing) return;
      const repository = batch.repositories[batch.index];
      batch.current = repository; batch.status = 'running'; this.github.saveManagement();
      this.note(`正在处理 ${batch.index + 1}/${batch.repositories.length} 个仓库：${repository}。`);
      try {
        const record = await this.github.runOperation(repository, batch.operation, { signal, requestId: batch.requestId });
        batch.results[repository] = record;
        if (record.status !== 'completed' || record.deferredRequest) { batch.status = 'waiting'; this.github.saveManagement(); return; }
      } catch (error) {
        if (signal.aborted) return;
        batch.results[repository] = { error: safeMessage(error.message), code: error.code || 'OPERATION_FAILED' };
        if (['DISPATCH_UNCERTAIN', 'AMBIGUOUS_RUN', 'NETWORK_ERROR', 'TIMEOUT', 'GITHUB_UNAVAILABLE', 'RATE_LIMITED'].includes(error.code)) { batch.status = 'waiting'; this.github.saveManagement(); return; }
      }
      batch.index++; this.github.saveManagement();
    }
    batch.status = 'completed'; batch.completedAt = new Date(this.now()).toISOString(); this.github.saveManagement();
    this.note(batch.operation === 'checkin' ? '本轮全部账号签到处理结束；暂停账号已跳过，结果请逐账号查看。' : '本轮账号信息查询结束；没有额外签到或兑换。');
  }
  async refreshPending() {
    await super.refreshPending();
    if (this.closing || this.state.busy || this.managementTask || this.backgroundTask || this.now() - this.managementLastRead < 90000) return;
    this.managementLastRead = this.now(); this.managementAbort = new AbortController();
    const signal = this.managementAbort.signal;
    this.managementTask = (async () => {
      if (this.github.managed.batch && this.github.managed.batch.status !== 'completed') await this.continueBatch(signal);
      else await this.refreshManaged(signal, false);
    })().catch(error => { if (!signal.aborted) this.note('后台状态读取暂未完成：' + safeMessage(error.message), 'warning'); })
      .finally(() => { this.managementTask = null; this.managementAbort = null; });
    return this.managementTask;
  }
  async shutdown() {
    this.managementAbort?.abort();
    if (this.managementTask) await this.managementTask.catch(() => {});
    this.github.vault?.clear();
    return super.shutdown();
  }
  async action(name, payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('操作参数无效。');
    if (name === 'pause') {
      if (typeof payload.paused !== 'boolean') throw new Error('暂停状态无效。');
      const base = this.findAccount(payload.accountKey);
      const repo = this.github.managed.repositories[base.repository.toLowerCase()];
      if (!repo) throw new Error('请先刷新云端配置后再修改。');
      return this.action('manage.edit', { repository: base.repository, keys: [base.accountKey], expectedDigest: repo.configDigest, patch: { enabled: !payload.paused } });
    }
    if (!name.startsWith('manage.')) return super.action(name, payload);
    if (name === 'manage.note') {
      this.github.noteAccount(payload.repository, payload.accountKey, payload.note); return this.snapshot();
    }
    if (name === 'manage.open') {
      const row = this.github.managed.accounts[recordKey(payload.repository || '', payload.accountKey || '')];
      const repo = this.github.managed.repositories[String(payload.repository || '').toLowerCase()];
      if (!row && !repo) throw new Error('请选择已管理的账号或仓库。');
      const url = row?.latestRun?.url || `https://github.com/${repo?.repository || row.repository}/actions`;
      await this.options.openExternal(url); return this.snapshot();
    }
    return this.exclusive(async signal => {
      await this.ensureGitHub(signal, false, { requireWorkflow: !['manage.refresh', 'manage.details'].includes(name) });
      if (name === 'manage.upgradeAll') {
        const repositories = this.repositories();
        if (!repositories.length) throw new Error('尚无已部署账号，请先添加账号或同步已有部署。');
        const summary = { observedAt: new Date(this.now()).toISOString(), completed: [], failed: [] };
        this.github.managed.upgrade = summary; this.github.saveManagement();
        for (const repository of repositories) {
          if (signal.aborted) return;
          this.note('正在升级并核对全部账号配置：' + repository);
          try {
            const result = await this.github.upgrade(repository, { signal });
            summary.completed.push({ repository, accounts: result.config.accounts.length, changed: result.changed });
          } catch (error) {
            if (signal.aborted) return;
            summary.failed.push({ repository, message: safeMessage(error.message), code: error.code || 'UPGRADE_FAILED' });
          }
          this.github.saveManagement();
        }
        this.note(summary.failed.length ? `已完成 ${summary.completed.length} 个仓库，${summary.failed.length} 个仍需处理；账号和原设置保留，重新点击会接续核对。` : '全部账号云端配置已升级并读回核实，无需逐个重新登录。', summary.failed.length ? 'warning' : 'success');
      } else if (name === 'manage.edit' || name === 'manage.maintenance') {
        if (!this.repositories().some(r => r.toLowerCase() === String(payload.repository).toLowerCase())) throw new Error('未知部署仓库。');
        const result = await this.github.upgrade(payload.repository, { signal, expectedDigest: payload.expectedDigest,
          ...(name === 'manage.edit' ? { keys: payload.keys, patch: payload.patch } : { maintenance: payload.maintenance }) });
        for (const base of this.state.accounts.filter(a => a.repository === payload.repository)) {
          const config = result.config.accounts.find(a => a.accountKey === base.accountKey);
          if (config) base.paused = !config.enabled;
        }
        this.persist(); this.note('设置已写入云端并读回一致，将用于后续运行；没有额外发起签到。', 'success');
      } else if (name === 'manage.refresh' || name === 'manage.details') {
        const failures = await this.refreshManaged(signal, name === 'manage.details');
        this.note(failures ? `有 ${failures} 个仓库尚未同步，保留原数据；没有触发签到或兑换。` : '已查询已有云端记录；没有触发新的签到或兑换。', failures ? 'warning' : 'info');
      } else if (name === 'manage.checkinAll' || name === 'manage.statusAll') {
        const repositories = this.repositories();
        if (!repositories.length) throw new Error('尚无已部署账号。');
        const old = this.github.managed.batch;
        if (old && old.status !== 'completed') this.note('正在接续已有批量任务，不重复创建请求。');
        else {
          this.github.managed.batch = { requestId: randomBytes(16).toString('hex'), operation: name === 'manage.checkinAll' ? 'checkin' : 'status', repositories, index: 0, status: 'queued', results: {}, createdAt: new Date(this.now()).toISOString() };
          this.github.saveManagement();
        }
        await this.continueBatch(signal);
      } else if (name === 'manage.checkin' || name === 'manage.status') {
        const row = this.github.managed.accounts[recordKey(payload.repository || '', payload.accountKey || '')];
        if (!row) throw new Error('请选择有效账号。');
        await this.github.runOperation(row.repository, name === 'manage.checkin' ? 'checkin' : 'status', { accountKey: row.accountKey, signal });
      } else if (name === 'manage.cleanup') {
        if (!this.repositories().includes(payload.repository)) throw new Error('请选择已管理仓库。');
        await this.github.runOperation(payload.repository, 'cleanup', { signal });
      } else throw new Error('不支持的管理操作。');
      this.state.stage = 'complete'; this.changed();
    });
  }
}
module.exports = { ManagementController };
