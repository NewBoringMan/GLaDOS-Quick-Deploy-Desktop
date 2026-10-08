'use strict';

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const KEY = /^[A-F0-9]{16}$/;
const PLANS = new Set(['off', 'plan100', 'plan200', 'plan500']);
const OFFSET = 8 * 3600000;
const VERSION = '1.2.0';

function fail(message) { throw Object.assign(new Error(message), { code: 'INVALID_CONFIGURATION', stage: 'configuration' }); }
function normalizeTimes(value, fallback = ['09:30']) {
  const input = value === undefined ? fallback : typeof value === 'string' ? value.split(/[,，\s]+/).filter(Boolean) : value;
  if (!Array.isArray(input) || !input.length || input.length > 6 || input.some(x => typeof x !== 'string' || !TIME.test(x))) fail('每个账号须设置 1–6 个有效时间（HH:mm）。');
  return [...new Set(input)].sort();
}
function plan(value = 'plan500') { if (!PLANS.has(value)) fail('积分兑换方案无效。'); return value; }
function toCron(time) {
  if (!TIME.test(time || '')) fail('时间格式应为 HH:mm。');
  const [h, m] = time.split(':').map(Number);
  return `${m} ${(h + 16) % 24} * * *`;
}
function businessDate(now = Date.now()) {
  const time = Number(new Date(now));
  if (!Number.isFinite(time)) fail('日期无效。');
  return new Date(time + OFFSET).toISOString().slice(0, 10);
}
function nextOccurrence(times, now = Date.now()) {
  const t = Number(new Date(now)); const date = businessDate(t);
  return Math.min(...normalizeTimes(times).map(time => {
    let x = Date.parse(`${date}T${time}:00+08:00`);
    if (x <= t) x += 86400000;
    return x;
  }));
}
function normalizeManifest(raw) {
  if (!raw || ![1, 2].includes(raw.schemaVersion) || !Array.isArray(raw.accounts) || raw.accounts.length > 100) fail('云端配置版本不兼容；原配置未被覆盖。');
  const defaults = raw.schemaVersion === 1
    ? { times: normalizeTimes(raw.time), exchangePlan: plan(raw.exchangePlan) }
    : { times: normalizeTimes(raw.defaults?.times), exchangePlan: plan(raw.defaults?.exchangePlan) };
  const seen = new Set();
  const accounts = raw.accounts.map(account => {
    if (!account || !KEY.test(account.accountKey || '') || seen.has(account.accountKey)) fail('账号标识无效或重复。');
    seen.add(account.accountKey);
    if (account.enabled !== undefined && typeof account.enabled !== 'boolean') fail('账号启用状态无效。');
    return { ...account, accountKey: account.accountKey,
      times: normalizeTimes(account.times, defaults.times), exchangePlan: plan(account.exchangePlan ?? defaults.exchangePlan), enabled: account.enabled !== false };
  });
  if (new Set(accounts.flatMap(a => a.enabled ? a.times : [])).size > 100) fail('单仓库最多支持 100 个不同的触发时点。');
  const maintenance = { retentionDays: 3, cleanupTime: '03:43', cleanupEnabled: true, keepaliveEnabled: true, ...(raw.maintenance || {}) };
  if (maintenance.retentionDays !== 3 || !TIME.test(maintenance.cleanupTime) || typeof maintenance.cleanupEnabled !== 'boolean' || typeof maintenance.keepaliveEnabled !== 'boolean') fail('维护设置无效，历史记录固定保留 3 天。');
  if (raw.timezone && raw.timezone !== 'Asia/Taipei') fail('暂仅支持 Asia/Taipei（UTC+8）；没有擅自转换原时区。');
  return { ...raw, schemaVersion: 2, appVersion: VERSION, defaults, accounts, maintenance, timezone: 'Asia/Taipei',
    time: defaults.times[0], exchangePlan: defaults.exchangePlan };
}
function updateAccounts(raw, keys, patch = {}) {
  const config = normalizeManifest(raw);
  if (!Array.isArray(keys) || !keys.length || keys.length > 100 || new Set(keys).size !== keys.length || keys.some(k => !config.accounts.some(a => a.accountKey === k))) fail('请选择有效的账号。');
  if (Object.keys(patch).some(k => !['times', 'exchangePlan', 'enabled'].includes(k))) fail('包含不支持的账号设置。');
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') fail('账号启用状态无效。');
  config.accounts = config.accounts.map(a => !keys.includes(a.accountKey) ? a : { ...a,
    ...(patch.times !== undefined ? { times: normalizeTimes(patch.times) } : {}),
    ...(patch.exchangePlan !== undefined ? { exchangePlan: plan(patch.exchangePlan) } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) });
  return normalizeManifest(config);
}
function retainedHistory(history = [], now = Date.now()) {
  return history.filter(x => Number.isFinite(Date.parse(x?.observedAt)) && Date.parse(x.observedAt) > now - 72 * 3600000 && Date.parse(x.observedAt) <= now + 60000).slice(-2000);
}
module.exports = { VERSION, TIME, KEY, PLANS, normalizeTimes, plan, toCron, businessDate, nextOccurrence, normalizeManifest, updateAccounts, retainedHistory };
