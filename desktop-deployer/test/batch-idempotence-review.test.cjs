'use strict';
// Independent review regression: never replay a completed cloud request merely
// because the application closed before advancing its local batch index.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ManagementClient } = require('../src/management-client.cjs');
const { normalizeManifest } = require('../src/schedule-config.cjs');
const A = 'AAAAAAAAAAAAAAAA';
const B = 'BBBBBBBBBBBBBBBB';
const REPO = 'owner/repo';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gqd-batch-review-'));
  const client = new ManagementClient({ directory: dir, ghPath: '/fake/gh', reportVault: {} });
  const config = normalizeManifest({ schemaVersion: 1, accounts: [{ accountKey: A }, { accountKey: B }], time: '12:30', exchangePlan: 'plan500' });
  client.inspect = async () => ({ schemaVersion: 2, actionsEnabled: true, branch: 'main', config });
  client.pages = async () => [{ id: 77, status: 'completed', head_branch: 'main', event: 'workflow_dispatch' }];
  let posts = 0;
  client._api = async (_endpoint, options = {}) => {
    if (options.method === 'POST') { posts++; return { workflow_run_id: 88 }; }
    throw new Error('Unexpected API request in isolated regression');
  };
  client.waitOperation = async (_repository, run) => ({ ...run, status: 'completed' });
  return { client, dir, posts: () => posts, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('same durable batch request reuses a completed run after restart without another POST', async () => {
  const f = fixture();
  try {
    const requestId = 'a'.repeat(32);
    f.client.managed.operations[REPO + ':glados-quick-deploy.yml'] = {
      repository: REPO, workflow: 'glados-quick-deploy.yml', requestId,
      operation: 'checkin', accountKey: '', nonce: 'b'.repeat(32),
      runId: 77, status: 'completed', submittedAt: '2026-10-08T09:00:00Z',
    };
    // A persisted batch still points at this repository; the cloud operation was
    // already completed before a crash, but batch.index was not persisted yet.
    const result = await f.client.runOperation(REPO, 'checkin', { requestId });
    assert.equal(f.posts(), 0, 'Resuming the same logical batch must never submit another workflow');
    assert.equal(result.id, 77);
  } finally { f.close(); }
});

test('a genuinely new explicit batch can submit once after the previous batch completed', async () => {
  const f = fixture();
  try {
    f.client.managed.operations[REPO + ':glados-quick-deploy.yml'] = {
      repository: REPO, requestId: 'a'.repeat(32), operation: 'checkin',
      accountKey: '', runId: 77, status: 'completed', submittedAt: '2026-10-08T09:00:00Z',
    };
    const result = await f.client.runOperation(REPO, 'checkin', { requestId: 'c'.repeat(32) });
    assert.equal(f.posts(), 1);
    assert.equal(result.id, 88);
  } finally { f.close(); }
});
