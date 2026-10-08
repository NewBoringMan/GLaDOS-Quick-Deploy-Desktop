'use strict';
(() => {
  let state = { busy: true, management: { repositories: {}, accounts: {}, history: [] } };
  const noteDrafts = new Map();
  const openSections = new Set();
  const localFeedback = { management: '', maintenance: '' };
  let waitingScope = 'management'; let waitingAction = '';
  let waiting = false; let batchControlPending = false; let signature = ''; let selection = new Set(); let draft = null;
  const $ = id => document.getElementById(id);
  const make = (tag, cls, value) => { const e = document.createElement(tag); if (cls) e.className = cls; if (value !== undefined) e.textContent = String(value); return e; };
  const planNames = { off: '不自动兑换', plan100: '100 分 / 10 天', plan200: '200 分 / 30 天', plan500: '500 分 / 100 天' };
  const errors = { authentication: '登录授权已失效，请更新此账号登录', previous_uncertain: '前次操作中断，结果尚未核实，未重复提交', request_failed: '服务端结果待核实', rate_limited: '服务端限流，等待备用时间', exchange: '兑换未完成，签到结果单独保留', execution: '本次处理未完成，请查看运行记录', configuration: '云端配置需要更新' };
  const exchangeNames = { completed: '兑换成功', already_completed: '今日已兑换，未重复扣分', not_needed: '积分未达兑换门槛', disabled: '自动兑换已关闭', failed: '兑换失败', uncertain: '兑换结果待核实，未重复兑换', points_unavailable: '积分未获取，未兑换', not_run: '未执行兑换', status_only: '本次仅查询信息' };
  const upgradeStages = { inspect: '读取云端配置', compare: '比较配置', commit: '提交配置', 'verify-config': '读回配置', workflows: '核对工作流', retention: '核对保留期', 'verify-maintenance': '复核维护设置', completed: '完成' };
  const diagnosticStages = { 'auth-verify': '授权后确认连接', github: 'GitHub 操作', identity: '确认 GitHub 身份', login: 'GitHub 授权', repository: '核对仓库', configuration: '读取或更新配置', actions: '检查 Actions', verification: '核对运行', results: '读取结果', management: '管理云端任务', report: '读取账号报告', dispatch: '提交云端任务', ...Object.fromEntries(Object.entries(upgradeStages).map(([key, value]) => ['upgrade-' + key, value])) };
  const diagnosticReasons = { network_eof: '连接意外结束', http2_stream: '连接流中断', network_transport: '传输失败', http_rejected: '请求被拒绝', service_unavailable: '服务暂不可用', rate_limited: '请求受限', auth_required: '需要 GitHub 授权', workflow_scope: '缺少工作流权限', permission_denied: '访问被拒绝', not_found: '资源未找到', conflict: '远端状态冲突', validation_failed: '请求校验未通过', auth_denied: '授权被拒绝', auth_expired: '授权已过期', wrong_account: 'GitHub 身份不符', cli_failed: '命令未完成，原因未确定', cli_unavailable: '命令组件不可用', timeout: '请求超时', output_limit: '响应超出读取上限', aborted: '操作已中止', invalid_response: '响应无法核实' };
  const actionNames = { 'manage.upgradeAll': '升级全部云端配置', 'manage.checkinAll': '全部账号签到', 'manage.statusAll': '更新账号信息', 'manage.resumeBatch': '继续批次', 'manage.checkin': '账号签到', 'manage.status': '查询账号信息', 'manage.edit': '修改账号设置', 'manage.maintenance': '修改维护设置', 'manage.refresh': '读取已有结果', 'manage.details': '加载积分与会员信息', 'manage.cleanup': '清理过期记录', 'manage.endOperation': '结束未确认请求' };
  const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false }) : '尚未获取';
  const keyFor = row => row.repository.toLowerCase() + '/' + row.accountKey;
  function upgradeProgressText(progress, status) {
    if (!progress || !upgradeStages[progress.stage]) return '本次升级进度尚未核实';
    if (status === 'completed' && progress.configurationVerified === true && progress.maintenanceVerified === true) return '本次升级已全部核对';
    if (status === 'running') return '正在' + upgradeStages[progress.stage];
    if (progress.configurationVerified === true) return '配置已核对，后续检查待完成';
    if (['commit', 'verify-config'].includes(progress.stage)) return '配置结果待核实，尚未完成核对';
    return '本次尚未更新配置';
  }
  function diagnosticText(value) {
    if (!value || typeof value !== 'object') return '';
    const token = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(x) ? x : '';
    const fields = []; const code = token(value.code); const stage = token(value.stage); const reason = token(value.reason);
    if (stage) fields.push('环节：' + (diagnosticStages[stage] || stage));
    if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) fields.push('HTTP：' + value.httpStatus);
    if (Number.isInteger(value.exitCode) && value.exitCode >= -2147483648 && value.exitCode <= 4294967295) fields.push('CLI 退出码：' + value.exitCode);
    if (reason) fields.push('原因：' + (diagnosticReasons[reason] || reason));
    if (['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(value.method)) fields.push('方法：' + value.method);
    const endpoint = token(value.endpointKind); if (endpoint) fields.push('接口类型：' + endpoint);
    if (code) fields.push('代码：' + code);
    return fields.join('；');
  }
  function diagnosticView(diagnostic) {
    const value = diagnosticText(diagnostic); if (!value) return null;
    const wrap = make('details', 'diagnostic-details'); wrap.append(make('summary', '', '查看安全诊断'));
    const line = make('p', 'mg-line mg-muted', value); line.dataset.mgDiagnostic = '';
    const copy = make('button', 'button mg-button', '复制诊断'); copy.type = 'button'; copy.dataset.mgCopyDiagnostic = '';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(value); copy.textContent = '已复制诊断'; }
      catch {
        const selected = window.getSelection(); const range = document.createRange(); range.selectNodeContents(line);
        selected?.removeAllRanges(); selected?.addRange(range); copy.textContent = '已选中，请复制';
      }
    });
    wrap.append(line, copy); return wrap;
  }
  function failureView(record, prefix = '') {
    const wrap = make('div', 'mg-result-detail');
    const code = record.diagnostic?.code || record.code;
    const message = code === 'GITHUB_COMMAND_FAILED'
      ? (record.diagnostic ? 'GitHub 操作未完成，具体环节见诊断。' : '旧版仅保存了通用错误，具体原因未记录。')
      : record.message || record.error || '云端运行结束，但有任务未成功；请查看逐账号结果。';
    wrap.append(make('span', 'mg-warning', prefix + message));
    if (record.upgradeProgress) { const progress = make('p', 'mg-line', upgradeProgressText(record.upgradeProgress) + '；环节：' + (upgradeStages[record.upgradeProgress.stage] || '待核实')); wrap.append(progress); }
    const diagnostic = diagnosticView(record.diagnostic); if (diagnostic) wrap.append(diagnostic);
    return wrap;
  }
  function scopeFor(name) {
    if (['manage.upgradeAll', 'manage.maintenance', 'manage.cleanup', 'manage.endOperation'].includes(name)) return 'maintenance';
    return name.startsWith('manage.') ? 'management' : 'deployment';
  }
  function operationProgressText(progress = {}) {
    if (progress.resultVerified) return '账号结果已核对，积分与会员信息待读取';
    if (progress.runStatus === 'completed') return progress.runConclusion === 'failure' ? '云端运行报告失败，账号结果待确认' : '云端运行已结束，账号结果待确认';
    if (progress.runStatus === 'in_progress') return '云端正在执行，APP 等待读取结果';
    if (progress.submission === 'accepted') return '云端已接受请求，结果待确认';
    return '提交结果待确认，已保留原请求';
  }
  function pendingView(record, prefix = '') {
    const wrap = make('div', 'mg-result-detail is-pending');
    wrap.append(make('p', 'mg-line', prefix + operationProgressText(record.operationProgress)));
    wrap.append(make('p', 'mg-line mg-muted', '读取已有结果会继续核对原任务，不重复提交。'));
    const diagnostic = diagnosticView(record.diagnostic || record.readback?.diagnostic); if (diagnostic) wrap.append(diagnostic);
    return wrap;
  }
  function foldout(label, key) {
    const details = make('details', 'mg-card-more'); details.open = openSections.has(key);
    details.append(make('summary', '', label));
    details.addEventListener('toggle', () => { if (details.open) openSections.add(key); else openSections.delete(key); });
    return details;
  }
  function selectionLabel() {
    $('mg-selected-count').textContent = selection.size ? '已选 ' + selection.size + ' 个账号' : '未选择账号';
    $('mg-edit-selected').disabled = !selection.size || state.busy || waiting;
  }
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
    if (row.latestRun?.status === 'completed' && row.latestRun?.conclusion === 'failure' && !result.observedAt) return ['云端运行异常，账号结果待确认', 'pending'];
    if (result.businessDate === today() && result.outcome === 'unverified') return ['本次结果待确认', 'pending'];
    return ['今日尚无成功证据', 'pending'];
  }
  function button(label, action, payload, cls = '') {
    const e = make('button', 'button mg-button ' + cls, label); e.type = 'button';
    e.disabled = state.busy || waiting; e.addEventListener('click', () => typeof action === 'function' ? action() : invoke(action, payload)); return e;
  }
  function metric(label, value) { const e = make('div', 'mg-metric'); e.append(make('span', '', label), make('strong', '', value ?? '未获取')); return e; }
  async function invoke(name, payload = {}) {
    if (state.busy || waiting) return false;
    const scope = scopeFor(name); waitingScope = scope; waitingAction = name; waiting = true;
    if (scope === 'deployment') window.quickDeployUI?.showPage('deployment', false);
    else localFeedback[scope] = '';
    render();
    try {
      receive(await window.quickDeploy.action(name, payload));
      return !state.feedback?.[scope]?.error && !(state.actionScope === scope && state.error);
    } catch (error) {
      if (scope !== 'deployment') localFeedback[scope] = String(error.message || '操作未完成，请查看诊断。');
      return false;
    } finally { waiting = false; signature = ''; render(); }
  }
  async function stopBatch(name) {
    if (batchControlPending) return;
    batchControlPending = true; localFeedback.management = ''; render();
    try { receive(await window.quickDeploy.action(name)); }
    catch (error) { localFeedback.management = String(error.message || '停止批次未完成'); }
    finally { batchControlPending = false; signature = ''; render(); }
  }
  function openEdit(rows) {
    if (!rows.length) { localFeedback.management = '请先勾选账号。'; render(); return; }
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
        const saved = await invoke('manage.edit', { repository, keys: current.rows.filter(r => r.repository === repository).map(r => r.accountKey), expectedDigest: current.digests[repository], patch });
        if (!saved) break;
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
    check.addEventListener('change', () => { if (check.checked) selection.add(key); else selection.delete(key); selectionLabel(); });
    const label = make('div', 'mg-identity'); label.append(make('h3', '', row.note || row.email || '账号 · ' + row.accountKey.slice(-4)), make('p', '', row.email && row.note ? row.email : row.repository));
    const [status, tone] = accountStatus(row); head.append(check, label); card.append(head, make('span', 'mg-badge is-' + tone, status));
    const detail = row.details || {}; const result = row.result || {};
    const metrics = make('div', 'mg-metrics');
    metrics.append(metric('当前积分', detail.points), metric('剩余会员天数', Number.isFinite(detail.leftDays) ? Math.floor(detail.leftDays) : null),
      metric('今日新增积分', result.checkinBusinessDate === today() && (detail.businessDate === today() || row.dailyCredit?.day === today()) ? (detail.pointsAdded ?? row.dailyCredit?.pointsAdded) : null), metric('兑换方案', planNames[row.settings?.exchangePlan] || '未获取'));
    card.append(metrics);
    const schedule = make('div', 'mg-schedule'); schedule.append(make('span', 'mg-muted', '每日 UTC+8'));
    for (const time of row.settings?.times || []) schedule.append(make('span', 'mg-time', time));
    card.append(schedule, make('p', 'mg-line mg-muted', '下次计划：' + (row.settings?.enabled === false ? '已暂停' : nextTime(row.settings?.times))));
    if (result.authenticationRequired && result.checkinConfirmed && result.checkinBusinessDate === today()) card.append(make('p', 'mg-warning', '今日签到成功已保留，但当前登录需要更新。'));
    const error = row.lastError || row.detailError || errors[result.errorKind]; if (error) card.append(make('p', 'mg-warning', error));
    if (row.readback?.pending) {
      const pending = make('p', 'mg-warning', row.readback.stage === 'details' ? '签到结果已保留，积分与会员信息待读取。' : '账号结果待确认，可读取已有结果继续核对。');
      card.append(pending); const diagnostic = diagnosticView(row.readback.diagnostic); if (diagnostic) card.append(diagnostic);
    }
    const controls = make('div', 'mg-actions');
    controls.append(button('签到', 'manage.checkin', { repository: row.repository, accountKey: row.accountKey }),
      button('更新信息', 'manage.status', { repository: row.repository, accountKey: row.accountKey }), button('编辑设置', () => openEdit([row])));
    card.append(controls);
    const more = foldout('账号详情与更多操作', key);
    const content = make('div', 'mg-foldout-body');
    content.append(make('p', 'mg-line', '兑换结果：' + (exchangeNames[result.exchange] || '尚无记录')),
      make('p', 'mg-line mg-muted', '信息采集：' + date(detail.observedAt) + '；签到确认：' + date(result.checkinConfirmedAt)));
    const extra = make('div', 'mg-actions'); extra.append(button('更新登录', 'reloginAccount', { accountKey: row.accountKey }), button('查看云端运行记录', 'manage.open', { repository: row.repository, accountKey: row.accountKey })); content.append(extra);
    const noteLine = make('div', 'mg-note-line'); const note = make('input'); note.type = 'text'; note.maxLength = 200; note.placeholder = '本机备注，不上传云端'; note.value = noteDrafts.has(key) ? noteDrafts.get(key) : row.note || ''; note.addEventListener('input', () => noteDrafts.set(key, note.value)); note.setAttribute('aria-label', '账号备注');
    noteLine.append(note, button('保存备注', () => invoke('manage.note', { repository: row.repository, accountKey: row.accountKey, note: note.value }).then(saved => { if (saved) noteDrafts.delete(key); }))); content.append(noteLine);
    more.append(content); card.append(more); return card;
  }
  function renderMaintenance(repo) {
    const card = make('article', 'mg-repository'); card.dataset.mgRepository = repo.repository; card.append(make('h3', '', repo.repository));
    const s = repo.lastScheduledRun;
    card.append(make('p', 'mg-line', '云端配置：' + (repo.upgraded ? '已读取账号独立设置' : '旧版，需要一键升级') + '；Actions：' + (repo.actionsEnabled ? '开启' : '已关闭')));
    const attempt = repo.upgradeAttempt;
    if (attempt) {
      const progress = make('p', attempt.status === 'completed' ? 'mg-line' : 'mg-warning', '本次升级：' + (attempt.interrupted ? '上次升级中断，待重新核对；' : '') + upgradeProgressText(attempt, attempt.status) + '；开始于 ' + date(attempt.startedAt));
      progress.dataset.mgUpgradeProgress = ''; card.append(progress);
      if (attempt.status !== 'completed') {
        card.append(make('p', 'mg-line', '当前环节：' + (upgradeStages[attempt.stage] || '尚未核实')));
        const diagnostic = diagnosticView(attempt.diagnostic); if (diagnostic) card.append(diagnostic);
      }
    }
    card.append(make('p', 'mg-line', '平台原生保留期：' + (repo.nativeRetentionDays === 3 ? '最近读取为 3 天' : '尚未确认，请一键升级云端配置')));
    card.append(make('p', 'mg-line', '真正定时触发：' + (s ? date(s.createdAt) + ' · ' + (s.conclusion || s.status) : '尚未观察到 schedule 运行，不能视为已验收')));
    const maintenance = repo.config?.maintenance || {};
    const c = repo.maintenance?.cleanup?.lastRun; const k = repo.maintenance?.keepalive?.lastRun;
    card.append(make('p', 'mg-line', '自动清理：' + (maintenance.cleanupEnabled ? '每日 ' + maintenance.cleanupTime + '，保留 72 小时' : '已暂停') + '；最近：' + (c ? date(c.createdAt) + ' · ' + (c.conclusion || c.status) : '尚未运行')));
    card.append(make('p', 'mg-line', '自动保活：' + (maintenance.keepaliveEnabled ? '每月 1 日 11:23，提交活动时间戳' : '已暂停') + '；最近：' + (k ? date(k.createdAt) + ' · ' + (k.conclusion || k.status) : '尚未运行')));
    if (repo.cleanupSummary) card.append(make('p', 'mg-line', `最近清理：${repo.cleanupSummary.deletedRuns || 0} 条运行、${repo.cleanupSummary.deletedArtifacts || 0} 个附件、${repo.cleanupSummary.deletedCaches || 0} 份缓存；错误 ${repo.cleanupSummary.errors || 0} 项。`));
    const actions = make('div', 'mg-actions'); actions.append(button('维护设置', () => openMaintenance(repo))); card.append(actions);
    const advanced = foldout('其他维护操作', 'maintenance:' + repo.repository); const advancedBody = make('div', 'mg-foldout-body');
    advancedBody.append(make('p', 'mg-line mg-muted', '立即按已设定的 72 小时规则清理过期记录。'), button('立即清理过期记录', 'manage.cleanup', { repository: repo.repository }));
    for (const workflow of ['glados-quick-deploy.yml', 'glados-quick-deploy-cleanup.yml']) {
      const operation = state.management.operations?.[repo.repository.toLowerCase() + ':' + workflow];
      if (!operation || operation.status === 'ended' || operation.status === 'completed' && !operation.observationPending) continue;
      if (operation.observationPending && workflow.includes('cleanup')) card.append(pendingView(operation, '清理任务：'));
      advancedBody.append(make('p', 'mg-warning', '此仓库还有本机未确认请求。结束前会核对云端没有活动运行；不会重发原请求。未确认的签到在今天继续保留防重保护。'));
      const end = button('结束未确认请求（不重发）', 'manage.endOperation', { repository: repo.repository, workflow, expectedNonce: operation.nonce });
      end.dataset.mgEndOperation = workflow; advancedBody.append(end);
    }
    advanced.append(advancedBody); card.append(advanced);
    const block = state.management.checkinBlocks?.[repo.repository.toLowerCase()];
    if (block?.day >= today()) card.append(make('p', 'mg-warning', '前次签到结果未核实，今天不会重复发起签到；仍可查询账号信息，明天可明确发起新的签到。'));
    return card;
  }
  function renderFeedback(management) {
    for (const scope of ['management', 'maintenance']) {
      const target = $(scope === 'management' ? 'mg-notice' : 'maintenance-notice');
      const feedback = state.feedback?.[scope];
      const fallback = !state.feedback && (!state.actionScope || state.actionScope === scope) ? state : {};
      const current = feedback || fallback;
      let message = localFeedback[scope] || (waiting && waitingScope === scope ? '正在处理：' + (actionNames[waitingAction] || '当前操作') + '…' : current.error || current.message || '');
      const retained = management.lastFailure;
      if (retained && !retained.resolvedAt && scopeFor(retained.action || '') === scope && current.error === retained.message) message = localFeedback[scope] || '';
      target.textContent = message; target.hidden = !message;
      target.classList.toggle('is-error', Boolean(localFeedback[scope] || current.error));
      target.classList.toggle('is-pending', current.stage === 'awaiting_result');
      const targetFailure = $(scope === 'management' ? 'mg-last-failure' : 'maintenance-last-failure');
      const entries = [];
      if (retained && !retained.resolvedAt && scopeFor(retained.action || '') === scope) entries.push(failureView(retained, `${actionNames[retained.action] || '操作'}未完成（${date(retained.observedAt)}）${retained.repository ? ' · ' + retained.repository : ''}：`));
      const pending = management.lastPending;
      if (pending && !pending.resolvedAt && scopeFor(pending.action || '') === scope) entries.push(pendingView(pending, `${actionNames[pending.action] || '操作'}：`));
      targetFailure.hidden = !entries.length; targetFailure.replaceChildren(...entries);
    }
  }
  function render() {
    if (!$('mg-section')) return;
    const management = state.management || { accounts: {}, repositories: {}, history: [] };
    state.management = management;
    const accounts = Object.values(management.accounts || {});
    $('mg-count').textContent = accounts.length;
    $('nav-account-count').textContent = Math.max(accounts.length, state.accounts?.length || 0);
    selection = new Set([...selection].filter(key => accounts.some(row => keyFor(row) === key)));
    renderFeedback(management);
    for (const id of ['mg-upgrade-all', 'mg-checkin-all', 'mg-status-all', 'mg-refresh', 'mg-details', 'mg-edit-selected']) $(id).disabled = state.busy || waiting;
    selectionLabel();
    const view = JSON.stringify([management, state.busy, waiting, batchControlPending, today()]);
    if (signature === view) return; signature = view;
    $('mg-account-list').replaceChildren(...accounts.map(renderAccount));
    if (!accounts.length) $('mg-account-list').append(make('p', 'mg-empty', '连接 GitHub 后会同步已有部署。第一次使用请点击“新增账号”。'));
    $('mg-repositories').replaceChildren(...Object.values(management.repositories || {}).map(renderMaintenance));
    if (!Object.keys(management.repositories || {}).length) $('mg-repositories').append(make('p', 'mg-empty', '尚无已部署仓库。添加账号后，这里会显示维护设置。'));
    const batch = management.batch;
    $('mg-batch-panel').hidden = !batch;
    $('mg-batch').hidden = !batch;
    const batchLabels = { queued: '等待处理', running: '处理中', waiting: '等待原云端任务', paused: '本机已停止，进度已保留', completed: '本轮请求处理结束', ended: '本轮已结束' };
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
      if (result.observationPending) controls.append(pendingView(result, repository + '：'));
      else if (result.error || result.conclusion && result.conclusion !== 'success') controls.append(failureView(result, repository + '：'));
    }
    $('mg-upgrade-status').hidden = !management.upgrade;
    if (management.upgrade) {
      const u = management.upgrade;
      const completed = u.completed || []; const failed = u.failed || [];
      $('mg-upgrade-status').replaceChildren(make('span', '', `最近升级批次（${date(u.observedAt)}）：全部核对 ${completed.length} 个仓库，待处理 ${failed.length} 个。`), ...failed.map(x => failureView(x, x.repository + '：')));
    }
    const history = (management.history || []).filter(x => Date.parse(x.observedAt) > Date.now() - 72 * 3600000).slice().reverse();
    $('mg-history').replaceChildren(...history.slice(0, 100).map(x => {
      const row = make('div', 'mg-history-row'); row.append(make('span', '', date(x.observedAt)), make('span', '', '…' + x.accountKey.slice(-4)), make('span', '', x.event === 'schedule' ? '定时' : '主动触发'), make('span', '', x.checkinConfirmed && x.checkinBusinessDate === x.businessDate ? '签到已确认' : errors[x.errorKind] || (x.operation === 'status' ? '仅查询' : '待核实'))); return row;
    }));
    if (!history.length) $('mg-history').append(make('p', 'mg-empty', '最近 3 天暂无结构化结果；历史手动成功不会冒充今日定时成功。'));
  }
  function receive(next) { if (next && typeof next === 'object') state = next; render(); }
  function initialize() {
    if (!window.quickDeploy) return;
    for (const [id, action] of [['mg-upgrade-all', 'manage.upgradeAll'], ['mg-checkin-all', 'manage.checkinAll'], ['mg-status-all', 'manage.statusAll'], ['mg-refresh', 'manage.refresh'], ['mg-details', 'manage.details']]) $(id).addEventListener('click', () => invoke(action));
    $('mg-edit-selected').addEventListener('click', () => openEdit(Object.values(state.management.accounts || {}).filter(a => selection.has(keyFor(a)))));
    $('mg-edit-form').addEventListener('submit', saveEdit); $('mg-dialog-cancel').addEventListener('click', () => { $('mg-dialog').close(); draft = null; });
    const unsubscribe = window.quickDeploy.onState(receive); window.addEventListener('beforeunload', unsubscribe, { once: true });
    window.quickDeploy.getState().then(receive).catch(e => { $('mg-notice').textContent = String(e.message); $('mg-notice').hidden = false; });
    const timer = setInterval(() => { render(); }, 60000); window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  }
  initialize();
})();
