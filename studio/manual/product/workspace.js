const SOCIAL_DB = 'sideways-social-v1';
const SOCIAL_DB_VERSION = 2;
const POST_STORE = 'posts';
const DRAFT_STORE = 'drafts';
const EVENT_STORE = 'events';

const META_DB = 'sideways-workspace-meta-v1';
const META_VERSION = 1;
const PLACE_STORE = 'places';

const UNDO_KEY = 'sideways-workspace-undo-v2';
const ACTIVE_PLACE_KEY = 'sideways-active-place-v1';
const DEFAULT_IDS = new Set(['everything', 'later', 'archive']);
const DEFAULT_PLACES = Object.freeze([
  { id: 'everything', name: 'Everything', icon: 'globe', color: '#9cc7ff', virtual: true, order: 0 },
  { id: 'later', name: 'Later', icon: 'later', color: '#ffd66b', virtual: false, order: 1 },
  { id: 'archive', name: 'Archive', icon: 'archive', color: '#c7cbd4', virtual: true, order: 2 }
]);

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

async function transact(db, stores, mode, work) {
  const tx = db.transaction(stores, mode);
  const completion = transactionDone(tx);
  let result;
  try {
    result = await work(tx);
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
  await completion;
  return result;
}

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
      const db = request.result;
      if (!db.objectStoreNames.contains(PLACE_STORE)) {
        db.createObjectStore(PLACE_STORE, { keyPath: 'id' }).createIndex('order', 'order');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function notify(detail) {
  window.dispatchEvent(new CustomEvent('sideways:workspacechange', { detail: clone(detail) }));
}

function rememberUndo(operation) {
  localStorage.setItem(UNDO_KEY, JSON.stringify({ ...operation, at: new Date().toISOString() }));
}

function takeUndo() {
  let operation = null;
  try { operation = JSON.parse(localStorage.getItem(UNDO_KEY) || 'null'); } catch {}
  return operation;
}

export function createWorkspaceBackend() {
  let socialDb;
  let metaDb;
  let readyPromise;

  async function seedDefaultPlaces() {
    await transact(metaDb, [PLACE_STORE], 'readwrite', async tx => {
      const store = tx.objectStore(PLACE_STORE);
      for (const place of DEFAULT_PLACES) {
        if (!await requestResult(store.get(place.id))) {
          store.put({ ...place, createdAt: new Date().toISOString() });
        }
      }
    });
  }

  async function migrateEntities() {
    await transact(socialDb, [POST_STORE], 'readwrite', async tx => {
      const store = tx.objectStore(POST_STORE);
      const records = await requestResult(store.getAll());
      const now = new Date().toISOString();
      for (const record of records) {
        const normalized = {
          ...record,
          id: record.id || uid('post'),
          placeId: record.placeId || 'everything',
          archived: Boolean(record.archived),
          createdAt: record.createdAt || now,
          updatedAt: record.updatedAt || record.createdAt || now,
          source: record.source || 'sideways'
        };
        if (JSON.stringify(normalized) !== JSON.stringify(record)) store.put(normalized);
      }
    });
  }

  async function ready() {
    if (!readyPromise) {
      readyPromise = (async () => {
        [socialDb, metaDb] = await Promise.all([openSocialDB(), openMetaDB()]);
        await seedDefaultPlaces();
        await migrateEntities();
        return { ok: true };
      })();
    }
    return readyPromise;
  }

  function getActivePlace() {
    return localStorage.getItem(ACTIVE_PLACE_KEY) || 'everything';
  }

  function setActivePlace(id) {
    const placeId = id || 'everything';
    localStorage.setItem(ACTIVE_PLACE_KEY, placeId);
    notify({ type: 'active-place', placeId });
    return { placeId };
  }

  async function rawPlaces() {
    await ready();
    return transact(metaDb, [PLACE_STORE], 'readonly', tx => requestResult(tx.objectStore(PLACE_STORE).getAll()));
  }

  async function rawPosts() {
    await ready();
    return transact(socialDb, [POST_STORE], 'readonly', tx => requestResult(tx.objectStore(POST_STORE).getAll()));
  }

  async function listPlaces() {
    const [places, posts] = await Promise.all([rawPlaces(), rawPosts()]);
    const counts = { everything: 0, later: 0, archive: 0 };
    for (const post of posts) {
      if (post.archived) {
        counts.archive += 1;
        continue;
      }
      counts.everything += 1;
      const id = post.placeId || 'everything';
      if (id !== 'everything') counts[id] = (counts[id] || 0) + 1;
    }
    return places
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
      .map(place => ({ ...place, count: counts[place.id] || 0 }));
  }

  async function createPlace({ name, icon = 'folder', color = '#9cc7ff' }) {
    await ready();
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('place name required');
    const places = await rawPlaces();
    const place = {
      id: uid('place'),
      name: clean,
      icon,
      color,
      virtual: false,
      order: Math.max(-1, ...places.map(item => Number(item.order || 0))) + 1,
      createdAt: new Date().toISOString()
    };
    await transact(metaDb, [PLACE_STORE], 'readwrite', tx => requestResult(tx.objectStore(PLACE_STORE).add(place)));
    rememberUndo({ type: 'delete-place', placeId: place.id });
    notify({ type: 'place-create', place });
    return clone(place);
  }

  async function renamePlace(id, name) {
    await ready();
    if (DEFAULT_IDS.has(id)) throw new Error('cannot rename a default place');
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('place name required');
    const updated = await transact(metaDb, [PLACE_STORE], 'readwrite', async tx => {
      const store = tx.objectStore(PLACE_STORE);
      const current = await requestResult(store.get(id));
      if (!current) throw new Error(`place not found: ${id}`);
      rememberUndo({ type: 'put-place', place: current });
      const next = { ...current, name: clean, updatedAt: new Date().toISOString() };
      store.put(next);
      return next;
    });
    notify({ type: 'place-rename', place: updated });
    return clone(updated);
  }

  async function reorderPlaces(orderedIds) {
    await ready();
    const ids = [...new Set(orderedIds || [])];
    const previous = await rawPlaces();
    const byId = new Map(previous.map(place => [place.id, place]));
    const complete = [...ids.filter(id => byId.has(id)), ...previous.map(place => place.id).filter(id => !ids.includes(id))];
    await transact(metaDb, [PLACE_STORE], 'readwrite', tx => {
      const store = tx.objectStore(PLACE_STORE);
      complete.forEach((id, order) => store.put({ ...byId.get(id), order }));
    });
    rememberUndo({ type: 'restore-place-order', places: previous });
    notify({ type: 'place-reorder', orderedIds: complete });
    return listPlaces();
  }

  async function deletePlace(id) {
    await ready();
    if (DEFAULT_IDS.has(id)) throw new Error('cannot delete a default place');
    const places = await rawPlaces();
    const place = places.find(item => item.id === id);
    if (!place) throw new Error(`place not found: ${id}`);
    const affected = (await rawPosts()).filter(post => !post.archived && post.placeId === id);

    await transact(socialDb, [POST_STORE], 'readwrite', tx => {
      const store = tx.objectStore(POST_STORE);
      for (const post of affected) store.put({ ...post, placeId: 'everything', updatedAt: new Date().toISOString() });
    });
    try {
      await transact(metaDb, [PLACE_STORE], 'readwrite', tx => requestResult(tx.objectStore(PLACE_STORE).delete(id)));
    } catch (error) {
      await transact(socialDb, [POST_STORE], 'readwrite', tx => {
        const store = tx.objectStore(POST_STORE);
        for (const post of affected) store.put(post);
      });
      throw error;
    }

    rememberUndo({ type: 'restore-place', place, entities: affected });
    if (getActivePlace() === id) localStorage.setItem(ACTIVE_PLACE_KEY, 'everything');
    notify({ type: 'place-delete', placeId: id, movedEntities: affected.length });
    return { deleted: true, movedEntities: affected.length };
  }

  async function listEntities({ placeId = 'everything', archived = false } = {}) {
    const posts = await rawPosts();
    return posts.filter(post => {
      if (archived || placeId === 'archive') return Boolean(post.archived);
      if (post.archived) return false;
      if (placeId === 'everything') return true;
      return (post.placeId || 'everything') === placeId;
    });
  }

  async function listArchived() {
    return listEntities({ placeId: 'archive', archived: true });
  }

  async function getEntity(id) {
    await ready();
    return transact(socialDb, [POST_STORE], 'readonly', tx => requestResult(tx.objectStore(POST_STORE).get(id)));
  }

  async function putEntity(entity) {
    await ready();
    await transact(socialDb, [POST_STORE], 'readwrite', tx => requestResult(tx.objectStore(POST_STORE).put(entity)));
    return clone(entity);
  }

  async function updateEntity(id, patch) {
    const current = await getEntity(id);
    if (!current) throw new Error('entity not found');
    const next = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
    await putEntity(next);
    rememberUndo({ type: 'put-entity', entity: current });
    notify({ type: 'entity-update', entity: next });
    return clone(next);
  }

  async function moveEntity(id, placeId) {
    const result = await updateEntity(id, { placeId: placeId || 'everything', archived: false, archivedAt: null });
    notify({ type: 'entity-move', entityId: id, placeId: result.placeId });
    return result;
  }

  async function archiveEntity(id) {
    const result = await updateEntity(id, { archived: true, archivedAt: new Date().toISOString() });
    notify({ type: 'entity-archive', entityId: id });
    return result;
  }

  async function restoreEntity(id) {
    const result = await updateEntity(id, { archived: false, archivedAt: null });
    notify({ type: 'entity-restore', entityId: id });
    return result;
  }

  async function deleteEntity(id) {
    const previous = await getEntity(id);
    if (!previous) return { entityId: id, deleted: false };
    await transact(socialDb, [POST_STORE], 'readwrite', tx => requestResult(tx.objectStore(POST_STORE).delete(id)));
    rememberUndo({ type: 'restore-entity', entity: previous });
    notify({ type: 'entity-delete', entityId: id });
    return { entityId: id, deleted: true };
  }

  async function listDrafts() {
    await ready();
    const drafts = await transact(socialDb, [DRAFT_STORE], 'readonly', tx => requestResult(tx.objectStore(DRAFT_STORE).getAll()));
    return drafts.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  async function saveDraft(draft) {
    await ready();
    const record = { ...draft, id: draft.id || uid('draft'), updatedAt: new Date().toISOString() };
    await transact(socialDb, [DRAFT_STORE], 'readwrite', tx => requestResult(tx.objectStore(DRAFT_STORE).put(record)));
    notify({ type: 'draft-save', draftId: record.id });
    return clone(record);
  }

  async function deleteDraft(id) {
    await ready();
    const previous = await transact(socialDb, [DRAFT_STORE], 'readonly', tx => requestResult(tx.objectStore(DRAFT_STORE).get(id)));
    await transact(socialDb, [DRAFT_STORE], 'readwrite', tx => requestResult(tx.objectStore(DRAFT_STORE).delete(id)));
    if (previous) rememberUndo({ type: 'restore-draft', draft: previous });
    notify({ type: 'draft-delete', draftId: id });
    return { draftId: id };
  }

  async function publishDraft(draftId, post) {
    await ready();
    const record = await transact(socialDb, [DRAFT_STORE, POST_STORE], 'readwrite', async tx => {
      const drafts = tx.objectStore(DRAFT_STORE);
      const draft = await requestResult(drafts.get(draftId));
      if (!draft) throw new Error(`draft not found: ${draftId}`);
      const now = new Date().toISOString();
      const entity = {
        id: post.id || uid('post'),
        createdAt: post.createdAt || now,
        updatedAt: now,
        placeId: post.placeId || draft.placeId || 'everything',
        archived: false,
        source: post.source || 'sideways',
        ...post
      };
      tx.objectStore(POST_STORE).put(entity);
      drafts.delete(draftId);
      return entity;
    });
    rememberUndo({ type: 'unpublish', entity: record, draftId });
    notify({ type: 'entity-publish', entity: record, draftId });
    return clone(record);
  }

  async function undo() {
    await ready();
    const operation = takeUndo();
    if (!operation) return { restored: false };

    if (operation.type === 'restore-entity' || operation.type === 'put-entity') {
      await putEntity(operation.entity);
    } else if (operation.type === 'restore-draft') {
      await transact(socialDb, [DRAFT_STORE], 'readwrite', tx => requestResult(tx.objectStore(DRAFT_STORE).put(operation.draft)));
    } else if (operation.type === 'delete-place') {
      await transact(metaDb, [PLACE_STORE], 'readwrite', tx => requestResult(tx.objectStore(PLACE_STORE).delete(operation.placeId)));
    } else if (operation.type === 'put-place') {
      await transact(metaDb, [PLACE_STORE], 'readwrite', tx => requestResult(tx.objectStore(PLACE_STORE).put(operation.place)));
    } else if (operation.type === 'restore-place-order') {
      await transact(metaDb, [PLACE_STORE], 'readwrite', tx => {
        const store = tx.objectStore(PLACE_STORE);
        for (const place of operation.places) store.put(place);
      });
    } else if (operation.type === 'restore-place') {
      await transact(metaDb, [PLACE_STORE], 'readwrite', tx => requestResult(tx.objectStore(PLACE_STORE).put(operation.place)));
      await transact(socialDb, [POST_STORE], 'readwrite', tx => {
        const store = tx.objectStore(POST_STORE);
        for (const entity of operation.entities || []) store.put(entity);
      });
    } else if (operation.type === 'unpublish') {
      await transact(socialDb, [POST_STORE, DRAFT_STORE], 'readwrite', tx => {
        tx.objectStore(POST_STORE).delete(operation.entity.id);
        tx.objectStore(DRAFT_STORE).put({ ...operation.entity, id: operation.draftId, updatedAt: new Date().toISOString() });
      });
    }

    localStorage.removeItem(UNDO_KEY);
    notify({ type: 'undo', operation: operation.type });
    return { restored: true, type: operation.type };
  }

  async function exportSnapshot() {
    const [places, posts, drafts] = await Promise.all([
      rawPlaces(),
      rawPosts(),
      listDrafts()
    ]);
    return {
      version: META_VERSION,
      exportedAt: new Date().toISOString(),
      activePlace: getActivePlace(),
      places,
      posts,
      drafts
    };
  }

  async function importSnapshot(snapshot) {
    await ready();
    if (!snapshot || snapshot.version !== META_VERSION) throw new Error('incompatible or missing snapshot version');
    for (const key of ['places', 'posts', 'drafts']) {
      if (!Array.isArray(snapshot[key])) throw new Error(`snapshot ${key} must be an array`);
    }

    await transact(socialDb, [POST_STORE, DRAFT_STORE], 'readwrite', async tx => {
      const posts = tx.objectStore(POST_STORE);
      const drafts = tx.objectStore(DRAFT_STORE);
      posts.clear();
      drafts.clear();
      for (const post of snapshot.posts) posts.put(post);
      for (const draft of snapshot.drafts) drafts.put(draft);
    });
    await transact(metaDb, [PLACE_STORE], 'readwrite', async tx => {
      const places = tx.objectStore(PLACE_STORE);
      places.clear();
      for (const place of snapshot.places) places.put(place);
    });
    await seedDefaultPlaces();
    setActivePlace(snapshot.activePlace || 'everything');
    localStorage.removeItem(UNDO_KEY);
    notify({ type: 'snapshot-import', counts: { places: snapshot.places.length, posts: snapshot.posts.length, drafts: snapshot.drafts.length } });
    return { imported: true };
  }

  return Object.freeze({
    ready,
    getActivePlace,
    setActivePlace,
    listPlaces,
    createPlace,
    renamePlace,
    reorderPlaces,
    deletePlace,
    listEntities,
    listArchived,
    getEntity,
    updateEntity,
    moveEntity,
    archiveEntity,
    restoreEntity,
    deleteEntity,
    listDrafts,
    saveDraft,
    deleteDraft,
    publishDraft,
    undo,
    exportSnapshot,
    importSnapshot
  });
}

window.SidewaysWorkspace = createWorkspaceBackend();
