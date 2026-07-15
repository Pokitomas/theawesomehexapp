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
  safePublicURL,
  saveDiscoveryRecord
} from '../../studio/manual/product/discovery-source.js';
import {
  buildAuthorizationURL,
  connectionCapability,
  createConnectionState,
  createDisconnectReceipt,
  createPKCE,
  providerCatalog,
  redactConnection,
  reduceSyncState,
  serverTokenBoundary,
  validateCallback
} from '../../studio/manual/product/account-connections.js';

const callback = 'https://sideways.example/api/connections/reddit/callback';
const configuration = {
  reddit: {
    clientId: 'client',
    redirectUri: callback,
    authorizationEndpoint: 'https://provider.example/oauth/authorize',
    allowedRedirects: [callback]
  }
};

test('public source URLs reject credentials, local networks, secret queries, and non-web protocols', () => {
  assert.equal(safePublicURL('https://example.com/feed#section').href, 'https://example.com/feed');
  for (const value of ['file:///tmp/a', 'https://user:pass@example.com/', 'http://localhost:3000/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://169.254.1.1/', 'https://example.com/?access_token=secret']) {
    assert.throws(() => safePublicURL(value));
  }
});

test('add input classification is small and capability-oriented', () => {
  assert.equal(classifyAddInput('https://example.com/'), 'website');
  assert.equal(classifyAddInput('https://example.com/feed.xml'), 'feed');
  assert.equal(classifyAddInput('https://example.com/sitemap_index.xml'), 'sitemap');
  assert.equal(classifyAddInput('https://example.com/users/kai/outbox'), 'activitypub');
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

test('public and connected material becomes Private only through explicit save', () => {
  const web = normalizeDiscoveryRecord({ id: 'a', title: 'A', url: 'https://example.com/a' }, { sourceId: 'example', state: CAPABILITY_STATES.WEB });
  assert.throws(() => saveDiscoveryRecord(web), /explicit user action/);
  const saved = saveDiscoveryRecord(web, { explicit: true, savedAt: '2026-07-15T00:00:00.000Z' });
  assert.equal(saved.state, CAPABILITY_STATES.PRIVATE);
  assert.deepEqual(saved.saveReceipt, { schema: 'sideways-explicit-save/v1', from: 'web', to: 'private', explicit: true, savedAt: '2026-07-15T00:00:00.000Z' });
  assert.throws(() => saveDiscoveryRecord(saved, { explicit: true }), /Only readable Web or Connected/);
});

test('candidate materialization is request-bounded, source-filtered, and deduplicated', () => {
  const a = normalizeDiscoveryRecord({ id: 'a', title: 'A', url: 'https://a.example/post' }, { sourceId: 'a' });
  const duplicate = normalizeDiscoveryRecord({ id: 'a2', title: 'A again', url: 'https://a.example/post' }, { sourceId: 'a' });
  const b = normalizeDiscoveryRecord({ id: 'b', title: 'B', url: 'https://b.example/post' }, { sourceId: 'b' });
  assert.deepEqual(materializeCandidates([a, duplicate, b], { enabledSourceIds: ['a'], limit: 20 }).map(item => item.id), ['a']);
  assert.deepEqual(materializeCandidates([a, duplicate, b], { limit: 1 }).map(item => item.id), ['a']);
});

test('source collections keep same-host paths distinct and support enable, disable, remove', () => {
  const collection = createSourceCollection();
  const first = collection.add({ url: 'https://example.com/feed.xml' });
  const second = collection.add({ url: 'https://example.com/news/atom.xml' });
  assert.notEqual(first.id, second.id);
  assert.equal(collection.list().length, 2);
  collection.setEnabled(first.id, false);
  assert.equal(collection.list().find(item => item.id === first.id).enabled, false);
  collection.remove(first.id);
  assert.deepEqual(collection.list().map(item => item.id), [second.id]);
  const search = collection.add({ url: 'https://search.example/query', kind: 'search' });
  assert.equal(search.capability, 'unavailable');
});

test('fetch plans are credential-free, request-local, and capped', () => {
  const plan = boundedFetchPlan('https://example.com/feed', { records: 9999, bytes: 99_000_000, redirects: 99, timeoutMs: 99_000 });
  assert.equal(plan.credentials, 'omit');
  assert.equal(plan.cache, 'no-store');
  assert.equal(plan.publicCacheBoundary, 'separate-from-private-archive');
  assert.equal(plan.limits.records, 200);
  assert.equal(plan.limits.bytes, 2_000_000);
  assert.equal(plan.limits.redirects, 4);
  assert.equal(plan.limits.timeoutMs, 30_000);
  assert.deepEqual(plan.allowedContentTypes, ALLOWED_CONTENT_TYPES);
});

test('PKCE, state, nonce, redirect allowlist, callback, and scope contracts are exact', async () => {
  const pkce = await createPKCE();
  assert.equal(pkce.method, 'S256');
  assert.ok(pkce.verifier.length >= 43);
  assert.ok(pkce.challenge.length >= 43);

  const provider = providerCatalog(configuration).find(item => item.id === 'reddit');
  assert.equal(provider.configured, true);
  const connection = createConnectionState({ providerId: 'reddit', redirectUri: callback, allowedRedirects: [callback], stateBytes: new Uint8Array(24).fill(1), nonceBytes: new Uint8Array(24).fill(2) });
  const authorization = buildAuthorizationURL({ provider, endpoint: provider.authorizationEndpoint, clientId: 'client', redirectUri: connection.redirectUri, allowedRedirects: provider.allowedRedirects, scopes: ['read'], state: connection.state, nonce: connection.nonce, challenge: pkce.challenge });
  const parsed = new URL(authorization);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(validateCallback(`${connection.redirectUri}?code=ok&state=${encodeURIComponent(connection.state)}`, connection).code, 'ok');
  assert.throws(() => validateCallback(`${connection.redirectUri}?code=ok&state=wrong`, connection), /state/i);
  assert.throws(() => createConnectionState({ providerId: 'reddit', redirectUri: callback }), /allowlist/);
  assert.throws(() => buildAuthorizationURL({ provider, endpoint: provider.authorizationEndpoint, clientId: 'client', redirectUri: callback, allowedRedirects: [callback], scopes: ['write'], state: connection.state, nonce: connection.nonce, challenge: pkce.challenge }), /scope/i);
  assert.throws(() => buildAuthorizationURL({ provider, endpoint: 'http://provider.example/oauth', clientId: 'client', redirectUri: callback, allowedRedirects: [callback], state: connection.state, nonce: connection.nonce, challenge: pkce.challenge }), /HTTPS/);
});

test('provider catalog fails honest and tokens stay behind a server-only boundary', () => {
  const catalog = providerCatalog(configuration);
  assert.equal(catalog.find(item => item.id === 'reddit').configured, true);
  assert.equal(catalog.find(item => item.id === 'spotify').configured, false);
  assert.equal(connectionCapability({ staticDeployment: true, configured: true }).state, 'unavailable');
  assert.equal(connectionCapability({ staticDeployment: false, configured: false }).state, 'unavailable');
  assert.equal(connectionCapability({ staticDeployment: false, configured: true }).state, 'available');
  assert.deepEqual(serverTokenBoundary({ provider: 'reddit' }), {
    schema: 'sideways-server-token-boundary/v1', provider: 'reddit', storage: 'encrypted-server-only', browserReadable: false,
    publicProjection: false, arkExport: false, logs: 'redacted', refresh: 'server-only'
  });
  assert.deepEqual(redactConnection({ provider: 'reddit', accessToken: 'secret', nested: { refresh_token: 'secret2', code: 'secret3', verifier: 'secret4', status: 'connected' }, cookie: 'x' }), { provider: 'reddit', nested: { status: 'connected' } });
  assert.deepEqual(createDisconnectReceipt({ provider: 'reddit', connectionId: 'c-1', revoked: true, deletedServerState: true, at: '2026-07-15T00:00:00.000Z' }), {
    schema: 'sideways-connection-disconnect/v1', provider: 'reddit', connectionId: 'c-1', revoked: true, deletedServerState: true, disconnectedAt: '2026-07-15T00:00:00.000Z'
  });
});

test('incremental sync is deduplicated, resumable, cancellable, recoverable, and disconnectable', () => {
  let state = reduceSyncState({ provider: 'reddit' }, { type: 'start' });
  state = reduceSyncState(state, { type: 'page', cursor: 'next-1', ids: ['a', 'b', 'b'] });
  state = reduceSyncState(state, { type: 'page', cursor: 'next-2', ids: ['b', 'c'] });
  assert.equal(state.imported, 3);
  assert.equal(state.cursor, 'next-2');
  state = reduceSyncState(state, { type: 'error', message: 'temporary' });
  assert.equal(state.recoveryCursor, 'next-2');
  state = reduceSyncState(state, { type: 'cancel', at: '2026-07-15T00:00:00.000Z' });
  assert.equal(state.status, 'connected');
  assert.equal(state.cursor, 'next-2');
  state = reduceSyncState(state, { type: 'disconnect' });
  assert.equal(state.status, 'disconnected');
  assert.equal(state.cursor, null);
  assert.deepEqual(state.seenIds, []);
});

test('manual assembly installs exactly one four-choice ingestion surface with file, drop, source, and Ark paths', () => {
  const studio = fs.readFileSync('studio/manual/product/import-studio.js', 'utf8');
  const installer = fs.readFileSync('studio/manual/imports/apply.py', 'utf8');
  const verify = fs.readFileSync('studio/manual/verify.py', 'utf8');
  for (const label of ['Connect an account', 'Add a website or feed', 'Import files', 'Restore a Sideways backup']) assert.match(studio, new RegExp(label));
  assert.match(studio, /sidewaysImportFiles/);
  assert.match(studio, /addEventListener\('drop'/);
  assert.match(studio, /Survival\.restoreArk/);
  assert.match(studio, /setEnabled/);
  assert.match(studio, /remove/);
  assert.doesNotMatch(studio, /sessionStorage|document\.cookie|localStorage\.setItem\([^)]*(?:token|verifier)/i);
  assert.match(installer, /discovery-source\.js/);
  assert.match(installer, /account-connections\.js/);
  assert.match(installer, /add-to-sideways-runtime\.js/);
  assert.match(verify, /data-add-to-sideways/);
});
