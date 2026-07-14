import {
  LEDGER_STORE,
  NETWORK_RECORD_STORE,
  NETWORK_VIEW_STORE,
  RECORD_STORE,
  clean,
  hashText,
  ledgerEntry,
  openCorpusDB,
  openWorkspaceDB,
  readStore,
  transactionDone
} from './workspace-db.js';

const PREFIX = 'network:';
const isNetwork = record => String(record?.nativeId || '').startsWith(PREFIX);
const postIdOf = record => String(record?.postId || record?.social?.postId || String(record?.nativeId || '').slice(PREFIX.length));
const viewKeyOf = detail => clean(detail?.mode || 'discover').slice(0, 24) || 'discover';

async function projectedRecord(post, existing = null, observedAt = new Date().toISOString()) {
  const postId = String(post?.id || '');
  const text = clean(post?.text || '').slice(0, 4000);
  const published = post?.createdAt || new Date().toISOString();
  const nativeId = `${PREFIX}${postId}`;
  const firstLine = clean(text.split('\n')[0] || 'Post').slice(0, 240) || 'Post';
  const authorHandle = clean(post?.author?.handle || '').replace(/^@/, '');
  const hash = await hashText(`${nativeId}\n${post.updatedAt || published}\n${text}`);
  const record = {
    ...(existing || {}),
    postId,
    authority: 'public',
    observedAt,
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
      postId,
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
  delete record.id;
  delete record.eligibilitySource;
  return record;
}

export function mergeNetworkCache(existing = [], incoming = []) {
  const merged = new Map();
  for (const record of existing) {
    const postId = postIdOf(record);
    if (postId) merged.set(postId, { ...record, postId });
  }
  for (const record of incoming) {
    const postId = postIdOf(record);
    if (postId) merged.set(postId, { ...record, postId });
  }
  return [...merged.values()];
}

export function legacyNetworkCacheSeeds(existingRecords = [], observedAt = new Date().toISOString()) {
  return (Array.isArray(existingRecords) ? existingRecords : [])
    .filter(isNetwork)
    .map(source => {
      const record = structuredClone(source);
      const postId = postIdOf(record);
      delete record.id;
      delete record.eligibilitySource;
      return {
        ...record,
        postId,
        authority: 'public',
        observedAt: record.observedAt || record.updatedAt || record.addedAt || observedAt
      };
    })
    .filter(record => record.postId);
}

export function networkViewSnapshot(records = [], detail = {}, observedAt = new Date().toISOString()) {
  const postIds = [];
  const seen = new Set();
  for (const record of records) {
    const postId = postIdOf(record);
    if (!postId || seen.has(postId)) continue;
    seen.add(postId);
    postIds.push(postId);
  }
  return {
    key: viewKeyOf(detail),
    postIds,
    observedAt,
    source: 'server'
  };
}

export function candidateMaterializationPlan(existingRecords = [], projectedRecords = [], view = {}) {
  const existingCandidates = new Map(
    existingRecords
      .filter(isNetwork)
      .map(record => [postIdOf(record), record])
      .filter(([postId]) => postId)
  );
  const projected = new Map(projectedRecords.map(record => [postIdOf(record), record]).filter(([postId]) => postId));
  const eligible = new Set(Array.isArray(view.postIds) ? view.postIds.map(String) : []);
  const deleteIds = [...existingCandidates.entries()]
    .filter(([postId, record]) => !eligible.has(postId) && Number(record.id))
    .map(([, record]) => Number(record.id));
  const upserts = [];
  for (const postId of eligible) {
    const record = projected.get(postId);
    if (!record) continue;
    const existing = existingCandidates.get(postId);
    const candidate = { ...record, eligibilitySource: String(view.key || 'discover') };
    if (Number(existing?.id)) candidate.id = Number(existing.id);
    upserts.push(candidate);
  }
  return { deleteIds, upserts };
}

async function cacheNetworkView(projected, view, legacySeeds = []) {
  const existing = await readStore(openWorkspaceDB, NETWORK_RECORD_STORE);
  const retained = mergeNetworkCache(existing || [], legacySeeds);
  const merged = mergeNetworkCache(retained, projected);
  const db = await openWorkspaceDB();
  try {
    const tx = db.transaction([NETWORK_RECORD_STORE, NETWORK_VIEW_STORE], 'readwrite');
    const records = tx.objectStore(NETWORK_RECORD_STORE);
    for (const record of merged) records.put(record);
    tx.objectStore(NETWORK_VIEW_STORE).put(view);
    await transactionDone(tx);
  } finally {
    db.close();
  }
  return { cached: merged.length, migrated: Math.max(0, retained.length - (existing || []).length) };
}

async function materializeCandidateView(projected, view, allRecords, cacheDetail = {}) {
  const plan = candidateMaterializationPlan(allRecords || [], projected, view);
  const db = await openCorpusDB();
  try {
    const tx = db.transaction([RECORD_STORE, LEDGER_STORE], 'readwrite');
    const records = tx.objectStore(RECORD_STORE);
    for (const id of plan.deleteIds) records.delete(id);
    for (const record of plan.upserts) {
      if (record.id) records.put(record);
      else records.add(record);
    }
    tx.objectStore(LEDGER_STORE).add(ledgerEntry('network.materialize', {
      mode: view.key,
      records: plan.upserts.length,
      removedCandidates: plan.deleteIds.length,
      cached: Number(cacheDetail.cached || projected.length),
      migrated: Number(cacheDetail.migrated || 0),
      authoritativeDeletes: 0,
      source: 'server'
    }));
    await transactionDone(tx);
  } finally {
    db.close();
  }
  return plan;
}

export async function projectNetworkPosts(posts = [], detail = {}) {
  const incoming = [];
  const seen = new Set();
  for (const post of Array.isArray(posts) ? posts : []) {
    const postId = String(post?.id || '');
    if (!postId || !post?.author?.id || seen.has(postId)) continue;
    seen.add(postId);
    incoming.push(post);
  }
  const observedAt = new Date().toISOString();
  const [cached, allRecords] = await Promise.all([
    readStore(openWorkspaceDB, NETWORK_RECORD_STORE),
    readStore(openCorpusDB, RECORD_STORE)
  ]);
  const legacySeeds = legacyNetworkCacheSeeds(allRecords || [], observedAt);
  const retained = mergeNetworkCache(cached || [], legacySeeds);
  const existing = new Map(retained.map(record => [postIdOf(record), record]));
  const next = await Promise.all(incoming.map(post => projectedRecord(post, existing.get(String(post.id)), observedAt)));
  const view = networkViewSnapshot(next, detail, observedAt);
  const cacheDetail = await cacheNetworkView(next, view, legacySeeds);
  const plan = await materializeCandidateView(next, view, allRecords || [], cacheDetail);
  const refresh = new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 3000);
    window.addEventListener('sideways:corpusrefresh', event => {
      clearTimeout(timer);
      resolve(event.detail || {});
    }, { once: true });
  });
  window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { source: 'network', mode: view.key, count: next.length } }));
  await refresh;
  window.dispatchEvent(new CustomEvent('sideways:networkchange', { detail: { mode: view.key, count: next.length } }));
  return {
    count: next.length,
    view: view.key,
    cached: cacheDetail.cached,
    migrated: cacheDetail.migrated,
    removedCandidates: plan.deleteIds.length
  };
}

export async function networkRecords(viewKey = '') {
  const cached = await readStore(openWorkspaceDB, NETWORK_RECORD_STORE);
  const records = cached || [];
  if (!clean(viewKey)) {
    return records.sort((a, b) => String(b.published || b.addedAt).localeCompare(String(a.published || a.addedAt)));
  }
  const view = await readStore(openWorkspaceDB, NETWORK_VIEW_STORE, viewKeyOf({ mode: viewKey }));
  if (!view?.postIds?.length) return [];
  const byId = new Map(records.map(record => [postIdOf(record), record]));
  return view.postIds.map(postId => byId.get(String(postId))).filter(Boolean);
}
