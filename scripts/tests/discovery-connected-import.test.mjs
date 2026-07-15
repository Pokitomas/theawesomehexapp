import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ALLOWED_CONTENT_TYPES,
  CAPABILITY_STATES,
  boundedFetchPlan,
  classifyAddInput,
  createSourceCollection,
  materializeCandidates,
  normalizeDiscoveryRecord,
  safePublicURL
} from '../../studio/manual/product/discovery-source.js';
import {
  buildAuthorizationURL,
  connectionCapability,
  createConnectionState,
  createPKCE,
  providerCatalog,
  redactConnection,
  reduceSyncState,
  validateCallback
} from '../../studio/manual/product/account-connections.js';

test('public source URLs reject credentials, local networks, and non-web protocols', () => {
  assert.equal(safePublicURL('https://example.com/feed#section').href, 'https://example.com/feed');
  for (const value of ['file:///tmp/a', 'https://user:pass@example.com/', 'http://localhost:3000/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://169.254.1.1/']) {
    assert.throws(() => safePublicURL(value));
  }
});

test('add input classification is small and capability-oriented', () => {
  assert.equal(classifyAddInput('https://example.com/'), 'website');
  assert.equal(classifyAddInput('https://example.com/feed.xml'), 'feed');
  assert.equal(classifyAddInput('https://example.com/archive.sideways'), 'backup');
  assert.equal(classifyAddInput('not a source'), 'unknown');
});

test('discovery normalization keeps provenance and tolerates records without URLs', () => {
  const web = normalizeDiscoveryRecord({ title: 'A useful page', text: 'Body', url: 'https://example.com/post' }, { sourceId: 'example', sourceName: 'Example', method: 'rss', fetchedAt: '2026-07-15T00:00:00.000Z' });
  assert.equal(web.schema, 'sideways-discovery-record/v1');
  assert.equal(web.state, CAPABILITY_STATES.WEB);
  assert.equal(web.source.id, 'example');
  assert.equal(web.source.method, 'rss');
  assert.equal(web.canonicalUrl, 'https://example.com/post');

  const local = normalizeDiscoveryRecord({ title: 'No URL note', text: 'Still valid' }, { sourceId: 'fixture', sourceName: 'Fixture' });
  assert.equal(local.source.id, 'fixture');
  assert.equal(local.canonicalUrl, '');
});

test('candidate materialization is request-bounded, source-filtered, and deduplicated', () => {
  const a = normalizeDiscoveryRecord({ id: 'a', title: 'A', url: 'https://a.example/post' }, { sourceId: 'a' });
  const duplicate = normalizeDiscoveryRecord({ id: 'a2', title: 'A again', url: 'https://a.example/post' }, { sourceId: 'a' });
  const b = normalizeDiscoveryRecord({ id: 'b', title: 'B', url: 'https://b.example/post' }, { sourceId: 'b' });
  assert.deepEqual(materializeCandidates([a, duplicate, b], { enabledSourceIds: ['a'], limit: 20 }).map(item => item.id), ['a']);
  assert.deepEqual(materializeCandidates([a, duplicate, b], { limit: 1 }).map(item => item.id), ['a']);
});

test('source collections enable, disable, and remove without touching private records', () => {
  const collection = createSourceCollection();
  const added = collection.add({ url: 'https://example.com/feed.xml' });
  assert.equal(added.kind, 'feed');
  assert.equal(collection.list()[0].enabled, true);
  collection.setEnabled(added.id, false);
  assert.equal(collection.list()[0].enabled, false);
  collection.remove(added.id);
  assert.equal(collection.list().length, 0);
});

test('fetch plans are credential-free and capped', () => {
  const plan = boundedFetchPlan('https://example.com/feed', { records: 9999, bytes: 99_000_000, redirects: 99, timeoutMs: 99_000 });
  assert.equal(plan.credentials, 'omit');
  assert.equal(plan.cache, 'no-store');
  assert.equal(plan.limits.records, 200);
  assert.equal(plan.limits.bytes, 2_000_000);
  assert.equal(plan.limits.redirects, 4);
  assert.equal(plan.limits.timeoutMs, 30_000);
  assert.deepEqual(plan.allowedContentTypes, ALLOWED_CONTENT_TYPES);
});

