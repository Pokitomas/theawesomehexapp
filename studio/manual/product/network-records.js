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
const postIdOf = record => String(record?.social?.postId || record?.nativeId || '').replace(/^network:/, '');

export function networkViewKey(value = 'discover') {
  return clean(value || 'discover').toLowerCase().replace(/[^a-z0-9:._-]+/g, '-').slice(0, 96) || 'discover';
}

export function planNetworkProjection({
  cachedPostIds = [],
  currentCandidatePostIds = [],
  incomingPostIds = [],
  viewKey = 'discover'
} = {}) {
  const normalizedView = networkViewKey(viewKey);
  const cached = new Set((cachedPostIds || []).map(String).filter(Boolean));
  const current = new Set((currentCandidatePostIds || []).map(String).filter(Boolean));
  const incoming = [...new Set((incomingPostIds || []).map(String).filter(Boolean))];
  for (const postId of incoming) cached.add(postId);
  return {
    viewKey: normalizedView,
    cacheRetain: [...cached].sort(),
    cacheUpsert: incoming,
    candidateMaterialize: incoming,
    candidateRemove: [...current].filter(postId => !incoming.includes(postId)).sort(),
    membershipReplace: incoming.map(postId => ({
      key: `${normalizedView}:${postId}`,
      viewKey: normalizedView,
      postId
    }))
  };
}

async function projectedRecord(post, existing = null, viewKey = 'discover') {
  const text = clean(post?.text || '').slice(0, 4000);
  const published = post?.createdAt || new Date().toISOString();
  const nativeId = `${PREFIX}${post.id}`;
  const firstLine = clean(text.split('\n')[0] || 'Post').slice(0, 240) || 'Post';
  const authorHandle = clean(post?.author?.handle || '').replace(/^@/, '');
  const hash = await hashText(`${nativeId}\n${post.updatedAt || published}\n${text}`);
  const record = {
    ...(existing || {}),
    authority: 'public',
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
    eligibility: {
      source: 'network-view',
      viewKey: networkViewKey(viewKey)
    },
    social: {
      postId: String(post.id || ''),
      replyTo: post.replyTo || null,
      likeCount: Number(post.likeCount || 0),
      replyCount: Number(post.replyCount || 0),
      liked: Boolean(post.liked),
      following: Boolean(post.following),
      mine: Boolean(post.mine),
      authorId: String(post?.author?.id || ''),
      authorHandle,
      eligibilitySource: networkViewKey(viewKey)
    }
  };
  if (!existing?.id) delete record.id;
  return record;
}

function cachedRecord(record) {
  const cached = structuredClone(record || {});
  delete cached.id;
  cached.authority = 'public';
  cached.eligibility = { source: 'network-cache', viewKey: null };
  if (cached.social) cached.social.eligibilitySource = null;
  return cached;
}

function cacheRow(record, observedAt = new Date().toISOString()) {
  const postId = postIdOf(record);
  return {
    postId,
    nativeId: `${PREFIX}${postId}`,
    observedAt,
    updatedAt: record.updatedAt || observedAt,
    record: cachedRecord(record)
  };
}

async function writeNetworkCache({ existingProjections, incomingRecords, viewKey, observedAt }) {
  const [cachedRows, memberships] = await Promise.all([
    readStore(openWorkspaceDB, NETWORK_RECORD_STORE).catch(() => []),
    readStore(openWorkspaceDB, NETWORK_VIEW_STORE).catch(() => [])
  ]);
  const cached = new Map((cachedRows || []).map(row => [String(row.postId), row]));

  // Migrate any old shared-store projections into the durable public cache before
  // replacing the active candidate materialization.
  for (const projection of existingProjections) {
    const postId = postIdOf(projection);
    if (postId && !cached.has(postId)) cached.set(postId, cacheRow(projection, projection.updatedAt || projection.addedAt || observedAt));
  }
  for (const record of incomingRecords) cached.set(postIdOf(record), cacheRow(record, observedAt));

  const plan = planNetworkProjection({
    cachedPostIds: [...cached.keys()],
    currentCandidatePostIds: existingProjections.map(postIdOf),
    incomingPostIds: incomingRecords.map(postIdOf),
    viewKey
  });

  const db = await openWorkspaceDB();
  try {
    const tx = db.transaction([NETWORK_RECORD_STORE, NETWORK_VIEW_STORE], 'readwrite');
    const records = tx.objectStore(NETWORK_RECORD_STORE);
    const views = tx.objectStore(NETWORK_VIEW_STORE);
    for (const row of cached.values()) records.put(row);
    for (const membership of memberships || []) {
      if (membership.viewKey === plan.viewKey) views.delete(membership.key);
    }
    for (const membership of plan.membershipReplace) views.put({ ...membership, observedAt });
    await transactionDone(tx);
  } finally {
    db.close();
  }

  return plan;
}

