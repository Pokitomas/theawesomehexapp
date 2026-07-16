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
  robotsBytes: 256_000,
  forumThreadsPerSource: 3,
  forumRepliesPerThread: 3,
  forumReplyBytes: 512_000
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

function isHackerNewsForum(provider) {
  try {
    return provider?.kind === 'forum' && new URL(provider.url).hostname === 'hn.algolia.com';
  } catch {
    return false;
  }
}

async function enrichHackerNewsRows(rows, provider, options = {}) {
  if (!isHackerNewsForum(provider)) return Object.freeze({ rows, receipt: null });
  const limits = options.limits || DEFAULT_LIMITS;
  const fetchResource = options.requestPublicResource || requestPublicResource;
  const lookup = options.lookup || dns.lookup;
  const candidates = rows
    .filter(row => clean(row?.objectID || row?.id) && Number(row?.num_comments || row?.comments || 0) > 0)
    .slice(0, limits.forumThreadsPerSource);
  let enriched = 0;
  let replyCount = 0;
  let failures = 0;
  const entries = await Promise.all(candidates.map(async row => {
    const storyId = clean(row.objectID || row.id).slice(0, 120);
    try {
      const target = safeSourceURL(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(storyId)}`);
      const response = await fetchResource(target, {
        lookup,
        timeoutMs: limits.timeoutMs,
        bytes: limits.forumReplyBytes,
        redirects: limits.redirects,
        accept: 'application/json'
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`reply source responded ${response.status}`);
      const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') throw new Error(`reply source content type is not allowed: ${contentType || '(missing)'}`);
      const item = JSON.parse(response.body.toString('utf8'));
      const replies = (Array.isArray(item.children) ? item.children : [])
        .filter(reply => reply && !reply.deleted && !reply.dead && clean(reply.text))
        .slice(0, limits.forumRepliesPerThread)
        .map(reply => ({
          id: reply.id,
          author: reply.author,
          text: reply.text,
          published_at: reply.created_at,
          url: `https://news.ycombinator.com/item?id=${encodeURIComponent(clean(reply.id || storyId))}`,
          children: Array.isArray(reply.children) ? reply.children.length : 0
        }));
      if (replies.length) {
        enriched += 1;
        replyCount += replies.length;
      }
      return [storyId, replies];
    } catch {
      failures += 1;
      return [storyId, []];
    }
  }));
  const byStory = new Map(entries);
  return Object.freeze({
    rows: rows.map(row => {
      const storyId = clean(row?.objectID || row?.id).slice(0, 120);
      const replies = byStory.get(storyId);
      return replies?.length ? { ...row, replies } : row;
    }),
    receipt: Object.freeze({
      schema: 'sideways-forum-reply-enrichment/v1',
      attempted: candidates.length,
      enriched,
      replies: replyCount,
      failures,
      threads_per_source: limits.forumThreadsPerSource,
      replies_per_thread: limits.forumRepliesPerThread
    })
  });
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
  const parsedRows = parseSourcePayload(response.body.toString('utf8'), contentType, parseProvider)
    .slice(0, limits.recordsPerSource);
  const enrichment = await enrichHackerNewsRows(parsedRows, provider, { ...options, limits, lookup, requestPublicResource: fetchResource });
  return Object.freeze({
    records: Object.freeze(enrichment.rows.map(row => normalizeWebRecord(row, { ...provider, fetchedAt }))),
    receipt: Object.freeze({
      robots,
      hops: response.hops,
      bytes: response.body.length,
      contentType,
      ...(enrichment.receipt ? { forum_reply_enrichment: enrichment.receipt } : {})
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
    const providerId = clean(provider?.id || provider?.name || `provider-${receipts.length + 1}`) || `provider-${receipts.length + 1}`;
    try {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        throw new Error('provider configuration must be an object');
      }
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
        provider: providerId,
        status: 'ready',
        admitted,
        evidence: result.receipt
      }));
    } catch (error) {
      receipts.push(Object.freeze({
        provider: providerId,
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
    url: `https://${host}/api/v1/timelines/public?limit=40&local=true`
  };
}

function builtinProviders() {
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

export function resolveProviderConfiguration(raw = process.env.SIDEWAYS_PUBLIC_SOURCES) {
  const configured = clean(raw);
  if (!configured) return Object.freeze({ providers: Object.freeze(builtinProviders()), receipt: null });
  try {
    const parsed = JSON.parse(configured);
    if (!Array.isArray(parsed)) throw new Error('configuration must be a JSON array');
    return Object.freeze({
      providers: Object.freeze(parsed.length ? parsed : builtinProviders()),
      receipt: null
    });
  } catch (error) {
    return Object.freeze({
      providers: Object.freeze(builtinProviders()),
      receipt: Object.freeze({
        provider: 'configured-public-sources',
        status: 'unavailable',
        admitted: 0,
        error: `invalid SIDEWAYS_PUBLIC_SOURCES: ${clean(error.message)}`
      })
    });
  }
}

export function defaultProviders() {
  return resolveProviderConfiguration().providers;
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
  const resolution = args.providers
    ? { providers: JSON.parse(fs.readFileSync(args.providers, 'utf8')), receipt: null }
    : resolveProviderConfiguration();
  const built = await buildSnapshot(resolution.providers);
  const snapshot = resolution.receipt
    ? Object.freeze({ ...built, receipts: Object.freeze([resolution.receipt, ...built.receipts]) })
    : built;
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
