import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ARCHITECTURES,
  MAKER_VERSION,
  MODES,
  REPOSITORY,
  RUNTIMES,
  buildIssueBody,
  buildIssueTitle,
  buildIssueUrl,
  createDraftStorage,
  fetchRepositoryState,
  forgeLifecycle,
  hasSecretLikeMaterial,
  normalizeIntent,
  normalizeRepositoryState,
  nativeWorkerBridge,
  stableReceipt
} from '../../maker/maker.js';

const html = fs.readFileSync('maker/index.html', 'utf8');
const css = fs.readFileSync('maker/maker.css', 'utf8');
const manifest = JSON.parse(fs.readFileSync('maker/manifest.webmanifest', 'utf8'));
const worker = fs.readFileSync('maker/sw.js', 'utf8');
const icon = fs.readFileSync('maker/icon.svg', 'utf8');

for (const id of [
  'maker-request', 'maker-protect', 'maker-proof', 'maker-budget', 'maker-runtime',
  'send-command', 'copy-receipt', 'reset-maker', 'repo-head', 'open-issues', 'open-prs',
  'running-workflows', 'active-work', 'workflow-runs', 'state-status', 'receipt-preview'
]) assert.ok(html.includes(`id="${id}"`), `missing maker control ${id}`);
for (const mode of MODES) assert.ok(html.includes(`data-mode="${mode}"`), `missing maker mode ${mode}`);
for (const architecture of ARCHITECTURES) assert.ok(html.includes(`data-architecture="${architecture}"`), `missing architecture prior ${architecture}`);
for (const runtime of RUNTIMES) assert.ok(html.includes(`value="${runtime}"`), `missing product runtime ${runtime}`);
assert.ok(html.includes('Make it able.'));
assert.ok(html.includes('From brawl to product'));
assert.ok(html.includes('remove temporary installs'));
assert.ok(html.includes('apple-mobile-web-app-capable'));
assert.ok(html.includes('rel="manifest"'));
assert.ok(html.includes('viewport-fit=cover'));
assert.ok(!html.includes('SIDEWAYS / DEV / LIVE'));
assert.ok(!html.includes('Live engineering'));
assert.ok(!html.includes('../founder/'));
assert.ok(css.includes('@media (max-width: 620px)'));
assert.ok(css.includes('@media (max-width: 520px)'));
assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
assert.ok(css.includes('min-height: 54px'));
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, './');
assert.match(manifest.description, /capability forge/i);
assert.equal(manifest.background_color, '#f3f0e8');
assert.ok(manifest.icons.some(entry => entry.src === './icon.svg'));
assert.ok(worker.includes("const CACHE = 'sideways-maker-v3'"));
assert.ok(worker.includes("url.origin !== self.location.origin"));
assert.ok(worker.includes("request.mode === 'navigate'"));
assert.ok(icon.startsWith('<svg'));
assert.ok(icon.includes('#6459ff'));

const normalized = normalizeIntent({
  mode: 'DISTILL',
  request: '  Make the app construct a small native capability.  ',
  protect: '  Keep private imports private.  ',
  proof: '  Show the 390x844 product journey.  ',
  budget_envelope: 1.3,
  architecture_prior: 'STATE-SPACE',
  target_runtime: 'PHONE',
  ignored: 'nope'
});
assert.equal(normalized.version, MAKER_VERSION);
assert.equal(normalized.repository, REPOSITORY);
assert.equal(normalized.mode, 'distill');
assert.equal(normalized.request, 'Make the app construct a small native capability.');
assert.equal(normalized.protect, 'Keep private imports private.');
assert.equal(normalized.proof, 'Show the 390x844 product journey.');
assert.equal(normalized.budget_envelope, 1.3);
assert.equal(normalized.architecture_prior, 'state-space');
assert.equal(normalized.target_runtime, 'phone');
assert.equal(normalized.lifecycle.length, 7);
assert.equal(normalized.lifecycle[0].id, 'crawl');
assert.equal(normalized.lifecycle.at(-1).id, 'clean');
assert.equal(normalized.authority.external_install, 'explicit-operator-only');
assert.equal(normalizeIntent({ mode: 'build' }).mode, 'construct');
assert.equal(normalizeIntent({ mode: 'fix' }).mode, 'repair');
assert.equal(normalizeIntent({ budget_envelope: 999 }).budget_envelope, 1.3);
assert.deepEqual(forgeLifecycle({ architecture_prior: 'recurrent' }).map(item => item.id), [
  'crawl', 'architect', 'lease', 'distill', 'integrate', 'prove', 'clean'
]);

