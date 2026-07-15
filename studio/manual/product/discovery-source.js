const DEFAULT_LIMITS = Object.freeze({ records: 200, bytes: 2_000_000, redirects: 4, timeoutMs: 12_000 });
const CAPABILITY_STATES = Object.freeze({ WEB: 'web', CONNECTED: 'connected', PRIVATE: 'private', SHARED: 'shared' });
const ALLOWED_CONTENT_TYPES = Object.freeze(['text/html', 'application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml', 'application/json']);

function clean(value = '') {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function privateIPv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some(value => value > 255)) return true;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function privateIPv6(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
    || /^fe[89ab]/.test(value) || value.startsWith('ff') || value === '2001:db8::' || value.startsWith('2001:db8:');
}

function publicHostname(value = '') {
  try { return safePublicURL(value).hostname; } catch { return ''; }
}

export function safePublicURL(value) {
  const parsed = new URL(String(value));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only public HTTP or HTTPS sources are supported.');
  if (parsed.username || parsed.password) throw new Error('Source URLs cannot contain credentials.');
  for (const key of parsed.searchParams.keys()) {
    if (/(?:token|secret|api[-_]?key|access[-_]?key|credential|password)/i.test(key)) throw new Error('Source URLs cannot contain secret-like query parameters.');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || privateIPv4(hostname) || privateIPv6(hostname)) {
    throw new Error('Private-network sources are not allowed.');
  }
  parsed.hostname = hostname;
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
    if (/sitemap(?:_index)?\.xml$/i.test(parsed.pathname)) return 'sitemap';
    if (/\.(rss|atom|xml)(?:$|[?#])/i.test(parsed.pathname) || /\b(feed|rss|atom)\b/i.test(parsed.pathname)) return 'feed';
    if (/\/(?:api\/v1\/timelines|users\/[^/]+\/(?:outbox|statuses))\b/i.test(parsed.pathname)) return 'activitypub';
    return 'website';
  } catch {
    return 'unknown';
  }
}

function canonicalURL(value, fallback = '') {
  try { return safePublicURL(new URL(value || fallback, fallback || undefined).href).href; } catch { return ''; }
}

export function normalizeDiscoveryRecord(input = {}, provenance = {}) {
  const sourceURL = canonicalURL(input.sourceUrl || input.url, provenance.sourceUrl);
  const canonical = canonicalURL(input.canonicalUrl || input.outboundUrl, sourceURL);
  const hostname = publicHostname(sourceURL || canonical);
  const title = clean(input.title || input.name || input.text || canonical || 'Untitled').slice(0, 240);
  const text = clean(input.text || input.body || input.content || input.summary || '').slice(0, 50_000);
  const published = input.published || input.date || input.createdAt || null;
  const date = published ? new Date(published) : null;
  const state = Object.values(CAPABILITY_STATES).includes(provenance.state) ? provenance.state : CAPABILITY_STATES.WEB;
  return Object.freeze({
    schema: 'sideways-discovery-record/v1',
    id: clean(input.id || input.nativeId || canonical || `${title}:${published || ''}`).slice(0, 300),
    state,
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
      fetchedAt: provenance.fetchedAt || null,
      cache: clean(provenance.cache || 'request-window')
    }),
    author: Object.freeze({ name: clean(input.author?.name || input.authorName || ''), handle: clean(input.author?.handle || input.authorHandle || '') }),
    published: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    tags: Object.freeze((Array.isArray(input.tags) ? input.tags : []).map(clean).filter(Boolean).slice(0, 30))
  });
}

export function saveDiscoveryRecord(record, { explicit = false, savedAt = new Date().toISOString() } = {}) {
  if (!record || record.schema !== 'sideways-discovery-record/v1') throw new Error('Only normalized discovery records can be saved.');
  if (!explicit) throw new Error('Saving public or connected material requires an explicit user action.');
  if (![CAPABILITY_STATES.WEB, CAPABILITY_STATES.CONNECTED].includes(record.state)) throw new Error('Only readable Web or Connected material can be promoted to Private.');
  return Object.freeze({
    ...record,
    state: CAPABILITY_STATES.PRIVATE,
    savedAt,
    saveReceipt: Object.freeze({ schema: 'sideways-explicit-save/v1', from: record.state, to: CAPABILITY_STATES.PRIVATE, explicit: true, savedAt })
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

function generatedSourceId(parsed) {
  return clean(`${parsed.hostname}${parsed.pathname}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 160) || parsed.hostname;
}

function normalizedSource(source) {
  const parsed = safePublicURL(source.url);
  const kind = ['website', 'feed', 'sitemap', 'activitypub', 'search'].includes(source.kind) ? source.kind : classifyAddInput(parsed.href);
  return Object.freeze({
    id: clean(source.id || generatedSourceId(parsed)).slice(0, 160),
    name: clean(source.name || parsed.hostname).slice(0, 160),
    url: parsed.href,
    enabled: source.enabled !== false,
    kind,
    capability: kind === 'search' && source.publicEndpoint !== true ? 'unavailable' : 'available',
    unavailableReason: kind === 'search' && source.publicEndpoint !== true ? 'A configured credential-free public search endpoint is required.' : ''
  });
}

export function createSourceCollection(initial = []) {
  let sources = (Array.isArray(initial) ? initial : []).map(normalizedSource);
  return Object.freeze({
    list: () => [...sources],
    add(source) {
      const next = normalizedSource({ ...source, enabled: true });
      sources = [...sources.filter(item => item.id !== next.id && item.url !== next.url), next];
      return next;
    },
    setEnabled(id, enabled) {
      let changed = false;
      sources = sources.map(item => {
        if (item.id !== id) return item;
        changed = true;
        return Object.freeze({ ...item, enabled: Boolean(enabled) });
      });
      return changed;
    },
    remove(id) {
      const before = sources.length;
      sources = sources.filter(item => item.id !== id);
      return sources.length !== before;
    }
  });
}

export function boundedFetchPlan(url, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  return Object.freeze({
    url: safePublicURL(url).href,
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    cache: 'no-store',
    serverValidationRequired: true,
    publicCacheBoundary: 'separate-from-private-archive',
    limits: Object.freeze({
      records: Math.min(Number(limits.records) || 200, 200),
      bytes: Math.min(Number(limits.bytes) || 2_000_000, 2_000_000),
      redirects: Math.min(Number(limits.redirects) || 4, 4),
      timeoutMs: Math.min(Number(limits.timeoutMs) || 12_000, 30_000)
    }),
    allowedContentTypes: ALLOWED_CONTENT_TYPES
  });
}

export { CAPABILITY_STATES, DEFAULT_LIMITS, ALLOWED_CONTENT_TYPES };
