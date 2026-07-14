import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  candidateMaterializationPlan,
  legacyNetworkCacheSeeds,
  mergeNetworkCache,
  networkViewSnapshot
} from '../product/network-records.js';

const files = {
  core: 'netlify/functions/social-core.mjs',
  function: 'netlify/functions/social.mjs',
  client: 'studio/manual/product/social-client.js',
  network: 'studio/manual/product/network-records.js',
  db: 'studio/manual/product/workspace-db.js',
  actions: 'studio/manual/product/actions.js',
  workspace: 'studio/manual/product/workspace.js',
  survival: 'studio/manual/product/survival-ledger.js',
  apply: 'studio/manual/apply.py',
  importApply: 'studio/manual/imports/apply.py',
  netlify: 'netlify.toml'
};
const source = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, fs.readFileSync(path, 'utf8')]));
for (const key of ['core', 'function', 'client', 'network', 'db', 'actions', 'workspace']) {
  const check = spawnSync(process.execPath, ['--check', files[key]], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error(`${files[key]} syntax failed\n${check.stderr}`);
}
const requireAll = (key, tokens) => tokens.forEach(token => { if (!source[key].includes(token)) throw new Error(`${files[key]} missing ${token}`); });
const forbidAll = (key, tokens) => tokens.forEach(token => { if (source[key].includes(token)) throw new Error(`${files[key]} contains forbidden ${token}`); });
requireAll('core', ['HttpOnly', 'SameSite=Lax', 'scryptSync', 'timingSafeEqual', 'social/event/', 'post.replied', 'follow.created', 'like.created']);
requireAll('client', ["credentials: 'same-origin'", 'Workspace.projectNetworkPosts', 'dataset.socialSpine', 'window.SidewaysSocial']);
forbidAll('client', ['Workspace.saveProfile', "localStorage.setItem('sideways_session", 'new MutationObserver', 'location.reload()']);
requireAll('network', [
  "const PREFIX = 'network:'",
  "authority: 'public'",
  'mergeNetworkCache',
  'legacyNetworkCacheSeeds',
  'networkViewSnapshot',
  'candidateMaterializationPlan',
  "ledgerEntry('network.materialize'",
  'authoritativeDeletes: 0',
  'sideways:network',
  'rank: {}'
]);
forbidAll('network', ["ledgerEntry('network.project'"]);
requireAll('db', [
  'WORKSPACE_VERSION = 2',
  "NETWORK_RECORD_STORE = 'networkRecords'",
  "NETWORK_VIEW_STORE = 'networkViews'",
  'db.onversionchange = () => db.close()',
  'request.onblocked'
]);
requireAll('workspace', ['projectNetworkPosts', 'networkRecords']);
requireAll('survival', ["startsWith('network:')", 'user-owned Ark excludes server projections']);
for (const id of ['social.join', 'social.login', 'social.logout', 'social.post', 'social.follow', 'social.feed', 'social.discover']) requireAll('actions', [`'${id}'`]);
requireAll('apply', ['social-client.css', 'social-client.js', 'network-records.js', 'data-social-spine']);
requireAll('importApply', ['SOCIAL_LIVE_ENDPOINT', 'NETLIFY', 'SOCIAL_STYLE', 'SOCIAL_SCRIPT', 'remove_once']);
requireAll('netlify', ['/api/social', '/.netlify/functions/social']);

const legacyCandidates = [
  { id: 1, nativeId: 'network:A', social: { postId: 'A' }, text: 'old A', updatedAt: '2026-07-13T00:00:00Z' },
  { id: 2, nativeId: 'network:B', social: { postId: 'B' }, text: 'old B', updatedAt: '2026-07-13T00:00:00Z' },
  { id: 3, nativeId: 'import:private', title: 'private archive record' }
];
const migrated = legacyNetworkCacheSeeds(legacyCandidates, '2026-07-14T00:00:00Z');
assert.deepEqual(migrated.map(record => record.postId), ['A', 'B']);
assert.ok(migrated.every(record => record.authority === 'public'));
assert.ok(migrated.every(record => !Object.hasOwn(record, 'id')));

const cached = mergeNetworkCache(migrated, [
  { postId: 'B', nativeId: 'network:B', text: 'new B', authority: 'public' }
]);
assert.deepEqual(cached.map(record => record.postId), ['A', 'B']);
assert.equal(cached.find(record => record.postId === 'A').text, 'old A');
assert.equal(cached.find(record => record.postId === 'B').text, 'new B');

const following = networkViewSnapshot([{ postId: 'B' }], { mode: 'following' }, '2026-07-14T00:00:00.000Z');
assert.deepEqual(following, {
  key: 'following',
  postIds: ['B'],
  observedAt: '2026-07-14T00:00:00.000Z',
  source: 'server'
});

const plan = candidateMaterializationPlan(legacyCandidates, [
  { postId: 'B', nativeId: 'network:B', authority: 'public', social: { postId: 'B' } }
], following);
assert.deepEqual(plan.deleteIds, [1]);
assert.equal(plan.upserts.length, 1);
assert.equal(plan.upserts[0].id, 2);
assert.equal(plan.upserts[0].eligibilitySource, 'following');
assert.ok(!plan.deleteIds.includes(3));
assert.ok(cached.some(record => record.postId === 'A'), 'first v2 view switch must migrate A before removing its active candidate');

console.log('social spine contract ok: legacy public projections migrate into cache; view changes replace candidates without deleting public or private authority');
