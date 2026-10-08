'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// This runs only inside the packaged, offline smoke process. The caller replaces
// controller.action before loading the renderer; every UI action is a recorder.
async function runRendererRegression({ window, controller, uiFile, actions, outputDirectory }) {
  if (!process.argv.includes('--smoke-test')) throw new Error('Renderer fixtures are available only in smoke-test mode');
  assert.ok(Array.isArray(actions), 'Smoke actions must use an isolated recorder');
  const started = Date.now();
  const deadline = started + 8000;
  const checks = [];
  const screenshots = [];
  const originalState = controller.snapshot();
  const originalBounds = window.getBounds();
  const actionOffset = actions.length;

  async function within(promise, label) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      Promise.resolve(promise).catch(() => {});
      throw new Error('Renderer smoke time budget exceeded: ' + label);
    }
    let timeout;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Renderer smoke timed out: ' + label)), remaining); }),
      ]);
    } finally { clearTimeout(timeout); }
  }

  function evaluate(fn, argument) {
    return within(window.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(argument ?? null) + ')'), 'renderer evaluation');
  }

  async function waitFor(condition, label) {
    while (Date.now() < deadline) {
      const result = await within(Promise.resolve().then(condition), label);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
    }
    throw new Error('Renderer smoke timed out: ' + label);
  }

  function check(condition, label) {
    assert.ok(condition, label);
    checks.push(label);
  }

  async function clickAction(selector, name, payload, formValues) {
    await waitFor(() => evaluate(selector => {
      const button = document.querySelector(selector);
      return Boolean(button && !button.disabled && button.getClientRects().length);
    }, selector), 'enabled ' + selector);
    const offset = actions.length;
    await evaluate(({ selector, formValues }) => {
      if (formValues) {
        for (const [id, value] of Object.entries(formValues)) document.getElementById(id).value = value;
        document.getElementById('schedule-input').dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector(selector).click();
    }, { selector, formValues });
    await waitFor(() => actions.length > offset, 'IPC action ' + name);
    await waitFor(() => evaluate(() => !document.getElementById('deploy-button').disabled), 'UI action completion');
    const emitted = actions.slice(offset);
    assert.deepEqual(emitted, [{ name, payload }], selector + ' must send only the intended IPC action and payload');
    checks.push('IPC ' + selector + ' → ' + name);
  }

  async function screenshot(filename) {
    if (!outputDirectory) return;
    fs.mkdirSync(outputDirectory, { recursive: true });
    const capture = await within(window.webContents.capturePage(), 'capture ' + filename);
    fs.writeFileSync(path.join(outputDirectory, filename), capture.toPNG());
    screenshots.push(filename);
  }

  const taskA = {
    id: 'a'.repeat(32), accountKey: 'A'.repeat(16), email: 'pending.one@example.invalid',
    repository: 'quickdeploy-fixture/saved-account-one', githubLogin: 'quickdeploy-fixture', browserId: 'embedded',
    phase: 'deploying', settings: { repoName: 'saved-account-one', exchangePlan: 'plan100', time: '07:45' },
    updatedAt: '2026-10-07T09:10:00.000Z', errorCode: 'WORKFLOW_AUTH_REQUIRED', lastError: 'GitHub 需要补充工作流授权。',
    needsLogin: false, canResume: true, savedAcrossRestart: true, actionLabel: '补充 GitHub 授权并继续',
  };
  const taskB = {
    id: 'b'.repeat(32), accountKey: 'B'.repeat(16), email: 'pending.two@example.invalid',
    repository: 'quickdeploy-fixture/saved-account-two', githubLogin: 'quickdeploy-fixture', browserId: 'brave',
    phase: 'browser_login', settings: { repoName: 'saved-account-two', exchangePlan: 'plan200', time: '06:10' },
    updatedAt: '2026-10-07T09:05:00.000Z', errorCode: '', lastError: '',
    needsLogin: true, canResume: true, savedAcrossRestart: true, actionLabel: '重新登录并继续',
  };
  const deployedKey = 'C'.repeat(16);
  const fixture = {
    ...originalState,
    busy: false, stage: 'resume_available', activeTaskId: taskA.id,
    github: { login: 'quickdeploy-fixture', name: '界面验证账号' },
    browsers: [
      { id: 'brave', name: 'Brave', family: 'chromium', available: true, details: '烟雾测试用登录方式，不会启动浏览器。' },
      { id: 'embedded', name: '内置登录窗口', family: 'electron', available: true, details: '随软件提供。' },
    ],
    selectedBrowser: 'brave', settings: { repoName: 'new-account-default', exchangePlan: 'plan500', time: '09:30' },
    authCode: null, currentRun: null, storageWarning: '',
    message: '已恢复 2 个未完成任务，可接续此前进度。',
    error: taskA.lastError,
    errorInfo: { code: 'WORKFLOW_AUTH_REQUIRED', stage: 'deploying', message: taskA.lastError, hint: 'GLaDOS 登录已保留，补充 GitHub 授权后继续。', taskId: taskA.id, action: 'resumeDeploy', actionLabel: taskA.actionLabel },
    progress: { completed: [0, 1], current: 2 },
    // Put the active task second so startup must honor activeTaskId.
    resumeTasks: [taskB, taskA],
    accounts: [
      { accountKey: taskA.accountKey, email: taskA.email, browser: 'embedded', repository: taskA.repository, pendingTaskId: taskA.id, deploymentStatus: 'pending', status: 'not_started', conclusion: 'not_started', paused: false, updatedAt: taskA.updatedAt },
      { accountKey: taskB.accountKey, email: taskB.email, browser: 'brave', repository: taskB.repository, pendingTaskId: taskB.id, deploymentStatus: 'pending', status: 'not_started', conclusion: 'not_started', paused: false, updatedAt: taskB.updatedAt },
      { accountKey: deployedKey, email: 'checked.account@example.invalid', browser: 'embedded', repository: 'quickdeploy-fixture/deployed-account', deploymentStatus: 'deployed', pendingTaskId: '', status: 'completed', conclusion: 'already_checked_in', pointsAdded: 0, message: '上次已确认今日签到。', runId: 300, runUrl: 'https://example.invalid/runs/300', paused: false, updatedAt: '2026-10-07T09:30:00.000Z', lastRefreshError: '网络暂不可用，保留上次结果。' },
    ],
    events: [{ time: '2026-10-07T09:30:00.000Z', level: 'warning', message: '界面夹具：所有登录和云端操作均由记录器替代。' }],
  };

  try {
    // An unknown action is harmless even if caller isolation is accidentally absent.
    // The recorded round trip proves the real preload/IPC route uses the recorder.
    const probe = '__renderer_smoke_probe';
    await evaluate(name => window.quickDeploy.action(name, { fixture: true }), probe);
    assert.deepEqual(actions.slice(actionOffset), [{ name: probe, payload: { fixture: true } }], 'Smoke must intercept actions before any UI fixture clicks');
    checks.push('Real preload/IPC action path is isolated');

    controller.state = fixture;
    controller.changed();
    window.setContentSize(1000, 760);
    await within(window.loadFile(uiFile), 'reopen renderer with saved tasks');
    await waitFor(() => evaluate(() => document.getElementById('accounts-count')?.textContent === '3' && document.getElementById('resume-count')?.textContent === '2'), 'fixture state loaded');

    const restored = await evaluate(() => {
      const get = id => document.getElementById(id);
      const fields = ['browser-select', 'repository-input', 'exchange-select', 'schedule-input'];
      return {
        selected: get('resume-select').value,
        frozen: fields.every(id => get(id).disabled),
        values: fields.map(id => get(id).value),
        recoveryVisible: !get('resume-panel').hidden && !get('error-banner').hidden && !get('error-action').hidden,
        label: get('deploy-button-label').textContent,
        completed: [...get('progress-steps').children].filter(item => item.classList.contains('is-done')).map(item => Number(item.dataset.step)),
        controls: ['add-account', 'refresh-all', 'resume-task-button', 'discard-resume'].every(id => get(id).getClientRects().length && !get(id).disabled),
      };
    });
    check(restored.selected === taskA.id, 'Reopen selects the active saved task');
    check(restored.frozen && JSON.stringify(restored.values) === JSON.stringify(['embedded', 'saved-account-one', 'plan100', '07:45']), 'Recovery form displays frozen task settings');
    check(restored.recoveryVisible && restored.label === taskA.actionLabel && restored.controls, 'Repair, resume, add-account and refresh-all controls are available');
    assert.deepEqual(restored.completed, [0, 1]);
    checks.push('Progress displays controller-provided completed steps');
    await screenshot('recovery-smoke.png');

    await clickAction('#error-action', 'resumeDeploy', { taskId: taskA.id });
    await clickAction('#resume-task-button', 'resumeDeploy', { taskId: taskA.id });
    await clickAction('#deploy-button', 'resumeDeploy', { taskId: taskA.id });

    controller.state.error = '';
    controller.state.errorInfo = null;
    controller.changed();
    await waitFor(() => evaluate(() => document.getElementById('error-banner').hidden), 'clear fixture error');
    await evaluate(id => {
      const select = document.getElementById('resume-select');
      select.value = id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, taskB.id);
    const switched = await evaluate(() => ({
      repository: document.getElementById('repository-input').value,
      time: document.getElementById('schedule-input').value,
      frozen: document.getElementById('repository-input').disabled,
      staleProgressHidden: document.getElementById('progress-steps').hidden && document.getElementById('current-run').hidden,
    }));
    check(switched.repository === taskB.settings.repoName && switched.time === taskB.settings.time && switched.frozen, 'Changing pending task changes only its saved settings');
    check(switched.staleProgressHidden, 'Another task cannot inherit the active task progress');
    await clickAction('#resume-task-button', 'resumeDeploy', { taskId: taskB.id });
    await clickAction('[data-action="resumeDeploy"][data-account-key="' + taskB.accountKey + '"]', 'resumeDeploy', { taskId: taskB.id });

    const beforeAdd = actions.length;
    await evaluate(() => document.getElementById('add-account').click());
    const newMode = await evaluate(() => ({
      label: document.getElementById('deploy-button-label').textContent,
      repository: document.getElementById('repository-input').value,
      editable: !document.getElementById('repository-input').disabled && !document.getElementById('browser-select').disabled,
      pending: document.getElementById('resume-count').textContent,
    }));
    check(newMode.label === '添加并部署账号' && newMode.repository === fixture.settings.repoName && newMode.editable && newMode.pending === '2' && actions.length === beforeAdd, 'Adding an account preserves pending tasks and opens the separate new form');
    await clickAction('#deploy-button', 'startDeploy', { browserId: 'brave', repoName: 'fixture-new-account', exchangePlan: 'off', time: '11:35', newTask: true }, {
      'browser-select': 'brave', 'repository-input': 'fixture-new-account', 'exchange-select': 'off', 'schedule-input': '11:35',
    });
    await clickAction('[data-action="reloginAccount"][data-account-key="' + deployedKey + '"]', 'reloginAccount', { accountKey: deployedKey, browserId: 'embedded' });
    await clickAction('#refresh-all', 'refreshAll', {});

    const accountInspection = await evaluate(key => {
      const card = document.querySelector('.account-card[data-account-key="' + key + '"]');
      const allCards = [...document.querySelectorAll('.account-card')];
      const selector = '.main-content, .page-content, .resume-panel, .account-card';
      const overflowing = [...document.querySelectorAll(selector)].filter(element => element.scrollWidth > element.clientWidth + 2).map(element => element.className);
      const importantButtons = [...document.querySelectorAll('.account-action.is-primary')];
      return {
        cards: allCards.length,
        previousResult: card.querySelector('.account-status').textContent,
        refreshError: card.querySelector('.account-refresh-error')?.textContent || '',
        errorCount: document.querySelectorAll('.account-refresh-error').length,
        importantButtons: importantButtons.length,
        labelsVisible: importantButtons.every(button => button.querySelector('.account-primary-label')?.getClientRects().length && button.getClientRects().length),
        sharedPause: card.querySelector('[data-action="pause"]')?.getAttribute('aria-label') || '',
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2 || overflowing.length > 0,
        overflowing,
        viewport: { width: innerWidth, height: innerHeight },
      };
    }, deployedKey);
    check(accountInspection.cards === 3 && accountInspection.importantButtons === 5 && accountInspection.labelsVisible, 'All account cards expose readable continue or update-login buttons');
    check(accountInspection.previousResult.includes('上次结果：今日已签到') && accountInspection.refreshError.includes('刷新暂未完成：') && accountInspection.errorCount === 1, 'Refresh failure is local to its card and retains an explicitly previous result');
    check(accountInspection.sharedPause.includes('此账号签到'), 'Pause control explicitly names only this account');
    check(!accountInspection.horizontalOverflow && accountInspection.viewport.width === 1000 && accountInspection.viewport.height === 760, '1000×760 renderer has no horizontal overflow: ' + accountInspection.overflowing.join(', '));

    await evaluate(() => document.getElementById('accounts-section').scrollIntoView({ behavior: 'instant', block: 'start' }));
    await waitFor(() => evaluate(() => document.getElementById('accounts-section').getBoundingClientRect().top < innerHeight - 200), 'account screenshot position');
    await screenshot('multi-account-smoke.png');

    // One completed workflow can still lack the selected account's result. Push
    // each full snapshot once, then inspect the real renderer after that update.
    const readReason = '工作流已结束，但暂未读到该账号完整的签到结果。将自动补读原运行结果，也可点击“刷新结果”；无需重新登录 GLaDOS。';
    const verificationAccount = {
      ...fixture.accounts[2], conclusion: 'unverified', pointsAdded: null,
      resultReadError: 'INCOMPLETE_RESULTS', lastRefreshError: '', message: readReason,
    };
    controller.state = {
      ...controller.state, busy: false, stage: 'complete', activeTaskId: '', resumeTasks: [],
      error: '', errorInfo: null, message: readReason,
      accounts: [verificationAccount],
      currentRun: { accountKey: deployedKey, repository: verificationAccount.repository, runId: 300,
        runUrl: verificationAccount.runUrl, status: 'completed', conclusion: 'unverified', pointsAdded: null, message: readReason },
      progress: { completed: [0, 1, 2], current: 3 },
    };
    controller.changed();
    await waitFor(() => evaluate(() => document.getElementById('current-run-title').textContent.includes('待核实')), 'account result remains unverified');
    const unverified = await evaluate(key => {
      const card = document.querySelector('.account-card[data-account-key="' + key + '"]');
      const step = document.querySelector('#progress-steps [data-step="3"]');
      return {
        title: document.getElementById('progress-title').textContent,
        badge: document.getElementById('overview-text').textContent,
        count: document.getElementById('progress-count').textContent,
        stepDone: step.classList.contains('is-done'), stepText: step.querySelector('.step-state').textContent,
        status: card.querySelector('.account-status').textContent,
        detail: card.querySelector('.account-detail').textContent,
      };
    }, deployedKey);
    check(unverified.title.includes('待核实') && unverified.badge === '待核实' && unverified.count === '3 / 4' && !unverified.stepDone && unverified.stepText === '待核实', 'An unverified account keeps the final step open even after the workflow completed');
    check(unverified.status.includes('结果待核实') && unverified.detail === readReason, 'The unverified account shows its concrete read reason and how to refresh the original result');

    const checkedMessage = '已确认签到成功，本次新增积分为 0。';
    controller.state = {
      ...controller.state, message: checkedMessage,
      accounts: [{ ...verificationAccount, conclusion: 'checkin_success', pointsAdded: 0, resultReadError: '', message: checkedMessage }],
      currentRun: { ...controller.state.currentRun, conclusion: 'checkin_success', pointsAdded: 0, message: checkedMessage },
      progress: { completed: [0, 1, 2, 3], current: 3 },
    };
    controller.changed();
    await waitFor(() => evaluate(() => document.getElementById('current-run-title').textContent === '签到成功'), 'verified account result applied');
    const checked = await evaluate(key => {
      const card = document.querySelector('.account-card[data-account-key="' + key + '"]');
      return {
        badge: document.getElementById('overview-text').textContent,
        count: document.getElementById('progress-count').textContent,
        done: [...document.getElementById('progress-steps').children].filter(step => step.classList.contains('is-done')).map(step => Number(step.dataset.step)),
        currentRun: document.getElementById('current-run-title').textContent,
        accountStatus: card.querySelector('.account-status').textContent,
        accountSuccess: card.querySelector('.account-status').classList.contains('is-success'),
        detail: card.querySelector('.account-detail').textContent,
      };
    }, deployedKey);
    check(checked.badge === '已完成' && checked.count === '4 / 4' && JSON.stringify(checked.done) === '[0,1,2,3]' && checked.currentRun === '签到成功' && checked.accountStatus === '签到成功' && checked.accountSuccess && checked.detail === checkedMessage, 'One state update resolves the zero-point successful account, current run and all four progress steps');

    return {
      ok: true, checks, elapsedMs: Date.now() - started, viewport: accountInspection.viewport,
      fixtureAccounts: 3, fixturePendingTasks: 2, screenshots,
      ipcActions: actions.slice(actionOffset).filter(action => action.name !== probe),
    };
  } finally {
    controller.state = originalState;
    controller.changed();
    if (!window.isDestroyed()) window.setBounds(originalBounds);
  }
}

module.exports = { runRendererRegression };
