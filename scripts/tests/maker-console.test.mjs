import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BACKENDS,
  CONTROL_REPOSITORY,
  DEFAULT_REPOSITORY,
  INTERVENTIONS,
  MAKER_CONSOLE_VERSION,
  MAKER_VERSION,
  MAX_DIRECT_ISSUE_URL,
  MODES,
  RECEIPT_HISTORY_KEY,
  STORAGE_KEY,
  buildDispatch,
  buildInterventionUrl,
  buildIssueBody,
  buildIssueTitle,
  buildIssueUrl,
  createDraftStorage,
  executionTruth,
  fetchRepositoryState,
  hasSecretLikeMaterial,
  normalizeIntent,
  normalizeRepositoryState,
  parseMachineComments,
  stableReceipt,
  validateIntent,
} from '../../maker/maker.js';

const html = fs.readFileSync('maker/index.html', 'utf8');
const css = fs.readFileSync('maker/maker.css', 'utf8');
const manifest = JSON.parse(fs.readFileSync('maker/manifest.webmanifest', 'utf8'));
const worker = fs.readFileSync('maker/sw.js', 'utf8');
const icon = fs.readFileSync('maker/icon.svg', 'utf8');

for (const id of [
  'maker-control-repository', 'maker-repository', 'maker-head-repository', 'maker-base', 'maker-branch', 'maker-backend',
  'maker-request', 'maker-protect', 'maker-proof', 'send-command', 'copy-receipt', 'download-receipt', 'reset-maker',
  'backend-state', 'tool-state', 'lease-state', 'human-gates', 'routing-state', 'dispatch-strategy', 'capability-matrix',
  'native-model-state', 'repo-head', 'open-issues', 'open-prs', 'running-workflows', 'active-work', 'workflow-runs',
  'task-timeline', 'intervention-links', 'recent-receipts', 'state-status', 'receipt-preview', 'target-repo-link',
  'archie-runtime', 'archie-sparse', 'archie-planner', 'archie-confidence', 'archie-route', 'archie-budget',
  'archie-teacher', 'archie-learning', 'archie-corpus', 'archie-sync', 'archie-compute', 'archie-usage', 'archie-storage',
  'archie-blockers', 'archie-source', 'archie-receipt-input', 'archie-apply', 'archie-export-pack', 'archie-import-pack',
  'archie-sync-command', 'archie-clear', 'archie-status', 'archie-command-preview'
]) assert.ok(html.includes(`id="${id}"`), `missing maker control ${id}`);
for (const mode of MODES) assert.ok(html.includes(`data-mode="${mode}"`), `missing maker mode ${mode}`);
for (const backend of BACKENDS) assert.ok(html.includes(`value="${backend}"`), `missing backend ${backend}`);
for (const capability of ['Workspace', 'Files', 'Commands', 'Network', 'Browser', 'GitHub', 'Release']) assert.ok(html.includes(`<dt>${capability}</dt>`));
assert.ok(html.includes('Build software.'));
assert.ok(html.includes('Task author and observer only'));
assert.ok(html.includes('OPEN AUTHORIZED TASK'));
assert.ok(html.includes('OPEN CONTROL REPOSITORY'));
assert.ok(!html.includes('Training complete'));
assert.ok(!html.includes('GPU available'));
assert.ok(css.includes('@media (max-width: 520px)'));
assert.ok(css.includes('min-height: 58px'));
assert.equal(manifest.name, 'Maker Engineering');
assert.equal(manifest.display, 'standalone');
assert.ok(worker.includes('maker-engineering-v4'));
assert.ok(worker.includes('url.origin !== self.location.origin'));
assert.ok(icon.startsWith('<svg'));
assert.equal(STORAGE_KEY, 'maker:engineering:task:v3');
assert.equal(RECEIPT_HISTORY_KEY, 'maker:engineering:receipts:v1');
assert.notEqual('maker:archie:receipt:v1', STORAGE_KEY);
assert.ok(css.includes('.archie-console :focus-visible'));
assert.ok(css.includes('prefers-reduced-motion: reduce'));

