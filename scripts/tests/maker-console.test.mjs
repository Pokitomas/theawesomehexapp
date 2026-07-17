import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BACKENDS,
  DEFAULT_REPOSITORY,
  MAKER_CONSOLE_VERSION,
  MAKER_VERSION,
  MODES,
  STORAGE_KEY,
  buildIssueBody,
  buildIssueTitle,
  buildIssueUrl,
  createDraftStorage,
  executionTruth,
  fetchRepositoryState,
  hasSecretLikeMaterial,
  normalizeIntent,
  normalizeRepositoryState,
  stableReceipt,
  validateIntent,
} from '../../maker/maker.js';
import {
  createOperatorCommandPacket,
  createOperatorRuntimeReceipt,
  projectOperatorView,
  verifyOperatorRuntimeReceipt
} from '../maker-archie-operator.mjs';

const html = fs.readFileSync('maker/index.html', 'utf8');
const css = fs.readFileSync('maker/maker.css', 'utf8');
const sharedCss = fs.readFileSync('desktop/desktop.css', 'utf8');
const manifest = JSON.parse(fs.readFileSync('maker/manifest.webmanifest', 'utf8'));
const worker = fs.readFileSync('maker/sw.js', 'utf8');
const icon = fs.readFileSync('maker/icon.svg', 'utf8');

for (const id of [
  'maker-repository', 'maker-base', 'maker-backend', 'maker-request', 'maker-protect', 'maker-proof',
  'send-command', 'copy-receipt', 'reset-maker', 'backend-state', 'tool-state', 'lease-state', 'human-gates',
  'native-model-state', 'repo-head', 'open-issues', 'open-prs', 'running-workflows', 'active-work',
  'workflow-runs', 'state-status', 'receipt-preview', 'archie-runtime', 'archie-sparse', 'archie-planner',
  'archie-confidence', 'archie-route', 'archie-budget', 'archie-teacher', 'archie-learning', 'archie-corpus',
  'archie-sync', 'archie-compute', 'archie-usage', 'archie-storage', 'archie-blockers', 'archie-source',
  'archie-receipt-input', 'archie-apply', 'archie-export-pack', 'archie-import-pack', 'archie-sync-command',
  'archie-clear', 'archie-status', 'archie-command-preview'
]) assert.ok(html.includes(`id="${id}"`), `missing maker control ${id}`);
for (const mode of MODES) assert.ok(html.includes(`data-mode="${mode}"`), `missing maker mode ${mode}`);
for (const backend of BACKENDS) assert.ok(html.includes(`value="${backend}"`), `missing backend ${backend}`);
assert.ok(html.includes('Build software.'));
assert.ok(html.includes('Task author only'));
assert.ok(html.includes('OPEN AUTHORIZED TASK'));
assert.ok(html.includes('Repository, proof, and execution controls'));
assert.ok(html.includes('../desktop/desktop.css'));
assert.ok(html.includes('../desktop/desktop.js'));
assert.ok(!html.includes('SEND TO CO-ENGINEERS'));
assert.ok(!html.includes('SIDEWAYS / DEV / LIVE'));
assert.ok(css.includes('@media (max-width: 520px)'));
assert.ok(css.includes('min-height: 58px'));
assert.ok(sharedCss.includes('@media (max-width: 560px)'));
assert.equal(manifest.name, 'Maker Engineering');
assert.equal(manifest.display, 'standalone');
assert.ok(worker.includes('maker-engineering-v4'));
assert.ok(worker.includes('../desktop/desktop.css'));
assert.ok(worker.includes('../desktop/desktop.js'));
assert.ok(worker.includes('url.origin !== self.location.origin'));
assert.ok(icon.startsWith('<svg'));
assert.equal(STORAGE_KEY, 'maker:engineering:task:v2');
assert.notEqual('maker:archie:receipt:v1', STORAGE_KEY);
assert.ok(css.includes('.archie-console :focus-visible'));
assert.ok(sharedCss.includes('prefers-reduced-motion: reduce'));
assert.ok(!html.includes('<style>'));
assert.ok(!html.includes('Training complete'));
assert.ok(!html.includes('GPU available'));

const archieClock = Date.parse('2026-07-16T07:00:00.000Z');
const archieReceipt = createOperatorRuntimeReceipt({
  route: { sparse: 'miss', planner: 'hit', selected: 'cpu-planner', confidence: 0.81, margin: 0.24 },
  budget: { decision: 'local-first', charged_credits: 0, usage_evidence: 'observed' },
  teacher: { state: 'not-called', reason: 'planner admitted' },
  learning: { lesson: 'stored', retraining: 'complete' },
  corpus: { health: 'healthy', pack: 'verified', pack_digest: 'a'.repeat(64) },
  sync: { state: 'locked', generation: 2 },
  compute: { selected: 'local-cpu', gpu: 'unavailable', linux: 'unavailable', storage: 'available', ladder: [{ kind: 'local_cpu', state: 'available', evidence: 'observed' }] },
  blockers: ['GPU not observed.']
}, { clock: () => archieClock });
assert.equal(verifyOperatorRuntimeReceipt(archieReceipt, { clock: () => archieClock }), true);
const archieView = projectOperatorView(archieReceipt, { clock: () => archieClock });
assert.equal(archieView.route.planner, 'hit');
assert.equal(archieView.execution_claimed_by_browser, false);
const archiePacket = createOperatorCommandPacket('export_pack', {}, { clock: () => archieClock });
assert.equal(archiePacket.execution_claimed, false);
assert.equal(archiePacket.requires_authenticated_runtime, true);
assert.throws(() => createOperatorCommandPacket('sync', { api_key: 'sk-123456789012345678901' }, { clock: () => archieClock }), /secret/i);

