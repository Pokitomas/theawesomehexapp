const PROFILE_KEY = 'sideways-local-profile-v1';

function safeURL(value = '') {
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

function clean(value = '') {
  return String(value).replace(/\u0000/g, '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function localProfile() {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    return {
      displayName: clean(value.name || 'Me').slice(0, 80) || 'Me',
      handle: value.handle ? `@${clean(value.handle).replace(/^@/, '').slice(0, 47)}` : ''
    };
  } catch {
    return { displayName: 'Me', handle: '' };
  }
}

export function currentProfile() {
  const core = window.SidewaysProfiles?.profile;
  return core?.displayName && core.displayName !== 'Me' ? core : localProfile();
}

export function normalizeRecord(input, file, digest) {
  const profile = currentProfile();
  const now = new Date().toISOString();
  const text = clean(input.text || '');
  const title = clean(input.title || input.name || text.split('\n')[0] || file.name || 'UNTITLED').slice(0, 240) || 'UNTITLED';
  const source = clean(input.source || file.name || 'MY IMPORT').slice(0, 120) || 'MY IMPORT';
  return {
    type: ['article', 'forum', 'social'].includes(input.type) ? input.type : 'social',
    title,
    summary: clean(input.summary || text.slice(0, 420)).slice(0, 900),
    text,
    body: Array.isArray(input.body) ? input.body.map(clean).filter(Boolean).slice(0, 100) : [],
    source,
    sourceUrl: safeURL(input.sourceUrl),
    outboundUrl: safeURL(input.outboundUrl),
    author: {
      name: clean(input.author?.name || profile.displayName || 'Me').slice(0, 80),
      handle: clean(input.author?.handle || profile.handle || '').slice(0, 48),
      url: safeURL(input.author?.url),
      avatar: safeURL(input.author?.avatar)
    },
    published: input.published || now,
    addedAt: now,
    updatedAt: now,
    originalName: clean(input.originalName || file.webkitRelativePath || file.name || title).slice(0, 260),
    mime: clean(input.mime || file.type || 'application/octet-stream').slice(0, 120),
    size: Number(input.size) || file.size || new Blob([text]).size,
    hash: input.hash || `${digest}:${input.nativeId || title}`,
    assetKey: clean(input.assetKey || ''),
    mediaKind: clean(input.mediaKind || ''),
    mediaConfidence: clean(input.mediaConfidence || ''),
    width: Math.max(0, Number(input.width) || 0),
    height: Math.max(0, Number(input.height) || 0),
    duration: Math.max(0, Number(input.duration) || 0),
    nativeId: clean(input.nativeId || '').slice(0, 180),
    links: Array.isArray(input.links) ? input.links.map(item => ({ label: clean(item.label || item.url || 'LINK').slice(0, 120), url: safeURL(item.url) })).filter(item => item.url).slice(0, 100) : [],
    tags: Array.isArray(input.tags) ? input.tags.map(clean).filter(Boolean).slice(0, 30) : [],
    rank: input.rank && typeof input.rank === 'object' ? structuredClone(input.rank) : {},
    compatibility: input.compatibility && typeof input.compatibility === 'object' ? structuredClone(input.compatibility) : {}
  };
}