test('PKCE, state, nonce, callback, and authorization URL contracts are exact', async () => {
  const pkce = await createPKCE();
  assert.equal(pkce.method, 'S256');
  assert.ok(pkce.verifier.length >= 43);
  assert.ok(pkce.challenge.length >= 43);

  const connection = createConnectionState({ providerId: 'reddit', redirectUri: 'https://sideways.example/api/connections/reddit/callback', stateBytes: new Uint8Array(24).fill(1), nonceBytes: new Uint8Array(24).fill(2) });
  const authorization = buildAuthorizationURL({ endpoint: 'https://provider.example/oauth/authorize', clientId: 'client', redirectUri: connection.redirectUri, scopes: ['read'], state: connection.state, nonce: connection.nonce, challenge: pkce.challenge });
  const parsed = new URL(authorization);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(validateCallback(`${connection.redirectUri}?code=ok&state=${encodeURIComponent(connection.state)}`, connection).code, 'ok');
  assert.throws(() => validateCallback(`${connection.redirectUri}?code=ok&state=wrong`, connection), /state/i);
  assert.throws(() => buildAuthorizationURL({ endpoint: 'http://provider.example/oauth', clientId: 'x', redirectUri: connection.redirectUri, state: connection.state, nonce: connection.nonce, challenge: pkce.challenge }), /HTTPS/);
});

test('provider catalog fails honest and redaction removes bearer material', () => {
  const catalog = providerCatalog({ reddit: { clientId: 'id', redirectUri: 'https://sideways.example/callback' } });
  assert.equal(catalog.find(item => item.id === 'reddit').configured, true);
  assert.equal(catalog.find(item => item.id === 'spotify').configured, false);
  assert.equal(connectionCapability({ staticDeployment: true, configured: true }).state, 'unavailable');
  assert.equal(connectionCapability({ staticDeployment: false, configured: false }).state, 'unavailable');
  assert.equal(connectionCapability({ staticDeployment: false, configured: true }).state, 'available');
  assert.deepEqual(redactConnection({ provider: 'reddit', accessToken: 'secret', refreshToken: 'secret2', cookie: 'x', status: 'connected' }), { provider: 'reddit', status: 'connected' });
});

test('incremental sync state is resumable, cancellable, and disconnectable', () => {
  let state = reduceSyncState({ provider: 'reddit' }, { type: 'start' });
  state = reduceSyncState(state, { type: 'page', cursor: 'next-1', added: 4 });
  state = reduceSyncState(state, { type: 'page', cursor: 'next-2', added: 3 });
  assert.equal(state.imported, 7);
  assert.equal(state.cursor, 'next-2');
  state = reduceSyncState(state, { type: 'cancel' });
  assert.equal(state.status, 'connected');
  state = reduceSyncState(state, { type: 'disconnect' });
  assert.equal(state.status, 'disconnected');
  assert.equal(state.cursor, null);
});

test('manual assembly installs one four-choice ingestion surface and no password automation', () => {
  const studio = fs.readFileSync('studio/manual/product/import-studio.js', 'utf8');
  const installer = fs.readFileSync('studio/manual/imports/apply.py', 'utf8');
  assert.match(studio, /Connect an account/);
  assert.match(studio, /Add a website or feed/);
  assert.match(studio, /Import files/);
  assert.match(studio, /Restore a Sideways backup/);
  assert.doesNotMatch(studio, /password\s*=|document\.cookie|localStorage\.setItem\([^)]*token/i);
  assert.match(installer, /discovery-source\.js/);
  assert.match(installer, /account-connections\.js/);
  assert.match(installer, /add-to-sideways-runtime\.js/);
});
