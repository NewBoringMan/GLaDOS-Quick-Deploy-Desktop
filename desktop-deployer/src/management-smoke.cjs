'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeManifest, businessDate } = require('./schedule-config.cjs');

async function runManagementRendererRegression({ window, controller, actions, outputDirectory }) {
  if (!process.argv.includes('--smoke-test')) throw new Error('Management fixtures require isolated smoke mode');
  const original = controller.state; const managed = controller.github.managed;
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
  const checks = []; const deadline = Date.now() + 25000;
  const evaluate = (fn, arg) => window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`);
  async function until(predicate, label) {
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Management renderer timed out: ' + label);
  }
  function check(condition, label) { assert.ok(condition, label); checks.push(label); }
  async function stable() { await until(() => evaluate(() => !document.getElementById('mg-checkin-all').disabled), 'buttons ready'); }
  async function click(selector, expectedName, expectedPayload = {}) {
    await stable(); const offset = actions.length;
    await evaluate(s => document.querySelector(s).click(), selector);
    await until(() => actions.length > offset, expectedName); await stable();
    assert.deepEqual(actions.slice(offset), [{ name: expectedName, payload: expectedPayload }]); checks.push('IPC ' + expectedName);
  }
  try {
    controller.github.managed = { version: 1, operations: {}, history: [], repositories: {
      [repository]: { repository, branch: 'main', configDigest: 'fixture-digest', schemaVersion: 2, upgraded: true, config,
        nativeRetentionDays: 3, actionsEnabled: true, workflows: [], lastScheduledRun: null, maintenance: {} },
    }, accounts: { [repository + '/' + A]: rowA, [repository + '/' + B]: rowB } };
    controller.state = { ...original, busy: false, stage: 'idle', github: { login: 'quickdeploy-fixture', id: 99 }, error: '', errorInfo: null,
      accounts: [{ accountKey: A, email: rowA.email, repository }, { accountKey: B, email: rowB.email, repository }], resumeTasks: [], activeTaskId: '' };
    controller.changed();
    await until(() => evaluate(() => document.querySelectorAll('.mg-card').length === 2), 'two managed cards');
    const inspection = await evaluate(({ A, B }) => {
      const a = document.querySelector('[data-mg-account="' + A + '"]'); const b = document.querySelector('[data-mg-account="' + B + '"]');
      return { count: document.getElementById('mg-count').textContent, a: a.innerText, b: b.innerText,
        statusA: a.querySelector('.mg-badge').textContent, statusB: b.querySelector('.mg-badge').textContent,
        maintenance: document.getElementById('mg-repositories').innerText,
        width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 2 };
    }, { A, B });
    check(inspection.count === '2' && inspection.statusA === '今日签到成功', 'Today success is based on same-day receipt');
    check(inspection.statusB !== '今日签到成功' && inspection.b.includes('未获取'), 'Yesterday success and credit are not shown as today');
    check(inspection.a.includes('18:37') && inspection.a.includes('22:13') && inspection.a.includes('411'), 'Per-account multi-time settings and decrypted balances are visible');
    check(inspection.maintenance.includes('尚未观察到 schedule') && inspection.maintenance.includes('尚未运行'), 'Configured schedules and never-run maintenance do not pretend to be verified');
    check(inspection.maintenance.includes('已确认 3 天') && !inspection.overflow, 'Retention confirmation and layout fit the window');
    for (const [id, name] of [['mg-upgrade-all','manage.upgradeAll'],['mg-checkin-all','manage.checkinAll'],['mg-status-all','manage.statusAll'],['mg-refresh','manage.refresh'],['mg-details','manage.details']]) await click('#' + id, name);
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
    check(await evaluate(() => !document.querySelector('.mg-card h3 img')), 'Account notes are text, not executable markup');
    if (outputDirectory) {
      fs.mkdirSync(outputDirectory, { recursive: true });
      await evaluate(() => document.getElementById('mg-section').scrollIntoView());
      fs.writeFileSync(path.join(outputDirectory, 'management-panel.png'), (await window.webContents.capturePage()).toPNG());
    }
    return { ok: true, checks, fixtureAccounts: 2, noCloudWrites: true };
  } finally { controller.github.managed = managed; controller.state = original; controller.changed(); }
}
module.exports = { runManagementRendererRegression };
