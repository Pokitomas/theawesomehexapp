import {
  BLOB_STORE,
  LEDGER_STORE,
  RECORD_STORE,
  ledgerEntry,
  openCorpusDB,
  requestResult,
  transactionDone
} from '../shared/corpus-db.js';

async function transaction(stores, mode, work) {
  const db = await openCorpusDB();
  try {
    const tx = db.transaction(stores, mode);
    const done = transactionDone(tx);
    const value = work(tx);
    const result = value instanceof Promise ? await value : value;
    await done;
    return result;
  } finally {
    db.close();
  }
}

function receipt(record, source) {
  return {
    hash: record.hash,
    source,
    compatibility: {
      ...(record.compatibility || {}),
      mediaKind: record.mediaKind || '',
      mime: record.mime || '',
      mediaConfidence: record.mediaConfidence || '',
      assetKey: record.assetKey || ''
    }
  };
}

export async function existingKeys() {
  return transaction(RECORD_STORE, 'readonly', async tx => {
    const rows = await requestResult(tx.objectStore(RECORD_STORE).getAll());
    return {
      hashes: new Set(rows.map(row => row.hash).filter(Boolean)),
      native: new Set(rows.map(row => row.nativeId && `${row.source}\n${row.nativeId}`).filter(Boolean)),
      count: rows.length
    };
  });
}

export function uniqueRecord(record, keys) {
  const nativeKey = record.nativeId ? `${record.source}\n${record.nativeId}` : '';
  if (keys.hashes.has(record.hash) || (nativeKey && keys.native.has(nativeKey))) return false;
  keys.hashes.add(record.hash);
  if (nativeKey) keys.native.add(nativeKey);
  return true;
}

export async function addRecords(records) {
  if (!records.length) return;
  await transaction([RECORD_STORE, LEDGER_STORE], 'readwrite', tx => {
    const store = tx.objectStore(RECORD_STORE);
    const ledger = tx.objectStore(LEDGER_STORE);
    for (const record of records) {
      const request = store.add(record);
      request.onsuccess = () => ledger.add(ledgerEntry('record.import', {
        recordId: request.result,
        ...receipt(record, 'adapter')
      }));
    }
  });
}

export async function addMediaRecord(record, asset) {
  await transaction([RECORD_STORE, BLOB_STORE, LEDGER_STORE], 'readwrite', tx => {
    const request = tx.objectStore(RECORD_STORE).add(record);
    tx.objectStore(BLOB_STORE).put(asset);
    request.onsuccess = () => tx.objectStore(LEDGER_STORE).add(ledgerEntry('record.import', {
      recordId: request.result,
      ...receipt(record, 'direct-media')
    }));
  });
}