const normalized = normalizeIntent({
  repository: 'acme/widgets', head_repository: 'acme/widgets-fork', branch: 'maker/repair-7',
  base_revision: 'abc123', backend: 'NATIVE', mode: 'REPAIR',
  request: '  Build a reliable repair loop.  ', protect: '  Keep credentials server-side.  ', proof: '  Execute failure and repair.  '
});
assert.equal(normalized.version, MAKER_VERSION);
assert.equal(normalized.console_version, MAKER_CONSOLE_VERSION);
assert.equal(normalized.control_repository, CONTROL_REPOSITORY);
assert.equal(normalized.repository, 'acme/widgets');
assert.equal(normalized.target_repository, 'acme/widgets');
assert.equal(normalized.head_repository, 'acme/widgets-fork');
assert.equal(normalized.branch, 'maker/repair-7');
assert.equal(normalized.backend, 'native');
assert.equal(normalized.mode, 'repair');
assert.equal(normalized.authority.human_merge_required, true);
assert.equal(normalizeIntent().repository, DEFAULT_REPOSITORY);
assert.equal(validateIntent(normalized).repository, 'acme/widgets');
assert.throws(() => validateIntent({ repository: 'bad', request: 'x' }), /owner\/repository/);
assert.throws(() => validateIntent({ repository: 'a/b', head_repository: 'bad', request: 'x' }), /Head repository/);
assert.throws(() => validateIntent({ repository: 'a/b', branch: '../bad', request: 'x' }), /Branch/);

const receipt = stableReceipt(normalized);
assert.equal(receipt, stableReceipt(JSON.parse(receipt)));
assert.ok(buildIssueTitle(normalized).startsWith('[maker:repair] Build a reliable repair loop.'));
const body = buildIssueBody(normalized);
assert.ok(body.includes('control repository: `Pokitomas/theawesomehexapp`'));
assert.ok(body.includes('target repository: `acme/widgets`'));
assert.ok(body.includes('head repository: `acme/widgets-fork`'));
assert.ok(body.includes('leased branch: `maker/repair-7`'));
assert.ok(body.includes('The issue is opened in the control repository'));
const issueUrl = new URL(buildIssueUrl(normalized));
assert.equal(issueUrl.pathname, '/Pokitomas/theawesomehexapp/issues/new');
assert.ok(!issueUrl.searchParams.has('token'));
assert.throws(() => buildIssueUrl({ repository: 'acme/widgets', request: '' }), /end state/i);

const direct = buildDispatch(normalized);
assert.equal(direct.strategy, 'direct_issue');
assert.equal(direct.requires_full_receipt_attachment, false);
const large = buildDispatch({ ...normalized, request: 'x'.repeat(8000), protect: 'y'.repeat(4000), proof: 'z'.repeat(4000) });
assert.equal(large.strategy, 'compact_issue_with_receipt');
assert.equal(large.requires_full_receipt_attachment, true);
assert.ok(large.issue_url.length < MAX_DIRECT_ISSUE_URL);
assert.ok(large.receipt.length > MAX_DIRECT_ISSUE_URL);

for (const action of INTERVENTIONS) {
  const url = new URL(buildInterventionUrl(action, normalized));
  assert.equal(url.pathname, '/Pokitomas/theawesomehexapp/issues/new');
  assert.ok(url.searchParams.get('body').includes(`action: \`${action}\``));
  assert.ok(url.searchParams.get('body').includes('did not perform the intervention'));
}
assert.throws(() => buildInterventionUrl('deploy-now', normalized), /Unsupported/);

for (const secret of [
  'ghp_123456789012345678901234567890123456',
  'github_pat_123456789012345678901234567890',
  'sk-123456789012345678901234567890',
  'SIDEWAYS_MODEL_API_KEY=do-not-publish-this-value',
  '-----BEGIN PRIVATE KEY-----'
]) {
  assert.equal(hasSecretLikeMaterial({ repository: 'a/b', request: secret }), true, secret);
  assert.throws(() => buildIssueUrl({ repository: 'a/b', request: secret }), /Secret-like material/);
}
assert.equal(hasSecretLikeMaterial(normalized), false);

