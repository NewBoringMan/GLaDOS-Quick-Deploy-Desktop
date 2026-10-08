'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { normalizeManifest, toCron } = require('./schedule-config.cjs');
const { UPSTREAM_REPOSITORY, UPSTREAM_SHA, WORKFLOW_PATH, KEEPALIVE_PATH, MANIFEST_PATH } = require('./workflow.cjs');
const CLEANUP_FILE = 'glados-quick-deploy-cleanup.yml';
const CLEANUP_PATH = '.github/workflows/' + CLEANUP_FILE;
const UPLOAD = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
const DOWNLOAD = 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093';
const CHECKOUT = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';
const PYTHON = 'actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1';
const ex = value => '${{ ' + value + ' }}';

function mainWorkflow(raw) {
  const config = normalizeManifest(raw);
  const times = [...new Set(config.accounts.flatMap(a => a.enabled ? a.times : []))].sort();
  const scheduled = times.length ? '  schedule:\n' + times.map(t => `    - cron: '${toCron(t)}'`).join('\n') + '\n' : '';
  return `name: GLaDOS Quick Deploy
run-name: GLaDOS Quick Deploy · ${ex("inputs.deployment_id || github.event_name")} · ${ex("inputs.account_key || 'all'")}
on:
${scheduled}  workflow_dispatch:
    inputs:
      deployment_id:
        description: Idempotent request identifier
        type: string
        default: ''
      account_key:
        description: Anonymous account key; empty selects all enabled accounts
        type: string
        default: ''
      operation:
        description: checkin sends a check-in; status only reads account information
        type: choice
        options: [checkin, status]
        default: checkin
permissions:
  contents: read
  actions: read
concurrency:
  group: glados-quick-deploy
  cancel-in-progress: false
  queue: max
jobs:
  prepare:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    outputs:
      matrix: ${ex('steps.select.outputs.matrix')}
      has_accounts: ${ex('steps.select.outputs.has_accounts')}
      operation: ${ex('steps.select.outputs.operation')}
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - uses: ${PYTHON}
        with:
          python-version: '3.11'
      - name: Select accounts and read confirmed recent receipts
        id: select
        env:
          GH_TOKEN: ${ex('github.token')}
          GQD_DEFAULT_BRANCH: ${ex('github.event.repository.default_branch')}
          GQD_OPERATION: ${ex("inputs.operation || 'checkin'")}
          GQD_TARGET_ACCOUNT: ${ex('inputs.account_key')}
          GQD_SCHEDULE: ${ex('github.event.schedule')}
        run: python .github/glados/runner.py prepare
      - uses: ${UPLOAD}
        if: steps.select.outputs.has_accounts == 'true'
        with:
          name: gqd-history-${ex('github.run_id')}-${ex('github.run_attempt')}
          path: gqd-history/history.json
          retention-days: 3
          if-no-files-found: error
  checkin:
    needs: prepare
    if: needs.prepare.outputs.has_accounts == 'true'
    name: Account ${ex('matrix.account')}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      max-parallel: 1
      fail-fast: false
      matrix: ${ex('fromJSON(needs.prepare.outputs.matrix)')}
    env:
      GQD_ACCOUNT_KEY: ${ex('matrix.account')}
      GQD_OPERATION: ${ex('needs.prepare.outputs.operation')}
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - name: Read verified upstream
        uses: ${CHECKOUT}
        with:
          repository: ${UPSTREAM_REPOSITORY}
          ref: ${UPSTREAM_SHA}
          path: upstream
          persist-credentials: false
      - uses: ${PYTHON}
        with:
          python-version: '3.11'
      - name: Install upstream dependencies
        run: python -m pip install --disable-pip-version-check --no-cache-dir -r upstream/requirements.txt
      - uses: ${DOWNLOAD}
        with:
          name: gqd-history-${ex('github.run_id')}-${ex('github.run_attempt')}
          path: gqd-history
      - name: Prepare exact account operation
        id: preflight
        env:
          GQD_ACCOUNT_JSON: ${ex("secrets[format('GLADOS_ACCOUNT_{0}', matrix.account)]")}
        run: python .github/glados/runner.py preflight
      - name: Save durable operation intent before side effects
        if: steps.preflight.outputs.side_effects == 'true'
        uses: ${UPLOAD}
        with:
          name: gqd-intent-${ex('matrix.account')}-${ex('github.run_id')}-${ex('github.run_attempt')}
          path: gqd-intent/receipt.json
          retention-days: 3
          if-no-files-found: error
      - name: Check in or refresh account information
        env:
          GQD_ACCOUNT_JSON: ${ex("secrets[format('GLADOS_ACCOUNT_{0}', matrix.account)]")}
          PYTHONIOENCODING: utf-8
        run: python .github/glados/runner.py run
      - name: Publish anonymous receipt and encrypted details
        if: always() && steps.preflight.outcome == 'success'
        uses: ${UPLOAD}
        with:
          name: gqd-result-${ex('matrix.account')}-${ex('github.run_id')}-${ex('github.run_attempt')}
          path: gqd-output/
          retention-days: 3
          if-no-files-found: error
`;
}
function cleanupWorkflow(raw) {
  const c = normalizeManifest(raw);
  return `name: GLaDOS Quick Deploy Cleanup
run-name: GLaDOS Quick Deploy Cleanup · ${ex("inputs.deployment_id || github.event_name")}
on:
${c.maintenance.cleanupEnabled ? `  schedule:\n    - cron: '${toCron(c.maintenance.cleanupTime)}'\n` : ''}  workflow_dispatch:
    inputs:
      deployment_id:
        description: Idempotent cleanup request identifier
        type: string
        default: ''
permissions:
  contents: read
  actions: write
concurrency:
  group: glados-quick-deploy-cleanup
  cancel-in-progress: false
jobs:
  cleanup:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - uses: ${PYTHON}
        with:
          python-version: '3.11'
      - name: Clean managed history older than 72 hours
        env:
          GH_TOKEN: ${ex('github.token')}
        run: python .github/glados/cleanup.py
`;
}
function keepaliveWorkflow(raw) {
  const c = normalizeManifest(raw);
  return `name: GLaDOS Quick Deploy Keepalive
on:
${c.maintenance.keepaliveEnabled ? "  schedule:\n    - cron: '23 3 1 * *'\n" : ''}  workflow_dispatch:
permissions:
  contents: write
concurrency:
  group: glados-quick-deploy-keepalive
  cancel-in-progress: false
jobs:
  keepalive:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: ${CHECKOUT}
      - name: Record repository activity
        env:
          BRANCH: ${ex('github.event.repository.default_branch')}
        run: |
          date -u +'%Y-%m-%dT%H:%M:%SZ' > .github/glados-last-active.txt
          git config user.name 'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          git add .github/glados-last-active.txt
          git diff --staged --quiet && exit 0
          git commit -m 'chore: keep GLaDOS schedule active [skip ci]'
          git pull --rebase origin "$BRANCH"
          git push origin "HEAD:$BRANCH"
          echo 'Repository activity timestamp saved; this does not refresh GLaDOS login.' >> "$GITHUB_STEP_SUMMARY"
`;
}
function deploymentFiles(raw) {
  const c = normalizeManifest(raw);
  const files = { [MANIFEST_PATH]: JSON.stringify(c, null, 2) + '\n', [WORKFLOW_PATH]: mainWorkflow(c),
    [CLEANUP_PATH]: cleanupWorkflow(c), [KEEPALIVE_PATH]: keepaliveWorkflow(c) };
  for (const name of ['common.py', 'runner.py', 'cleanup.py', 'encrypt.cjs']) files['.github/glados/' + name] = fs.readFileSync(path.join(__dirname, 'cloud', name), 'utf8');
  return files;
}
module.exports = { deploymentFiles, mainWorkflow, cleanupWorkflow, keepaliveWorkflow, CLEANUP_FILE, CLEANUP_PATH };
