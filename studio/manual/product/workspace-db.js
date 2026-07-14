import {
  BLOB_STORE,
  CORPUS_DB,
  CORPUS_VERSION,
  LEDGER_STORE,
  RECORD_STORE,
  ledgerEntry,
  openCorpusDB,
  readCorpusLedger,
  requestResult,
  storageDurability,
  transactionDone
} from '../shared/corpus-db.js';

export {
  BLOB_STORE,
  CORPUS_DB,
  CORPUS_VERSION,
  LEDGER_STORE,
  RECORD_STORE,
  ledgerEntry,
  openCorpusDB,
  readCorpusLedger,
  requestResult,
  storageDurability,
  transactionDone
};

export const WORKSPACE_DB = 'sideways-workspace-v1';
export const WORKSPACE_VERSION = 2;
export const DRAFT_STORE = 'drafts';
export const PLACE_STORE = 'places';
export const META_STORE = 'meta';
export const NETWORK_RECORD_STORE = 'networkRecords';
export const NETWORK_VIEW_STORE = 'networkViews';
export const LEGACY_SOCIAL_DB = 'sideways-social-v1';

export function uid(prefix) {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}-${Date.now().toString(36)}-${random[0].toString(36)}${random[1].toString(36)}`;
}

export function clean(value = '') {
  return String(value)
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function safeURL(value = '') {
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

export function openWorkspaceDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE_DB, WORKSPACE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PLACE_STORE)) {
        const places = db.createObjectStore(PLACE_STORE, { keyPath: 'id' });
        places.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(NETWORK_RECORD_STORE)) {
        const records = db.createObjectStore(NETWORK_RECORD_STORE, { keyPath: 'postId' });
        records.createIndex('nativeId', 'nativeId', { unique: true });
        records.createIndex('observedAt', 'observedAt');
      }
      if (!db.objectStoreNames.contains(NETWORK_VIEW_STORE)) {
        const views = db.createObjectStore(NETWORK_VIEW_STORE, { keyPath: 'key' });
        views.createIndex('viewKey', 'viewKey');
        views.createIndex('postId', 'postId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readStore(open, storeName, query = null) {
  const db = await open();
  try {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = query === null ? store.getAll() : store.get(query);
    const result = await requestResult(request);
    await transactionDone(transaction);
    return result;
  } finally {
    db.close();
  }
}

export async function putWorkspace(storeName, value) {
  const db = await openWorkspaceDB();
  try {
    const transaction = db.transaction(storeName, 'readwrite');
    const result = await requestResult(transaction.objectStore(storeName).put(value));
    await transactionDone(transaction);
    return result;
  } finally {
    db.close();
  }
}

export async function deleteWorkspace(storeName, key) {
  const db = await openWorkspaceDB();
  try {
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(key);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function hashText(value) {
  const bytes = new TextEncoder().encode(value);
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261 >>> 0;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
