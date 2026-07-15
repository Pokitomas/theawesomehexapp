#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_LIMITS = Object.freeze({ sources: 24, recordsPerSource: 250, totalRecords: 1800, bytesPerSource: 2_000_000, timeoutMs: 20_000 });
const ALLOWED_TYPES = ['application/json', 'application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml', 'text/html'];

function clean(value = '') { return value == null ? '' : String(value).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim(); }
function stripTags(value = '') { return clean(String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')); }
function decodeEntities(value = '') { return String(value).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

function privateIPv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some(value => value > 255)) return true;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export function safeSourceURL(value) {
  const parsed = new URL(String(value));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('source protocol must be HTTP or HTTPS');
  if (parsed.username || parsed.password) throw new Error('source URL cannot contain credentials');
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || privateIPv4(host)) throw new Error('source URL cannot target a private network');
  parsed.hash = '';
  return parsed;
}

function isoDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function stableId(provider, canonical, title, published) {
  return crypto.createHash('sha256').update(`${provider}\n${canonical}\n${title}\n${published}`).digest('hex').slice(0, 24);
}

function authorName(input, fallback) {
  if (typeof input.author === 'string') return input.author;
  return input.author?.name || input.author?.display_name || input.account?.display_name || input.account?.username || input.contributor || fallback;
}

export function normalizeWebRecord(input = {}, provider = {}) {
  const sourceURL = (() => { try { return safeSourceURL(input.url || input.link || input.sourceUrl || input.fullurl || input.story_url || provider.url).href; } catch { return ''; } })();
  const providerName = clean(provider.name || provider.id || (sourceURL ? new URL(sourceURL).hostname : 'Web'));
  const providerId = clean(provider.id || providerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 100);
  const rawText = input.summary || input.description || input.extract || input.content || input.text || input.story_text || '';
  const title = clean(decodeEntities(input.title || input.story_title || input.name || stripTags(rawText) || sourceURL || 'Untitled')).slice(0, 240);
  const summary = clean(decodeEntities(stripTags(rawText))).slice(0, 900);
  const published = isoDate(input.published || input.pubDate || input.updated || input.createdAt || input.created_at || input.timestamp || provider.fetchedAt);
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
    resurfaced: (provider.fetchedAt || new Date().toISOString()).slice(0, 10),
    synthetic: false,
    provenance: {
      schema: 'sideways-web-provenance/v1',
      provider: providerId,
      method: clean(provider.method || provider.format || 'web'),
      source_url: safeSourceURL(provider.url).href,
      fetched_at: provider.fetchedAt || new Date().toISOString(),
      cache: 'bounded-build-snapshot'
    }
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
  const rows = payload.items || payload.entries || payload.hits || payload.data || payload.posts || [];
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

export async function fetchBoundedSource(provider, { fetchImpl = fetch, limits = DEFAULT_LIMITS } = {}) {
  const source = safeSourceURL(provider.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    const response = await fetchImpl(source, { headers: { accept: ALLOWED_TYPES.join(', ') }, redirect: 'follow', credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error(`source responded ${response.status}`);
    safeSourceURL(response.url || source.href);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.includes(contentType) && !provider.format) throw new Error(`source content type is not allowed: ${contentType || '(missing)'}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > limits.bytesPerSource) throw new Error('source exceeds byte limit');
    const reader = response.body?.getReader();
    let bytes = 0;
    const chunks = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limits.bytesPerSource) { await reader.cancel(); throw new Error('source exceeds byte limit'); }
        chunks.push(value);
      }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > limits.bytesPerSource) throw new Error('source exceeds byte limit');
      chunks.push(buffer);
    }
    const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    const fetchedAt = new Date().toISOString();
    const rows = parseSourcePayload(new TextDecoder().decode(merged), contentType, provider).slice(0, limits.recordsPerSource);
    return rows.map(row => normalizeWebRecord(row, { ...provider, fetchedAt }));
  } finally {
    clearTimeout(timer);
  }
}

export async function buildSnapshot(providers, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const selected = (Array.isArray(providers) ? providers : []).filter(provider => provider?.enabled !== false).slice(0, limits.sources);
  const records = [];
  const receipts = [];
  for (const provider of selected) {
    try {
      const next = options.fixturePayloads?.[provider.id]
        ? parseSourcePayload(options.fixturePayloads[provider.id].text, options.fixturePayloads[provider.id].contentType, provider).map(row => normalizeWebRecord(row, { ...provider, fetchedAt: options.now || '2026-07-15T00:00:00.000Z' }))
        : await fetchBoundedSource(provider, { fetchImpl: options.fetchImpl || fetch, limits });
      let admitted = 0;
      for (const record of next) {
        if (records.length >= limits.totalRecords) break;
        if (records.some(existing => existing.url && existing.url === record.url)) continue;
        records.push(record); admitted += 1;
      }
      receipts.push({ provider: provider.id, status: 'ready', admitted });
    } catch (error) {
      receipts.push({ provider: provider.id, status: 'unavailable', admitted: 0, error: clean(error.message) });
    }
    if (records.length >= limits.totalRecords) break;
  }
  return Object.freeze({ schema: 'sideways-web-source-snapshot/v1', generated_at: options.now || new Date().toISOString(), records: Object.freeze(records), receipts: Object.freeze(receipts), limits: Object.freeze(limits) });
}

function writeSnapshot(snapshot, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const jsonl = snapshot.records.map(record => JSON.stringify(record)).join('\n') + (snapshot.records.length ? '\n' : '');
  fs.writeFileSync(output, zlib.gzipSync(jsonl, { level: 9 }));
  fs.writeFileSync(`${output}.meta.json`, `${JSON.stringify({ schema: snapshot.schema, generated_at: snapshot.generated_at, records: snapshot.records.length, receipts: snapshot.receipts, limits: snapshot.limits }, null, 2)}\n`);
}

function defaultProviders() {
  const configured = process.env.SIDEWAYS_PUBLIC_SOURCES ? JSON.parse(process.env.SIDEWAYS_PUBLIC_SOURCES) : [];
  if (Array.isArray(configured) && configured.length) return configured;
  return [
    { id: 'hacker-news', name: 'Hacker News', kind: 'forum', format: 'json', method: 'public-api', url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=250' },
    { id: 'wikinews', name: 'Wikinews', kind: 'article', format: 'json', method: 'mediawiki-api', url: 'https://en.wikinews.org/w/api.php?action=query&generator=categorymembers&gcmtitle=Category:Published&gcmtype=page&gcmlimit=250&prop=extracts|info&exintro=1&inprop=url&format=json&origin=*' },
    { id: 'mastodon', name: 'Mastodon', kind: 'social', format: 'json', method: 'activitypub-public', url: 'https://mastodon.social/api/v1/timelines/public?limit=40' }
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
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

export { DEFAULT_LIMITS, ALLOWED_TYPES, writeSnapshot };
