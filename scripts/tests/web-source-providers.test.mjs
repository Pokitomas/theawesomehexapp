import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LIMITS,
  buildSnapshot,
  defaultProviders,
  safeSourceURL
} from '../build-web-source-snapshot.mjs';

test('default public providers are bounded, diverse, credential-free windows', () => {
  const providers = defaultProviders();
  const counts = providers.reduce((value, provider) => {
    value[provider.kind] = (value[provider.kind] || 0) + 1;
    return value;
  }, {});
  assert.equal(providers.length, 11);
  assert.deepEqual(counts, { article: 3, forum: 3, social: 5 });
  assert.ok(providers.length <= DEFAULT_LIMITS.sources);
  assert.equal(new Set(providers.map(provider => provider.id)).size, providers.length);
  for (const provider of providers) {
    const url = safeSourceURL(provider.url);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(provider.robots, 'not-applicable');
    assert.ok(['public-api', 'mediawiki-api'].includes(provider.method));
    if (provider.kind === 'social') assert.equal(url.searchParams.get('local'), 'true');
    for (const key of url.searchParams.keys()) {
      assert.doesNotMatch(key, /token|secret|key|credential|password/i);
    }
  }
});

test('configured search remains honestly unavailable without a public endpoint', async () => {
  const snapshot = await buildSnapshot([{
    id: 'configured-search',
    name: 'Configured Search',
    kind: 'search',
    url: 'https://search.example/query'
  }], { now: '2026-07-15T00:00:00.000Z' });
  assert.equal(snapshot.records.length, 0);
  assert.equal(snapshot.receipts[0].status, 'unavailable');
  assert.match(snapshot.receipts[0].error, /credential-free public endpoint/);
});

test('provider windows deduplicate canonicals across sources before the global limit', async () => {
  const providers = [
    { id: 'article-a', name: 'A', kind: 'article', format: 'json', robots: 'not-applicable', url: 'https://a.example/api' },
    { id: 'article-b', name: 'B', kind: 'article', format: 'json', robots: 'not-applicable', url: 'https://b.example/api' }
  ];
  const fixture = JSON.stringify({ items: [
    { title: 'One', url: 'https://story.example/one' },
    { title: 'Two', url: 'https://story.example/two' }
  ] });
  const snapshot = await buildSnapshot(providers, {
    now: '2026-07-15T00:00:00.000Z',
    limits: { totalRecords: 3 },
    fixturePayloads: {
      'article-a': { contentType: 'application/json', text: fixture },
      'article-b': { contentType: 'application/json', text: fixture }
    }
  });
  assert.deepEqual(snapshot.records.map(record => record.url), [
    'https://story.example/one',
    'https://story.example/two'
  ]);
  assert.deepEqual(snapshot.receipts.map(receipt => receipt.admitted), [2, 0]);
});
