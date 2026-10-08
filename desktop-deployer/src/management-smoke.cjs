'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeManifest, businessDate } = require('./schedule-config.cjs');
const { GitHubError, safeGitHubDiagnostic } = require('./github.cjs');

async function runManagementRendererRegression({ window, controller, actions, outputDirectory }) {
  if (!process.argv.includes('--smoke-test')) throw new Error('Management fixtures require isolated smoke mode');
  const original = controller.state; const originalActiveTask = controller.activeTask; const originalBounds = window.getBounds(); const screenshots = []; const managed = controller.github.managed;
  const A = 'A'.repeat(16), B = 'B'.repeat(16), repository = 'quickdeploy-fixture/managed';
  const now = new Date().toISOString(), today = businessDate(), yesterday = businessDate(Date.now() - 86400000);
  const config = normalizeManifest({ schemaVersion: 1, accounts: [{ accountKey: A }, { accountKey: B }], time: '12:30', exchangePlan: 'plan500' });
  config.accounts[0].times = ['12:30', '18:37', '22:13'];
  const rowA = { repository, accountKey: A, email: 'active@example.invalid', settings: config.accounts[0],
    result: { outcome: 'checked', checkinConfirmed: true, checkinBusinessDate: today, businessDate: today, checkinConfirmedAt: now, observedAt: now, exchange: 'not_needed' },
    details: { points: 411, leftDays: 90, pointsAdded: 11, observedAt: now, businessDate: today }, dailyCredit: { day: today, pointsAdded: 11 } };
  const rowB = { repository, accountKey: B, email: 'pending@example.invalid', settings: config.accounts[1],
    result: { outcome: 'checked', checkinConfirmed: true, checkinBusinessDate: yesterday, businessDate: yesterday, observedAt: now, exchange: 'not_needed' },
    details: { points: 499, leftDays: 50, pointsAdded: 10, observedAt: now, businessDate: yesterday } };
  const checks = []; const deadline = Date.now() + 40000;
  const evaluate = (fn, arg) => window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`);
  async function until(predicate, label) {
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Management renderer timed out: ' + label);
  }
  function check(condition, label) { assert.ok(condition, label); checks.push(label); }
  async function stable() { await until(() => evaluate(() => !document.getElementById('mg-checkin-all').disabled), 'buttons ready'); }
  async function navigate(page) {
    await evaluate(page => document.querySelector('[data-page="' + page + '"]').click(), page);
    await until(() => evaluate(page => !document.getElementById('page-' + page).hidden, page), 'navigate ' + page);
    check(await evaluate(page => [...document.querySelectorAll('[data-page-panel]')].every(panel => panel.hidden === (panel.dataset.pagePanel !== page)) && document.querySelector('[aria-current=page]').dataset.page === page, page), 'Navigation isolates page ' + page);
    check(await evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2 && [...document.querySelectorAll('.main-content,.page-content,.mg-card,.mg-toolbar,.mg-repository,.mg-upgrade-panel')].every(element => element.scrollWidth <= element.clientWidth + 2)), 'No horizontal overflow on page ' + page);
  }
  async function expose(selector) {
    await evaluate(selector => {
      const target = document.querySelector(selector); const page = target?.closest('[data-page-panel]');
      if (page?.hidden) document.querySelector('[data-page="' + page.dataset.pagePanel + '"]').click();
      for (let parent = target?.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) parent.querySelector(':scope > summary').click();
    }, selector);
    await until(() => evaluate(selector => Boolean(document.querySelector(selector)?.getClientRects().length), selector), 'visible ' + selector);
  }
  async function screenshot(filename) {
    if (!outputDirectory) return;
    fs.mkdirSync(outputDirectory, { recursive: true });
    const { captureSmokePage } = require('./smoke-capture.cjs');
    fs.writeFileSync(path.join(outputDirectory, filename), (await captureSmokePage(window, { label: filename })).toPNG()); screenshots.push(filename);
  }
  async function click(selector, expectedName, expectedPayload = {}) {
    await expose(selector); await stable(); const offset = actions.length;
    await evaluate(s => document.querySelector(s).click(), selector);
    await until(() => actions.length > offset, expectedName); await stable();
    assert.deepEqual(actions.slice(offset), [{ name: expectedName, payload: expectedPayload }]); checks.push('IPC ' + expectedName);
  }
  try {
    controller.github.managed = { version: 1, operations: {}, history: [], repositories: {
      [repository]: { repository, branch: 'main', configDigest: 'fixture-digest', schemaVersion: 2, upgraded: true, config,
        nativeRetentionDays: 3, actionsEnabled: true, workflows: [], lastScheduledRun: null, maintenance: {} },
    }, accounts: { [repository + '/' + A]: rowA, [repository + '/' + B]: rowB } };
    window.setContentSize(1320, 860);
    controller.state = { ...original, busy: false, stage: 'idle', actionScope: 'management', message: '', authCode: null,
      feedback: { deployment: { stage: 'idle', message: '', error: '', errorInfo: null, progress: { completed: [], current: null }, currentRun: null, activeTaskId: '', busy: false } }, github: { login: 'quickdeploy-fixture', id: 99 }, error: '', errorInfo: null,
      accounts: [{ accountKey: A, email: rowA.email, repository }, { accountKey: B, email: rowB.email, repository }], resumeTasks: [], activeTaskId: '' };
    controller.changed();
    await until(() => evaluate(() => document.querySelectorAll('.mg-card').length === 2), 'two managed cards');
    await navigate('accounts');
    check(await evaluate(() => ['全部签到','更新账号信息','读取已有结果','编辑所选账号'].every((label, i) => document.getElementById(['mg-checkin-all','mg-status-all','mg-refresh','mg-edit-selected'][i]).textContent === label)), 'Primary account actions have distinct user-facing labels');
    await screenshot('accounts-page.png');
    const inspection = await evaluate(({ A, B }) => {
      const a = document.querySelector('[data-mg-account="' + A + '"]'); const b = document.querySelector('[data-mg-account="' + B + '"]');
      return { count: document.getElementById('mg-count').textContent, a: a.innerText, b: b.innerText,
        statusA: a.querySelector('.mg-badge').textContent, statusB: b.querySelector('.mg-badge').textContent,
        maintenance: document.getElementById('mg-repositories').textContent,
        width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 2 };
    }, { A, B });
    check(inspection.count === '2' && inspection.statusA === '今日签到成功', 'Today success is based on same-day receipt');
    check(inspection.statusB !== '今日签到成功' && inspection.b.includes('未获取'), 'Yesterday success and credit are not shown as today');
    check(inspection.a.includes('18:37') && inspection.a.includes('22:13') && inspection.a.includes('411'), 'Per-account multi-time settings and decrypted balances are visible');
    check(inspection.maintenance.includes('尚未观察到 schedule') && inspection.maintenance.includes('尚未运行'), 'Configured schedules and never-run maintenance do not pretend to be verified');
    check(inspection.maintenance.includes('最近读取为 3 天') && !inspection.overflow, 'Retention confirmation and layout fit the window');
    await navigate('deployment'); await screenshot('new-account-page.png');
    await navigate('maintenance'); await screenshot('settings-diagnostics-page.png');
    for (const [id, name] of [['mg-upgrade-all','manage.upgradeAll'],['mg-checkin-all','manage.checkinAll'],['mg-status-all','manage.statusAll'],['mg-refresh','manage.refresh'],['mg-details','manage.details']]) await click('#' + id, name);
    await navigate('accounts');
    controller.github.managed.batch = { requestId: 'b'.repeat(32), operation: 'checkin', repositories: [repository], index: 0, status: 'waiting', results: {} };
    controller.state.busy = true; controller.changed();
    await until(() => evaluate(() => document.getElementById('mg-stop-batch') && !document.getElementById('mg-stop-batch').disabled), 'stop control remains available while busy');
    check(await evaluate(() => document.getElementById('mg-checkin-all').disabled && !document.getElementById('mg-stop-batch').disabled), 'Busy batch blocks new dispatch but keeps the stop control available');
    const stopOffset = actions.length;
    await evaluate(() => document.getElementById('mg-stop-batch').click());
    await until(() => actions.length > stopOffset, 'stop batch IPC');
    assert.deepEqual(actions[stopOffset], { name: 'manage.stopBatch', payload: {} });
    checks.push('Stopping a busy batch uses its dedicated IPC action');
    controller.github.managed.batch.status = 'paused'; controller.state.busy = false; controller.changed();
    await until(() => evaluate(() => document.getElementById('mg-resume-batch') && !document.getElementById('mg-resume-batch').disabled), 'paused batch can be explicitly resumed');
    check(await evaluate(() => document.getElementById('mg-batch').textContent.includes('后台不会提交剩余任务')), 'Paused batch explains that remaining work will not resume in the background');
    await click('#mg-resume-batch', 'manage.resumeBatch');
    await click('#mg-end-batch', 'manage.endBatch');
    delete controller.github.managed.batch;
    const workflow = 'glados-quick-deploy.yml', nonce = 'c'.repeat(32);
    controller.github.managed.operations[repository + ':' + workflow] = { repository, workflow, nonce, operation: 'checkin', status: 'submitting', submittedAt: now };
    controller.changed();
    await until(() => evaluate(() => Boolean(document.querySelector('[data-mg-end-operation="glados-quick-deploy.yml"]'))), 'unconfirmed operation recovery control');
    await click('[data-mg-end-operation="glados-quick-deploy.yml"]', 'manage.endOperation', { repository, workflow, expectedNonce: nonce });
    delete controller.github.managed.operations[repository + ':' + workflow]; controller.changed(); await stable();
    await navigate('accounts');
    await evaluate(A => {
      [...document.querySelector('[data-mg-account="' + A + '"]').querySelectorAll('button')].find(x => x.textContent === '编辑设置').click();
    }, A);
    await until(() => evaluate(() => document.getElementById('mg-dialog').open), 'edit dialog');
    const offset = actions.length;
    await evaluate(() => {
      document.getElementById('mg-edit-times').value = '24:00';
      document.getElementById('mg-edit-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    check(await evaluate(() => document.getElementById('mg-dialog').open && document.getElementById('mg-edit-notice').textContent.includes('1–6')), 'Invalid multi-time input is rejected before IPC');
    check(actions.length === offset, 'Invalid form does not change any cloud account');
    await evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })));
    check(actions.length === offset, 'Keyboard shortcut in edit dialog cannot trigger new deployment');
    await evaluate(() => {
      document.getElementById('mg-edit-times').value = '12:30, 18:37, 22:13';
      document.getElementById('mg-edit-plan').value = 'off';
      document.getElementById('mg-edit-enabled').checked = false;
      document.getElementById('mg-edit-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await until(() => actions.length > offset, 'single-account edit IPC'); await stable();
    assert.deepEqual(actions[offset], { name: 'manage.edit', payload: { repository, keys: [A], expectedDigest: 'fixture-digest', patch: { times: ['12:30','18:37','22:13'], exchangePlan: 'off', enabled: false } } });
    checks.push('Single-account edit preserves account targeting and concurrent-edit digest');
    await evaluate(() => {
      for (const cb of document.querySelectorAll('.mg-card-head > input')) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      document.getElementById('mg-edit-selected').click();
    });
    await until(() => evaluate(() => document.getElementById('mg-dialog').open), 'batch edit dialog');
    const batchOffset = actions.length;
    await evaluate(() => document.getElementById('mg-edit-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => actions.length > batchOffset, 'batch edit IPC'); await stable();
    assert.deepEqual(actions[batchOffset].payload.keys, [A, B]); checks.push('Batch edit targets exactly selected accounts');
    await navigate('maintenance');
    await evaluate(() => [...document.querySelectorAll('.mg-repository button')].find(b => b.textContent === '维护设置').click());
    await until(() => evaluate(() => document.getElementById('mg-dialog').open), 'maintenance dialog');
    const maintenanceOffset = actions.length;
    await evaluate(() => {
      document.getElementById('mg-cleanup-time').value = '04:17';
      document.getElementById('mg-keepalive-enabled').checked = false;
      document.getElementById('mg-edit-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await until(() => actions.length > maintenanceOffset, 'maintenance IPC'); await stable();
    assert.deepEqual(actions[maintenanceOffset], { name: 'manage.maintenance', payload: { repository, expectedDigest: 'fixture-digest', maintenance: { cleanupTime: '04:17', cleanupEnabled: true, keepaliveEnabled: false } } });
    checks.push('Cleanup and keepalive changes use independent maintenance settings');
    await navigate('accounts'); await expose('[data-mg-account="' + A + '"] .mg-note-line input');
    const noteOffset = actions.length;
    await evaluate(A => {
      const card = document.querySelector('[data-mg-account="' + A + '"]'); card.querySelector('.mg-note-line input').value = 'fixture note';
      [...card.querySelectorAll('button')].find(b => b.textContent === '保存备注').click();
    }, A);
    await until(() => actions.length > noteOffset, 'note IPC'); await stable();
    assert.deepEqual(actions[noteOffset], { name: 'manage.note', payload: { repository, accountKey: A, note: 'fixture note' } });
    checks.push('Local notes do not trigger deployment or check-in');
    await evaluate(A => {
      const note = document.querySelector('[data-mg-account="' + A + '"] .mg-note-line input');
      note.value = 'unsaved note survives'; note.dispatchEvent(new Event('input', { bubbles: true }));
    }, A);
    controller.github.managed.accounts[repository + '/' + A].details.points = 412;
    controller.changed(); await stable();
    check(await evaluate(A => document.querySelector('[data-mg-account="' + A + '"] .mg-note-line input').value === 'unsaved note survives', A), 'Background account updates preserve unsaved note drafts');
    controller.state.busy = true; controller.changed();
    await until(() => evaluate(() => document.getElementById('mg-checkin-all').disabled), 'busy guard');
    const busyOffset = actions.length; await evaluate(() => document.getElementById('mg-checkin-all').click());
    check(actions.length === busyOffset, 'Busy state prevents a second all-account dispatch');
    controller.state.busy = false;
    controller.github.managed.accounts[repository + '/' + A].note = '<img src=x onerror=alert(1)>';
    controller.changed(); await stable();
    await until(() => evaluate(() => [...document.querySelectorAll('.mg-card h3')].some(h => h.textContent.includes('<img src=x'))), 'untrusted note rendered as text');
    check(await evaluate(() => !document.querySelector('.mg-card h3 img')), 'Account notes are text, not executable markup');
    controller.github.managed.accounts[repository + '/' + A].note = '';
    const repositoryRow = controller.github.managed.repositories[repository];
    const retentionError = new GitHubError('GITHUB_UNAVAILABLE', '配置已一致，后续核验待完成。', 'upgrade-retention', {
      httpStatus: 503, exitCode: 1, reason: 'service_unavailable', method: 'GET', endpointKind: 'actions-retention',
    });
    const diagnostic = safeGitHubDiagnostic(retentionError);
    const progress = { stage: 'retention', configurationVerified: true, maintenanceVerified: false, commitSha: 'c'.repeat(40) };
    repositoryRow.upgradeVerifiedAt = '2026-10-01T00:00:00Z';
    repositoryRow.upgradeAttempt = { attemptId: 'd'.repeat(32), startedAt: now, updatedAt: now, status: 'pending', ...progress, diagnostic };
    controller.github.managed.upgrade = { observedAt: now, completed: [], failed: [{ repository, message: retentionError.message, code: retentionError.code, upgradeProgress: { ...progress }, diagnostic }] };
    controller.github.managed.batch = { requestId: 'e'.repeat(32), operation: 'checkin', repositories: [repository], index: 1, status: 'completed', results: {
      [repository]: { code: 'GITHUB_COMMAND_FAILED', error: 'GitHub 操作未完成，请重试或重新授权。' },
    } };
    controller.changed(); await stable();
    await until(() => evaluate(() => document.querySelector('[data-mg-upgrade-progress]')?.textContent.includes('配置已核对')), 'partial upgrade stage');
    await navigate('maintenance');
    const failureInspection = await evaluate(() => ({
      progress: document.querySelector('[data-mg-upgrade-progress]').textContent,
      summary: document.getElementById('mg-upgrade-status').textContent,
      diagnostics: [...document.querySelectorAll('[data-mg-diagnostic]')].map(x => x.textContent).join('\n'),
      legacy: document.getElementById('mg-batch-controls').textContent,
      copyButtons: document.querySelectorAll('[data-mg-copy-diagnostic]').length,
      overflow: document.documentElement.scrollWidth > innerWidth + 2,
    }));
    check(failureInspection.progress.includes('配置已核对，后续检查待完成') && !failureInspection.progress.includes('已全部核对') && failureInspection.summary.includes('全部核对 0 个仓库'), 'Current partial upgrade cannot inherit an old successful verification timestamp');
    check(failureInspection.diagnostics.includes('环节：核对保留期') && failureInspection.diagnostics.includes('HTTP：503') && failureInspection.diagnostics.includes('CLI 退出码：1') && failureInspection.diagnostics.includes('actions-retention'), 'Failed maintenance displays the actual safe phase, HTTP status and CLI exit code');
    check(failureInspection.copyButtons >= 1 && !failureInspection.overflow, 'Safe diagnostics can be copied and fit the native window');
    check(failureInspection.legacy.includes('具体原因未记录') && !failureInspection.legacy.includes('重新授权'), 'Legacy generic errors do not invent a cause or recommend reauthorization');
    diagnostic.raw = 'diagnostic-raw-must-not-render'; diagnostic.body = 'diagnostic-body-must-not-render'; diagnostic.url = 'https://private.example.invalid/secret';
    controller.changed(); await stable();
    check(await evaluate(() => !/diagnostic-raw-must-not-render|diagnostic-body-must-not-render|private\.example/.test(document.querySelector('.page-content').textContent)), 'Diagnostic rendering ignores raw response, body and URL fields');
    delete diagnostic.raw; delete diagnostic.body; delete diagnostic.url;
    repositoryRow.upgradeAttempt = { ...repositoryRow.upgradeAttempt, stage: 'inspect', configurationVerified: false, diagnostic: safeGitHubDiagnostic(new GitHubError('NETWORK_ERROR', '连接中断。', 'upgrade-inspect', { reason: 'network_eof' })) };
    controller.github.managed.upgrade.failed[0].upgradeProgress = { stage: 'inspect', configurationVerified: false, maintenanceVerified: false };
    controller.changed(); await stable();
    await until(() => evaluate(() => document.querySelector('[data-mg-upgrade-progress]').textContent.includes('本次尚未更新配置')), 'unmodified configuration phase');
    check(await evaluate(() => document.querySelector('[data-mg-upgrade-progress]').textContent.includes('本次尚未更新配置')), 'Failure before configuration work is distinct from verified configuration with pending maintenance');
    repositoryRow.upgradeAttempt = { ...repositoryRow.upgradeAttempt, stage: 'commit' };
    controller.changed(); await stable();
    await until(() => evaluate(() => document.querySelector('[data-mg-upgrade-progress]').textContent.includes('配置结果待核实')), 'unverified configuration phase');
    check(await evaluate(() => document.querySelector('[data-mg-upgrade-progress]').textContent.includes('配置结果待核实')), 'An unverified commit response is not mislabeled as no change');
    repositoryRow.upgradeAttempt = { ...repositoryRow.upgradeAttempt, ...progress, diagnostic, interrupted: true };
    controller.changed(); await stable();
    await until(() => evaluate(() => document.querySelector('[data-mg-upgrade-progress]').textContent.includes('上次升级中断，待重新核对')), 'interrupted configuration phase');
    check(await evaluate(() => document.querySelector('[data-mg-upgrade-progress]').textContent.includes('上次升级中断，待重新核对')), 'A recovered interrupted upgrade is not shown as background execution');
    delete repositoryRow.upgradeAttempt.interrupted;
    controller.github.managed.upgrade.failed[0].upgradeProgress = { ...progress };
    controller.github.managed.lastFailure = { action: 'manage.statusAll', observedAt: now, message: 'GitHub 命令未完成，原因尚未确定。', diagnostic: safeGitHubDiagnostic(new GitHubError('GITHUB_COMMAND_FAILED', '未知命令错误。', 'identity', { exitCode: 1, reason: 'cli_failed' })) };
    controller.changed(); await stable();
    await until(() => evaluate(() => !document.getElementById('mg-last-failure').hidden), 'retained preflight failure');
    check(await evaluate(() => !document.getElementById('mg-last-failure').hidden && document.getElementById('mg-last-failure').textContent.includes('确认 GitHub 身份')), 'Preflight failures remain visible with safe diagnostics even before a batch exists');
    controller.github.managed.lastFailure.resolvedAt = now; controller.changed(); await stable();
    await until(() => evaluate(() => document.getElementById('mg-last-failure').hidden), 'resolved failure hidden');
    check(await evaluate(() => document.getElementById('mg-last-failure').hidden), 'A successfully resolved failure remains recorded without appearing as a current error');
    const readDiagnostic = safeGitHubDiagnostic(new GitHubError('NETWORK_ERROR', '结果读取中断。', 'results', { reason: 'network_eof', exitCode: 1, method: 'GET', endpointKind: 'actions-artifacts' }));
    controller.github.managed.batch.results[repository] = { observationPending: true, diagnostic: readDiagnostic, operationProgress: { submission: 'accepted', stage: 'receipts', runId: 901, runStatus: 'completed', runConclusion: 'success', resultVerified: false, detailsVerified: false } };
    controller.changed();
    await until(() => evaluate(() => document.getElementById('mg-batch-controls').textContent.includes('云端运行已结束，账号结果待确认')), 'completed cloud task pending app readback');
    await navigate('accounts');
    check(await evaluate(() => !document.getElementById('mg-batch-controls').textContent.includes('重新授权') && document.getElementById('mg-batch-controls').textContent.includes('不重复提交')), 'Accepted cloud work awaiting results is not rendered as a failed submission');
    controller.github.managed.batch.results[repository].operationProgress.runStatus = 'in_progress';
    controller.changed();
    await until(() => evaluate(() => document.getElementById('mg-batch-controls').textContent.includes('云端正在执行')), 'active cloud task');
    checks.push('Known active cloud work remains distinct from completed work awaiting account results');
    controller.github.managed.batch.results[repository].operationProgress = { submission: 'uncertain', stage: 'dispatch', resultVerified: false, detailsVerified: false };
    controller.changed();
    await until(() => evaluate(() => document.getElementById('mg-batch-controls').textContent.includes('提交结果待确认')), 'uncertain submission');
    checks.push('Uncertain submission is not mislabeled as accepted or successful');

    controller.state.feedback.deployment = { stage: 'awaiting_result', message: '部署原运行保留，结果待确认。', error: '部署结果暂未读回。', errorInfo: { severity: 'warning', stage: 'results', message: '部署结果暂未读回。', diagnostic: readDiagnostic }, progress: { completed: [0,1,2], current: 3 }, currentRun: { status: 'in_progress', repository, runId: 901 }, activeTaskId: '', busy: false };
    controller.state.actionScope = 'maintenance'; controller.state.stage = 'error'; controller.state.message = '维护阶段读取失败。'; controller.state.error = '维护阶段读取失败。'; controller.state.errorInfo = { code: 'GITHUB_UNAVAILABLE', message: '维护阶段读取失败。', diagnostic };
    controller.changed();
    await until(() => evaluate(() => document.getElementById('maintenance-notice').textContent.includes('维护阶段读取失败')), 'maintenance scoped feedback');
    await navigate('deployment');
    check(await evaluate(() => document.getElementById('overview-text').textContent === '结果待确认' && document.getElementById('error-banner').classList.contains('is-warning') && document.getElementById('progress-message').textContent === '部署原运行保留，结果待确认。' && !document.getElementById('page-deployment').innerText.includes('维护阶段读取失败')), 'Deployment preserves its own pending progress while maintenance fails on another page');
    check(await evaluate(() => document.getElementById('error-diagnostic-text').textContent.includes('network_eof')), 'Deployment pending-result warning exposes only safe diagnostic fields');
    await screenshot('new-account-pending-result.png');
    await navigate('accounts');
    check(await evaluate(() => !document.getElementById('page-accounts').innerText.includes('维护阶段读取失败') && !document.getElementById('page-accounts').innerText.includes('部署结果暂未读回')), 'Account page is isolated from deployment and maintenance errors');

    controller.state.actionScope = 'management'; controller.state.stage = 'github_auth'; controller.state.authCode = { code: 'DEMO-CODE' }; controller.state.busy = true; controller.state.error = ''; controller.state.errorInfo = null; controller.state.message = '请完成 GitHub 授权。';
    controller.changed();
    await until(() => evaluate(() => document.getElementById('auth-code').textContent === 'DEMO-CODE' && document.getElementById('github-auth').getClientRects().length), 'management authorization visible');
    check(await evaluate(() => document.getElementById('github-auth').closest('[data-page-panel]').dataset.pagePanel === 'accounts' && document.getElementById('page-deployment').hidden), 'Management authorization code remains visible on the initiating page');
    controller.state.actionScope = 'maintenance'; controller.state.authCode = { code: 'NEXT-CODE' }; controller.changed();
    await until(() => evaluate(() => document.getElementById('auth-code').textContent === 'NEXT-CODE' && document.getElementById('github-auth').getClientRects().length), 'maintenance authorization visible');
    check(await evaluate(() => document.getElementById('github-auth').closest('[data-page-panel]').dataset.pagePanel === 'maintenance'), 'Maintenance authorization is not hidden on the new-account page');
    controller.state.authCode = null; controller.state.busy = false; controller.state.stage = 'error'; controller.state.error = ''; controller.state.message = ''; controller.changed(); await stable();
    await navigate('maintenance');
    await evaluate(() => { document.querySelector('#mg-upgrade-status .diagnostic-details')?.querySelector('summary').click(); });
    await screenshot('settings-failure-phase.png');

    // Updating an existing login is a management operation. Closing it before
    // any cloud update preserves the account and never becomes a new deployment.
    controller.github.managed.batch = null;
    controller.github.managed.lastFailure = null; controller.github.managed.lastPending = null;
    controller.state = { ...controller.state, busy: false, stage: 'idle', actionScope: 'management', message: '', error: '', errorInfo: null, authCode: null,
      activeTaskId: '', resumeTasks: [],
      accounts: [{ accountKey: A, email: rowA.email, repository, deploymentStatus: 'deployed', status: 'completed', conclusion: 'checkin_success', runId: 902, runUrl: 'https://github.com/' + repository + '/actions/runs/902' }],
      feedback: { deployment: { stage: 'idle', message: '新账号部署准备就绪。', error: '', errorInfo: null, progress: { completed: [], current: null }, currentRun: null, activeTaskId: '', busy: false } } };
    controller.changed(); await stable(); await navigate('accounts');
    await click('[data-mg-account="' + A + '"] [data-mg-action="reloginAccount"]', 'reloginAccount', { accountKey: A });
    check(await evaluate(() => !document.getElementById('page-accounts').hidden && document.getElementById('page-deployment').hidden), 'Updating an existing login remains on the account management page');
    const loginTask = { id: 'd'.repeat(32), purpose: 'login_update', loginUpdateStage: 'local', accountKey: A, email: rowA.email, repository,
      browserId: 'embedded', phase: 'browser_login', githubLogin: 'quickdeploy-fixture', settings: { repoName: 'managed', exchangePlan: 'plan500', time: '12:30' },
      needsLogin: true, canResume: true, savedAcrossRestart: false, actionLabel: '重新打开登录窗口' };
    controller.activeTask = loginTask; controller.state.resumeTasks = [loginTask]; controller.state.activeTaskId = loginTask.id; controller.state.busy = true; controller.state.stage = 'browser_login'; controller.state.message = '请在专用窗口完成新登录；关闭窗口可取消本次更新。';
    controller.changed();
    await until(() => evaluate(() => !document.getElementById('mg-login-update-panel').hidden), 'login update panel visible');
    check(await evaluate(A => document.querySelector('[data-mg-account="' + A + '"] .mg-badge').textContent === '今日签到成功' && document.getElementById('resume-panel').hidden && document.getElementById('resume-count').textContent === '0', A), 'Pending login update preserves today success and is excluded from new-account recovery');
    check(await evaluate(() => !document.querySelector('[data-mg-cancel-login]').disabled && document.getElementById('mg-checkin-all').disabled), 'Login update cancellation remains available while conflicting account actions are blocked');
    await screenshot('existing-account-login-update.png');
    const cancelOffset = actions.length;
    await evaluate(() => document.querySelector('[data-mg-cancel-login]').click());
    await until(() => actions.length > cancelOffset, 'cancel login update IPC');
    assert.deepEqual(actions.slice(cancelOffset), [{ name: 'cancel', payload: { taskId: loginTask.id } }]); checks.push('Cancelling login update emits only the task-bound cancel action');
    controller.activeTask = null; controller.state.resumeTasks = []; controller.state.activeTaskId = ''; controller.state.busy = false; controller.state.stage = 'cancelled'; controller.state.error = ''; controller.state.errorInfo = null; controller.state.message = '已取消更新登录，原账号与定时任务保持原状。';
    controller.changed(); await stable();
    await until(() => evaluate(() => document.getElementById('mg-login-update-panel').hidden && document.getElementById('mg-notice').textContent.includes('已取消更新登录')), 'cancelled login update clears its task');
    check(await evaluate(A => !document.getElementById('mg-notice').classList.contains('is-error') && document.getElementById('error-banner').hidden && document.getElementById('resume-panel').hidden && document.querySelector('[data-mg-account="' + A + '"] .mg-badge').textContent === '今日签到成功', A), 'Cancelled login update has a neutral explanation, no new-account warning, and retains the account result');
    await screenshot('existing-account-login-cancelled.png');
    controller.state.resumeTasks = [{ ...loginTask, loginUpdateStage: 'remote_started', phase: 'verifying', resultPending: true }]; controller.state.activeTaskId = loginTask.id; controller.state.stage = 'awaiting_result'; controller.state.message = '登录更新已开始提交，结果仍待核对。';
    controller.changed();
    await until(() => evaluate(() => document.getElementById('mg-login-update-panel').textContent.includes('登录更新结果待核对')), 'remote login update pending');
    check(await evaluate(() => !document.getElementById('mg-login-update-panel').textContent.includes('原账号与定时任务保持原状') && !document.querySelector('[data-mg-discard-login]') && document.querySelector('[data-mg-resume-login]').textContent === '继续完成登录更新' && document.getElementById('resume-panel').hidden), 'Uncertain remote login update retains management recovery without claiming no change or exposing a local discard');
    controller.state.busy = true; controller.state.stage = 'deploying'; controller.state.message = '正在读取已有结果。'; controller.changed();
    await until(() => evaluate(() => document.getElementById('mg-refresh').disabled), 'unrelated management action busy');
    check(await evaluate(() => !document.querySelector('[data-mg-cancel-login]') && document.getElementById('mg-login-update-panel').textContent.includes('登录更新结果待核对')), 'A selected saved login update cannot impersonate or cancel an unrelated management action');
    controller.state.busy = false; controller.state.stage = 'awaiting_result'; controller.changed(); await stable();
    await click('[data-mg-resume-login]', 'resumeDeploy', { taskId: loginTask.id });
    check(await evaluate(() => !document.getElementById('page-accounts').hidden && document.getElementById('page-deployment').hidden), 'Resuming a remote login update stays on the management page');
    const sharedMessage = '连接暂时无法核对。';
    controller.state.resumeTasks = []; controller.state.activeTaskId = ''; controller.state.stage = 'error'; controller.state.error = sharedMessage;
    controller.state.errorInfo = { message: sharedMessage, hint: '请在对应账号继续更新登录。', diagnostic: readDiagnostic };
    for (const retained of [{ action: 'manage.statusAll', resolvedAt: now }, { action: 'manage.maintenance' }]) {
      controller.github.managed.lastFailure = { ...retained, message: sharedMessage, observedAt: now, diagnostic };
      controller.changed();
      await until(() => evaluate(() => document.getElementById('mg-last-failure').textContent.includes('actions-artifacts')), 'current login diagnostic not hidden by history');
      check(await evaluate(() => document.getElementById('mg-notice').textContent.includes('请在对应账号继续更新登录。') && document.getElementById('mg-last-failure').textContent.includes('actions-artifacts')), 'Current login diagnostics survive ' + (retained.resolvedAt ? 'resolved same-page history' : 'unrelated maintenance history') + ' with the same message');
    }
    return { ok: true, checks, fixtureAccounts: 2, noCloudWrites: true, screenshots };
  } finally { controller.github.managed = managed; controller.activeTask = originalActiveTask; controller.state = original; controller.changed(); if (!window.isDestroyed()) window.setBounds(originalBounds); }
}
module.exports = { runManagementRendererRegression };
