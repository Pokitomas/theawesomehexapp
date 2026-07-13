import {
  BLOB_STORE,
  LEDGER_STORE,
  RECORD_STORE,
  clean,
  hashText,
  ledgerEntry,
  openCorpusDB,
  readStore,
  requestResult,
  safeURL,
  transactionDone,
  uid
} from './workspace-db.js';
import { clearDraft, placeTag, readProfile, recordPlaceId } from './workspace-profile.js';

function canvasBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), type, quality));
}

function compatibilityOf(record = {}) {
  return {
    mediaKind: record.mediaKind || '',
    mime: record.mime || '',
    mediaConfidence: record.mediaConfidence || '',
    assetKey: record.assetKey || '',
    originalName: record.originalName || ''
  };
}

export async function prepareImage(file) {
  if (!file) return null;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 1800 / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d', { alpha: true }).drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, 'image/webp', .86) || await canvasBlob(canvas, 'image/png') || file;
    return { blob, width: canvas.width, height: canvas.height, mime: blob.type || file.type || 'image/png' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function dataURLToImage(value) {
  if (!value || !String(value).startsWith('data:image/')) return null;
  const response = await fetch(value);
  const blob = await response.blob();
  return { blob, width: 0, height: 0, mime: blob.type || 'image/jpeg' };
}

function authorFromProfile(profile = readProfile()) {
  return {
    name: profile.name,
    handle: profile.handle ? `@${profile.handle}` : '',
    url: '',
    avatar: ''
  };
}

export async function buildRecord(input = {}, options = {}) {
  const profile = options.profile || readProfile();
  const now = options.createdAt || new Date().toISOString();
  const text = clean(input.text || '');
  const firstLine = clean(text.split('\n')[0] || 'Untitled');
  const title = clean(input.title || firstLine || 'Untitled').slice(0, 240) || 'Untitled';
  const nativeId = options.nativeId || `sideways:workspace:${uid('entry')}`;
  const placeId = input.placeId || '';
  const tags = ['sideways:authored', placeTag(placeId), ...(input.tags || [])].filter(Boolean);
  const image = input.image || null;
  const hash = await hashText(`${nativeId}\n${text}\n${placeId}\n${now}`);
  return {
    type: 'social',
    title,
    summary: clean(input.summary || text.slice(0, 420)).slice(0, 900),
    text,
    body: [],
    source: 'Sideways',
    sourceUrl: '',
    outboundUrl: safeURL(input.url),
    author: options.author || authorFromProfile(profile),
    published: now,
    addedAt: now,
    updatedAt: now,
    originalName: 'Sideways post',
    mime: image?.mime || 'text/plain',
    size: new Blob([text]).size + Number(image?.blob?.size || 0),
    hash: `${hash}:${nativeId}`,
    assetKey: image ? `workspace-asset-${uid('image')}` : '',
    mediaKind: image ? 'image' : '',
    mediaConfidence: image ? 'authored' : '',
    width: Number(image?.width || 0),
    height: Number(image?.height || 0),
    nativeId,
    links: [],
    tags,
    rank: {}
  };
}

export async function insertRecord(record, image = null) {
  const db = await openCorpusDB();
  try {
    const stores = image ? [RECORD_STORE, BLOB_STORE, LEDGER_STORE] : [RECORD_STORE, LEDGER_STORE];
    const transaction = db.transaction(stores, 'readwrite');
    const done = transactionDone(transaction);
    if (image && record.assetKey) {
      transaction.objectStore(BLOB_STORE).put({ key: record.assetKey, blob: image.blob, mime: image.mime, mediaKind: 'image', width: image.width, height: image.height });
    }
    const id = await requestResult(transaction.objectStore(RECORD_STORE).add(record));
    transaction.objectStore(LEDGER_STORE).add(ledgerEntry('record.insert', {
      recordId: id,
      source: 'workspace',
      compatibility: compatibilityOf(record)
    }));
    await done;
    return { ...record, id };
  } finally {
    db.close();
  }
}

export async function refreshCorpus(detail = {}) {
  const refresh = new Promise(resolve => {
    const timer = setTimeout(() => {
      window.removeEventListener('sideways:corpusrefresh', onRefresh);
      resolve({ timedOut: true });
    }, 3000);
    const onRefresh = event => {
      clearTimeout(timer);
      resolve(event.detail || {});
    };
    window.addEventListener('sideways:corpusrefresh', onRefresh, { once: true });
  });
  window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { source: 'workspace', ...detail } }));
  const result = await refresh;
  window.dispatchEvent(new CustomEvent('sideways:workspacechange', { detail }));
  return result;
}

export async function publishEntry(input = {}) {
  if (!clean(input.text || '') && !input.image) throw new Error('Write something or add a photo.');
  const record = await buildRecord(input);
  const inserted = await insertRecord(record, input.image || null);
  await clearDraft();
  await refreshCorpus({ action: 'publish', recordId: inserted.id });
  return inserted;
}

export async function getRecord(recordId) {
  return (await readStore(openCorpusDB, RECORD_STORE, Number(recordId))) || null;
}

