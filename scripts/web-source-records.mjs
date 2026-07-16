import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { safeSourceURL } from './web-source-security.mjs';

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

function isoDate(value, fallback = '1970-01-01T00:00:00.000Z') {
  const date = value ? new Date(value) : new Date(fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function stableId(provider, canonical, title, published) {
  return crypto.createHash('sha256').update(`${provider}\n${canonical}\n${title}\n${published}`).digest('hex').slice(0, 24);
}

function authorName(input, fallback) {
  const explicit = typeof input.author === 'string' ? clean(input.author) : '';
  if (explicit) return explicit;
  return input.author?.name || input.author?.display_name || input.account?.display_name || input.account?.username || input.contributor || fallback;
}

function normalizeReplies(value, fallbackPublished) {
  return Object.freeze((Array.isArray(value) ? value : [])
    .slice(0, 18)
    .map(reply => {
      if (!reply || typeof reply !== 'object') return null;
      const text = clean(decodeEntities(stripTags(reply.text || reply.content || reply.body || ''))).slice(0, 1200);
      if (!text) return null;
      const id = clean(reply.id || reply.objectID || reply.native_id || '').slice(0, 240);
      const author = clean(authorName(reply, 'unknown')).slice(0, 160) || 'unknown';
      let url = '';
      try {
        const raw = reply.url || reply.canonical_url || '';
        if (raw) url = safeSourceURL(raw).href;
      } catch {}
      return Object.freeze({
        id,
        author,
        text,
        published_at: isoDate(reply.published_at || reply.published || reply.created_at || reply.createdAt, fallbackPublished),
        url,
        children: Math.max(0, Number(reply.children || reply.children_count || 0))
      });
    })
    .filter(Boolean));
}

export function normalizeWebRecord(input = {}, provider = {}) {
  const sourceURL = (() => {
    try {
      const raw = input.url || input.link || input.sourceUrl || input.fullurl || input.story_url || provider.url;
      return safeSourceURL(new URL(raw, provider.url).href).href;
    } catch {
      return '';
    }
  })();
  const providerName = clean(provider.name || provider.id || (sourceURL ? new URL(sourceURL).hostname : 'Web'));
  const providerId = clean(provider.id || providerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 100);
  const rawText = input.summary || input.description || input.extract || input.content || input.text || input.story_text || '';
  const title = clean(decodeEntities(input.title || input.story_title || input.name || stripTags(rawText) || sourceURL || 'Untitled')).slice(0, 240);
  const summary = clean(decodeEntities(stripTags(rawText))).slice(0, 900);
  const published = isoDate(input.published || input.pubDate || input.updated || input.createdAt || input.created_at || input.timestamp || provider.fetchedAt, provider.fetchedAt);
  const kind = ['article', 'forum', 'social'].includes(input.kind || input.type) ? (input.kind || input.type) : (provider.kind || 'article');
  const recordId = stableId(providerId, sourceURL, title, published);
  const contributor = clean(authorName(input, providerName)).slice(0, 160);
  const score = Math.max(0, Number(input.score || input.points || input.favourites_count || 0));
  const comments = Math.max(0, Number(input.comments || input.num_comments || input.replies_count || 0));
  const sourceRoot = safeSourceURL(provider.url).href;
  const replies = normalizeReplies(input.replies, published);
  const engagement = kind === 'forum'
    ? Object.freeze({ points: score, comments })
    : kind === 'social'
      ? Object.freeze({
        likes: score,
        boosts: Math.max(0, Number(input.reblogs_count || input.reblogs || input.boosts || 0)),
        replies: comments
      })
      : Object.freeze({});
  return Object.freeze({
    id: recordId,
    kind,
    type: kind,
    title,
    published,
    published_at: published,
    native_id: clean(input.id || input.objectID || input.nativeId || input.native_id || recordId).slice(0, 240),
    revision: 'bounded public source snapshot',
    contributor,
    author_name: contributor,
    categories: [...new Set([providerId, ...(Array.isArray(input.categories) ? input.categories : [])].map(clean).filter(Boolean))].slice(0, 24),
    dek: summary || title,
    text: summary || title,
    body: [summary || title],
    sources: sourceURL ? [{ label: providerName, url: sourceURL }] : [],
    url: sourceURL,
    canonical_url: sourceURL,
    outbound_url: clean(input.story_url || input.outbound_url || '').slice(0, 2000),
    source_name: providerName,
    source_url: sourceRoot,
    language: clean(input.language || provider.language || 'en').slice(0, 32),
    content_warning: clean(input.spoiler_text || input.content_warning || '').slice(0, 500),
    engagement,
    replies,
    license: clean(provider.license || 'source-defined'),
    attribution: providerName,
    community: clean(provider.community || providerName),
    score,
    comments,
    resurfaced: (provider.fetchedAt || published).slice(0, 10),
    synthetic: false,
    provenance: Object.freeze({
      schema: 'sideways-web-provenance/v1',
      provider: providerId,
      method: clean(provider.method || provider.format || 'web'),
      source_url: sourceRoot,
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

export function parseSitemap(text) {
  const entries = [];
  for (const match of String(text).matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const block = match[2];
    const url = tag(block, ['loc']);
    if (url) entries.push({ title: url, url, published: tag(block, ['lastmod']) });
  }
  return entries;
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

function attributeValue(tagText, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tagText);
  return match ? decodeEntities(match[1]) : '';
}

function metaContent(text, names) {
  for (const tagText of String(text).match(/<meta\b[^>]*>/gi) || []) {
    const key = attributeValue(tagText, 'name') || attributeValue(tagText, 'property');
    if (names.includes(key.toLowerCase())) return attributeValue(tagText, 'content');
  }
  return '';
}

function htmlRecord(text, provider) {
  const htmlTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] || '';
  const title = metaContent(text, ['og:title', 'twitter:title']) || stripTags(htmlTitle);
  const description = metaContent(text, ['description', 'og:description', 'twitter:description']);
  let canonical = provider.url;
  for (const tagText of String(text).match(/<link\b[^>]*>/gi) || []) {
    if (attributeValue(tagText, 'rel').toLowerCase().split(/\s+/).includes('canonical')) {
      canonical = attributeValue(tagText, 'href') || canonical;
      break;
    }
  }
  return [{
    title,
    description,
    url: new URL(canonical, provider.url).href,
    published: metaContent(text, ['article:published_time']),
    author: metaContent(text, ['author', 'article:author'])
  }];
}

export function parseSourcePayload(text, contentType, provider = {}) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || provider.format === 'json') return jsonRecords(JSON.parse(text));
  if (provider.format === 'sitemap' || /<(?:urlset|sitemapindex)\b/i.test(text)) return parseSitemap(text);
  if (type.includes('xml') || type.includes('rss') || type.includes('atom') || provider.format === 'rss' || provider.format === 'atom') return parseSyndication(text);
  if (type === 'text/html' || provider.format === 'html') return htmlRecord(text, provider);
  throw new Error(`unsupported source content type: ${type || '(missing)'}`);
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
