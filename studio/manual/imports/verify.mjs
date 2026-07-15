import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
const source = resolve(root, 'studio/manual');
const manual = resolve(root, 'manual-app');

async function exists(path) {
  try { return (await stat(path)).isFile(); }
  catch { return false; }
}

function checkJS(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path}\n${result.stderr}`);
}

const productAssets = [
  'product/import-studio.js',
  'product/import-studio.css',
  'product/import-phone.js',
  'product/add-to-sideways.js',
  'product/add-to-sideways.css',
  'product/discovery-source.js',
  'product/discovery-private-boundary.js',
  'product/account-connections.js'
];
const builtProductAssets = [
  'import-studio.js',
  'import-studio.css',
  'import-phone.js',
  'add-to-sideways.js',
  'add-to-sideways.css',
  'discovery-source.js',
  'discovery-private-boundary.js',
  'account-connections.js'
];
const sourceFiles = [
  'shared/corpus-db.js',
  'imports/registry.js',
  'imports/runtime.js',
  'imports/file-hash.js',
  'imports/hash-worker.js',
  'imports/corpus-writer.js',
  'imports/record-normalizer.js',
  'imports/apply.py',
  ...productAssets
];
for (const relative of sourceFiles) {
  assert.equal(await exists(resolve(source, relative)), true, `missing source: ${relative}`);
}

const builtFiles = [
  'shared/corpus-db.js',
  'imports/registry.js',
  'imports/runtime.js',
  'imports/file-hash.js',
  'imports/hash-worker.js',
  'imports/corpus-writer.js',
  'imports/record-normalizer.js',
  ...builtProductAssets,
  'index.html'
];
for (const relative of builtFiles) {
  assert.equal(await exists(resolve(manual, relative)), true, `missing built file: ${relative}`);
}

for (const relative of sourceFiles.filter(path => /\.(m?js)$/.test(path))) checkJS(resolve(source, relative));
for (const relative of builtFiles.filter(path => /\.(m?js)$/.test(path))) checkJS(resolve(manual, relative));

const html = await readFile(resolve(manual, 'index.html'), 'utf8');
assert.match(html, /data-import-workbench/);
assert.match(html, /data-import-phone/);
assert.match(html, /data-add-to-sideways/);
assert.equal((html.match(/import-studio\.css/g) || []).length, 1, 'stylesheet injected more than once');
assert.equal((html.match(/import-studio\.js/g) || []).length, 1, 'script injected more than once');
assert.equal((html.match(/import-phone\.js/g) || []).length, 1, 'phone script injected more than once');
assert.equal((html.match(/add-to-sideways\.css/g) || []).length, 1, 'Add to Sideways stylesheet injected more than once');
assert.equal((html.match(/add-to-sideways\.js/g) || []).length, 1, 'Add to Sideways script injected more than once');

const runtimeText = await readFile(resolve(source, 'imports/runtime.js'), 'utf8');
for (const contract of [
  'new AbortController()',
  'storageDurability',
  'digestFile',
  'existingKeys',
  'addMediaRecord',
  'this.chunkSize',
  "window.dispatchEvent(new CustomEvent('sideways:import-complete'"
]) assert.ok(runtimeText.includes(contract), `runtime contract missing: ${contract}`);

const dbText = await readFile(resolve(source, 'shared/corpus-db.js'), 'utf8');
for (const contract of [
  "CORPUS_DB = 'sideways-manual-corpus-v1'",
  'CORPUS_VERSION = 2',
  "RECORD_STORE = 'records'",
  "BLOB_STORE = 'blobs'",
  "LEDGER_STORE = 'ledger'",
  "createIndex('assetKey'",
  'storage.persisted',
  'storage.persist'
]) assert.ok(dbText.includes(contract), `corpus contract missing: ${contract}`);

const hashText = await readFile(resolve(source, 'imports/file-hash.js'), 'utf8');
for (const contract of ['FULL_HASH_MAX', 'new Worker', 'sha256-worker', 'sha256-sampled']) {
  assert.ok(hashText.includes(contract), `hash contract missing: ${contract}`);
}

const writerText = await readFile(resolve(source, 'imports/corpus-writer.js'), 'utf8');
for (const contract of ['LEDGER_STORE', 'record.import', 'addMediaRecord', 'addRecords']) {
  assert.ok(writerText.includes(contract), `writer contract missing: ${contract}`);
}

const normalizerText = await readFile(resolve(source, 'imports/record-normalizer.js'), 'utf8');
for (const contract of ['normalizeRecord', 'compatibility', 'sourceMime', 'canonicalMime']) {
  assert.ok(normalizerText.includes(contract), `normalizer contract missing: ${contract}`);
}

for (const forbidden of ['riskFloor', 'deep_saturation', 'scoreCandidate', 'updateLoads', 'diversifiedRank']) {
  assert.equal(runtimeText.includes(forbidden), false, `import runtime duplicated kernel logic: ${forbidden}`);
}

for (const relative of ['product/studio.js', 'product/import-studio.js', 'product/import-phone.js', 'product/add-to-sideways.js']) {
  const text = await readFile(resolve(source, relative), 'utf8');
  assert.equal(text.includes('new MutationObserver'), false, `${relative} reintroduced a global DOM observer`);
  assert.equal(text.includes('location.reload('), false, `${relative} reintroduced page reload`);
}

const addText = await readFile(resolve(source, 'product/add-to-sideways.js'), 'utf8');
for (const label of ['Connect an account', 'Add a website or feed', 'Import files', 'Restore a Sideways backup']) {
  assert.ok(addText.includes(label), `Add to Sideways choice missing: ${label}`);
}
const choices = addText.match(/const CHOICES = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] || '';
assert.equal((choices.match(/Object\.freeze\(\{ id:/g) || []).length, 4, 'Add to Sideways must have exactly four choices');
for (const contract of ['sidewaysImportFiles', 'SidewaysVaultUI.chooseArk', 'Survival.restoreArk', 'separate-from-private-archive']) {
  assert.ok(addText.includes(contract), `Add to Sideways integration missing: ${contract}`);
}

const { createDefaultRegistry } = await import(`${pathToFileURL(resolve(source, 'imports/registry.js')).href}?verify=${Date.now()}`);
const registry = createDefaultRegistry();
const ids = registry.list().map(adapter => adapter.id);
assert.deepEqual(ids, [
  'x-archive',
  'reddit-export',
  'instagram-export',
  'tiktok-export',
  'youtube-takeout',
  'spotify-history',
  'mastodon-outbox',
  'bookmarks-html',
  'rss-atom',
  'json-lines',
  'csv',
  'plain-text'
]);

const fake = (name, type = '', webkitRelativePath = '') => ({ name, type, size: 10, lastModified: 1, webkitRelativePath });
assert.equal(registry.find(fake('tweets.js'), 'window.YTD.tweets.part0 = []').id, 'x-archive');
assert.equal(registry.find(fake('comments.csv'), 'subreddit,permalink,created_utc').id, 'reddit-export');
assert.equal(registry.find(fake('saved_saved_media.json'), '"string_map_data"').id, 'instagram-export');
assert.equal(registry.find(fake('user_data.json'), '"ItemFavoriteList"').id, 'tiktok-export');
assert.equal(registry.find(fake('watch-history.html'), '<a href="https://youtube.com/watch?v=1">').id, 'youtube-takeout');
assert.equal(registry.find(fake('Streaming_History_Audio_2026.json'), '"master_metadata_track_name"').id, 'spotify-history');
assert.equal(registry.find(fake('outbox.json'), '{"orderedItems":[]}').id, 'mastodon-outbox');
assert.equal(registry.find(fake('Bookmarks.html'), '<!DOCTYPE NETSCAPE-Bookmark-file-1>').id, 'bookmarks-html');
assert.equal(registry.find(fake('feed.xml'), '<rss>').id, 'rss-atom');
assert.equal(registry.find(fake('records.jsonl')).id, 'json-lines');
assert.equal(registry.find(fake('records.csv', 'text/csv')).id, 'csv');
assert.equal(registry.find(fake('notes.txt', 'text/plain')).id, 'plain-text');

const discovery = await import(`${pathToFileURL(resolve(source, 'product/discovery-source.js')).href}?verify=${Date.now()}`);
const privateBoundary = await import(`${pathToFileURL(resolve(source, 'product/discovery-private-boundary.js')).href}?verify=${Date.now()}`);
const connections = await import(`${pathToFileURL(resolve(source, 'product/account-connections.js')).href}?verify=${Date.now()}`);
assert.throws(() => discovery.safePublicURL('http://127.0.0.1/feed'));
assert.equal(discovery.boundedFetchPlan('https://example.com/feed').publicCacheBoundary, 'separate-from-private-archive');
const publicRecord = discovery.normalizeDiscoveryRecord({ id: 'one', title: 'One', url: 'https://example.com/one' }, { state: 'web', sourceId: 'example', sourceUrl: 'https://example.com/feed' });
assert.throws(() => privateBoundary.saveDiscoveryRecord(publicRecord), /explicit user action/);
assert.equal(privateBoundary.saveDiscoveryRecord(publicRecord, { explicit: true }).state, 'private');
assert.equal(connections.connectionCapability({ staticDeployment: true, configured: true }).state, 'unavailable');
assert.deepEqual(connections.redactConnection({ access_token: 'no', nested: { cursor: 'yes', refreshToken: 'no' } }), { nested: { cursor: 'yes' } });

console.log(JSON.stringify({
  adapters: ids,
  corpusVersion: 2,
  ledger: true,
  workerHashing: true,
  workbench: true,
  addToSidewaysChoices: 4,
  publicPrivateBoundary: true,
  staticConnectionsFailHonestly: true,
  observerFree: true
}, null, 2));
