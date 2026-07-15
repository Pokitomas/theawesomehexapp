#!/usr/bin/env node
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'SidewaysDiscovery/1.0 (+https://github.com/Pokitomas/theawesomehexapp)';

function clean(value = '') {
  return value == null ? '' : String(value).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function stripTags(value = '') {
  return clean(String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function decodeEntities(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function ipv4Octets(address) {
  const values = String(address).split('.').map(Number);
  return values.length === 4 && values.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ? values : null;
}

function publicIPv4(address) {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function normalizedIPv6(address) {
  return String(address).toLowerCase().split('%')[0];
}

function publicIPv6(address) {
  const value = normalizedIPv6(address);
  if (value === '::' || value === '::1') return false;
  if (value.startsWith('::ffff:')) return publicIPv4(value.slice(7));
  if (/^f[cd]/.test(value)) return false;
  if (/^f[ef][89ab]/.test(value)) return false;
  if (value.startsWith('ff')) return false;
  if (value.startsWith('2001:db8:') || value === '2001:db8::') return false;
  return true;
}

export function isPublicAddress(address) {
  const family = net.isIP(String(address));
  if (family === 4) return publicIPv4(address);
  if (family === 6) return publicIPv6(address);
  return false;
}

export function safeSourceURL(value) {
  const parsed = new URL(String(value));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('source protocol must be HTTP or HTTPS');
  if (parsed.username || parsed.password) throw new Error('source URL cannot contain credentials');
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('source URL cannot target a private network');
  }
  if (net.isIP(host) && !isPublicAddress(host)) throw new Error('source URL cannot target a private network');
  parsed.hostname = host;
  parsed.hash = '';
  return parsed;
}

export async function resolvePublicTarget(value, { lookup = dns.lookup } = {}) {
  const url = safeSourceURL(value);
  const literalFamily = net.isIP(url.hostname);
  const answers = literalFamily
    ? [{ address: url.hostname, family: literalFamily }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!Array.isArray(answers) || answers.length === 0) throw new Error('source hostname did not resolve');
  const normalized = answers.map(answer => ({ address: String(answer.address), family: Number(answer.family) || net.isIP(answer.address) }));
  if (normalized.some(answer => !isPublicAddress(answer.address))) throw new Error('source hostname resolved to a non-public address');
  normalized.sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
  return Object.freeze({ url, addresses: Object.freeze(normalized), selected: Object.freeze(normalized[0]) });
}

function requestOnce(target, { lookup = dns.lookup, timeoutMs, byteLimit, headers = {} } = {}) {
  return resolvePublicTarget(target, { lookup }).then(resolved => new Promise((resolve, reject) => {
    const transport = resolved.url.protocol === 'https:' ? https : http;
    const selected = resolved.selected;
    const request = transport.request(resolved.url, {
      method: 'GET',
      headers: {
        accept: headers.accept || '*/*',
        'user-agent': USER_AGENT,
        ...headers
      },
      lookup(_hostname, options, callback) {
        const family = typeof options === 'object' && options?.family ? options.family : 0;
        if (family && family !== selected.family) {
          const alternative = resolved.addresses.find(answer => answer.family === family);
          if (!alternative) return callback(new Error('validated address family unavailable'));
          return callback(null, alternative.address, alternative.family);
        }
        callback(null, selected.address, selected.family);
      },
      servername: resolved.url.hostname,
      timeout: timeoutMs
    }, response => {
      const status = Number(response.statusCode || 0);
      if (REDIRECT_STATUSES.has(status)) {
        response.resume();
        resolve({ status, headers: response.headers, body: Buffer.alloc(0), url: resolved.url, address: selected.address });
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > byteLimit) {
          response.destroy(new Error('source exceeds byte limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks), url: resolved.url, address: selected.address }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('source request timed out')));
    request.on('error', reject);
    request.end();
  }));
}

export async function requestPublicResource(value, {
  lookup = dns.lookup,
  timeoutMs = DEFAULT_LIMITS.timeoutMs,
  byteLimit = DEFAULT_LIMITS.bytesPerSource,
  redirects = DEFAULT_LIMITS.redirects,
  accept = '*/*'
} = {}) {
  let current = safeSourceURL(value);
  const hops = [];
  for (let hop = 0; hop <= redirects; hop += 1) {
    const response = await requestOnce(current, { lookup, timeoutMs, byteLimit, headers: { accept } });
    hops.push(Object.freeze({ url: current.href, status: response.status, address: response.address }));
    if (!REDIRECT_STATUSES.has(response.status)) return Object.freeze({ ...response, hops: Object.freeze(hops) });
    const location = response.headers.location;
    if (!location) throw new Error('source redirect omitted a location');
    if (hop >= redirects) throw new Error('source exceeded redirect limit');
    const next = safeSourceURL(new URL(location, current).href);
    if (current.protocol === 'https:' && next.protocol !== 'https:') throw new Error('source redirect attempted an HTTPS downgrade');
    current = next;
  }
  throw new Error('source exceeded redirect limit');
}

function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      current = { agents: [value.toLowerCase()], rules: [] };
      groups.push(current);
    } else if (key === 'allow' || key === 'disallow') {
      if (!current) continue;
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups;
}

export function robotsAllows(text, pathname, userAgent = 'sidewaysdiscovery') {
  const groups = parseRobots(text);
  const candidates = groups.filter(group => group.agents.some(agent => agent === '*' || userAgent.toLowerCase().includes(agent)));
  let selected = null;
  for (const group of candidates) {
    for (const rule of group.rules) {
      if (!rule.path || !pathname.startsWith(rule.path)) continue;
      if (!selected || rule.path.length > selected.path.length || (rule.path.length === selected.path.length && rule.allow)) selected = rule;
    }
  }
  return selected ? selected.allow : true;
}

async function enforceRobots(provider, source, options) {
  const policy = provider.robots || (provider.method?.includes('api') ? 'not-applicable' : 'respect');
  if (policy === 'not-applicable') return Object.freeze({ policy, allowed: true });
  if (policy !== 'respect') throw new Error('source robots policy must be respect or not-applicable');
  const robotsURL = new URL('/robots.txt', source);
  try {
    const response = await requestPublicResource(robotsURL, {
      lookup: options.lookup,
      timeoutMs: Math.min(options.limits.timeoutMs, 8000),
      byteLimit: options.limits.robotsBytes,
      redirects: Math.min(options.limits.redirects, 2),
      accept: 'text/plain,*/*;q=0.1'
    });
    if (response.status === 404 || response.status === 410) return Object.freeze({ policy, allowed: true, status: response.status });
    if (response.status < 200 || response.status >= 300) throw new Error(`robots.txt responded ${response.status}`);
    const allowed = robotsAllows(response.body.toString('utf8'), source.pathname);
    if (!allowed) throw new Error('source is disallowed by robots policy');
    return Object.freeze({ policy, allowed: true, status: response.status });
  } catch (error) {
    if (provider.robotsFailOpen === true) return Object.freeze({ policy, allowed: true, warning: clean(error.message) });
    throw error;
  }
}

function isoDate(value, fallback = '1970-01-01T00:00:00.000Z') {
  const date = value ? new Date(value) : new Date(fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function stableId(provider, canonical, title, published) {
  return crypto.createHash('sha256').update(`${provider}\n${canonical}\n${title}\n${published}`).digest('hex').slice(0, 24);
}

function authorName(input, fallback) {
  if (typeof input.author === 'string') return input.author;
  return input.author?.name || input.author?.display_name || input.account?.display_name || input.account?.username || input.contributor || fallback;
}

export function normalizeWebRecord(input = {}, provider = {}) {
  const sourceURL = (() => {
    try { return safeSourceURL(input.url || input.link || input.sourceUrl || input.fullurl || input.story_url || provider.url).href; }
    catch { return ''; }
  })();
  const providerName = clean(provider.name || provider.id || (sourceURL ? new URL(sourceURL).hostname : 'Web'));
  const providerId = clean(provider.id || providerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 100);
  const rawText = input.summary || input.description || input.extract || input.content || input.text || input.story_text || '';
  const title = clean(decodeEntities(input.title || input.story_title || input.name || stripTags(rawText) || sourceURL || 'Untitled')).slice(0, 240);
  const summary = clean(decodeEntities(stripTags(rawText))).slice(0, 900);
  const published = isoDate(input.published || input.pubDate || input.updated || input.createdAt || input.created_at || input.timestamp || provider.fetchedAt, provider.fetchedAt);
  const kind = ['article', 'forum', 'social'].includes(input.kind || input.type) ? (input.kind || input.type) : (provider.kind || 'article');
  return Object.freeze({
    id: stableId(providerId, sourceURL, title, published),
    kind,
    title,
    published,
    revision: 'bounded public source snapshot',
    contributor: clean(authorName(input, providerName)).slice(0, 160),
    categories: [...new Set([providerId, ...(Array.isArray(input.categories) ? input.categories : [])].map(clean).filter(Boolean))].slice(0, 24),
    dek: summary || title,
    body: [summary || title],
    sources: sourceURL ? [{ label: providerName, url: sourceURL }] : [],
    url: sourceURL,
    license: clean(provider.license || 'source-defined'),
    attribution: providerName,
    community: clean(provider.community || providerName),
    score: Math.max(0, Number(input.score || input.points || input.favourites_count || 0)),
    comments: Math.max(0, Number(input.comments || input.num_comments || input.replies_count || 0)),
    resurfaced: (provider.fetchedAt || published).slice(0, 10),
    synthetic: false,
    provenance: Object.freeze({
      schema: 'sideways-web-provenance/v1',
      provider: providerId,
      method: clean(provider.method || provider.format || 'web'),
      source_url: safeSourceURL(provider.url).href,
      fetched_at: provider.fetchedAt || published,
      cache: 'bounded-build-snapshot',
      robots: provider.robots || (provider.method?.includes('api') ? 'not-applicable' : 'respect')
    })
  });
}

function tag(block, names) {
  for (const name of names) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
    if (match) return decodeEntities(stripTags(match[1]));
  }
  return '';
}

function linkFromBlock(block) {
  const atom = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(block);
  if (atom) return decodeEntities(atom[1]);
  return tag(block, ['link', 'guid', 'id']);
}

export function parseSyndication(text) {
  const blocks = [...String(text).matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(match => match[2]);
  return blocks.map(block => ({
    title: tag(block, ['title']),
    description: tag(block, ['description', 'summary', 'content', 'content:encoded']),
    url: linkFromBlock(block),
    published: tag(block, ['pubDate', 'published', 'updated']),
    author: tag(block, ['author', 'dc:creator', 'name'])
  })).filter(item => item.title || item.url);
}

function mediaWikiRecords(payload) {
  const pages = payload?.query?.pages;
  if (!pages || typeof pages !== 'object') return [];
  return Object.values(pages).map(page => ({ title: page.title, description: page.extract, url: page.fullurl, published: page.touched, nativeId: page.pageid }));
}

function activityPubRecords(payload) {
  const rows = payload?.orderedItems || payload?.items;
  return Array.isArray(rows) ? rows.map(item => ({
    title: item.name || stripTags(item.content || item.summary || ''),
    description: item.content || item.summary,
    url: typeof item.url === 'string' ? item.url : item.id,
    published: item.published || item.updated,
    author: typeof item.attributedTo === 'string' ? item.attributedTo : item.attributedTo?.name
  })) : [];
}

function jsonRecords(payload) {
  if (Array.isArray(payload)) return payload;
  const mediaWiki = mediaWikiRecords(payload);
  if (mediaWiki.length) return mediaWiki;
  const activityPub = activityPubRecords(payload);
  if (activityPub.length) return activityPub;
  const rows = payload?.items || payload?.entries || payload?.hits || payload?.data || payload?.posts || [];
  return Array.isArray(rows) ? rows : [];
}

function htmlRecord(text, provider) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] || '';
  const description = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["']/i.exec(text)?.[1] || '';
  const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(text)?.[1] || provider.url;
  return [{ title: stripTags(title), description: decodeEntities(description), url: canonical }];
}

export function parseSourcePayload(text, contentType, provider) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || provider.format === 'json') return jsonRecords(JSON.parse(text));
  if (type.includes('xml') || type.includes('rss') || type.includes('atom') || provider.format === 'rss' || provider.format === 'atom') return parseSyndication(text);
  if (type === 'text/html' || provider.format === 'html') return htmlRecord(text, provider);
  throw new Error(`unsupported source content type: ${type || '(missing)'}`);
}

export async function fetchBoundedSource(provider, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const source = safeSourceURL(provider.url);
  const robots = await enforceRobots(provider, source, { lookup: options.lookup || dns.lookup, limits });
  const response = await requestPublicResource(source, {
    lookup: options.lookup || dns.lookup,
    timeoutMs: limits.timeoutMs,
    byteLimit: limits.bytesPerSource,
    redirects: limits.redirects,
    accept: ALLOWED_TYPES.join(', ')
  });
  if (response.status === 429) throw new Error('source rate limit exceeded');
  if (response.status < 200 || response.status >= 300) throw new Error(`source responded ${response.status}`);
  const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(contentType) && !provider.format) throw new Error(`source content type is not allowed: ${contentType || '(missing)'}`);
  const fetchedAt = options.now || new Date().toISOString();
  const rows = parseSourcePayload(response.body.toString('utf8'), contentType, provider).slice(0, limits.recordsPerSource);
  return Object.freeze({
    records: Object.freeze(rows.map(row => normalizeWebRecord(row, { ...provider, fetchedAt }))),
    receipt: Object.freeze({ robots, hops: response.hops, bytes: response.body.length, contentType })
  });
}

export async function buildSnapshot(providers, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const selected = (Array.isArray(providers) ? providers : []).filter(provider => provider?.enabled !== false).slice(0, limits.sources);
  const records = [];
  const receipts = [];
  for (const provider of selected) {
    try {
      const fixture = options.fixturePayloads?.[provider.id];
      const fetchedAt = options.now || '2026-07-15T00:00:00.000Z';
      const result = fixture
        ? {
            records: parseSourcePayload(fixture.text, fixture.contentType, provider).map(row => normalizeWebRecord(row, { ...provider, fetchedAt })),
            receipt: { fixture: true, robots: { policy: 'fixture', allowed: true }, hops: [] }
          }
        : await fetchBoundedSource(provider, { ...options, limits });
      let admitted = 0;
      for (const record of result.records) {
        if (records.length >= limits.totalRecords) break;
        if (records.some(existing => existing.url && existing.url === record.url)) continue;
        records.push(record);
        admitted += 1;
      }
      receipts.push(Object.freeze({ provider: provider.id, status: 'ready', admitted, evidence: result.receipt }));
    } catch (error) {
      receipts.push(Object.freeze({ provider: provider.id, status: 'unavailable', admitted: 0, error: clean(error.message) }));
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

export function writeSnapshot(snapshot, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const jsonl = snapshot.records.map(record => JSON.stringify(record)).join('\n') + (snapshot.records.length ? '\n' : '');
  fs.writeFileSync(output, zlib.gzipSync(jsonl, { level: 9 }));
  fs.writeFileSync(`${output}.meta.json`, `${JSON.stringify({
    schema: snapshot.schema,
    generated_at: snapshot.generated_at,
    records: snapshot.records.length,
    receipts: snapshot.receipts,
    limits: snapshot.limits
  }, null, 2)}\n`);
}

function defaultProviders() {
  const configured = process.env.SIDEWAYS_PUBLIC_SOURCES ? JSON.parse(process.env.SIDEWAYS_PUBLIC_SOURCES) : [];
  if (Array.isArray(configured) && configured.length) return configured;
  return [
    { id: 'hacker-news', name: 'Hacker News', kind: 'forum', format: 'json', method: 'public-api', robots: 'not-applicable', url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=250' },
    { id: 'wikinews', name: 'Wikinews', kind: 'article', format: 'json', method: 'mediawiki-api', robots: 'not-applicable', url: 'https://en.wikinews.org/w/api.php?action=query&generator=categorymembers&gcmtitle=Category:Published&gcmtype=page&gcmlimit=250&prop=extracts|info&exintro=1&inprop=url&format=json&origin=*' },
    { id: 'mastodon', name: 'Mastodon', kind: 'social', format: 'json', method: 'public-api', robots: 'not-applicable', url: 'https://mastodon.social/api/v1/timelines/public?limit=40' }
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const providers = args.providers ? JSON.parse(fs.readFileSync(args.providers, 'utf8')) : defaultProviders();
  const snapshot = await buildSnapshot(providers);
  writeSnapshot(snapshot, args.output);
  process.stdout.write(`${JSON.stringify({ schema: snapshot.schema, output: args.output, records: snapshot.records.length, receipts: snapshot.receipts })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
