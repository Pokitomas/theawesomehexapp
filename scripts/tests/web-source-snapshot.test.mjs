import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  buildSnapshot,
  isPublicAddress,
  normalizeWebRecord,
  parseSitemap,
  parseSourcePayload,
  parseSyndication,
  requestPublicResource,
  resolvePublicTarget,
  robotsAllows,
  safeSourceURL,
  writeSnapshot
} from '../build-web-source-snapshot.mjs';

const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }];

test('source URL and resolved-address policy reject local, reserved, and credentialed targets', async () => {
  assert.equal(safeSourceURL('https://example.com/feed#x').href, 'https://example.com/feed');
  for (const value of ['file:///etc/passwd', 'https://u:p@example.com/', 'http://localhost/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.20.0.1/', 'http://192.168.0.1/', 'http://[::1]/', 'https://example.com/?api_key=secret']) {
    assert.throws(() => safeSourceURL(value));
  }
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
  const resolved = await resolvePublicTarget('https://example.com/feed', { lookup: publicLookup });
  assert.equal(resolved.selected.address, '8.8.8.8');
  await assert.rejects(
    () => resolvePublicTarget('https://public-name.example/', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
    /non-public/
  );
  await assert.rejects(
    () => requestPublicResource('https://public-name.example/', { lookup: async () => [{ address: '169.254.169.254', family: 4 }] }),
    /non-public/
  );
});

test('robots policy uses longest matching rule and allow wins equal specificity', () => {
  const robots = `User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /same\nAllow: /same`;
  assert.equal(robotsAllows(robots, '/'), true);
  assert.equal(robotsAllows(robots, '/private/item'), false);
  assert.equal(robotsAllows(robots, '/private/public/item'), true);
  assert.equal(robotsAllows(robots, '/same'), true);
});

test('RSS, Atom, sitemap, JSON, and HTML normalize with explicit public provenance', () => {
  const rows = parseSyndication(`<?xml version="1.0"?><rss><channel><item><title>One &amp; Two</title><link>https://example.com/post</link><description><![CDATA[<p>Useful body</p>]]></description><pubDate>2026-07-14T00:00:00Z</pubDate></item></channel></rss>`);
  assert.equal(rows.length, 1);
  const record = normalizeWebRecord(rows[0], { id: 'example', name: 'Example', url: 'https://example.com/feed.xml', format: 'rss', robots: 'respect', fetchedAt: '2026-07-15T00:00:00Z' });
  assert.equal(record.title, 'One & Two');
  assert.equal(record.url, 'https://example.com/post');
  assert.equal(record.synthetic, false);
  assert.equal(record.provenance.provider, 'example');
  assert.equal(record.provenance.cache, 'bounded-build-snapshot');
  assert.equal(record.provenance.robots, 'respect');
  assert.equal(parseSourcePayload(JSON.stringify({ hits: [{ title: 'Story', url: 'https://example.com/story' }] }), 'application/json', { format: 'json' }).length, 1);
  assert.equal(parseSourcePayload('<feed><entry><title>Entry</title><link href="https://example.com/entry"/></entry></feed>', 'application/atom+xml', { format: 'atom' }).length, 1);
  const html = parseSourcePayload('<html><head><title>Page</title><meta property="og:title" content="Open Page"><meta content="A summary" name="description"><link href="/page" rel="canonical"></head></html>', 'text/html', { format: 'html', url: 'https://example.com/' })[0];
  assert.equal(html.url, 'https://example.com/page');
  assert.equal(html.title, 'Open Page');
  assert.equal(html.description, 'A summary');
  assert.deepEqual(parseSitemap('<urlset><url><loc>https://example.com/a</loc><lastmod>2026-07-01</lastmod></url></urlset>'), [{ title: 'https://example.com/a', url: 'https://example.com/a', published: '2026-07-01' }]);
  assert.throws(() => parseSourcePayload('binary', 'application/octet-stream', {}), /unsupported/);
});

test('snapshot build is bounded, deduplicated, provenance-bearing, and fails providers honestly', async () => {
  const providers = [
    { id: 'feed-a', name: 'Feed A', kind: 'article', format: 'rss', robots: 'respect', url: 'https://a.example/feed.xml' },
    { id: 'feed-b', name: 'Feed B', kind: 'article', format: 'rss', robots: 'respect', url: 'https://b.example/feed.xml' },
    { id: 'bad', name: 'Bad', kind: 'article', format: 'rss', url: 'http://127.0.0.1/feed.xml' }
  ];
  const item = '<item><title>Same</title><link>https://story.example/one</link><description>Body</description></item>';
  const snapshot = await buildSnapshot(providers, {
    now: '2026-07-15T00:00:00.000Z',
    limits: { sources: 3, recordsPerSource: 5, totalRecords: 1, bytesPerSource: 1000, redirects: 2, timeoutMs: 1000, robotsBytes: 1000 },
    fixturePayloads: {
      'feed-a': { contentType: 'application/rss+xml', text: `<rss><channel>${item}</channel></rss>` },
      'feed-b': { contentType: 'application/rss+xml', text: `<rss><channel>${item}</channel></rss>` }
    }
  });
  assert.equal(snapshot.schema, 'sideways-web-source-snapshot/v2');
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.receipts[0].status, 'ready');
  assert.equal(snapshot.records[0].url, 'https://story.example/one');
  assert.equal(snapshot.records[0].synthetic, false);
  const unavailableSearch = await buildSnapshot([{ id: 'search', name: 'Search', kind: 'search', url: 'https://search.example/query' }], { now: '2026-07-15T00:00:00.000Z' });
  assert.equal(unavailableSearch.receipts[0].status, 'unavailable');
  assert.match(unavailableSearch.receipts[0].error, /credential-free public endpoint/);
});

test('snapshot writer emits gzip JSONL plus a finite source receipt', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sideways-web-snapshot-'));
  const output = path.join(directory, 'general.jsonl.gz');
  const record = normalizeWebRecord({ title: 'One', url: 'https://example.com/one' }, { id: 'example', name: 'Example', url: 'https://example.com/feed', robots: 'respect', fetchedAt: '2026-07-15T00:00:00Z' });
  writeSnapshot({ schema: 'sideways-web-source-snapshot/v2', generated_at: '2026-07-15T00:00:00Z', records: [record], receipts: [{ provider: 'example', status: 'ready', admitted: 1 }], limits: { totalRecords: 1 } }, output);
  const lines = zlib.gunzipSync(fs.readFileSync(output)).toString('utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).title, 'One');
  const metadata = JSON.parse(fs.readFileSync(`${output}.meta.json`, 'utf8'));
  assert.equal(metadata.records, 1);
  assert.equal(metadata.receipts[0].provider, 'example');
});

test('fetch implementation is manually redirected and DNS-pinned', () => {
  const source = fs.readFileSync(new URL('../web-source-security.mjs', import.meta.url), 'utf8');
  assert.match(source, /redirect omitted a location/);
  assert.match(source, /HTTPS downgrade/);
  assert.match(source, /lookup\(_hostname/);
  assert.match(source, /resolved to a non-public address/);
  assert.doesNotMatch(source, /redirect:\s*['"]follow/);
});
