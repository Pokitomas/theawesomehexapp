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

for (const id of ['maker-request', 'maker-protect', 'maker-proof', 'send-command', 'copy-receipt', 'reset-maker', 'repo-head', 'open-issues', 'open-prs', 'state-status', 'receipt-preview']) {
  assert.ok(html.includes(`id="${id}"`), `missing maker control ${id}`);
}
for (const mode of MODES) assert.ok(html.includes(`data-mode="${mode}"`), `missing maker mode ${mode}`);
assert.ok(html.includes('apple-mobile-web-app-capable'));
assert.ok(html.includes('rel="manifest"'));
assert.ok(html.includes('viewport-fit=cover'));
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
  { number: 218, title: 'Phone maker', html_url: 'https://github.com/Pokitomas/theawesomehexapp/issues/218' },
  { number: 217, title: 'Replay repair', html_url: 'https://github.com/Pokitomas/theawesomehexapp/pull/217', pull_request: {} },
  { number: 216, title: 'Drain proof', html_url: 'https://github.com/Pokitomas/theawesomehexapp/pull/216', pull_request: {} },
  { number: 215, title: 'Generation termination', html_url: 'https://github.com/Pokitomas/theawesomehexapp/issues/215' }
];
const state = normalizeRepositoryState({ sha: '634a511f68e80db708d890a86f757332819f1e5c' }, issuesPayload);
assert.equal(state.short_head, '634a511f68e8');
assert.equal(state.open_issues, 2);
assert.equal(state.open_pull_requests, 2);
assert.equal(state.active[1].kind, 'pull_request');

const calls = [];
const fetched = await fetchRepositoryState(async url => {
  calls.push(url);
  if (url.endsWith('/commits/main')) return { ok: true, status: 200, json: async () => ({ sha: '634a511f68e80db708d890a86f757332819f1e5c' }) };
  if (url.includes('/issues?state=open&per_page=100')) return { ok: true, status: 200, json: async () => issuesPayload };
  throw new Error(`unexpected URL ${url}`);
});
assert.equal(calls.length, 2);
assert.deepEqual(fetched, state);

await assert.rejects(
  fetchRepositoryState(async url => url.endsWith('/commits/main')
    ? { ok: false, status: 403, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => [] }),
  /main state unavailable \(403\)/
);

console.log('maker console contract ok: phone-safe founder intent becomes a deterministic credential-free GitHub command');
