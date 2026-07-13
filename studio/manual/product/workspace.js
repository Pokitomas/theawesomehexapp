// Workspace domain backend -- real implementation matching what
// social.js actually calls via window.SidewaysWorkspace (checked against
// its current HEAD, not the original issue text alone: getActivePlace,
// setActivePlace, listPlaces, listEntities, getEntity, updateEntity,
// moveEntity, archiveEntity, restoreEntity, deleteEntity, undo, listDrafts,
// saveDraft, deleteDraft, publishDraft). Also keeps createPlace/renamePlace/
// deletePlace/exportSnapshot/importSnapshot from the original issue spec
// for the places-management UI, since those don't conflict.
//
// Operates directly on social.js's own sideways-social-v1 (v2) posts/
// drafts/events stores -- placeId and archived live ON the entity record,
// matching social.js's own fallback implementation and its 'placeId' index.
// Never imports or edits social.js itself. Place *definitions* (the small
// list of places, not the entities in them) live in a separate small DB
// since that concept doesn't exist in social.js's schema.

const SOCIAL_DB = 'sideways-social-v1';
const SOCIAL_DB_VERSION = 2;
const POST_STORE = 'posts';
const DRAFT_STORE = 'drafts';
const EVENT_STORE = 'events';

const META_DB = 'sideways-workspace-meta-v1';
const META_VERSION = 1;
const PLACES = 'places';

const UNDO_KEY = 'sideways-workspace-undo-v1';
const ACTIVE_PLACE_KEY = 'sideways-active-place-v1'; // same key social.js's own fallback already uses

const DEFAULT_PLACES = [
  { id: 'everything', name: 'Everything', icon: 'globe', color: '#9cc7ff', virtual: true, order: 0 },
  { id: 'later', name: 'Later', icon: 'later', color: '#ffd66b', virtual: false, order: 1 },
  { id: 'archive', name: 'Archive', icon: 'archive', color: '#c7cbd4', virtual: true, order: 2 },
];

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runTx(db, storeNames, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    Promise.resolve(work(tx)).then(r => { result = r; }).catch(reject);
  });
}

