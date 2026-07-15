import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const product = path.join(root, 'studio/manual/product');
const moduleURL = name => `${pathToFileURL(path.join(product, name)).href}?test=${Date.now()}-${Math.random()}`;

const discovery = await import(moduleURL('discovery-source.js'));
const connections = await import(moduleURL('account-connections.js'));
const privateBoundary = await import(moduleURL('discovery-private-boundary.js'));

const record = discovery.normalizeDiscoveryRecord({
  id: 'story-1',
  title: 'Public story',
  url: 'https://example.com/story',
  text: 'Readable on the public web.'
}, {
  state: discovery.CAPABILITY_STATES.WEB,
  sourceId: 'example',
  sourceName: 'Example',
  sourceUrl: 'https://example.com/feed.xml',
  method: 'rss',
  fetchedAt: '2026-07-15T00:00:00.000Z'
});

test('public source validation, classification, collection controls, and request-local materialization stay bounded', () => {
  assert.equal(discovery.safePublicURL('https://example.com/feed.xml#fragment').href, 'https://example.com/feed.xml');
  for (const value of ['file:///etc/passwd', 'http://localhost/feed', 'http://127.0.0.1/feed', 'https://user:pass@example.com/feed', 'https://example.com/?access_token=x']) {
    assert.throws(() => discovery.safePublicURL(value));
  }
  assert.equal(discovery.classifyAddInput('https://example.com/feed.xml'), 'feed');
  assert.equal(discovery.classifyAddInput('https://example.com/sitemap.xml'), 'sitemap');
  assert.equal(discovery.classifyAddInput('https://mastodon.social/api/v1/timelines/public'), 'activitypub');
  assert.equal(discovery.classifyAddInput('https://example.com/page'), 'website');

  const sources = discovery.createSourceCollection();
  sources.add({ id: 'example', name: 'Example', url: 'https://example.com/feed.xml', kind: 'feed' });
  assert.equal(sources.list()[0].enabled, true);
  assert.equal(sources.setEnabled('example', false), true);
  assert.equal(sources.list()[0].enabled, false);
  assert.equal(sources.setEnabled('example', true), true);
  assert.equal(discovery.materializeCandidates([record, record], { enabledSourceIds: ['example'], limit: 200 }).length, 1);
  assert.equal(discovery.materializeCandidates([record], { enabledSourceIds: ['other'] }).length, 0);
  assert.equal(discovery.boundedFetchPlan('https://example.com/feed.xml').publicCacheBoundary, 'separate-from-private-archive');
  assert.equal(sources.remove('example'), true);
});

test('public results cross into the private archive only after an explicit save', () => {
  assert.equal(record.state, 'web');
  assert.throws(() => privateBoundary.saveDiscoveryRecord(record), /explicit user action/);
  const saved = privateBoundary.saveDiscoveryRecord(record, {
    explicit: true,
    savedAt: '2026-07-15T01:00:00.000Z',
    collectionId: 'reading'
  });
  assert.equal(saved.state, 'private');
  assert.equal(saved.privateSave.sourceState, 'web');
  assert.equal(saved.privateSave.collectionId, 'reading');
  assert.equal(privateBoundary.isPrivateDiscoverySave(saved), true);
});

test('static account connections fail honestly and connection receipts redact secret material recursively', () => {
  const catalog = connections.providerCatalog({
    mastodon: {
      clientId: 'public-client-id',
      redirectUri: 'https://sideways.example/oauth/mastodon',
      authorizationEndpoint: 'https://mastodon.example/oauth/authorize'
    }
  });
  assert.equal(catalog.find(provider => provider.id === 'mastodon').configured, true);
  assert.equal(connections.connectionCapability({ staticDeployment: true, configured: true }).state, 'unavailable');
  assert.match(connections.connectionCapability({ staticDeployment: true, configured: true }).reason, /configured server callback/);
  assert.equal(connections.connectionCapability({ staticDeployment: false, configured: true }).state, 'available');

  const redacted = connections.redactConnection({
    provider: 'mastodon',
    access_token: 'never',
    nested: { refreshToken: 'never', cursor: 'ok' },
    pages: [{ authorization: 'never', id: 'one' }]
  });
  assert.equal('access_token' in redacted, false);
  assert.equal('refreshToken' in redacted.nested, false);
  assert.equal(redacted.nested.cursor, 'ok');
  assert.equal('authorization' in redacted.pages[0], false);
  assert.equal(connections.createDisconnectReceipt({ provider: 'mastodon', connectionId: 'c1', revoked: true, deletedServerState: true }).revoked, true);
});

test('connected sync is resumable, deduplicated, cancellable, and recoverable', () => {
  let state = connections.reduceSyncState({ provider: 'reddit' }, { type: 'start' });
  state = connections.reduceSyncState(state, { type: 'page', ids: ['a', 'a', 'b'], cursor: 'two' });
  assert.equal(state.imported, 2);
  state = connections.reduceSyncState(state, { type: 'page', ids: ['b', 'c'], cursor: 'three' });
  assert.equal(state.imported, 3);
  assert.equal(state.cursor, 'three');
  state = connections.reduceSyncState(state, { type: 'cancel' });
  assert.equal(state.status, 'connected');
  state = connections.reduceSyncState(state, { type: 'error', message: 'temporary' });
  assert.equal(state.status, 'error');
  state = connections.reduceSyncState(state, { type: 'start' });
  assert.equal(state.status, 'syncing');
});

test('shipped Add to Sideways assembly has exactly four ordinary choices and reuses importer and Ark ownership', () => {
  const controller = fs.readFileSync(path.join(product, 'add-to-sideways.js'), 'utf8');
  const labels = ['Connect an account', 'Add a website or feed', 'Import files', 'Restore a Sideways backup'];
  for (const label of labels) assert.equal(controller.includes(label), true, `missing choice: ${label}`);
  const choiceBlock = controller.match(/const CHOICES = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] || '';
  assert.equal((choiceBlock.match(/Object\.freeze\(\{ id:/g) || []).length, 4);
  for (const word of ['Web', 'Connected', 'Private', 'Shared']) assert.equal(choiceBlock.includes(`badge: '${word}'`), true);
  assert.match(controller, /sidewaysImportFiles/);
  assert.match(controller, /SidewaysVaultUI\.chooseArk/);
  assert.match(controller, /Survival\.restoreArk/);
  assert.match(controller, /separate-from-private-archive/);
  assert.doesNotMatch(controller, /location\.reload\(/);
  assert.doesNotMatch(controller, /new MutationObserver/);

  const installer = fs.readFileSync(path.join(root, 'studio/manual/imports/apply.py'), 'utf8');
  for (const asset of ['add-to-sideways.js', 'add-to-sideways.css', 'discovery-source.js', 'discovery-private-boundary.js', 'account-connections.js']) {
    assert.equal(installer.includes(asset), true, `installer missing ${asset}`);
  }
  assert.match(installer, /data-add-to-sideways/);
});

test('repository entrypoints run the focused ingestion proof and Pages uses the bounded snapshot builder', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:ingestion'] || '', /web-source-snapshot\.test\.mjs/);
  assert.match(pkg.scripts['test:ingestion'] || '', /discovery-connected-import\.test\.mjs/);
  const pages = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
  assert.match(pages, /npm run test:ingestion/);
  assert.match(pages, /build-web-source-snapshot\.mjs/);
  assert.doesNotMatch(pages, /fetch_wikinews\.py/);
  assert.doesNotMatch(pages, /fetch_forum\.py/);
  assert.doesNotMatch(pages, /fetch_social\.py/);
});
