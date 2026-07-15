import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MAKER_VERSION,
  MODES,
  REPOSITORY,
  buildIssueBody,
  buildIssueTitle,
  buildIssueUrl,
  createDraftStorage,
  fetchRepositoryState,
  hasSecretLikeMaterial,
  normalizeIntent,
  normalizeRepositoryState,
  stableReceipt
} from '../../maker/maker.js';

const html = fs.readFileSync('maker/index.html', 'utf8');
const css = fs.readFileSync('maker/maker.css', 'utf8');
const manifest = JSON.parse(fs.readFileSync('maker/manifest.webmanifest', 'utf8'));
const worker = fs.readFileSync('maker/sw.js', 'utf8');
const icon = fs.readFileSync('maker/icon.svg', 'utf8');

for (const id of [
  'maker-request', 'maker-protect', 'maker-proof', 'send-command', 'copy-receipt', 'reset-maker',
  'repo-head', 'open-issues', 'open-prs', 'running-workflows', 'active-work', 'workflow-runs',
  'state-status', 'receipt-preview'
]) assert.ok(html.includes(`id="${id}"`), `missing maker control ${id}`);
for (const mode of MODES) assert.ok(html.includes(`data-mode="${mode}"`), `missing maker mode ${mode}`);
assert.ok(html.includes('apple-mobile-web-app-capable'));
assert.ok(html.includes('rel="manifest"'));
assert.ok(html.includes('viewport-fit=cover'));
assert.ok(html.includes('Live engineering'));
assert.ok(html.includes('OPEN WORK'));
assert.ok(html.includes('ACTIONS'));
assert.ok(!html.includes('../founder/'), 'maker must not expose founder consumer/taste surfaces');
assert.ok(!html.includes('OPEN SIDEWAYS'), 'maker must not contain consumer product navigation');
assert.ok(css.includes('@media (max-width: 520px)'));
assert.ok(css.includes('min-height: 56px'));
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, './');
assert.ok(manifest.icons.some(entry => entry.src === './icon.svg'));
assert.ok(worker.includes("url.origin !== self.location.origin"), 'service worker must ignore cross-origin GitHub traffic');
assert.ok(worker.includes("request.mode === 'navigate'"));
assert.ok(icon.startsWith('<svg'));

const normalized = normalizeIntent({
  mode: 'EXPLORE',
  request: '  Make the app feel alive.  ',
  protect: '  Keep private imports private.  ',
  proof: '  Show the 390x844 journey.  ',
  ignored: 'nope'
});
assert.deepEqual(normalized, {
  version: MAKER_VERSION,
  repository: REPOSITORY,
  mode: 'explore',
  request: 'Make the app feel alive.',
  protect: 'Keep private imports private.',
  proof: 'Show the 390x844 journey.',
  device_requirement: 'phone-first',
  authority: {
    human_merge_required: true,
    human_deploy_required: true,
    browser_credentials: 'none'
  }
});
assert.equal(normalizeIntent({ mode: 'invent' }).mode, 'build');

const receipt = stableReceipt(normalized);
assert.equal(receipt, stableReceipt(JSON.parse(receipt)));
assert.ok(receipt.endsWith('\n'));
assert.ok(buildIssueTitle(normalized).startsWith('[maker:explore] Make the app feel alive.'));
assert.ok(buildIssueBody(normalized).includes('This command was created by the static Sideways Maker phone surface.'));

const issueUrl = new URL(buildIssueUrl(normalized));
assert.equal(issueUrl.origin, 'https://github.com');
assert.equal(issueUrl.pathname, '/Pokitomas/theawesomehexapp/issues/new');
assert.ok(issueUrl.searchParams.get('title').startsWith('[maker:explore]'));
const issueBody = issueUrl.searchParams.get('body');
assert.ok(issueBody.includes('Keep private imports private.'));
assert.ok(issueBody.includes('"browser_credentials": "none"'));
assert.ok(!issueUrl.searchParams.has('token'));
assert.throws(() => buildIssueUrl({ request: '' }), /founder request is required/i);

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

const brokenStorage = createDraftStorage({
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); }
});
assert.deepEqual(brokenStorage.load(), normalizeIntent());
assert.equal(brokenStorage.save(normalized), false);
assert.equal(brokenStorage.clear(), false);

const issuesPayload = [
  { number: 219, title: 'Phone maker', updated_at: '2026-07-15T05:00:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/pull/219', pull_request: {} },
  { number: 218, title: 'Maker issue', updated_at: '2026-07-15T04:59:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/issues/218' },
  { number: 217, title: 'Replay repair', updated_at: '2026-07-15T04:58:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/pull/217', pull_request: {} },
  { number: 215, title: 'Generation termination', updated_at: '2026-07-15T04:57:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/issues/215' }
];
const runsPayload = {
  workflow_runs: [
    { id: 3, name: 'Phone Maker', status: 'in_progress', conclusion: null, event: 'pull_request', head_branch: 'agent/phone-maker-console', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:01:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/actions/runs/3' },
    { id: 2, name: 'Authority manifest', status: 'completed', conclusion: 'success', event: 'pull_request', head_branch: 'agent/phone-maker-console', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:00:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/actions/runs/2' },
    { id: 1, name: 'Old failure', status: 'completed', conclusion: 'failure', event: 'push', head_branch: 'main', head_sha: '123456abcdef7890', created_at: '2026-07-15T04:00:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/actions/runs/1' }
  ]
};
const state = normalizeRepositoryState({ sha: '634a511f68e80db708d890a86f757332819f1e5c' }, issuesPayload, runsPayload);
assert.equal(state.short_head, '634a511f68e8');
assert.equal(state.open_issues, 2);
assert.equal(state.open_pull_requests, 2);
assert.equal(state.running_workflows, 1);
assert.equal(state.active.length, 4, 'all returned open work must remain visible');
assert.equal(state.runs.length, 3, 'all returned recent workflows must remain visible');
assert.equal(state.active[0].kind, 'pull_request');
assert.equal(state.runs[1].conclusion, 'success');

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

await assert.rejects(
  fetchRepositoryState(async url => url.endsWith('/commits/main')
    ? { ok: false, status: 403, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => url.includes('/actions/runs') ? { workflow_runs: [] } : [] }),
  /main state unavailable \(403\)/
);

console.log('maker console contract ok: compact phone command shows every returned open object and recent workflow run');
