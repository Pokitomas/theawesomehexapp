import { LEDGER_STORE, RECORD_STORE, ledgerEntry, openCorpusDB, requestResult, transactionDone } from '../workspace-db.js';
import { Feeds } from './feeds.js';
import { networkRecord } from './schema.js';

const PREFIX = 'network:';

async function refresh(detail = {}) {
  const done = new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 3000);
    window.addEventListener('sideways:corpusrefresh', event => { clearTimeout(timer); resolve(event.detail || {}); }, { once: true });
  });
  window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { source: 'network', ...detail } }));
  await done;
  window.dispatchEvent(new CustomEvent('sideways:networksync', { detail }));
}

export async function replaceNetworkCache(posts = []) {
  const incoming = posts.map(networkRecord);
  const db = await openCorpusDB();
  let inserted = 0, updated = 0, removed = 0;
  try {
    const tx = db.transaction([RECORD_STORE, LEDGER_STORE], 'readwrite');
    const done = transactionDone(tx);
    const records = tx.objectStore(RECORD_STORE);
    const existingRows = await requestResult(records.getAll());
    const existing = new Map(existingRows.filter(row => String(row.nativeId || '').startsWith(PREFIX)).map(row => [row.nativeId, row]));
    const keep = new Set(incoming.map(row => row.nativeId));
    for (const old of existing.values()) {
      if (keep.has(old.nativeId)) continue;
      records.delete(old.id);
      removed += 1;
    }
    for (const row of incoming) {
      const old = existing.get(row.nativeId);
      if (old) { records.put({ ...old, ...row, id: old.id }); updated += 1; }
      else { records.add(row); inserted += 1; }
    }
    tx.objectStore(LEDGER_STORE).add(ledgerEntry('network.cache.replace', { inserted, updated, removed, count: incoming.length, authority: 'server', localRole: 'offline-cache' }));
    await done;
  } finally { db.close(); }
  await refresh({ action: 'network-sync', inserted, updated, removed, count: incoming.length });
  return { inserted, updated, removed, count: incoming.length };
}

export async function clearNetworkCache() {
  const db = await openCorpusDB();
  let removed = 0;
  try {
    const tx = db.transaction([RECORD_STORE, LEDGER_STORE], 'readwrite');
    const done = transactionDone(tx);
    const records = tx.objectStore(RECORD_STORE);
    const rows = await requestResult(records.getAll());
    for (const row of rows) {
      if (!String(row.nativeId || '').startsWith(PREFIX)) continue;
      records.delete(row.id);
      removed += 1;
    }
    tx.objectStore(LEDGER_STORE).add(ledgerEntry('network.cache.clear', { removed, authority: 'server', localRole: 'offline-cache' }));
    await done;
  } finally { db.close(); }
  await refresh({ action: 'network-clear', removed, count: 0 });
  return { removed };
}

export async function following() {
  const result = await Feeds.following();
  const cache = await replaceNetworkCache(result.items || []);
  return { ...result, cache };
}

export const Sync = Object.freeze({ following, replaceNetworkCache, clearNetworkCache });
