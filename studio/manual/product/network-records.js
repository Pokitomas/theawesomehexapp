import {
  LEDGER_STORE,
  RECORD_STORE,
  clean,
  hashText,
  ledgerEntry,
  openCorpusDB,
  readStore,
  transactionDone
} from './workspace-db.js';

const PREFIX = 'network:';
const isNetwork = record => String(record?.nativeId || '').startsWith(PREFIX);

async function projectedRecord(post, existing = null) {
  const text = clean(post?.text || '').slice(0, 4000);
  const published = post?.createdAt || new Date().toISOString();
  const nativeId = `${PREFIX}${post.id}`;
  const firstLine = clean(text.split('\n')[0] || 'Post').slice(0, 240) || 'Post';
  const authorHandle = clean(post?.author?.handle || '').replace(/^@/, '');
  const hash = await hashText(`${nativeId}\n${post.updatedAt || published}\n${text}`);
  const record = {
    ...(existing || {}),
    type: 'social',
    title: firstLine,
    summary: text.slice(0, 420),
    text,
    body: [],
    source: 'Sideways network',
    sourceUrl: '',
    outboundUrl: '',
    author: {
      name: clean(post?.author?.name || authorHandle || 'Sideways user').slice(0, 80),
      handle: authorHandle ? `@${authorHandle}` : '',
      url: '',
      avatar: ''
    },
    published,
    addedAt: existing?.addedAt || published,
    updatedAt: post?.updatedAt || published,
    originalName: 'Public Sideways post',
    mime: 'text/plain',
    size: new Blob([text]).size,
    hash: `${hash}:${nativeId}`,
    assetKey: '',
    mediaKind: '',
    mediaConfidence: '',
    width: 0,
    height: 0,
    nativeId,
    links: [],
    tags: ['sideways:network', ...(post.replyTo ? ['sideways:reply'] : [])],
    rank: {},
    social: {
      postId: String(post.id || ''),
      replyTo: post.replyTo || null,
      likeCount: Number(post.likeCount || 0),
      replyCount: Number(post.replyCount || 0),
      liked: Boolean(post.liked),
      following: Boolean(post.following),
      mine: Boolean(post.mine),
      authorId: String(post?.author?.id || ''),
      authorHandle
    }
  };
  if (!existing?.id) delete record.id;
  return record;
}

export async function projectNetworkPosts(posts = [], detail = {}) {
  const incoming = Array.isArray(posts) ? posts.filter(post => post?.id && post?.author?.id) : [];
  const all = await readStore(openCorpusDB, RECORD_STORE);
  const existing = new Map((all || []).filter(isNetwork).map(record => [String(record.nativeId).slice(PREFIX.length), record]));
  const next = await Promise.all(incoming.map(post => projectedRecord(post, existing.get(String(post.id)))));
  const incomingIds = new Set(incoming.map(post => String(post.id)));
  const db = await openCorpusDB();
  try {
    const tx = db.transaction([RECORD_STORE, LEDGER_STORE], 'readwrite');
    const records = tx.objectStore(RECORD_STORE);
    for (const record of existing.values()) {
      const id = String(record.nativeId).slice(PREFIX.length);
      if (!incomingIds.has(id)) records.delete(record.id);
    }
    for (const record of next) {
      if (record.id) records.put(record);
      else records.add(record);
    }
    tx.objectStore(LEDGER_STORE).add(ledgerEntry('network.project', {
      mode: clean(detail.mode || 'discover').slice(0, 24),
      records: next.length,
      removed: [...existing.keys()].filter(id => !incomingIds.has(id)).length,
      source: 'server'
    }));
    await transactionDone(tx);
  } finally {
    db.close();
  }
  const refresh = new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 3000);
    window.addEventListener('sideways:corpusrefresh', event => {
      clearTimeout(timer);
      resolve(event.detail || {});
    }, { once: true });
  });
  window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { source: 'network', mode: detail.mode || 'discover', count: next.length } }));
  await refresh;
  window.dispatchEvent(new CustomEvent('sideways:networkchange', { detail: { mode: detail.mode || 'discover', count: next.length } }));
  return { count: next.length };
}

export async function networkRecords() {
  return (await readStore(openCorpusDB, RECORD_STORE) || []).filter(isNetwork);
}