const normalized = normalizeIntent({
  repository: 'acme/widgets',
  base_revision: 'abc123',
  backend: 'NATIVE',
  mode: 'EXPLORE',
  request: '  Build a reliable repair loop.  ',
  protect: '  Keep credentials server-side.  ',
  proof: '  Execute failure and repair.  '
});
assert.equal(normalized.version, MAKER_VERSION);
assert.equal(normalized.console_version, MAKER_CONSOLE_VERSION);
assert.equal(normalized.repository, 'acme/widgets');
assert.equal(normalized.base_revision, 'abc123');
assert.equal(normalized.backend, 'native');
assert.equal(normalized.mode, 'explore');
assert.equal(normalized.authority.human_merge_required, true);
assert.equal(normalizeIntent().repository, DEFAULT_REPOSITORY);
assert.equal(validateIntent(normalized).repository, 'acme/widgets');
assert.throws(() => validateIntent({ repository: 'bad', request: 'x' }), /owner\/repository/);
assert.throws(() => validateIntent({ repository: 'a/b', base_revision: 'bad base', request: 'x' }), /Base revision/);

const receipt = stableReceipt(normalized);
assert.equal(receipt, stableReceipt(JSON.parse(receipt)));
assert.ok(buildIssueTitle(normalized).startsWith('[maker:explore] Build a reliable repair loop.'));
const body = buildIssueBody(normalized);
assert.ok(body.includes('repository: `acme/widgets`'));
assert.ok(body.includes('base revision: `abc123`'));
assert.ok(body.includes('The browser did not execute code'));
assert.ok(!body.includes('static Sideways Maker'));
const issueUrl = new URL(buildIssueUrl(normalized));
assert.equal(issueUrl.pathname, '/acme/widgets/issues/new');
assert.ok(!issueUrl.searchParams.has('token'));
assert.throws(() => buildIssueUrl({ repository: 'acme/widgets', request: '' }), /end state/i);

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
assert.equal(executionTruth(normalized, { admitted_native_models: ['candidate:one'] }).native, '1 admitted checkpoint');

const memory = new Map();
const storage = createDraftStorage({
  getItem: key => memory.get(key) || null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: key => memory.delete(key)
});
assert.equal(storage.save(normalized), true);
assert.deepEqual(storage.load(), normalized);
assert.equal(storage.clear(), true);
assert.deepEqual(storage.load(), normalizeIntent());

const issuesPayload = [
  { number: 219, title: 'Maker engine', updated_at: '2026-07-15T05:00:00Z', html_url: 'https://github.com/acme/widgets/pull/219', pull_request: {} },
  { number: 218, title: 'Engineering task', updated_at: '2026-07-15T04:59:00Z', html_url: 'https://github.com/acme/widgets/issues/218' }
];
const runsPayload = { workflow_runs: [
  { id: 3, name: 'Maker runtime', status: 'in_progress', conclusion: null, event: 'pull_request', head_branch: 'maker/task', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:01:00Z', html_url: 'https://github.com/acme/widgets/actions/runs/3' },
  { id: 2, name: 'Verify', status: 'completed', conclusion: 'success', event: 'pull_request', head_branch: 'maker/task', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:00:00Z', html_url: 'https://github.com/acme/widgets/actions/runs/2' }
] };
const state = normalizeRepositoryState('acme/widgets', { sha: '634a511f68e80db708d890a86f757332819f1e5c' }, issuesPayload, runsPayload);
assert.equal(state.repository, 'acme/widgets');
assert.equal(state.open_issues, 1);
assert.equal(state.open_pull_requests, 1);
assert.equal(state.running_workflows, 1);
const calls = [];
const fetched = await fetchRepositoryState('acme/widgets', async url => {
  calls.push(url);
  if (url.endsWith('/commits/main')) return { ok: true, status: 200, json: async () => ({ sha: '634a511f68e80db708d890a86f757332819f1e5c' }) };
  if (url.includes('/issues?state=open&per_page=100')) return { ok: true, status: 200, json: async () => issuesPayload };
  if (url.includes('/actions/runs?per_page=30')) return { ok: true, status: 200, json: async () => runsPayload };
  throw new Error(`unexpected URL ${url}`);
});
assert.equal(calls.length, 3);
assert.ok(calls.every(url => url.includes('/repos/acme/widgets/')));
assert.deepEqual(fetched, state);

console.log('maker engineering console contract ok: result-first task authoring remains separate from execution authority and the shared phone shell is cached');