const truth = executionTruth({ ...normalized, backend: 'native' });
assert.match(truth.backend, /blocked until checkpoint admission/);
assert.equal(truth.writer, 'One leased branch');
assert.match(truth.tools, /rollback/);
assert.match(truth.routing, /Pokitomas\/theawesomehexapp → acme\/widgets/);
assert.equal(executionTruth(normalized, { admitted_native_models: ['candidate:one'] }).native, '1 admitted checkpoint');

const memory = new Map();
const storage = createDraftStorage({
  getItem: key => memory.get(key) || null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: key => memory.delete(key)
});
assert.equal(storage.save(normalized), true);
assert.deepEqual(storage.load(), normalized);
assert.equal(storage.record(normalized), true);
assert.equal(storage.record({ ...normalized, mode: 'review' }), true);
assert.equal(storage.history().length, 2);
assert.ok([...memory.keys()].every(key => [STORAGE_KEY, RECEIPT_HISTORY_KEY].includes(key)));
assert.equal(storage.clear(), true);
assert.deepEqual(storage.load(), normalizeIntent());

const comments = parseMachineComments([{ id: 5, body: '<!-- sideways-native-worker:v1 -->\n**branch:** maker/issue-7\n**base_sha:** abcdef123456\n**run:** https://github.com/Pokitomas/theawesomehexapp/actions/runs/7' }]);
assert.equal(comments[0].kind, 'worker');
assert.equal(comments[0].branch, 'maker/issue-7');
assert.equal(comments[0].run, 'https://github.com/Pokitomas/theawesomehexapp/actions/runs/7');

const issuesPayload = [
  { number: 219, title: 'Maker engine', updated_at: '2026-07-15T05:00:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/pull/219', pull_request: {} },
  { number: 218, title: '[maker:repair] Engineering task', updated_at: '2026-07-15T04:59:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/issues/218' }
];
const runsPayload = { workflow_runs: [
  { id: 3, name: 'Maker runtime', status: 'in_progress', conclusion: null, event: 'pull_request', head_branch: 'maker/task', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:01:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/actions/runs/3' },
  { id: 2, name: 'Verify', status: 'completed', conclusion: 'success', event: 'pull_request', head_branch: 'maker/task', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:00:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/actions/runs/2' }
] };
const state = normalizeRepositoryState('acme/widgets', { sha: '634a511f68e80db708d890a86f757332819f1e5c' }, issuesPayload, runsPayload, [{ id: 5, body: '**branch:** maker/task\nstarted' }]);
assert.equal(state.control_repository, CONTROL_REPOSITORY);
assert.equal(state.target_repository, 'acme/widgets');
assert.equal(state.open_issues, 1);
assert.equal(state.open_pull_requests, 1);
assert.equal(state.running_workflows, 1);
assert.ok(state.timeline.length >= 5);

const calls = [];
const fetched = await fetchRepositoryState('acme/widgets', async url => {
  calls.push(url);
  if (url.endsWith('/repos/acme/widgets/commits/main')) return { ok: true, status: 200, json: async () => ({ sha: '634a511f68e80db708d890a86f757332819f1e5c' }) };
  if (url.includes('/repos/Pokitomas/theawesomehexapp/issues?state=open')) return { ok: true, status: 200, json: async () => issuesPayload };
  if (url.includes('/repos/Pokitomas/theawesomehexapp/actions/runs?')) return { ok: true, status: 200, json: async () => runsPayload };
  if (url.includes('/repos/Pokitomas/theawesomehexapp/issues/218/comments')) return { ok: true, status: 200, json: async () => [{ id: 5, body: '**branch:** maker/task\nstarted' }] };
  throw new Error(`unexpected URL ${url}`);
});
assert.equal(calls.length, 4);
assert.ok(calls[0].includes('/repos/acme/widgets/'));
assert.ok(calls.slice(1).every(url => url.includes('/repos/Pokitomas/theawesomehexapp/')));
assert.deepEqual(fetched, state);

console.log('maker operator cockpit contract ok: control routing, target identity, long-receipt fallback, evidence timeline, intervention packets, and local namespace are truthful');