const receipt = stableReceipt(normalized);
assert.equal(receipt, stableReceipt(JSON.parse(receipt)));
assert.ok(receipt.endsWith('\n'));
assert.ok(buildIssueTitle(normalized).startsWith('[maker:explore] Make the app construct'));
const body = buildIssueBody(normalized);
assert.ok(body.includes('## Capability to construct'));
assert.ok(body.includes('architecture prior: state-space'));
assert.ok(body.includes('temporary external installs require an isolated lease'));
assert.ok(body.includes('no merge, deploy, credential, production-data, training-spend'));
assert.ok(body.includes('## Native worker bridge'));
assert.equal(nativeWorkerBridge(normalized).mode, 'explore');
assert.ok(nativeWorkerBridge(normalized).request.includes('Architecture search prior: state-space'));

const issueUrl = new URL(buildIssueUrl(normalized));
assert.equal(issueUrl.origin, 'https://github.com');
assert.equal(issueUrl.pathname, '/Pokitomas/theawesomehexapp/issues/new');
assert.ok(issueUrl.searchParams.get('title').startsWith('[maker:explore]'));
assert.ok(issueUrl.searchParams.get('body').includes('"budget_envelope": 1.3'));
assert.ok(!issueUrl.searchParams.has('token'));
assert.throws(() => buildIssueUrl({ request: '' }), /capability request is required/i);

for (const secret of [
  'ghp_123456789012345678901234567890123456',
  'github_pat_123456789012345678901234567890',
  'sk-123456789012345678901234567890',
  'REMOTE_KEY=do-not-publish-this-value',
  '-----BEGIN PRIVATE KEY-----'
]) {
  assert.equal(hasSecretLikeMaterial({ request: secret }), true, secret);
  assert.throws(() => buildIssueUrl({ request: secret }), /Secret-like material/);
}
assert.equal(hasSecretLikeMaterial(normalized), false);

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

memory.set('sideways:maker:draft:v1', JSON.stringify({
  version: 'sideways-maker/v1',
  mode: 'explore',
  request: 'legacy request',
  protect: '',
  proof: ''
}));
assert.equal(storage.load().mode, 'construct');
assert.equal(storage.load().request, 'legacy request');

const issuesPayload = [
  { number: 219, title: 'Phone maker', updated_at: '2026-07-15T05:00:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/pull/219', pull_request: {} },
  { number: 218, title: 'Maker issue', updated_at: '2026-07-15T04:59:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/issues/218' }
];
const runsPayload = {
  workflow_runs: [
    { id: 3, name: 'Phone Maker', status: 'in_progress', conclusion: null, event: 'pull_request', head_branch: 'agent/phone-maker-console', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:01:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/actions/runs/3' },
    { id: 2, name: 'Authority manifest', status: 'completed', conclusion: 'success', event: 'pull_request', head_branch: 'agent/phone-maker-console', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:00:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/actions/runs/2' }
  ]
};
const state = normalizeRepositoryState({ sha: '634a511f68e80db708d890a86f757332819f1e5c' }, issuesPayload, runsPayload);
assert.equal(state.short_head, '634a511f68e8');
assert.equal(state.open_issues, 1);
assert.equal(state.open_pull_requests, 1);
assert.equal(state.running_workflows, 1);
assert.equal(state.active.length, 2);
assert.equal(state.runs.length, 2);

const calls = [];
const fetched = await fetchRepositoryState(async url => {
  calls.push(url);
  if (url.endsWith('/commits/main')) return { ok: true, status: 200, json: async () => ({ sha: '634a511f68e80db708d890a86f757332819f1e5c' }) };
  if (url.includes('/issues?state=open&per_page=100')) return { ok: true, status: 200, json: async () => issuesPayload };
  if (url.includes('/actions/runs?per_page=30')) return { ok: true, status: 200, json: async () => runsPayload };
  throw new Error(`unexpected URL ${url}`);
});
assert.equal(calls.length, 3);
assert.deepEqual(fetched, state);

console.log('maker capability surface contract ok: phone plan emits architecture brawl, budget, lifecycle, product proof, cleanup authority, and offline shell identity');
