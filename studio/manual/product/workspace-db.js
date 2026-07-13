export const CORPUS_DB = 'sideways-manual-corpus-v1';
export const RECORD_STORE = 'records';
export const BLOB_STORE = 'blobs';
export const WORKSPACE_DB = 'sideways-workspace-v1';
export const WORKSPACE_VERSION = 1;
export const DRAFT_STORE = 'drafts';
export const PLACE_STORE = 'places';
export const EVENT_STORE = 'events';
export const META_STORE = 'meta';
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

export function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

export function openCorpusDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CORPUS_DB);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        const store = db.createObjectStore(RECORD_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('hash', 'hash', { unique: false });
        store.createIndex('addedAt', 'addedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
      if (!db.objectStoreNames.contains(EVENT_STORE)) {
        const events = db.createObjectStore(EVENT_STORE, { keyPath: 'id', autoIncrement: true });
        events.createIndex('at', 'at');
        events.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
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
