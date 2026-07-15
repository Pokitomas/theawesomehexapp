#!/usr/bin/env node
import dns from 'node:dns/promises';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  enforceRobots,
  requestPublicResource,
  safeSourceURL
} from './web-source-security.mjs';
import {
  normalizeWebRecord,
  parseSourcePayload,
  writeSnapshot
} from './web-source-records.mjs';

export * from './web-source-security.mjs';
export * from './web-source-records.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  sources: 24,
  recordsPerSource: 250,
  totalRecords: 1800,
  bytesPerSource: 2_000_000,
  redirects: 4,
  timeoutMs: 20_000,
  robotsBytes: 256_000
});

export const ALLOWED_TYPES = Object.freeze([
  'application/json',
  'application/rss+xml',
  'application/atom+xml',
  'application/xml',
  'text/xml',
  'text/html'
]);

function clean(value = '') {
  return value == null ? '' : String(value).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

export async function fetchBoundedSource(provider, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const source = safeSourceURL(provider.url);
  const lookup = options.lookup || dns.lookup;
  const robots = await enforceRobots(provider, source, { lookup, ...limits });
  const fetchResource = options.requestPublicResource || requestPublicResource;
  const response = await fetchResource(source, {
    lookup,
    timeoutMs: limits.timeoutMs,
    bytes: limits.bytesPerSource,
    redirects: limits.redirects,
    accept: ALLOWED_TYPES.join(', ')
  });
  if (response.status === 429) throw new Error('source rate limit exceeded');
  if (response.status < 200 || response.status >= 300) throw new Error(`source responded ${response.status}`);
  const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(contentType)) {
    throw new Error(`source content type is not allowed: ${contentType || '(missing)'}`);
  }
  const fetchedAt = options.now || new Date().toISOString();
  const parseProvider = { ...provider, url: response.url?.href || source.href };
  const rows = parseSourcePayload(response.body.toString('utf8'), contentType, parseProvider)
    .slice(0, limits.recordsPerSource);
  return Object.freeze({
    records: Object.freeze(rows.map(row => normalizeWebRecord(row, { ...provider, fetchedAt }))),
    receipt: Object.freeze({
      robots,
      hops: response.hops,
      bytes: response.body.length,
      contentType
    })
  });
}

export async function buildSnapshot(providers, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const selected = (Array.isArray(providers) ? providers : [])
    .filter(provider => provider?.enabled !== false)
    .slice(0, limits.sources);
  const records = [];
  const receipts = [];
  const seen = new Set();
  for (const provider of selected) {
    try {
      if (provider.kind === 'search' && provider.publicEndpoint !== true) {
        throw new Error('search provider is unavailable until a credential-free public endpoint is configured');
      }
      const fixture = options.fixturePayloads?.[provider.id];
      const fetchedAt = options.now || '2026-07-15T00:00:00.000Z';
      const result = fixture
        ? {
            records: parseSourcePayload(fixture.text, fixture.contentType, provider)
              .map(row => normalizeWebRecord(row, { ...provider, fetchedAt })),
            receipt: { fixture: true, robots: { policy: 'fixture', allowed: true }, hops: [] }
          }
        : await fetchBoundedSource(provider, { ...options, limits });
      let admitted = 0;
      for (const record of result.records) {
        if (records.length >= limits.totalRecords) break;
        const key = record.url || `${record.kind}:${record.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(record);
        admitted += 1;
      }
      receipts.push(Object.freeze({
        provider: provider.id,
        status: 'ready',
        admitted,
        evidence: result.receipt
      }));
    } catch (error) {
      receipts.push(Object.freeze({
        provider: provider.id,
        status: 'unavailable',
        admitted: 0,
        error: clean(error.message)
      }));
    }
    if (records.length >= limits.totalRecords) break;
  }
  return Object.freeze({
    schema: 'sideways-web-source-snapshot/v2',
    generated_at: options.now || new Date().toISOString(),
    records: Object.freeze(records),
    receipts: Object.freeze(receipts),
    limits: Object.freeze(limits)
  });
}

function wikinewsProvider(id, start) {
  const query = new URLSearchParams({
    action: 'query',
    generator: 'allpages',
    gapnamespace: '0',
    gaplimit: '250',
    gapfrom: start,
    prop: 'extracts|info',
    exintro: '1',
    inprop: 'url',
    format: 'json',
    origin: '*'
  });
  return {
    id,
    name: 'Wikinews',
    kind: 'article',
    format: 'json',
    method: 'mediawiki-api',
    robots: 'not-applicable',
    license: 'CC BY 2.5',
    url: `https://en.wikinews.org/w/api.php?${query}`
  };
}

function hackerNewsProvider(page) {
  return {
    id: `hacker-news-${page}`,
    name: 'Hacker News',
    kind: 'forum',
    format: 'json',
    method: 'public-api',
    robots: 'not-applicable',
    url: `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=250&page=${page}`
  };
}

function mastodonProvider(id, host) {
  return {
    id,
    name: host,
    kind: 'social',
    format: 'json',
    method: 'public-api',
    robots: 'not-applicable',
    url: `https://${host}/api/v1/timelines/public?limit=40`
  };
}

export function defaultProviders() {
  const configured = process.env.SIDEWAYS_PUBLIC_SOURCES
    ? JSON.parse(process.env.SIDEWAYS_PUBLIC_SOURCES)
    : [];
  if (Array.isArray(configured) && configured.length) return configured;
  return [
    wikinewsProvider('wikinews-a', 'A'),
    wikinewsProvider('wikinews-i', 'I'),
    wikinewsProvider('wikinews-q', 'Q'),
    hackerNewsProvider(0),
    hackerNewsProvider(1),
    hackerNewsProvider(2),
    mastodonProvider('mastodon-social', 'mastodon.social'),
    mastodonProvider('mstdn-social', 'mstdn.social'),
    mastodonProvider('fosstodon', 'fosstodon.org'),
    mastodonProvider('hachyderm', 'hachyderm.io'),
    mastodonProvider('techhub', 'techhub.social')
  ];
}

function parseArgs(argv) {
  const args = { output: 'corpus/general.jsonl.gz' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--providers') args.providers = argv[++index];
  }
  return args;
}

export async function runSnapshotCLI(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const providers = args.providers
    ? JSON.parse(fs.readFileSync(args.providers, 'utf8'))
    : defaultProviders();
  const snapshot = await buildSnapshot(providers);
  writeSnapshot(snapshot, args.output);
  process.stdout.write(`${JSON.stringify({
    schema: snapshot.schema,
    output: args.output,
    records: snapshot.records.length,
    receipts: snapshot.receipts
  })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSnapshotCLI().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
