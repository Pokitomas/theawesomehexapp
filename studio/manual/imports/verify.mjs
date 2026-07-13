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

for (const relative of [
  'imports/registry.js',
  'imports/runtime.js',
  'imports/apply.py',
  'product/import-studio.js',
  'product/import-studio.css'
]) assert.equal(await exists(resolve(source, relative)), true, `missing source: ${relative}`);

for (const relative of [
  'imports/registry.js',
  'imports/runtime.js',
  'import-studio.js',
  'import-studio.css',
  'index.html'
]) assert.equal(await exists(resolve(manual, relative)), true, `missing built file: ${relative}`);

for (const path of [
  resolve(source, 'imports/registry.js'),
  resolve(source, 'imports/runtime.js'),
  resolve(source, 'product/import-studio.js'),
  resolve(manual, 'imports/registry.js'),
  resolve(manual, 'imports/runtime.js'),
  resolve(manual, 'import-studio.js')
]) checkJS(path);

const html = await readFile(resolve(manual, 'index.html'), 'utf8');
assert.match(html, /data-import-workbench/);
assert.equal((html.match(/import-studio\.css/g) || []).length, 1, 'stylesheet injected more than once');
assert.equal((html.match(/import-studio\.js/g) || []).length, 1, 'script injected more than once');

const runtimeText = await readFile(resolve(source, 'imports/runtime.js'), 'utf8');
for (const contract of [
  "const DB_NAME = 'sideways-manual-corpus-v1'",
  "const RECORD_STORE = 'records'",
  'new AbortController()',
  'navigator.storage?.estimate',
  'navigator.storage?.persist',
  'this.chunkSize',
  "window.dispatchEvent(new CustomEvent('sideways:import-complete'"
]) assert.ok(runtimeText.includes(contract), `runtime contract missing: ${contract}`);

for (const forbidden of ['riskFloor', 'deep_saturation', 'scoreCandidate', 'updateLoads', 'diversifiedRank']) {
  assert.equal(runtimeText.includes(forbidden), false, `import runtime duplicated kernel logic: ${forbidden}`);
}

const { createDefaultRegistry } = await import(`${pathToFileURL(resolve(source, 'imports/registry.js')).href}?verify=${Date.now()}`);
const registry = createDefaultRegistry();
const ids = registry.list().map(adapter => adapter.id);
assert.deepEqual(ids, [
  'x-archive',
  'reddit-export',
  'mastodon-outbox',
  'bookmarks-html',
  'rss-atom',
  'json-lines',
  'csv',
  'plain-text'
]);

const fake = (name, type = '') => ({ name, type, size: 10, lastModified: 1 });
assert.equal(registry.find(fake('tweets.js'), 'window.YTD.tweets.part0 = []').id, 'x-archive');
assert.equal(registry.find(fake('outbox.json'), '{"orderedItems":[]}').id, 'mastodon-outbox');
assert.equal(registry.find(fake('Bookmarks.html'), '<!DOCTYPE NETSCAPE-Bookmark-file-1>').id, 'bookmarks-html');
assert.equal(registry.find(fake('feed.xml'), '<rss>').id, 'rss-atom');
assert.equal(registry.find(fake('records.jsonl')).id, 'json-lines');
assert.equal(registry.find(fake('records.csv', 'text/csv')).id, 'csv');
assert.equal(registry.find(fake('notes.txt', 'text/plain')).id, 'plain-text');

console.log(JSON.stringify({ adapters: ids, indexedDB: DBContract(runtimeText), workbench: true }, null, 2));

function DBContract(text) {
  return text.includes("sideways-manual-corpus-v1") && text.includes("RECORD_STORE = 'records'");
}