export async function getAsset(assetKey) {
  if (!assetKey) return null;
  return (await readStore(openCorpusDB, BLOB_STORE, assetKey)) || null;
}

export async function getAssets(assetKeys = []) {
  const keys = [...new Set(assetKeys.filter(Boolean))];
  if (!keys.length) return new Map();
  const db = await openCorpusDB();
  try {
    const transaction = db.transaction(BLOB_STORE, 'readonly');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(BLOB_STORE);
    const requests = keys.map(key => requestResult(store.get(key)).then(value => [key, value || null]));
    const rows = await Promise.all(requests);
    await done;
    return new Map(rows);
  } finally {
    db.close();
  }
}

export async function updateEntry(recordId, input = {}) {
  const existing = await getRecord(recordId);
  if (!existing || !String(existing.nativeId || '').startsWith('sideways:')) throw new Error('This post cannot be edited here.');
  const text = clean(input.text ?? existing.text ?? '');
  if (!text && !input.image && !existing.assetKey) throw new Error('Write something or add a photo.');
  const next = {
    ...existing,
    title: clean(text.split('\n')[0] || existing.title || 'Untitled').slice(0, 240),
    summary: text.slice(0, 420),
    text,
    updatedAt: new Date().toISOString(),
    tags: ['sideways:authored', placeTag(input.placeId || ''), ...(existing.tags || []).filter(tag => !String(tag).startsWith('place:') && tag !== 'sideways:authored')].filter(Boolean)
  };
  const db = await openCorpusDB();
  try {
    const transaction = db.transaction([RECORD_STORE, BLOB_STORE, LEDGER_STORE], 'readwrite');
    const done = transactionDone(transaction);
    const blobs = transaction.objectStore(BLOB_STORE);
    if (input.removeImage && next.assetKey) {
      blobs.delete(next.assetKey);
      Object.assign(next, { assetKey: '', mediaKind: '', mediaConfidence: '', width: 0, height: 0, mime: 'text/plain' });
    }
    if (input.image) {
      if (next.assetKey) blobs.delete(next.assetKey);
      next.assetKey = `workspace-asset-${uid('image')}`;
      next.mediaKind = 'image';
      next.mediaConfidence = 'authored';
      next.width = input.image.width;
      next.height = input.image.height;
      next.mime = input.image.mime;
      next.size = new Blob([text]).size + input.image.blob.size;
      blobs.put({ key: next.assetKey, blob: input.image.blob, mime: input.image.mime, mediaKind: 'image', width: input.image.width, height: input.image.height });
    }
    transaction.objectStore(RECORD_STORE).put(next);
    transaction.objectStore(LEDGER_STORE).add(ledgerEntry('record.update', {
      recordId: Number(recordId),
      source: 'workspace',
      previousAssetKey: existing.assetKey || '',
      compatibility: compatibilityOf(next)
    }));
    await done;
  } finally {
    db.close();
  }
  await clearDraft();
  await refreshCorpus({ action: 'update', recordId: next.id });
  return next;
}

export async function deleteEntry(recordId) {
  const numericId = Number(recordId);
  const db = await openCorpusDB();
  let existing;
  try {
    const transaction = db.transaction([RECORD_STORE, BLOB_STORE, LEDGER_STORE], 'readwrite');
    const done = transactionDone(transaction);
    const records = transaction.objectStore(RECORD_STORE);
    existing = await requestResult(records.get(numericId));
    if (!existing) {
      transaction.abort();
      await done.catch(() => {});
      throw new Error('This item no longer exists.');
    }
    let assetIsShared = false;
    if (existing.assetKey) {
      const matches = await requestResult(records.index('assetKey').getAll(existing.assetKey));
      assetIsShared = matches.some(record => Number(record.id) !== numericId);
    }
    records.delete(numericId);
    if (existing.assetKey && !assetIsShared) transaction.objectStore(BLOB_STORE).delete(existing.assetKey);
    transaction.objectStore(LEDGER_STORE).add(ledgerEntry('record.delete', {
      recordId: numericId,
      source: String(existing.nativeId || '').startsWith('sideways:') ? 'workspace' : 'import',
      assetDeleted: Boolean(existing.assetKey && !assetIsShared),
      compatibility: compatibilityOf(existing)
    }));
    await done;
  } finally {
    db.close();
  }
  await refreshCorpus({ action: 'delete', recordId: numericId, imported: !String(existing.nativeId || '').startsWith('sideways:') });
}

export async function listRecords() {
  const records = await readStore(openCorpusDB, RECORD_STORE);
  return (records || []).sort((a, b) => String(b.published || b.addedAt).localeCompare(String(a.published || a.addedAt)));
}

export async function ownedEntries() {
  return (await listRecords()).filter(record => String(record.nativeId || '').startsWith('sideways:'));
}

export async function recordsByPlace() {
  const groups = new Map();
  for (const record of await listRecords()) {
    const placeId = recordPlaceId(record);
    if (!placeId) continue;
    if (!groups.has(placeId)) groups.set(placeId, []);
    groups.get(placeId).push(record);
  }
  return groups;
}
