'use strict';
(() => {
  let state = { busy: true, management: { repositories: {}, accounts: {}, history: [] } };
  const noteDrafts = new Map();
  let waiting = false; let batchControlPending = false; let signature = ''; let selection = new Set(); let draft = null;
  const $ = id => document.getElementById(id);
  const make = (tag, cls, value) => { const e = document.createElement(tag); if (cls) e.className = cls; if (value !== undefined) e.textContent = String(value); return e; };
  const planNames = { off: '不自动兑换', plan100: '100 分 / 10 天', plan200: '200 分 / 30 天', plan500: '500 分 / 100 天' };
  const errors = { authentication: '登录授权已失效，请更新此账号登录', previous_uncertain: '前次操作中断，结果尚未核实，未重复提交', request_failed: '服务端结果待核实', rate_limited: '服务端限流，等待备用时间', exchange: '兑换未完成，签到结果单独保留', execution: '本次处理未完成，请查看运行记录', configuration: '云端配置需要更新' };
  const exchangeNames = { completed: '兑换成功', already_completed: '今日已兑换，未重复扣分', not_needed: '积分未达兑换门槛', disabled: '自动兑换已关闭', failed: '兑换失败', uncertain: '兑换结果待核实，未重复兑换', points_unavailable: '积分未获取，未兑换', not_run: '未执行兑换', status_only: '本次仅查询信息' };
  const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false }) : '尚未获取';
  const keyFor = row => row.repository.toLowerCase() + '/' + row.accountKey;
  function nextTime(times) {
    const list = (times || []).map(t => { let x = Date.parse(today() + 'T' + t + ':00+08:00'); if (x <= Date.now()) x += 86400000; return x; }).filter(Number.isFinite);
    return list.length ? date(new Date(Math.min(...list)).toISOString()) : '未启用';
  }
  function accountStatus(row) {
    const result = row.result || {}; const repo = state.management.repositories[row.repository.toLowerCase()];
    if (result.checkinConfirmed && result.checkinBusinessDate === today()) return ['今日签到成功', 'success'];
    if (result.authenticationRequired) return ['需要更新登录', 'error'];
    if (row.settings?.enabled === false) return ['已暂停签到', 'muted'];
    if (repo?.actionsEnabled === false) return ['仓库 Actions 已关闭', 'error'];
    if (repo?.workflows?.some(w => w.path === '.github/workflows/glados-quick-deploy.yml' && w.state !== 'active')) return ['云端签到工作流已停用', 'muted'];
    if (['queued', 'requested', 'waiting', 'pending'].includes(row.latestRun?.status)) return ['等待云端执行', 'pending'];
    if (row.latestRun?.status === 'in_progress') return ['逐个处理进行中', 'pending'];
    if (result.businessDate === today() && result.outcome === 'failed') return ['本次失败，等待补漏', 'error'];
    if (row.latestRun?.status === 'completed' && row.latestRun?.conclusion === 'failure' && !result.observedAt) return ['任务失败，尚无账号结果', 'error'];
    if (result.businessDate === today() && result.outcome === 'unverified') return ['本次结果待核实', 'error'];
    return ['今日尚无成功证据', 'pending'];
  }
  function button(label, action, payload, cls = '') {
    const e = make('button', 'button mg-button ' + cls, label); e.type = 'button';
    e.disabled = state.busy || waiting; e.addEventListener('click', () => typeof action === 'function' ? action() : invoke(action, payload)); return e;
  }
  function metric(label, value) { const e = make('div', 'mg-metric'); e.append(make('span', '', label), make('strong', '', value ?? '未获取')); return e; }
  async function invoke(name, payload = {}) {
    if (state.busy || waiting) return;
    waiting = true; render(); $('mg-notice').textContent = '正在执行，请查看逐账号状态…';
    try { receive(await window.quickDeploy.action(name, payload)); $('mg-notice').textContent = state.error || state.message || '操作已处理。'; }
    catch (error) { $('mg-notice').textContent = String(error.message || '操作未完成'); }
    finally { waiting = false; signature = ''; render(); }
  }
  async function stopBatch(name) {
    if (batchControlPending) return;
    batchControlPending = true; render();
    try { receive(await window.quickDeploy.action(name)); $('mg-notice').textContent = state.error || state.message || '本机批次已停止。'; }
    catch (error) { $('mg-notice').textContent = String(error.message || '停止批次未完成'); }
    finally { batchControlPending = false; signature = ''; render(); }
  }
  function openEdit(rows) {
    if (!rows.length) { $('mg-notice').textContent = '请先勾选账号。'; return; }
    const repositories = [...new Set(rows.map(a => a.repository))];
    draft = { kind: 'accounts', rows, repositories, digests: Object.fromEntries(repositories.map(r => [r, state.management.repositories[r.toLowerCase()]?.configDigest])) };
    $('mg-dialog-title').textContent = rows.length === 1 ? '修改账号设置' : '批量修改 ' + rows.length + ' 个账号';
    $('mg-edit-times').value = rows[0].settings.times.join(', ');
    $('mg-edit-plan').value = rows[0].settings.exchangePlan;
    $('mg-edit-enabled').checked = rows[0].settings.enabled !== false;
    $('mg-edit-account-fields').hidden = false; $('mg-edit-maintenance-fields').hidden = true;
    $('mg-edit-notice').textContent = '只修改所选账号，保留其他账号设置。保存成功后会读回云端核实，不会额外签到。';
    $('mg-dialog').showModal();
  }
  function openMaintenance(repo) {
    draft = { kind: 'maintenance', repository: repo.repository, digest: repo.configDigest };
    $('mg-dialog-title').textContent = '仓库维护设置';
    $('mg-edit-account-fields').hidden = true; $('mg-edit-maintenance-fields').hidden = false;
    $('mg-cleanup-time').value = repo.config.maintenance.cleanupTime;
    $('mg-cleanup-enabled').checked = repo.config.maintenance.cleanupEnabled;
    $('mg-keepalive-enabled').checked = repo.config.maintenance.keepaliveEnabled;
    $('mg-edit-notice').textContent = '清理只作用于本仓库的 Quick Deploy 运行记录，固定保留 72 小时。保活不刷新 GLaDOS 登录。';
    $('mg-dialog').showModal();
  }
  async function saveEdit(event) {
    event.preventDefault(); if (!draft || waiting || state.busy) return;
    const current = draft;
    if (current.kind === 'accounts') {
      const times = $('mg-edit-times').value.split(/[,，\s]+/).filter(Boolean);
      if (!times.length || times.length > 6 || times.some(t => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))) { $('mg-edit-notice').textContent = '请填写 1–6 个 HH:mm 时间，用逗号分隔。'; return; }
      const patch = { times, exchangePlan: $('mg-edit-plan').value, enabled: $('mg-edit-enabled').checked };
      $('mg-dialog').close();
      for (const repository of current.repositories) {
        await invoke('manage.edit', { repository, keys: current.rows.filter(r => r.repository === repository).map(r => r.accountKey), expectedDigest: current.digests[repository], patch });
        if (state.error) break;
      }
    } else {
      const maintenance = { cleanupTime: $('mg-cleanup-time').value, cleanupEnabled: $('mg-cleanup-enabled').checked, keepaliveEnabled: $('mg-keepalive-enabled').checked };
      $('mg-dialog').close(); await invoke('manage.maintenance', { repository: current.repository, expectedDigest: current.digest, maintenance });
    }
    draft = null;
  }
  function renderAccount(row) {
    const key = keyFor(row); const card = make('article', 'mg-card'); card.dataset.mgAccount = row.accountKey; card.dataset.repository = row.repository;
    const head = make('div', 'mg-card-head');
    const check = make('input'); check.type = 'checkbox'; check.checked = selection.has(key); check.setAttribute('aria-label', '选择账号 ' + (row.email || row.accountKey));
    check.addEventListener('change', () => { if (check.checked) selection.add(key); else selection.delete(key); });
    const label = make('div', 'mg-identity'); label.append(make('h3', '', row.note || row.email || '账号 · ' + row.accountKey.slice(-4)), make('p', '', row.email && row.note ? row.email : row.repository));
    const [status, tone] = accountStatus(row); head.append(check, label, make('span', 'mg-badge is-' + tone, status)); card.append(head);
    const detail = row.details || {}; const result = row.result || {};
    const metrics = make('div', 'mg-metrics');
    metrics.append(metric('当前积分', detail.points), metric('本日新增积分', result.checkinBusinessDate === today() && (detail.businessDate === today() || row.dailyCredit?.day === today()) ? (detail.pointsAdded ?? row.dailyCredit?.pointsAdded) : null),
      metric('剩余会员天数', Number.isFinite(detail.leftDays) ? Math.floor(detail.leftDays) : null), metric('自动兑换', planNames[row.settings?.exchangePlan] || '未获取')); card.append(metrics);
    const scheduling = make('p', 'mg-line', '每日 UTC+8：' + (row.settings?.times || []).join(' / ') + '；下次计划：' + (row.settings?.enabled === false ? '已暂停' : nextTime(row.settings?.times)));
    const freshness = make('p', 'mg-line mg-muted', '账号信息采集（非实时）：' + date(detail.observedAt) + '；签到确认：' + date(result.checkinConfirmedAt));
    card.append(scheduling, freshness, make('p', 'mg-line', '兑换结果：' + (exchangeNames[result.exchange] || '尚无记录')));
    if (result.authenticationRequired && result.checkinConfirmed && result.checkinBusinessDate === today()) card.append(make('p', 'mg-warning', '今日签到成功已保留，但当前登录需要更新。'));
    const error = row.lastError || row.detailError || errors[result.errorKind]; if (error) card.append(make('p', 'mg-warning', error));
    const controls = make('div', 'mg-actions');
    controls.append(button('编辑设置', () => openEdit([row])), button('查询信息', 'manage.status', { repository: row.repository, accountKey: row.accountKey }),
      button('签到', 'manage.checkin', { repository: row.repository, accountKey: row.accountKey }),
      button('更新登录', 'reloginAccount', { accountKey: row.accountKey }), button('运行记录', 'manage.open', { repository: row.repository, accountKey: row.accountKey }));
    card.append(controls);
    const noteLine = make('div', 'mg-note-line'); const note = make('input'); note.type = 'text'; note.maxLength = 200; note.placeholder = '本机备注，不上传云端'; note.value = noteDrafts.has(key) ? noteDrafts.get(key) : row.note || ''; note.addEventListener('input', () => noteDrafts.set(key, note.value)); note.setAttribute('aria-label', '账号备注');
    noteLine.append(note, button('保存备注', () => invoke('manage.note', { repository: row.repository, accountKey: row.accountKey, note: note.value }).then(() => { if (!state.error) noteDrafts.delete(key); }))); card.append(noteLine);
    return card;
  }
  function renderMaintenance(repo) {
    const card = make('article', 'mg-repository'); card.append(make('h3', '', repo.repository));
    const s = repo.lastScheduledRun;
    card.append(make('p', 'mg-line', '云端配置：' + (repo.upgraded ? '1.2.0 已升级' : '旧版，需要一键升级') + '；Actions：' + (repo.actionsEnabled ? '开启' : '已关闭')));
    card.append(make('p', 'mg-line', '平台原生保留期：' + (repo.nativeRetentionDays === 3 ? '已确认 3 天' : '尚未确认，请一键升级云端配置')));
    card.append(make('p', 'mg-line', '真正定时触发：' + (s ? date(s.createdAt) + ' · ' + (s.conclusion || s.status) : '尚未观察到 schedule 运行，不能视为已验收')));
    const maintenance = repo.config?.maintenance || {};
    const c = repo.maintenance?.cleanup?.lastRun; const k = repo.maintenance?.keepalive?.lastRun;
    card.append(make('p', 'mg-line', '自动清理：' + (maintenance.cleanupEnabled ? '每日 ' + maintenance.cleanupTime + '，保留 72 小时' : '已暂停') + '；最近：' + (c ? date(c.createdAt) + ' · ' + (c.conclusion || c.status) : '尚未运行')));
    card.append(make('p', 'mg-line', '自动保活：' + (maintenance.keepaliveEnabled ? '每月 1 日 11:23，提交活动时间戳' : '已暂停') + '；最近：' + (k ? date(k.createdAt) + ' · ' + (k.conclusion || k.status) : '尚未运行')));
    if (repo.cleanupSummary) card.append(make('p', 'mg-line', `最近清理：${repo.cleanupSummary.deletedRuns || 0} 条运行、${repo.cleanupSummary.deletedArtifacts || 0} 个附件、${repo.cleanupSummary.deletedCaches || 0} 份缓存；错误 ${repo.cleanupSummary.errors || 0} 项。`));
    const actions = make('div', 'mg-actions'); actions.append(button('维护设置', () => openMaintenance(repo)), button('立即清理过期记录', 'manage.cleanup', { repository: repo.repository })); card.append(actions);
    for (const workflow of ['glados-quick-deploy.yml', 'glados-quick-deploy-cleanup.yml']) {
      const operation = state.management.operations?.[repo.repository.toLowerCase() + ':' + workflow];
      if (!operation || ['completed', 'ended'].includes(operation.status)) continue;
      card.append(make('p', 'mg-warning', '此仓库还有本机未确认请求。结束前会核对云端没有活动运行；不会重发原请求。未确认的签到在今天继续保留防重保护。'));
      const end = button('结束未确认请求（不重发）', 'manage.endOperation', { repository: repo.repository, workflow, expectedNonce: operation.nonce });
      end.dataset.mgEndOperation = workflow; card.append(end);
    }
    const block = state.management.checkinBlocks?.[repo.repository.toLowerCase()];
    if (block?.day >= today()) card.append(make('p', 'mg-warning', '前次签到结果未核实，今天不会重复发起签到；仍可查询账号信息，明天可明确发起新的签到。'));
    return card;
  }
  function render() {
    if (!$('mg-section')) return;
    const management = state.management || { accounts: {}, repositories: {}, history: [] };
    state.management = management;
    const accounts = Object.values(management.accounts || {});
    $('mg-count').textContent = accounts.length;
    for (const id of ['mg-upgrade-all', 'mg-checkin-all', 'mg-status-all', 'mg-refresh', 'mg-details', 'mg-edit-selected']) $(id).disabled = state.busy || waiting;
    const view = JSON.stringify([management, state.busy, waiting, batchControlPending, today()]);
    if (signature === view) return; signature = view;
    $('mg-account-list').replaceChildren(...accounts.map(renderAccount));
    if (!accounts.length) $('mg-account-list').append(make('p', 'mg-empty', '已有部署将在连接 GitHub 后同步。首次使用可在下方添加账号。'));
    $('mg-repositories').replaceChildren(...Object.values(management.repositories || {}).map(renderMaintenance));
    const batch = management.batch;
    $('mg-batch').hidden = !batch;
    const batchLabels = { queued: '等待处理', running: '处理中', waiting: '等待原云端任务', paused: '本机已停止，进度已保留', completed: '本轮已处理', ended: '本轮已结束' };
    $('mg-batch').textContent = batch ? `${batch.operation === 'checkin' ? '全部账号签到' : '全部信息查询'}：${batchLabels[batch.status] || '待核对'}，已处理仓库 ${batch.index} / ${batch.repositories.length}。${batch.status === 'waiting' ? '继续跟踪原任务，不会重复提交；可停止本机批次。' : batch.status === 'paused' ? '后台不会提交剩余任务，需点击继续。' : ''}` : '';
    const controls = $('mg-batch-controls'); controls.replaceChildren(); controls.hidden = !batch;
    if (batch && !['completed', 'ended'].includes(batch.status)) {
      if (batch.status === 'paused') {
        const resume = button('继续此批次', 'manage.resumeBatch'); resume.id = 'mg-resume-batch'; controls.append(resume);
      } else {
        const stop = button('停止并保留进度', () => stopBatch('manage.stopBatch')); stop.id = 'mg-stop-batch'; stop.disabled = batchControlPending; controls.append(stop);
      }
      const end = button('结束此批次', () => stopBatch('manage.endBatch')); end.id = 'mg-end-batch'; end.disabled = batchControlPending; controls.append(end);
    }
    if (batch) for (const [repository, result] of Object.entries(batch.results || {})) {
      if (result.error || result.conclusion && result.conclusion !== 'success') controls.append(make('p', 'mg-warning', repository + '：' + (result.error || '云端运行结束，但有任务未成功；请查看逐账号结果。')));
    }
    if (management.upgrade) {
      $('mg-upgrade-status').hidden = false;
      const u = management.upgrade;
      $('mg-upgrade-status').textContent = `配置升级：已完成 ${u.completed.length} 个仓库，待处理 ${u.failed.length} 个。` + u.failed.map(x => `${x.repository}：${x.message}`).join('；');
    }
    const history = (management.history || []).filter(x => Date.parse(x.observedAt) > Date.now() - 72 * 3600000).slice().reverse();
    $('mg-history').replaceChildren(...history.slice(0, 100).map(x => {
      const row = make('div', 'mg-history-row'); row.append(make('span', '', date(x.observedAt)), make('span', '', '…' + x.accountKey.slice(-4)), make('span', '', x.event === 'schedule' ? '定时' : '主动触发'), make('span', '', x.checkinConfirmed && x.checkinBusinessDate === x.businessDate ? '签到已确认' : errors[x.errorKind] || (x.operation === 'status' ? '仅查询' : '待核实'))); return row;
    }));
    if (!history.length) $('mg-history').append(make('p', 'mg-empty', '最近 3 天暂无 1.2.0 结构化结果；历史手动成功不会冒充今日定时成功。'));
  }
  function receive(next) { if (next && typeof next === 'object') state = next; render(); }
  function initialize() {
    if (!window.quickDeploy) return;
    const batchControls = make('div', 'mg-actions'); batchControls.id = 'mg-batch-controls'; batchControls.hidden = true;
    $('mg-batch').insertAdjacentElement('afterend', batchControls);
    for (const [id, action] of [['mg-upgrade-all', 'manage.upgradeAll'], ['mg-checkin-all', 'manage.checkinAll'], ['mg-status-all', 'manage.statusAll'], ['mg-refresh', 'manage.refresh'], ['mg-details', 'manage.details']]) $(id).addEventListener('click', () => invoke(action));
    $('mg-edit-selected').addEventListener('click', () => openEdit(Object.values(state.management.accounts || {}).filter(a => selection.has(keyFor(a)))));
    $('mg-edit-form').addEventListener('submit', saveEdit); $('mg-dialog-cancel').addEventListener('click', () => { $('mg-dialog').close(); draft = null; });
    const unsubscribe = window.quickDeploy.onState(receive); window.addEventListener('beforeunload', unsubscribe, { once: true });
    window.quickDeploy.getState().then(receive).catch(e => { $('mg-notice').textContent = String(e.message); });
    const timer = setInterval(() => { render(); }, 60000); window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  }
  initialize();
})();