// Mirrors social.js's own openFallbackDB upgrade logic exactly (idempotent
// -- whichever of us opens this DB first creates the stores; the other
// just opens cleanly since objectStoreNames already contains them).
function openSocialDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SOCIAL_DB, SOCIAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(POST_STORE)) {
        const store = db.createObjectStore(POST_STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('placeId', 'placeId');
      }
      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        const store = db.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(EVENT_STORE)) {
        const store = db.createObjectStore(EVENT_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('actionId', 'actionId');
        store.createIndex('at', 'at');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openMetaDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(META_DB, META_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PLACES)) {
        request.result.createObjectStore(PLACES, { keyPath: 'id' }).createIndex('order', 'order');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createWorkspaceBackend() {
  let socialDb = null, metaDb = null, readyPromise = null;

  async function seedDefaultPlaces() {
    await runTx(metaDb, [PLACES], 'readwrite', async (tx) => {
      const store = tx.objectStore(PLACES);
      for (const place of DEFAULT_PLACES) {
        const existing = await reqToPromise(store.get(place.id));
        if (!existing) store.put({ ...place, createdAt: new Date().toISOString() });
      }
    });
  }

  async function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      [socialDb, metaDb] = await Promise.all([openSocialDB(), openMetaDB()]);
      await seedDefaultPlaces();
      return { ok: true };
    })();
    return readyPromise;
  }

  function getActivePlace() {
    return localStorage.getItem(ACTIVE_PLACE_KEY) || 'everything';
  }

  function setActivePlace(id) {
    localStorage.setItem(ACTIVE_PLACE_KEY, id || 'everything');
    return { placeId: id || 'everything' };
  }

  async function listPlaces() {
    const places = await runTx(metaDb, [PLACES], 'readonly', (tx) => reqToPromise(tx.objectStore(PLACES).getAll()));
    const posts = await runTx(socialDb, [POST_STORE], 'readonly', (tx) => reqToPromise(tx.objectStore(POST_STORE).getAll()));
    const counts = { everything: 0, later: 0, archive: 0 };
    for (const post of posts) {
      if (post.archived) { counts.archive++; continue; }
      counts.everything++;
      const pid = post.placeId || 'everything';
      if (pid !== 'everything') counts[pid] = (counts[pid] || 0) + 1;
    }
    return places.sort((a, b) => a.order - b.order).map(p => ({ ...p, count: counts[p.id] || 0 }));
  }

  async function createPlace({ name, icon = 'circle', color = '#72c8ff' }) {
    if (!name || !name.trim()) throw new Error('place name required');
    const all = await runTx(metaDb, [PLACES], 'readonly', (tx) => reqToPromise(tx.objectStore(PLACES).getAll()));
    const place = { id: uid('place'), name: name.trim().slice(0, 60), icon, color, virtual: false, order: all.length, createdAt: new Date().toISOString() };
    await runTx(metaDb, [PLACES], 'readwrite', (tx) => tx.objectStore(PLACES).add(place));
    return place;
  }

  async function renamePlace(id, name) {
    if (!name || !name.trim()) throw new Error('place name required');
    return runTx(metaDb, [PLACES], 'readwrite', async (tx) => {
      const store = tx.objectStore(PLACES);
      const place = await reqToPromise(store.get(id));
      if (!place) throw new Error(`place not found: ${id}`);
      if (['everything', 'later', 'archive'].includes(id)) throw new Error('cannot rename a default place');
      const updated = { ...place, name: name.trim().slice(0, 60) };
      store.put(updated);
      return updated;
    });
  }

  async function deletePlace(id) {
    if (['everything', 'later', 'archive'].includes(id)) throw new Error('cannot delete a default place');
    const moved = await runTx(socialDb, [POST_STORE], 'readwrite', async (tx) => {
      const store = tx.objectStore(POST_STORE);
      const idx = store.index('placeId');
      const affected = await reqToPromise(idx.getAll(id));
      for (const post of affected) store.put({ ...post, placeId: 'everything' });
      return affected.length;
    });
    await runTx(metaDb, [PLACES], 'readwrite', (tx) => tx.objectStore(PLACES).delete(id));
    return { deleted: true, movedEntities: moved };
  }

  async function listEntities({ placeId = 'everything', archived = false } = {}) {
    const posts = await runTx(socialDb, [POST_STORE], 'readonly', (tx) => reqToPromise(tx.objectStore(POST_STORE).getAll()));
    return posts.filter(post => {
      if (archived || placeId === 'archive') return Boolean(post.archived);
      if (post.archived) return false;
      if (placeId === 'everything') return true;
      return (post.placeId || 'everything') === placeId;
    });
  }

  async function getEntity(id) {
    return runTx(socialDb, [POST_STORE], 'readonly', (tx) => reqToPromise(tx.objectStore(POST_STORE).get(id)));
  }

  async function putEntity(post) {
    await runTx(socialDb, [POST_STORE], 'readwrite', (tx) => tx.objectStore(POST_STORE).put(post));
    return post;
  }

  function rememberUndo(operation) {
    localStorage.setItem(UNDO_KEY, JSON.stringify({ ...operation, at: new Date().toISOString() }));
  }

  async function updateEntity(id, patch) {
    const current = await getEntity(id);
    if (!current) throw new Error('entity not found');
    rememberUndo({ type: 'put-entity', entity: current });
    return putEntity({ ...current, ...patch, id, updatedAt: new Date().toISOString() });
  }

  async function moveEntity(id, placeId) {
    return updateEntity(id, { placeId: placeId || 'everything' });
  }

  async function archiveEntity(id) {
    return updateEntity(id, { archived: true, archivedAt: new Date().toISOString() });
  }

  async function restoreEntity(id) {
    return updateEntity(id, { archived: false, archivedAt: null });
  }

  async function deleteEntity(id) {
    const previous = await getEntity(id);
    if (previous) rememberUndo({ type: 'restore-entity', entity: previous });
    await runTx(socialDb, [POST_STORE], 'readwrite', (tx) => tx.objectStore(POST_STORE).delete(id));
    return { entityId: id };
  }

  async function undo() {
    let operation;
    try { operation = JSON.parse(localStorage.getItem(UNDO_KEY) || 'null'); } catch { operation = null; }
    if (!operation) return { restored: false };
    if (operation.type === 'restore-entity' || operation.type === 'put-entity') await putEntity(operation.entity);
    localStorage.removeItem(UNDO_KEY);
    return { restored: true, type: operation.type };
  }

  async function listDrafts() {
    const drafts = await runTx(socialDb, [DRAFT_STORE], 'readonly', (tx) => reqToPromise(tx.objectStore(DRAFT_STORE).getAll()));
    return drafts.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function saveDraft(draft) {
    const record = { ...draft, id: draft.id || uid('draft'), updatedAt: new Date().toISOString() };
    await runTx(socialDb, [DRAFT_STORE], 'readwrite', (tx) => tx.objectStore(DRAFT_STORE).put(record));
    return record;
  }

  async function deleteDraft(id) {
    await runTx(socialDb, [DRAFT_STORE], 'readwrite', (tx) => tx.objectStore(DRAFT_STORE).delete(id));
    return { draftId: id };
  }

  async function publishDraft(draftId, post) {
    return runTx(socialDb, [DRAFT_STORE, POST_STORE], 'readwrite', async (tx) => {
      const draft = await reqToPromise(tx.objectStore(DRAFT_STORE).get(draftId));
      if (!draft) throw new Error(`draft not found: ${draftId}`);
      const record = { id: uid('post'), createdAt: new Date().toISOString(), placeId: 'everything', archived: false, ...post };
      tx.objectStore(POST_STORE).put(record);
      tx.objectStore(DRAFT_STORE).delete(draftId);
      return record;
    });
  }

  async function exportSnapshot() {
    const [places, posts, drafts] = await Promise.all([
      runTx(metaDb, [PLACES], 'readonly', (tx) => reqToPromise(tx.objectStore(PLACES).getAll())),
      runTx(socialDb, [POST_STORE], 'readonly', (tx) => reqToPromise(tx.objectStore(POST_STORE).getAll())),
      runTx(socialDb, [DRAFT_STORE], 'readonly', (tx) => reqToPromise(tx.objectStore(DRAFT_STORE).getAll())),
    ]);
    return { version: META_VERSION, exportedAt: new Date().toISOString(), places, posts, drafts };
  }

  async function importSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== META_VERSION) throw new Error('incompatible or missing snapshot version');
    await runTx(metaDb, [PLACES], 'readwrite', async (tx) => {
      const store = tx.objectStore(PLACES);
      for (const key of await reqToPromise(store.getAllKeys())) store.delete(key);
      for (const p of snapshot.places || []) store.put(p);
    });
    return { imported: true };
  }

  return {
    ready, getActivePlace, setActivePlace, listPlaces, createPlace, renamePlace, deletePlace,
    listEntities, getEntity, updateEntity, moveEntity, archiveEntity, restoreEntity, deleteEntity, undo,
    listDrafts, saveDraft, deleteDraft, publishDraft, exportSnapshot, importSnapshot,
  };
}

// Auto-install as the global social.js actually reads (window.SidewaysWorkspace),
// unless something already set one (e.g. a test harness providing its own).
if (typeof window !== 'undefined' && !window.SidewaysWorkspace) {
  window.SidewaysWorkspace = createWorkspaceBackend();
}