async function materializeCandidates({ existingProjections, incomingRecords, plan }) {
  const db = await openCorpusDB();
  try {
    const tx = db.transaction([RECORD_STORE, LEDGER_STORE], 'readwrite');
    const records = tx.objectStore(RECORD_STORE);
    const incomingIds = new Set(plan.candidateMaterialize);
    for (const record of existingProjections) {
      if (!incomingIds.has(postIdOf(record))) records.delete(record.id);
    }
    for (const record of incomingRecords) {
      if (record.id) records.put(record);
      else records.add(record);
    }
    tx.objectStore(LEDGER_STORE).add(ledgerEntry('network.materialize', {
      viewKey: plan.viewKey,
      candidates: incomingRecords.length,
      candidateRemoved: plan.candidateRemove.length,
      cachedPublicRecords: plan.cacheRetain.length,
      authoritativeDeletes: 0,
      source: 'server'
    }));
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function projectNetworkPosts(posts = [], detail = {}) {
  const incoming = Array.isArray(posts) ? posts.filter(post => post?.id && post?.author?.id) : [];
  const viewKey = networkViewKey(detail.viewKey || detail.mode || 'discover');
  const observedAt = new Date().toISOString();
  const all = await readStore(openCorpusDB, RECORD_STORE);
  const existingProjections = (all || []).filter(isNetwork);
  const existing = new Map(existingProjections.map(record => [postIdOf(record), record]));
  const cachedRows = await readStore(openWorkspaceDB, NETWORK_RECORD_STORE).catch(() => []);
  const cached = new Map((cachedRows || []).map(row => [String(row.postId), row.record]));
  const next = await Promise.all(incoming.map(post => projectedRecord(
    post,
    existing.get(String(post.id)) || cached.get(String(post.id)) || null,
    viewKey
  )));

  const plan = await writeNetworkCache({
    existingProjections,
    incomingRecords: next,
    viewKey,
    observedAt
  });
  await materializeCandidates({ existingProjections, incomingRecords: next, plan });

  const refresh = new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 3000);
    window.addEventListener('sideways:corpusrefresh', event => {
      clearTimeout(timer);
      resolve(event.detail || {});
    }, { once: true });
  });
  window.dispatchEvent(new CustomEvent('sideways:importcomplete', {
    detail: {
      source: 'network',
      mode: detail.mode || 'discover',
      viewKey,
      count: next.length,
      cached: plan.cacheRetain.length
    }
  }));
  await refresh;
  window.dispatchEvent(new CustomEvent('sideways:networkchange', {
    detail: {
      mode: detail.mode || 'discover',
      viewKey,
      count: next.length,
      cached: plan.cacheRetain.length
    }
  }));
  return {
    count: next.length,
    cached: plan.cacheRetain.length,
    candidateRemoved: plan.candidateRemove.length,
    viewKey
  };
}

export async function networkRecords({ viewKey = '' } = {}) {
  const [rows, memberships] = await Promise.all([
    readStore(openWorkspaceDB, NETWORK_RECORD_STORE).catch(() => []),
    readStore(openWorkspaceDB, NETWORK_VIEW_STORE).catch(() => [])
  ]);
  const normalizedView = viewKey ? networkViewKey(viewKey) : '';
  const eligible = normalizedView
    ? new Set((memberships || []).filter(row => row.viewKey === normalizedView).map(row => String(row.postId)))
    : null;
  const viewsByPost = new Map();
  for (const membership of memberships || []) {
    const postId = String(membership.postId || '');
    if (!viewsByPost.has(postId)) viewsByPost.set(postId, []);
    viewsByPost.get(postId).push(membership.viewKey);
  }
  return (rows || [])
    .filter(row => !eligible || eligible.has(String(row.postId)))
    .map(row => ({
      ...structuredClone(row.record),
      authority: 'public',
      cache: {
        observedAt: row.observedAt,
        eligibleIn: [...new Set(viewsByPost.get(String(row.postId)) || [])].sort()
      }
    }))
    .sort((left, right) => String(right.published || right.addedAt).localeCompare(String(left.published || left.addedAt)));
}
