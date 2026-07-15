import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  buildSnapshot,
  normalizeWebRecord,
  parseSourcePayload,
  parseSyndication,
  safeSourceURL,
  writeSnapshot
} from '../build-web-source-snapshot.mjs';

test('snapshot sources reject private networks, credentials, and unsupported schemes', () => {
  assert.equal(safeSourceURL('https://example.com/feed#x').href, 'https://example.com/feed');
  for (const value of ['file:///etc/passwd', 'https://u:p@example.com/', 'http://localhost/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.20.0.1/', 'http://192.168.0.1/']) assert.throws(() => safeSourceURL(value));
});

test('RSS and Atom items normalize with canonical provenance and no synthetic records', () => {
  const rows = parseSyndication(`<?xml version="1.0"?><rss><channel><item><title>One &amp; Two</title><link>https://example.com/post</link><description><![CDATA[<p>Useful body</p>]]></description><pubDate>2026-07-14T00:00:00Z</pubDate></item></channel></rss>`);
  assert.equal(rows.length, 1);
  const record = normalizeWebRecord(rows[0], { id: 'example', name: 'Example', url: 'https://example.com/feed.xml', format: 'rss', fetchedAt: '2026-07-15T00:00:00Z' });
  assert.equal(record.title, 'One & Two');
  assert.equal(record.url, 'https://example.com/post');
  assert.equal(record.synthetic, false);
  assert.equal(record.provenance.provider, 'example');
  assert.equal(record.provenance.cache, 'bounded-build-snapshot');
});

test('JSON, feed, and HTML payloads share one normalized handoff', () => {
  assert.equal(parseSourcePayload(JSON.stringify({ hits: [{ title: 'Story', url: 'https://example.com/story' }] }), 'application/json', { format: 'json' }).length, 1);
  assert.equal(parseSourcePayload('<feed><entry><title>Entry</title><link href="https://example.com/entry"/></entry></feed>', 'application/atom+xml', { format: 'atom' }).length, 1);
  assert.equal(parseSourcePayload('<html><head><title>Page</title><link rel="canonical" href="https://example.com/page"></head></html>', 'text/html', { format: 'html', url: 'https://example.com/' })[0].url, 'https://example.com/page');
});

test('snapshot build is bounded, deduplicated, and fails individual providers honestly', async () => {
  const providers = [
    { id: 'feed-a', name: 'Feed A', kind: 'article', format: 'rss', url: 'https://a.example/feed.xml' },
    { id: 'feed-b', name: 'Feed B', kind: 'article', format: 'rss', url: 'https://b.example/feed.xml' },
    { id: 'bad', name: 'Bad', kind: 'article', format: 'rss', url: 'http://127.0.0.1/feed.xml' }
  ];
  const item = '<item><title>Same</title><link>https://story.example/one</link><description>Body</description></item>';
  const snapshot = await buildSnapshot(providers, {
    now: '2026-07-15T00:00:00.000Z',
    limits: { sources: 3, recordsPerSource: 5, totalRecords: 1, bytesPerSource: 1000, timeoutMs: 1000 },
    fixturePayloads: {
      'feed-a': { contentType: 'application/rss+xml', text: `<rss><channel>${item}</channel></rss>` },
      'feed-b': { contentType: 'application/rss+xml', text: `<rss><channel>${item}</channel></rss>` }
    }
  });
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.receipts[0].status, 'ready');
  assert.equal(snapshot.records[0].url, 'https://story.example/one');
  assert.equal(snapshot.records[0].synthetic, false);
});

test('snapshot writer emits deterministic gzip JSONL and metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sideways-web-snapshot-'));
  const output = path.join(directory, 'general.jsonl.gz');
  const record = normalizeWebRecord({ title: 'One', url: 'https://example.com/one' }, { id: 'example', name: 'Example', url: 'https://example.com/feed', fetchedAt: '2026-07-15T00:00:00Z' });
  writeSnapshot({ schema: 'sideways-web-source-snapshot/v1', generated_at: '2026-07-15T00:00:00Z', records: [record], receipts: [{ provider: 'example', status: 'ready', admitted: 1 }], limits: { totalRecords: 1 } }, output);
  const lines = zlib.gunzipSync(fs.readFileSync(output)).toString('utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).title, 'One');
  const metadata = JSON.parse(fs.readFileSync(`${output}.meta.json`, 'utf8'));
  assert.equal(metadata.records, 1);
});

test('Pages workflow delegates corpus acquisition to repository-owned snapshot builder', () => {
  const workflow = fs.readFileSync('.github/workflows/pages.yml', 'utf8');
  assert.match(workflow, /build-web-source-snapshot\.mjs/);
  assert.doesNotMatch(workflow, /fetch_wikinews\.py/);
  assert.doesNotMatch(workflow, /general\/fetch_forum\.py/);
  assert.doesNotMatch(workflow, /general\/fetch_social\.py/);
});
