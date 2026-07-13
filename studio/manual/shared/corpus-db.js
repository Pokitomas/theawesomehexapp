export const CORPUS_DB = 'sideways-manual-corpus-v1';
export const CORPUS_VERSION = 2;
export const RECORD_STORE = 'records';
export const BLOB_STORE = 'blobs';
export const LEDGER_STORE = 'ledger';

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
    const request = indexedDB.open(CORPUS_DB, CORPUS_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      let records;
      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        records = db.createObjectStore(RECORD_STORE, { keyPath: 'id', autoIncrement: true });
        records.createIndex('hash', 'hash', { unique: false });
        records.createIndex('addedAt', 'addedAt', { unique: false });
      } else {
        records = request.transaction.objectStore(RECORD_STORE);
      }
      if (!records.indexNames.contains('assetKey')) records.createIndex('assetKey', 'assetKey', { unique: false });
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(LEDGER_STORE)) {
        const ledger = db.createObjectStore(LEDGER_STORE, { keyPath: 'id', autoIncrement: true });
        ledger.createIndex('at', 'at', { unique: false });
        ledger.createIndex('op', 'op', { unique: false });
        ledger.createIndex('recordId', 'recordId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new DOMException('Close another Sideways tab and try again.', 'InvalidStateError'));
  });
}

export function ledgerEntry(op, detail = {}) {
  return {
    at: new Date().toISOString(),
    schema: CORPUS_VERSION,
    op,
    ...structuredClone(detail)
  };
}

export async function readCorpusLedger({ limit = 250 } = {}) {
  const db = await openCorpusDB();
  try {
    const transaction = db.transaction(LEDGER_STORE, 'readonly');
    const done = transactionDone(transaction);
    const index = transaction.objectStore(LEDGER_STORE).index('at');
    const rows = [];
    await new Promise((resolve, reject) => {
      const cursor = index.openCursor(null, 'prev');
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        if (!cursor.result || rows.length >= limit) {
          resolve();
          return;
        }
        rows.push(cursor.result.value);
        cursor.result.continue();
      };
    });
    await done;
    return rows;
  } finally {
    db.close();
  }
}

export async function storageDurability({ request = false } = {}) {
  const storage = navigator.storage;
  if (!storage) return { persisted: false, usage: 0, quota: 0, bestEffort: true };
  let persisted = Boolean(await storage.persisted?.().catch(() => false));
  if (request && !persisted) persisted = Boolean(await storage.persist?.().catch(() => false));
  const estimate = await storage.estimate?.().catch(() => ({})) || {};
  return {
    persisted,
    usage: Number(estimate.usage || 0),
    quota: Number(estimate.quota || 0),
    bestEffort: !persisted
  };
}
