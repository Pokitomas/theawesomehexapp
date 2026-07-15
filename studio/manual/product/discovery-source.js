const DEFAULT_LIMITS = Object.freeze({ records: 200, bytes: 2_000_000, redirects: 4, timeoutMs: 12_000 });
const CAPABILITY_STATES = Object.freeze({ WEB: 'web', CONNECTED: 'connected', PRIVATE: 'private', SHARED: 'shared' });
const ALLOWED_CONTENT_TYPES = Object.freeze(['text/html', 'application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml', 'application/json']);

function clean(value = '') {
  return String(value).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function privateIPv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some(value => value > 255)) return true;
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function publicHostname(value = '') {
  try { return safePublicURL(value).hostname; } catch { return ''; }
}

export function safePublicURL(value) {
  const parsed = new URL(String(value));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only public HTTP or HTTPS sources are supported.');
  if (parsed.username || parsed.password) throw new Error('Source URLs cannot contain credentials.');
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || hostname.endsWith('.local') || privateIPv4(hostname)) {
    throw new Error('Private-network sources are not allowed.');
  }
  parsed.hash = '';
  return parsed;
}

export function classifyAddInput(value) {
  if (typeof File !== 'undefined' && value instanceof File) return 'file';
  if (typeof Blob !== 'undefined' && value instanceof Blob) return 'file';
  const text = clean(value);
  if (!text) return 'unknown';
  if (/\.sideways(?:$|[?#])/i.test(text)) return 'backup';
  try {
    const parsed = safePublicURL(text);
    if (/\.(rss|atom|xml)(?:$|[?#])/i.test(parsed.pathname) || /\b(feed|rss|atom)\b/i.test(parsed.pathname)) return 'feed';
    return 'website';
  } catch {
    return 'unknown';
  }
}

function canonicalURL(value, fallback = '') {
  try { return safePublicURL(value || fallback).href; } catch { return ''; }
}

export function normalizeDiscoveryRecord(input = {}, provenance = {}) {
  const sourceURL = canonicalURL(input.sourceUrl || input.url, provenance.sourceUrl);
  const canonical = canonicalURL(input.canonicalUrl || input.outboundUrl, sourceURL);
  const hostname = publicHostname(sourceURL || canonical);
  const title = clean(input.title || input.name || input.text || canonical || 'Untitled').slice(0, 240);
  const text = clean(input.text || input.body || input.content || input.summary || '').slice(0, 50_000);
  const published = input.published || input.date || input.createdAt || null;
  const date = published ? new Date(published) : null;
  return Object.freeze({
    schema: 'sideways-discovery-record/v1',
    id: clean(input.id || input.nativeId || canonical || `${title}:${published || ''}`).slice(0, 300),
    state: provenance.state || CAPABILITY_STATES.WEB,
    type: ['article', 'forum', 'social', 'media'].includes(input.type) ? input.type : 'article',
    title,
    summary: clean(input.summary || text).slice(0, 900),
    text,
    canonicalUrl: canonical,
    source: Object.freeze({
      id: clean(provenance.sourceId || input.sourceId || hostname || 'unknown-source').slice(0, 160),
      name: clean(provenance.sourceName || input.source || hostname || 'Unknown source').slice(0, 160),
      url: sourceURL || canonical,
      method: clean(provenance.method || 'web'),
      fetchedAt: provenance.fetchedAt || new Date().toISOString(),
      cache: clean(provenance.cache || 'request-window')
    }),
    author: Object.freeze({ name: clean(input.author?.name || input.authorName || ''), handle: clean(input.author?.handle || input.authorHandle || '') }),
    published: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    tags: Object.freeze((Array.isArray(input.tags) ? input.tags : []).map(clean).filter(Boolean).slice(0, 30))
  });
}

export function materializeCandidates(records, { enabledSourceIds = [], limit = DEFAULT_LIMITS.records } = {}) {
  const enabled = new Set(enabledSourceIds.map(clean).filter(Boolean));
  const seen = new Set();
  const output = [];
  for (const item of Array.isArray(records) ? records : []) {
    if (!item || item.schema !== 'sideways-discovery-record/v1') continue;
    if (enabled.size && !enabled.has(item.source.id)) continue;
    const key = item.canonicalUrl || `${item.source.id}:${item.id}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= Math.max(1, Math.min(Number(limit) || DEFAULT_LIMITS.records, DEFAULT_LIMITS.records))) break;
  }
  return Object.freeze(output);
}

export function createSourceCollection(initial = []) {
  let sources = (Array.isArray(initial) ? initial : []).map(source => Object.freeze({
    id: clean(source.id || source.url),
    name: clean(source.name || source.url),
    url: safePublicURL(source.url).href,
    enabled: source.enabled !== false,
    kind: ['website', 'feed', 'sitemap', 'activitypub', 'search'].includes(source.kind) ? source.kind : 'website'
  }));
  return Object.freeze({
    list: () => [...sources],
    add(source) {
      const parsed = safePublicURL(source.url);
      const next = Object.freeze({ id: clean(source.id || parsed.hostname), name: clean(source.name || parsed.hostname), url: parsed.href, enabled: true, kind: source.kind || classifyAddInput(parsed.href) });
      sources = [...sources.filter(item => item.id !== next.id && item.url !== next.url), next];
      return next;
    },
    setEnabled(id, enabled) { sources = sources.map(item => item.id === id ? Object.freeze({ ...item, enabled: Boolean(enabled) }) : item); },
    remove(id) { sources = sources.filter(item => item.id !== id); }
  });
}

export function boundedFetchPlan(url, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  return Object.freeze({
    url: safePublicURL(url).href,
    method: 'GET',
    redirect: 'follow',
    credentials: 'omit',
    cache: 'no-store',
    limits: Object.freeze({ records: Math.min(Number(limits.records) || 200, 200), bytes: Math.min(Number(limits.bytes) || 2_000_000, 2_000_000), redirects: Math.min(Number(limits.redirects) || 4, 4), timeoutMs: Math.min(Number(limits.timeoutMs) || 12_000, 30_000) }),
    allowedContentTypes: ALLOWED_CONTENT_TYPES
  });
}

export { CAPABILITY_STATES, DEFAULT_LIMITS, ALLOWED_CONTENT_TYPES };
