import {
  EVENT_STORE,
  openWorkspaceDB,
  putWorkspace,
  readStore,
  safeURL,
  transactionDone
} from './workspace-db.js';

const SYNC_KEY = 'sideways-workspace-sync-v1';

function readSyncEndpoint() {
  try {
    const value = JSON.parse(localStorage.getItem(SYNC_KEY) || '{}');
    return safeURL(value.endpoint || '');
  } catch {
    return '';
  }
}

export function configureSync(endpoint = '') {
  const normalized = safeURL(endpoint);
  if (normalized) localStorage.setItem(SYNC_KEY, JSON.stringify({ endpoint: normalized }));
  else localStorage.removeItem(SYNC_KEY);
  return normalized;
}

async function pendingEvents() {
  const events = await readStore(openWorkspaceDB, EVENT_STORE);
  return (events || []).filter(event => event.status === 'pending');
}

export async function persistEvent(detail) {
  if (!detail?.actionId) return;
  await putWorkspace(EVENT_STORE, { ...structuredClone(detail), status: 'pending' });
  if (readSyncEndpoint()) void flushOutbox();
}

export async function flushOutbox() {
  const endpoint = readSyncEndpoint();
  if (!endpoint || !navigator.onLine) return { sent: 0, pending: (await pendingEvents()).length };
  const events = await pendingEvents();
  if (!events.length) return { sent: 0, pending: 0 };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, events })
  });
  if (!response.ok) throw new Error(`Sync failed (${response.status})`);
  const db = await openWorkspaceDB();
  try {
    const transaction = db.transaction(EVENT_STORE, 'readwrite');
    const store = transaction.objectStore(EVENT_STORE);
    for (const event of events) store.delete(event.id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
  return { sent: events.length, pending: 0 };
}

export async function outboxCount() {
  return (await pendingEvents()).length;
}
