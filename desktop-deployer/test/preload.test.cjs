'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
function fixture() {
  const ipcRenderer = new EventEmitter();
  const calls = [];
  let api;
  ipcRenderer.invoke = (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject }));
  const electron = { ipcRenderer, contextBridge: { exposeInMainWorld(name, exposed) {
    assert.equal(name, 'quickDeploy'); api = exposed;
  } } };
  vm.runInNewContext(source, { require(name) { assert.equal(name, 'electron'); return electron; } }, { filename: 'preload.cjs' });
  return { api, calls, push: state => ipcRenderer.emit('qd:state', {}, state), ipcRenderer };
}
const snapshot = (snapshotSequence, busy, stage, extra = {}) => ({ snapshotSequence, busy, stage, ...extra });

test('late stop reply cannot overwrite a newer paused batch in either renderer', async () => {
  const f = fixture(); let deployment; let management;
  f.api.onState(state => { deployment = state; });
  f.api.onState(state => { management = state; });
  f.push(snapshot(20, true, 'running', { batch: { status: 'running' } }));
  const stop = f.api.action('manage.stopBatch').then(state => { management = state; });
  f.push(snapshot(22, false, 'idle', { batch: { status: 'paused' } }));
  f.calls[0].resolve(snapshot(21, true, 'running', { batch: { status: 'running' } }));
  await stop;
  for (const state of [deployment, management]) {
    assert.equal(state.snapshotSequence, 22); assert.equal(state.busy, false); assert.equal(state.batch.status, 'paused');
  }
  assert.deepEqual(structuredClone(f.calls.map(call => Array.from(call.args))), [['qd:action', 'manage.stopBatch', {}]]);
});

test('late initial reads and login-update replies preserve a newer cancellation', async () => {
  const f = fixture(); let deployment; let management;
  f.api.onState(state => { deployment = state; });
  f.api.onState(state => { management = state; });
  const initialDeployment = f.api.getState().then(state => { deployment = state; });
  const initialManagement = f.api.getState().then(state => { management = state; });
  const update = f.api.action('relogin', { accountKey: 'A'.repeat(16) }).then(state => { management = state; });
  const old = snapshot(1, true, 'browser_login', { resumeTasks: [{ purpose: 'login_update' }] });
  const cancelled = snapshot(4, false, 'idle', { resumeTasks: [], accounts: [{ conclusion: 'already_checked_in' }], error: '' });
  f.push(cancelled);
  f.calls[2].resolve({ ...old, snapshotSequence: 3 });
  f.calls[0].resolve(old);
  f.calls[1].resolve({ ...old, snapshotSequence: 2 });
  await Promise.all([initialDeployment, initialManagement, update]);
  assert.equal(deployment, cancelled); assert.equal(management, cancelled);
  assert.equal(management.resumeTasks.length, 0); assert.equal(management.accounts[0].conclusion, 'already_checked_in');
  assert.equal(f.calls.length, 3, 'Stale responses must not replay any action or read');
});

test('newer replies advance the cache and older pushed events cannot reverse them', async () => {
  const f = fixture(); const observed = [];
  const unsubscribe = f.api.onState(state => observed.push(state));
  f.push(snapshot(7, true, 'deploying'));
  const pending = f.api.action('manage.refresh');
  const completed = snapshot(9, false, 'completed');
  f.calls[0].resolve(completed);
  assert.equal(await pending, completed);
  f.push(snapshot(8, true, 'awaiting_result'));
  assert.equal(observed.at(-1), completed);
  f.push(snapshot(10, false, 'idle'));
  assert.equal(observed.at(-1).snapshotSequence, 10);
  unsubscribe(); const count = observed.length;
  f.push(snapshot(11, true, 'running'));
  assert.equal(observed.length, count); assert.equal(f.ipcRenderer.listenerCount('qd:state'), 0);
});

test('unversioned input cannot replace verified state and a new preload starts fresh', async () => {
  const f = fixture(); let current;
  f.api.onState(state => { current = state; });
  f.push({ stage: 'idle' }); assert.equal(current.stage, 'idle');
  const verified = snapshot(100, false, 'completed'); f.push(verified);
  for (const state of [undefined, null, { stage: 'browser_login' }, snapshot(-1, true, 'running'), snapshot(NaN, true, 'running'), snapshot(Infinity, true, 'running')]) {
    f.push(state); assert.equal(current, verified);
  }
  const restarted = fixture(); let fresh;
  restarted.api.onState(state => { fresh = state; }); restarted.push(snapshot(1, false, 'idle'));
  assert.equal(fresh.snapshotSequence, 1);
});

test('invoke rejections remain errors and invalid subscriptions remain rejected', async () => {
  const f = fixture();
  assert.throws(() => f.api.onState(null), /callback must be a function/);
  const result = f.api.action('invalid'); const error = new Error('IPC rejected');
  f.calls[0].reject(error);
  await assert.rejects(result, failure => failure === error);
});
