'use strict';

(() => {
  const icons = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    cloud: '<path d="M19 10a7 7 0 1 0-13.6 3.3A4.5 4.5 0 0 0 7.5 22h11a6 6 0 0 0 .5-12Z" transform="translate(0 -3)"/>',
    github: '<path d="M9 19c-4.3 1.3-4.3-2.2-6-2.7M15 22v-3.9a3.4 3.4 0 0 0-.94-2.65c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 19 4.67 5.07 5.07 0 0 0 18.91 1S17.73.65 15 2.48a13.38 13.38 0 0 0-7 0C5.27.65 4.09 1 4.09 1A5.07 5.07 0 0 0 4 4.67a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.4 3.4 0 0 0 8 18.1V22" transform="translate(1 .5) scale(.94)"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18-3-3.2-3-14.8 0-18Z"/>',
    repository: '<path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5Zm0 12a2 2 0 0 1 2-2h13M8 3v7l2-1 2 1V3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
    rocket: '<path d="m9 15-3 3m3-10-5 1-2 5 6 1m8-6 5 1-1 5-5 1M8 15c0-7 6-12 13-12 0 7-5 13-12 13L8 15Z"/><circle cx="16" cy="8" r="1"/><path d="M5 16c-2 0-3 3-3 5 2 0 5-1 5-3"/>',
    arrowRight: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    arrowUpRight: '<path d="M6 18 18 6M6 6h12v12"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronUp: '<path d="m6 15 6-6 6 6"/>',
    sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm7-2v4m-2-2h4M3 18v4m-2-2h4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    alert: '<path d="M10.3 3.8 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 10 9 5 9-5M3 18l9 5 9-5" transform="translate(0 -1)"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-4L2 10m0-6v6h6M4 13a8 8 0 0 0 14.9 4l3.1-3m0 6v-6h-6"/>',
    external: '<path d="M15 3h6v6m0-6L10 14M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>',
    pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
    play: '<path d="m8 4 12 8-12 8V4Z"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    loader: '<path d="M21 12a9 9 0 1 1-9-9"/>',
    browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01m3 0h.01"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6 6-2Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };

  const defaults = {
    version: '', platform: '', dataDirectory: '', busy: false, stage: 'idle', message: '', error: '',
    github: null, browsers: [], selectedBrowser: '', settings: { repoName: 'glados-quick-deploy', exchangePlan: 'plan500', time: '09:30' },
    authCode: null, accounts: [], events: [], currentRun: null,
    resumeTasks: [], activeTaskId: null, errorInfo: null, storageWarning: '', progress: { completed: [], current: null },
  };

  let state = { ...defaults, settings: { ...defaults.settings } };
  let draft = { ...defaults.settings, selectedBrowser: '' };
  let initializedDraft = false;
  let draftDirty = false;
  let saveTimer = null;
  let toastTimer = null;
  let awaitingAction = false;
  let deploymentMode = 'new';
  let selectedTaskId = null;
  let initializedMode = false;
  let refreshingAll = false;
  let resumeSignature = '';
  let eventsSignature = '';
  let accountsSignature = '';
  let browserSignature = '';
  let localError = '';
  let emptyAccountsTemplate = null;
  const pendingAccounts = new Set();
  const $ = (id) => document.getElementById(id);

  function iconMarkup(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || icons.info) + '</svg>';
  }

  function setIcon(element, name) {
    if (!element || element.dataset.renderedIcon === name) return;
    element.innerHTML = iconMarkup(name);
    element.dataset.renderedIcon = name;
  }

  function makeIcon(name, extraClass = '') {
    const element = document.createElement('span');
    element.className = 'icon' + (extraClass ? ' ' + extraClass : '');
    element.setAttribute('aria-hidden', 'true');
    setIcon(element, name);
    return element;
  }

  function safeText(value) {
    return String(value ?? '')
      .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/g, '[已隐藏令牌]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
      .replace(/\b(?:gld|koa):sess(?:\.sig)?\s*=\s*[^;\s]+/gi, '[已隐藏会话]');
  }

  function text(element, value) {
    if (element) element.textContent = safeText(value);
  }

  function makeText(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    text(element, value);
    return element;
  }

  function toast(message) {
    window.clearTimeout(toastTimer);
    text($('toast'), message);
    $('toast').hidden = false;
    toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 3600);
  }

  function isBusy() { return Boolean(state.busy || awaitingAction); }

  function findTask(taskId) { return state.resumeTasks.find((task) => task.id === taskId) || null; }
  function selectedTask() { return findTask(selectedTaskId); }
  function recoveryTask() { return deploymentMode === 'resume' ? selectedTask() : null; }
  function accountTask(account) { return findTask(account.pendingTaskId) || state.resumeTasks.find((task) => task.accountKey === account.accountKey) || null; }

  function taskActionLabel(task) {
    return task.actionLabel || (task.needsLogin ? '重新登录并继续' : '继续未完成任务');
  }

  function planLabel(plan) {
    return { plan500: '500 积分换 100 天', plan200: '200 积分换 30 天', plan100: '100 积分换 10 天', off: '关闭自动兑换' }[plan] || '按已保存的兑换计划';
  }

  function phaseLabel(phase) {
    return { github_auth: 'GitHub 授权', browser_login: 'GLaDOS 登录', deploying: '部署配置', verifying: '运行验证' }[phase] || '已保存的步骤';
  }

  function displayedSettings() {
    const task = recoveryTask();
    return task ? { ...defaults.settings, ...(task.settings || {}), selectedBrowser: task.browserId || '' } : draft;
  }

  function normalizeSelection() {
    if (!initializedMode && (state.resumeTasks.length || (!state.busy && state.stage !== 'initializing'))) {
      const preferred = findTask(state.activeTaskId) || state.resumeTasks[0];
      if (preferred) { selectedTaskId = preferred.id; deploymentMode = 'resume'; }
      initializedMode = true;
    }
    if (!selectedTask()) {
      if (selectedTaskId && deploymentMode === 'resume') deploymentMode = 'new';
      selectedTaskId = (findTask(state.activeTaskId) || state.resumeTasks[0])?.id || null;
    }
    if (state.busy && findTask(state.activeTaskId) && !['complete', 'error', 'cancelled'].includes(state.stage)) selectedTaskId = state.activeTaskId;
    if (deploymentMode === 'resume' && !selectedTask()) deploymentMode = 'new';
  }

  function stageInfo() {
    const stage = String(state.stage || 'idle').toLowerCase();
    const configurations = {
      idle: { title: '准备好开始了', badge: '准备就绪', icon: 'sparkles', kind: 'idle', message: '确认设置后点击“添加并部署账号”，在提示时完成登录。' },
      initializing: { title: '正在准备运行环境', badge: '准备中', icon: 'loader', kind: 'working', message: '初始化完成后即可开始部署。' },
      resume_available: { title: '有未完成任务可以继续', badge: '待继续', icon: 'refresh', kind: 'idle', message: '选择上方待办，按已保存的任务设置继续。' },
      github_auth: { title: '请完成 GitHub 授权', badge: '等待授权', icon: 'github', kind: 'working', message: '在 GitHub 官方页面完成授权，程序会自动接续当前任务。' },
      browser_login: { title: '请登录 GLaDOS', badge: '等待登录', icon: 'browser', kind: 'working', message: '在所选浏览器中完成登录，成功后自动接续部署。' },
      deploying: { title: '正在自动部署', badge: '部署中', icon: 'cloud', kind: 'working', message: '配置当前账号，并接续尚未完成的任务。' },
      verifying: { title: '正在验证运行结果', badge: '验证中', icon: 'activity', kind: 'working', message: '等待 GitHub Actions 返回实际运行结果。' },
      complete: { title: '当前操作已完成', badge: '已完成', icon: 'check', kind: 'complete', message: '每个账号的实际结果请查看下方卡片。' },
      error: { title: '当前任务需要处理', badge: '需要处理', icon: 'alert', kind: 'error', message: '使用上方错误提示中的操作接续当前任务。' },
      cancelling: { title: '正在取消任务', badge: '取消中', icon: 'loader', kind: 'working', message: '正在安全结束当前步骤。' },
      cancelled: { title: '本次操作已停止', badge: '已取消', icon: 'pause', kind: 'idle', message: '可恢复的任务会保留在待办列表中。' },
    };
    let result = configurations[stage] || (isBusy()
      ? { title: '任务正在进行', badge: '进行中', icon: 'loader', kind: 'working', message: '程序正在处理当前步骤。' }
      : configurations.idle);
    if (stage === 'complete' && state.currentRun) {
      const runResult = resultInfo(state.currentRun);
      if (state.currentRun.conclusion === 'unverified') result = { title: '账号结果待核实', badge: '待核实', icon: 'clock', kind: 'idle', message: state.currentRun.message || '部署配置已完成，正在补读原运行的账号结果，无需重新登录。' };
      if (runResult.kind === 'pending') result = { title: '部署完成，等待验证', badge: '等待验证', icon: 'clock', kind: 'working', message: '任务已配置，本次运行仍在排队或执行。可在账号卡片刷新结果。' };
      if (runResult.kind === 'error') result = { title: '当前运行未通过', badge: '需要处理', icon: 'alert', kind: 'error', message: '请查看对应账号的结果，处理具体问题后继续。' };
    }
    if (stage === 'idle' && isBusy()) result = configurations.initializing;
    const completed = new Set(state.progress.completed.filter((step) => Number.isInteger(step) && step >= 0 && step <= 3 && !(step === 3 && state.currentRun?.conclusion === 'unverified')));
    const current = Number.isInteger(state.progress.current) && state.progress.current >= 0 && state.progress.current <= 3 ? state.progress.current : null;
    return { ...result, step: current, completed, done: completed.size };
  }

  function renderConnection() {
    const connected = Boolean(state.github && state.github.login);
    text($('github-connect-label'), connected ? state.github.login : '连接 GitHub');
    $('github-connection-dot').classList.toggle('is-connected', connected);
    $('github-connect').disabled = isBusy();
    $('github-connect').title = connected ? '已连接 ' + safeText(state.github.login) + '；点击重新授权' : '连接用于部署的 GitHub 账号';
    $('github-connect').setAttribute('aria-label', connected ? 'GitHub 已连接：' + safeText(state.github.login) + '，点击重新授权' : '连接 GitHub');
    text($('app-version'), state.version ? 'v' + String(state.version).replace(/^v/, '') : '桌面版');
    const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
    text($('app-platform'), platformNames[state.platform] || state.platform || '正在连接');
    text($('data-directory'), state.dataDirectory || '应用启动后自动配置');
  }

  function renderBrowsers() {
    const browsers = Array.isArray(state.browsers) ? state.browsers : [];
    const task = recoveryTask();
    const savedBrowserId = task ? String(task.browserId || '') : '';
    const signature = JSON.stringify([browsers, task ? savedBrowserId : null]);
    if (signature !== browserSignature) {
      browserSignature = signature;
      const select = $('browser-select');
      select.replaceChildren();
      if (!browsers.length) {
        const option = makeText('option', '', '正在识别浏览器…');
        option.value = '';
        select.append(option);
      } else {
        for (const browser of browsers) {
          const available = browser.available !== false;
          const unavailableLabel = /safari/i.test(String(browser.id || '') + ' ' + String(browser.family || '')) ? ' · 仅用于 GitHub 授权' : ' · 未安装';
          const option = makeText('option', '', browser.name + (available ? '' : unavailableLabel));
          option.value = String(browser.id);
          option.disabled = !available;
          select.append(option);
        }
      }
      if (task && !browsers.some((browser) => browser.id === savedBrowserId)) {
        const option = makeText('option', '', savedBrowserId ? '已保存的浏览器：' + savedBrowserId : '按任务已保存的登录方式');
        option.value = savedBrowserId;
        option.disabled = true;
        select.append(option);
      }
    }
    const available = browsers.filter((browser) => browser.available !== false);
    if (!task && !available.some((browser) => browser.id === draft.selectedBrowser) && available.length) {
      const preferred = available.find((browser) => browser.id === state.selectedBrowser)
        || available.find((browser) => /brave/i.test(browser.id)) || available[0];
      draft.selectedBrowser = preferred.id;
    }
    const selectedId = task ? savedBrowserId : draft.selectedBrowser;
    $('browser-select').value = selectedId;
    $('browser-select').disabled = isBusy() || Boolean(task) || !available.length;
    const selected = browsers.find((browser) => browser.id === selectedId);
    const family = selected ? String(selected.family || '').toLowerCase() : '';
    const browserId = selected ? String(selected.id || '').toLowerCase() : '';
    let description = selected && selected.details ? safeText(selected.details) : '程序会打开专用登录窗口，完成 GLaDOS 登录后自动继续。';
    let familyLabel = '浏览器';
    let symbolName = 'globe';
    let symbolClass = '';
    if (/embedded|builtin|built-in/.test(browserId + ' ' + family)) {
      familyLabel = '无需安装'; symbolName = 'browser';
      if (!(selected && selected.details)) description = '使用应用内置的独立登录窗口，无需额外安装浏览器。';
    } else if (/firefox/.test(browserId + ' ' + family)) {
      familyLabel = '兼容通道'; symbolClass = 'is-firefox';
      if (!(selected && selected.details)) description = '通过 Firefox 专用兼容通道登录，完成后自动接续。';
    } else if (/safari/.test(browserId + ' ' + family)) {
      familyLabel = '备用通道'; symbolName = 'compass'; symbolClass = 'is-safari';
      if (!(selected && selected.details)) description = 'Safari 使用备用登录通道；请按照打开窗口中的说明完成登录。';
    } else if (selected) {
      familyLabel = /chromium|chrome|edge|brave|opera|vivaldi/.test(browserId + ' ' + family) ? 'Chromium' : '已检测';
      symbolClass = /brave/.test(browserId) ? 'is-brave' : /edge/.test(browserId) ? 'is-edge' : /chrome/.test(browserId) ? 'is-chrome' : '';
    }
    $('browser-symbol').className = 'browser-symbol' + (symbolClass ? ' ' + symbolClass : '');
    setIcon($('browser-symbol').querySelector('.icon'), symbolName);
    text($('browser-family'), familyLabel);
    text($('browser-description'), task ? task.needsLogin ? '任务需要补充登录；点击继续后由软件接续处理。' : '继续使用此任务已保存的登录进度。' : description);
    text($('browser-discovery'), task ? '任务已保存的登录方式' : available.length ? '已识别 ' + available.length + ' 种可用方式' : '正在识别可用浏览器');
  }

  function renderSettings() {
    const task = recoveryTask();
    const settings = displayedSettings();
    for (const [id, key] of [['repository-input', 'repoName'], ['exchange-select', 'exchangePlan'], ['schedule-input', 'time']]) {
      const element = $(id);
      if ((task || document.activeElement !== element) && element.value !== settings[key]) element.value = settings[key];
      element.disabled = isBusy() || Boolean(task);
    }
    const hasBrowser = state.browsers.some((browser) => browser.id === draft.selectedBrowser && browser.available !== false);
    $('deploy-button').disabled = isBusy() || !window.quickDeploy || (task ? task.canResume === false : !hasBrowser);
    text($('deploy-button-label'), isBusy() ? '任务正在进行…' : task ? taskActionLabel(task) : '添加并部署账号');
    setIcon($('deploy-button-icon'), isBusy() ? 'loader' : task ? 'refresh' : 'rocket');
    $('deploy-button-icon').classList.toggle('is-spinning', isBusy());
    $('cancel-button').hidden = !isBusy();
    $('cancel-button').disabled = state.stage === 'cancelling';
    text($('cancel-button'), state.stage === 'cancelling' ? '正在取消…' : '取消任务');
    const hints = {
      github_auth: '请在浏览器中完成 GitHub 授权，程序会自动继续。',
      browser_login: '请在打开的登录窗口完成登录，暂时无需其他操作。',
      deploying: '正在自动配置。你可以留在本页查看实时进度。',
      verifying: 'GitHub 任务正在排队或运行，结果会自动更新。',
      cancelling: '正在结束当前步骤，请稍候。',
    };
    text($('deploy-hint'), isBusy() ? hints[state.stage] || '正在处理当前操作，请稍候。' : task ? task.needsLogin ? '其他步骤已保留；本次需要重新登录后继续。' : '按此任务保存的配置继续，不读取新账号表单。' : '需要时会打开登录页，登录完成后自动接续。');
    text($('deploy-heading'), task ? '继续未完成任务' : '添加账号');
    text($('setup-description'), task ? '以下为该任务保存的设置，继续时沿用。' : '为新账号选择登录方式与每日任务。');
    text($('setup-mode'), task ? '已保存任务' : '新账号');
    $('task-context').hidden = !task;
    text($('task-context'), task ? (task.email || task.accountKey || '待确认账号') + ' · ' + (task.repository || task.settings?.repoName || '待确认仓库') : '');
    $('add-account').disabled = isBusy();
    $('refresh-all').disabled = isBusy() || !state.accounts.length;
    text($('refresh-all-label'), refreshingAll ? '正在刷新…' : '刷新全部');
    $('refresh-all-icon').classList.toggle('is-spinning', refreshingAll);
  }

  function renderResumeTasks() {
    const tasks = state.resumeTasks;
    $('resume-panel').hidden = !tasks.length;
    text($('resume-count'), tasks.length);
    if (!tasks.length) return;
    const signature = JSON.stringify(tasks.map((task) => [task.id, task.email, task.accountKey, task.repository]));
    if (signature !== resumeSignature) {
      resumeSignature = signature;
      $('resume-select').replaceChildren();
      for (const task of tasks) {
        const option = makeText('option', '', (task.email || task.accountKey || '待确认账号') + ' · ' + (task.repository || task.settings?.repoName || '待确认仓库'));
        option.value = task.id;
        $('resume-select').append(option);
      }
    }
    const task = selectedTask();
    if (!task) return;
    $('resume-select').value = task.id;
    $('resume-select').disabled = isBusy();
    $('resume-task-button').disabled = isBusy() || task.canResume === false;
    text($('resume-task-button'), taskActionLabel(task));
    $('discard-resume').disabled = isBusy();
    text($('resume-mode-label'), deploymentMode === 'resume' ? '当前选择' : '待办已保留');
    text($('resume-task-identity'), '任务位置：' + phaseLabel(task.phase) + (task.githubLogin ? ' · GitHub：' + task.githubLogin : ''));
    text($('resume-settings'), '已保存设置：' + (task.repository || task.settings?.repoName || '待确认仓库') + ' · 每日 ' + (task.settings?.time || '09:30') + ' UTC+8 · ' + planLabel(task.settings?.exchangePlan || 'plan500'));
    text($('resume-availability'), task.canResume === false ? '这条任务目前不能直接继续，请按对应错误提示处理。' : task.needsLogin ? '进度已保留；继续时需要完成 GLaDOS 官方登录。' : '可以接续此任务；是否需要 GitHub 授权会由程序提示。');
    const ownError = task.lastError && state.errorInfo?.taskId !== task.id;
    $('resume-task-error').hidden = !ownError;
    text($('resume-task-error'), ownError ? task.lastError : '');
    const retention = task.savedAcrossRestart ? '任务进度已保存，可在下次打开后继续。' : '当前登录可能仅在本次打开期间保留；关闭后可能需要重新登录。';
    text($('resume-retention'), retention + (task.updatedAt ? ' 更新于 ' + formatDate(task.updatedAt, true) : ''));
  }

  function errorAction() {
    if (localError || !state.errorInfo || typeof state.errorInfo !== 'object') return null;
    const info = state.errorInfo;
    const task = findTask(info.taskId);
    const name = info.action || (task ? 'resumeDeploy' : '');
    const allowed = ['resumeDeploy', 'connectGithub', 'reloginAccount', 'refreshAll', 'refreshRun'];
    if (!allowed.includes(name)) return null;
    if (name === 'resumeDeploy') return task ? { name, taskId: task.id, disabled: task.canResume === false, label: info.actionLabel || taskActionLabel(task) } : null;
    if (name === 'reloginAccount' || name === 'refreshRun') {
      const accountKey = info.accountKey || task?.accountKey;
      if (!state.accounts.some((account) => account.accountKey === accountKey)) return null;
      return { name, accountKey, label: info.actionLabel || (name === 'reloginAccount' ? '更新此账号登录' : '刷新此账号结果') };
    }
    return { name, label: info.actionLabel || (name === 'connectGithub' ? '重新授权 GitHub' : '刷新全部账号') };
  }

  function renderError() {
    const error = localError || state.error;
    const info = !localError && state.errorInfo && typeof state.errorInfo === 'object' ? state.errorInfo : null;
    const task = info ? findTask(info.taskId) : null;
    const titles = {
      WORKFLOW_AUTH_REQUIRED: 'GitHub 需要补充工作流授权',
      AUTH_REQUIRED: 'GitHub 需要重新授权',
      SESSION_REJECTED: 'GLaDOS 登录需要更新',
      AUTHENTICATION_REQUIRED: 'GLaDOS 登录需要更新',
      LOGIN_REQUIRED: 'GLaDOS 登录需要更新',
      IDENTITY_MISMATCH: '登录账号与目标账号不一致',
      ACCOUNT_MISMATCH: '登录账号与目标账号不一致',
      WRONG_ACCOUNT: '请使用此任务原来的 GitHub 账号',
    };
    $('error-banner').hidden = !error && !info?.message;
    text($('error-title'), titles[info?.code] || '当前任务需要处理');
    text($('error-message'), info?.message || (error && typeof error === 'object' ? error.message || '当前步骤未完成，请查看运行记录。' : error));
    const context = task ? (task.email || task.accountKey || '当前账号') + ' · ' + (task.repository || task.settings?.repoName || '待确认仓库') : '';
    const hint = [context, info?.hint].filter(Boolean).join('。');
    $('error-hint').hidden = !hint;
    text($('error-hint'), hint);
    const action = errorAction();
    $('error-action').hidden = !action;
    $('error-action').disabled = isBusy() || Boolean(action?.disabled);
    text($('error-action'), action?.label || '继续处理');
    $('storage-warning').hidden = !state.storageWarning;
    text($('storage-warning-message'), state.storageWarning);
  }

  function renderProgress() {
    const info = stageInfo();
    const task = recoveryTask();
    const appliesToSelection = !task || state.activeTaskId === task.id;
    $('overview-badge').className = 'overview-badge is-' + info.kind;
    text($('overview-text'), info.badge);
    text($('progress-count'), appliesToSelection ? info.done + ' / 4' : '待继续');
    $('progress-visual').className = 'progress-visual is-' + (appliesToSelection ? info.kind : 'idle');
    setIcon($('progress-center-icon'), appliesToSelection ? info.icon : 'refresh');
    $('progress-center-icon').classList.toggle('is-spinning', appliesToSelection && info.icon === 'loader');
    text($('progress-title'), appliesToSelection ? info.title : '已选择待继续任务');
    text($('progress-message'), appliesToSelection ? state.message || info.message : '此任务停在“' + phaseLabel(task.phase) + '”。点击继续后显示该任务的实际进度。');
    const stage = String(state.stage || 'idle');
    const waiting = !isBusy() && (stage === 'resume_available' || Boolean(task));
    const active = info.step !== null && (isBusy() || stage === 'error' || waiting || (stage === 'complete' && info.done < 4));
    $('progress-steps').hidden = !appliesToSelection;
    for (const item of $('progress-steps').children) {
      const index = Number(item.dataset.step);
      const current = index === info.step && active;
      const failed = current && info.kind === 'error';
      const done = info.completed.has(index) && !failed;
      item.classList.toggle('is-done', done);
      item.classList.toggle('is-current', current && !failed);
      item.classList.toggle('is-failed', failed);
      const indicator = item.querySelector('.step-indicator');
      if (done) { indicator.replaceChildren(makeIcon('check')); }
      else { text(indicator, index + 1); }
      const status = failed ? '需处理' : done ? '已完成' : current ? state.currentRun?.conclusion === 'unverified' ? '待核实' : stage === 'cancelling' ? '取消中' : waiting ? '待继续' : '进行中' : '';
      text(item.querySelector('.step-state'), status);
      item.setAttribute('aria-label', item.querySelector('strong').textContent + '：' + (status || '未开始'));
      if (current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
    const auth = state.authCode && state.authCode.code && stage === 'github_auth';
    $('github-auth').hidden = !auth;
    text($('auth-code'), auth ? state.authCode.code : '');
    const run = state.currentRun;
    $('current-run').hidden = !run || !appliesToSelection;
    if (run) {
      const status = resultInfo(run);
      text($('current-run-title'), status.label);
      text($('current-run-detail'), (run.repository || '') + (run.runId ? ' · #' + run.runId : ''));
    }
    renderError();
  }

  function resultInfo(account) {
    const conclusion = String(account.conclusion || account.outcome || '').toLowerCase();
    const status = String(account.status || '').toLowerCase();
    const points = Number(account.pointsAdded);
    const added = Number.isFinite(points) && points > 0;
    const creditSuffix = added ? ' · 已加分 +' + points : '';
    if (['authentication_rejected', 'authentication_required'].includes(conclusion)) return { kind: 'error', label: '需要重新登录' + creditSuffix, detail: '登录授权被拒绝，请重新登录后更新' };
    if (['failure', 'failed', 'error', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(conclusion)) return { kind: 'error', label: (conclusion === 'timed_out' ? '运行超时' : '运行异常') + creditSuffix, detail: added ? '已取得积分，但本次任务仍有异常；请查看运行记录' : '查看记录，处理后重新验证' };
    if (conclusion === 'cancelled' || conclusion === 'canceled') return { kind: 'neutral', label: '运行已取消' + creditSuffix, detail: added ? '取消前已取得积分，后续步骤未全部完成' : '可刷新查看最新记录' };
    if (status === 'in_progress' || conclusion === 'in_progress' || conclusion === 'running') return { kind: 'pending', label: '正在验证', detail: '等待本次运行返回结果' };
    if (['queued', 'pending', 'requested', 'waiting'].includes(status) || ['queued', 'pending', 'requested', 'waiting'].includes(conclusion)) return { kind: 'pending', label: '验证排队', detail: '本次验证尚未完成，请等待实际运行结果' };
    if (status === 'not_started' || conclusion === 'not_started') return { kind: 'neutral', label: '尚未验证', detail: '当前还没有可核验的运行记录' };
    if (conclusion === 'unverified') return { kind: 'neutral', label: '结果待核实' + creditSuffix, detail: account.message || '正在补读原运行的账号结果，可刷新查询；无需重新登录' };
    if (added) return { kind: 'success', label: '已加分 +' + points, detail: '本次签到已取得积分' };
    if (['already_checked_in', 'already-checked-in', 'checkin_already_done', 'already_checked', 'already'].includes(conclusion)) return { kind: 'success', label: '今日已签到', detail: '本次验证确认今日已签到' };
    if (['checked', 'checked_in', 'checkin_success', 'points_added', 'accepted'].includes(conclusion)) return { kind: 'success', label: '签到成功', detail: '已确认签到结果' };
    if (conclusion === 'success') return { kind: 'success', label: '工作流成功', detail: '签到结果以具体运行记录为准' };
    if (conclusion === 'skipped' || conclusion === 'neutral') return { kind: 'neutral', label: '本次未执行', detail: '查看工作流记录了解原因' };
    return { kind: 'pending', label: '验证排队', detail: '等待 GitHub Actions 运行' };
  }

  function formatDate(value, withDate = false) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return safeText(value);
    return new Intl.DateTimeFormat('zh-CN', withDate
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
      : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
  }

  function accountButton(account, action, icon, label, visibleLabel = false, payload = {}) {
    const button = document.createElement('button');
    const primary = action === 'resumeDeploy' || action === 'reloginAccount';
    const background = action === 'openRun' || action === 'openRepository';
    button.className = 'account-action' + (primary ? ' is-primary' : '') + (action === 'pause' && !account.paused ? ' is-danger' : '');
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.accountKey = String(account.accountKey || '');
    button.title = action === 'reloginAccount' ? '更新此账号登录，沿用该账号的仓库设置' : label;
    button.setAttribute('aria-label', label + '：' + safeText(account.email || account.accountKey));
    button.append(makeIcon(icon));
    if (visibleLabel) button.append(makeText('span', primary ? 'account-primary-label' : 'action-label', label));
    button.disabled = pendingAccounts.has(account.accountKey) || (!background && isBusy());
    if (action === 'openRun' && !account.runId && !account.runUrl) button.disabled = true;
    if (action === 'openRepository' && !account.repository) button.disabled = true;
    if ((action === 'pause' || action === 'refreshRun') && (!account.repository || account.deploymentStatus === 'pending')) button.disabled = true;
    if (action === 'resumeDeploy' && findTask(payload.taskId)?.canResume === false) button.disabled = true;
    button.addEventListener('click', () => accountAction(account.accountKey, action, payload));
    return button;
  }

  function accountStatus(account, task) {
    if (!task && account.deploymentStatus !== 'pending') return resultInfo(account);
    if (!task) return { kind: 'pending', label: '部署待完成', detail: '登录已确认，可更新此账号登录后继续部署' };
    const running = state.busy && state.activeTaskId === task.id && !['error', 'cancelled', 'complete'].includes(state.stage);
    if (running && state.stage === 'cancelling') return { kind: 'pending', label: '正在取消', detail: '正在安全结束此账号的当前步骤，已保存的进度会保留' };
    if (running) return { kind: 'pending', label: phaseLabel(state.stage === 'github_auth' ? 'github_auth' : task.phase) + '进行中', detail: '正在处理此账号，完成后会自动更新结果' };
    if (task.lastError) return { kind: 'error', label: task.needsLogin ? '登录待继续' : '任务待继续', detail: task.lastError };
    return { kind: 'pending', label: task.needsLogin ? '登录待继续' : task.phase === 'verifying' ? '验证待继续' : '部署待继续', detail: task.needsLogin ? '此前进度已保存，需要完成此账号登录' : '已停在“' + phaseLabel(task.phase) + '”，可接续已保存的进度' };
  }

  function renderAccounts(force = false) {
    text($('accounts-count'), state.accounts.length);
    text($('nav-account-count'), state.accounts.length);
    const signature = JSON.stringify([state.accounts, state.resumeTasks, state.activeTaskId, state.stage, Array.from(pendingAccounts), isBusy()]);
    if (!force && signature === accountsSignature) return;
    accountsSignature = signature;
    const list = $('accounts-list');
    if (!emptyAccountsTemplate && list.querySelector('.empty-accounts')) emptyAccountsTemplate = list.firstElementChild.cloneNode(true);
    if (!state.accounts.length) {
      if (!list.querySelector('.empty-accounts') && emptyAccountsTemplate) list.replaceChildren(emptyAccountsTemplate.cloneNode(true));
      return;
    }
    list.replaceChildren();
    for (const account of state.accounts) {
      const task = accountTask(account);
      const card = document.createElement('article');
      card.className = 'account-card';
      card.dataset.accountKey = String(account.accountKey || '');
      const identity = document.createElement('div');
      identity.className = 'account-identity';
      const email = account.email || account.accountKey || 'GLaDOS 账号';
      identity.append(makeText('div', 'account-avatar', String(email).charAt(0).toUpperCase()));
      const identityCopy = document.createElement('div');
      const emailLabel = makeText('h3', 'account-email', email);
      emailLabel.title = safeText(email);
      identityCopy.append(emailLabel);
      const repository = makeText('p', 'account-repository', account.repository || '正在配置仓库');
      repository.title = safeText(account.repository || '');
      identityCopy.append(repository);
      identityCopy.append(makeText('p', 'account-schedule' + (account.paused ? ' is-paused' : ''), account.paused ? '此仓库定时任务已暂停' : account.deploymentStatus === 'pending' ? '等待完成云端部署' : '此仓库定时任务已启用'));
      identity.append(identityCopy);
      card.append(identity);

      const status = accountStatus(account, task);
      const statusBlock = document.createElement('div');
      statusBlock.className = 'account-state';
      const badge = document.createElement('span');
      badge.className = 'account-status is-' + status.kind;
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      dot.setAttribute('aria-hidden', 'true');
      const previousResult = account.lastRefreshError && !task && account.deploymentStatus !== 'pending';
      badge.append(dot, makeText('span', '', (previousResult ? '上次结果：' : '') + status.label));
      statusBlock.append(badge);
      const detail = safeText(task || account.deploymentStatus === 'pending' ? status.detail : account.message || status.detail);
      const detailElement = makeText('span', 'account-detail', detail);
      statusBlock.append(detailElement);
      if (account.lastRefreshError) {
        const refreshError = makeText('span', 'account-refresh-error', '刷新暂未完成：' + account.lastRefreshError);
        refreshError.setAttribute('role', 'status');
        statusBlock.append(refreshError);
      }
      if (task && (account.runId || account.runUrl || (account.conclusion && account.conclusion !== 'not_started'))) statusBlock.append(makeText('span', 'account-previous', '上次结果：' + resultInfo(account).label));
      if (account.updatedAt) statusBlock.append(makeText('span', 'account-updated', '记录更新于 ' + formatDate(account.updatedAt, true)));
      card.append(statusBlock);

      const actions = document.createElement('div');
      actions.className = 'account-actions';
      if (task) actions.append(accountButton(account, 'resumeDeploy', 'refresh', taskActionLabel(task), true, { taskId: task.id }));
      actions.append(accountButton(account, 'reloginAccount', 'browser', '更新登录', true));
      actions.append(accountButton(account, 'refreshRun', 'refresh', '刷新结果'));
      actions.append(accountButton(account, 'openRun', 'external', '运行记录', true));
      actions.append(accountButton(account, 'openRepository', 'repository', '打开仓库'));
      actions.append(accountButton(account, 'pause', account.paused ? 'play' : 'pause', account.paused ? '恢复此仓库全部账号' : '暂停此仓库全部账号', false, { paused: !account.paused }));
      card.append(actions);
      list.append(card);
    }
  }

  function renderEvents() {
    const events = state.events.slice(-50).reverse();
    const signature = JSON.stringify(events);
    text($('activity-count'), state.events.length ? '最近 ' + Math.min(state.events.length, 50) + ' 条' : '暂无记录');
    if (signature === eventsSignature) return;
    eventsSignature = signature;
    const list = $('activity-list');
    list.replaceChildren();
    if (!events.length) { list.append(makeText('p', 'empty-activity', '操作与进度会实时记录在这里。')); return; }
    for (const event of events) {
      const row = document.createElement('div');
      const level = ['error', 'warning', 'success', 'warn'].includes(event.level) ? event.level === 'warn' ? 'warning' : event.level : 'info';
      row.className = 'event-row is-' + level;
      const time = makeText('time', 'event-time', formatDate(event.time));
      const parsedDate = new Date(event.time);
      if (!Number.isNaN(parsedDate.getTime())) time.dateTime = parsedDate.toISOString();
      row.append(time);
      const dot = document.createElement('span');
      dot.className = 'event-dot'; dot.setAttribute('aria-hidden', 'true');
      row.append(dot, makeText('span', 'event-message', event.message || ''));
      list.append(row);
    }
  }

  function render() {
    renderConnection();
    renderResumeTasks();
    renderBrowsers();
    renderSettings();
    renderProgress();
    renderAccounts();
    renderEvents();
  }

  function receiveState(next) {
    if (!next || typeof next !== 'object') return;
    state = {
      ...defaults, ...next,
      settings: { ...defaults.settings, ...(next.settings || {}) },
      browsers: Array.isArray(next.browsers) ? next.browsers : [],
      accounts: Array.isArray(next.accounts) ? next.accounts : [],
      events: Array.isArray(next.events) ? next.events : [],
      resumeTasks: Array.isArray(next.resumeTasks) ? next.resumeTasks.filter((task) => task && typeof task.id === 'string' && task.id) : [],
      progress: { completed: Array.isArray(next.progress?.completed) ? next.progress.completed : [], current: next.progress?.current ?? null },
      errorInfo: next.errorInfo && typeof next.errorInfo === 'object' ? next.errorInfo : null,
    };
    if (!initializedDraft || !draftDirty) {
      draft = { ...state.settings, selectedBrowser: state.selectedBrowser || draft.selectedBrowser };
      initializedDraft = true;
    }
    normalizeSelection();
    render();
  }

  function gatherSettings() {
    return {
      selectedBrowser: $('browser-select').value,
      repoName: $('repository-input').value.trim(),
      exchangePlan: $('exchange-select').value,
      time: $('schedule-input').value || '09:30',
    };
  }

  async function callAction(name, payload = {}) {
    if (!window.quickDeploy || typeof window.quickDeploy.action !== 'function') throw new Error('桌面服务尚未连接，请关闭窗口后重新打开应用。');
    const result = await window.quickDeploy.action(name, payload);
    if (result && typeof result === 'object') receiveState(result);
    return result;
  }

  function captureDraft() {
    if (deploymentMode !== 'new') return;
    draft = gatherSettings();
    draftDirty = true;
    localError = '';
  }

  async function saveSettings() {
    if (deploymentMode !== 'new' || !draftDirty || isBusy() || !window.quickDeploy) return;
    if (!$('repository-input').checkValidity() || !$('schedule-input').checkValidity()) return;
    const snapshot = { ...draft };
    try {
      const result = await window.quickDeploy.action('saveSettings', snapshot);
      if (JSON.stringify(snapshot) === JSON.stringify(draft)) draftDirty = false;
      if (result && typeof result === 'object') receiveState(result);
    } catch (error) {
      localError = safeText(error.message || '设置未能保存。请重试。');
      renderProgress();
    }
  }

  async function startDeploy(event) {
    if (event) event.preventDefault();
    if (isBusy()) return;
    const task = recoveryTask();
    if (task) { await performResume(task.id); return; }
    if (!$('deploy-form').reportValidity()) return;
    captureDraft();
    if (!draft.selectedBrowser) { toast('请选择一种可用的登录方式。'); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(draft.repoName)) { toast('仓库名称须为 1–80 个字符，并以英文字母或数字开头。'); $('repository-input').focus(); return; }
    window.clearTimeout(saveTimer);
    localError = '';
    awaitingAction = true;
    render();
    try {
      await callAction('startDeploy', { browserId: draft.selectedBrowser, repoName: draft.repoName, exchangePlan: draft.exchangePlan, time: draft.time, newTask: true });
      draftDirty = false;
    } catch (error) {
      localError = safeText(error.message || '任务未能启动。请查看提示后重试。');
    } finally {
      awaitingAction = false;
      selectErrorTask();
      render();
    }
  }

  function scrollTo(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function chooseTask(taskId) {
    if (isBusy() || !findTask(taskId)) return false;
    window.clearTimeout(saveTimer);
    selectedTaskId = taskId;
    deploymentMode = 'resume';
    localError = '';
    render();
    return true;
  }

  function selectErrorTask() {
    const task = findTask(state.errorInfo?.taskId) || (state.stage === 'cancelled' ? findTask(state.activeTaskId) : null);
    if (task) { selectedTaskId = task.id; deploymentMode = 'resume'; }
    normalizeSelection();
  }

  function addAccount() {
    if (isBusy()) return;
    window.clearTimeout(saveTimer);
    deploymentMode = 'new';
    localError = '';
    render();
    scrollTo($('deploy-heading'));
    $('deploy-heading').focus({ preventScroll: true });
  }

  async function performResume(taskId) {
    const task = findTask(taskId);
    if (!task || task.canResume === false || !chooseTask(taskId)) return;
    awaitingAction = true;
    render();
    try { await callAction('resumeDeploy', { taskId }); }
    catch (error) { localError = safeText(error.message || '任务未能接续，请查看提示后重试。'); }
    finally { awaitingAction = false; selectErrorTask(); render(); }
  }

  async function discardTask() {
    const task = selectedTask();
    if (isBusy() || !task) return;
    localError = '';
    awaitingAction = true;
    render();
    try {
      await callAction('discardResume', { taskId: task.id });
      if (!findTask(task.id)) toast('本地待办已移除，云端已部署任务保留。');
    } catch (error) { localError = safeText(error.message || '移除本地待办未完成，请重试。'); }
    finally { awaitingAction = false; normalizeSelection(); render(); }
  }

  async function refreshAll() {
    if (isBusy() || !state.accounts.length) return;
    localError = '';
    refreshingAll = true;
    awaitingAction = true;
    render();
    try { await callAction('refreshAll', {}); }
    catch (error) { localError = safeText(error.message || '刷新未完成，各账号已取得的结果会保留。'); }
    finally { refreshingAll = false; awaitingAction = false; render(); }
  }

  async function repairError() {
    const action = errorAction();
    if (isBusy() || !action || action.disabled) return;
    if (action.name === 'resumeDeploy') { await performResume(action.taskId); return; }
    if (action.name === 'connectGithub') { await connectGithub(); return; }
    if (action.name === 'refreshAll') { await refreshAll(); return; }
    await accountAction(action.accountKey, action.name, {});
  }

  async function connectGithub() {
    if (isBusy()) return;
    localError = '';
    awaitingAction = true;
    render();
    try { await callAction('connectGithub'); }
    catch (error) { localError = safeText(error.message || 'GitHub 连接未完成，请重试。'); }
    finally { awaitingAction = false; render(); }
  }

  async function cancelTask() {
    $('cancel-button').disabled = true;
    text($('cancel-button'), '正在取消…');
    try { await callAction('cancel'); }
    catch (error) { localError = safeText(error.message || '取消请求未完成，请稍后再试。'); }
    finally { render(); }
  }

  async function accountAction(accountKey, name, payload) {
    const account = state.accounts.find((item) => item.accountKey === accountKey);
    if (!account || pendingAccounts.has(accountKey)) return;
    if (name === 'resumeDeploy') {
      if (chooseTask(payload?.taskId)) { scrollTo($('workspace')); await performResume(payload.taskId); }
      return;
    }
    const blocking = name !== 'openRun' && name !== 'openRepository';
    if (blocking && isBusy()) return;
    if (blocking) localError = '';
    pendingAccounts.add(accountKey);
    if (blocking) awaitingAction = true;
    render();
    try {
      const request = name === 'reloginAccount' ? { accountKey } : { accountKey, ...payload };
      if (name === 'reloginAccount') {
        const savedBrowser = state.browsers.find((browser) => browser.id === account.browser && browser.available !== false);
        if (savedBrowser) request.browserId = savedBrowser.id;
        scrollTo($('workspace'));
      }
      await callAction(name, request);
    } catch (error) {
      if (blocking) localError = safeText(error.message || '此账号的操作未完成，请稍后重试。');
      else toast(error.message || '页面未能打开，请稍后重试。');
    }
    finally {
      pendingAccounts.delete(accountKey);
      if (blocking) awaitingAction = false;
      if (name === 'reloginAccount') selectErrorTask();
      render();
    }
  }

  function bindEvents() {
    $('deploy-form').addEventListener('submit', startDeploy);
    $('github-connect').addEventListener('click', connectGithub);
    $('cancel-button').addEventListener('click', cancelTask);
    $('add-account').addEventListener('click', addAccount);
    $('refresh-all').addEventListener('click', refreshAll);
    $('resume-select').addEventListener('change', () => { chooseTask($('resume-select').value); });
    $('resume-task-button').addEventListener('click', () => { performResume(selectedTaskId); });
    $('discard-resume').addEventListener('click', discardTask);
    $('error-action').addEventListener('click', repairError);
    $('error-details').addEventListener('click', () => {
      $('activity-list').hidden = false;
      $('toggle-activity').setAttribute('aria-expanded', 'true');
      $('toggle-activity').replaceChildren(document.createTextNode('收起'), makeIcon('chevronUp'));
      scrollTo($('activity-section'));
      $('activity-heading').setAttribute('tabindex', '-1');
      $('activity-heading').focus({ preventScroll: true });
    });
    $('copy-auth-code').addEventListener('click', async () => {
      try { await callAction('copyAuthCode'); toast('授权码已复制。'); }
      catch (error) { toast(error.message || '复制未完成，请手动选择授权码。'); }
    });
    for (const id of ['browser-select', 'repository-input', 'exchange-select', 'schedule-input']) {
      $(id).addEventListener('change', () => {
        if (deploymentMode !== 'new' || isBusy()) return;
        captureDraft(); window.clearTimeout(saveTimer); renderBrowsers(); renderSettings(); saveTimer = window.setTimeout(saveSettings, 200);
      });
    }
    $('repository-input').addEventListener('input', () => {
      if (deploymentMode !== 'new' || isBusy()) return;
      captureDraft(); window.clearTimeout(saveTimer); saveTimer = window.setTimeout(saveSettings, 500);
    });
    $('toggle-activity').addEventListener('click', () => {
      const collapsed = !$('activity-list').hidden;
      $('activity-list').hidden = collapsed;
      $('toggle-activity').setAttribute('aria-expanded', String(!collapsed));
      $('toggle-activity').replaceChildren(document.createTextNode(collapsed ? '展开' : '收起'), makeIcon(collapsed ? 'chevronDown' : 'chevronUp'));
    });
    document.querySelectorAll('[data-scroll]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = $(button.dataset.scroll);
        scrollTo(target);
        document.querySelectorAll('.nav-item').forEach((item) => {
          item.classList.toggle('is-active', item === button);
          if (item === button) item.setAttribute('aria-current', 'page');
          else item.removeAttribute('aria-current');
        });
      });
    });
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !isBusy()) { event.preventDefault(); startDeploy(); }
    });
  }

  async function initialize() {
    document.querySelectorAll('[data-icon]').forEach((element) => setIcon(element, element.dataset.icon));
    bindEvents();
    render();
    if (!window.quickDeploy || typeof window.quickDeploy.getState !== 'function') {
      localError = '桌面服务尚未连接。请使用已安装的 Quick Deploy 应用打开此界面。';
      render();
      return;
    }
    try {
      if (typeof window.quickDeploy.onState === 'function') {
        const unsubscribe = window.quickDeploy.onState(receiveState);
        if (typeof unsubscribe === 'function') window.addEventListener('beforeunload', unsubscribe, { once: true });
      }
      receiveState(await window.quickDeploy.getState());
    } catch (error) {
      localError = safeText(error.message || '读取应用状态失败，请重新打开应用。');
      render();
    }
  }

  initialize();
})();
