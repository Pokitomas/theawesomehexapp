import { actionButton, bindAction, emitAction } from './actions.js';

const FALLBACK_DB = 'sideways-social-v1';
const FALLBACK_DB_VERSION = 2;
const POST_STORE = 'posts';
const DRAFT_STORE = 'drafts';
const EVENT_STORE = 'events';
const PROFILE_KEY = 'sideways-social-profile-v1';
const RESULTS_KEY = 'sideways-action-results-v1';
const ACTIVE_PLACE_KEY = 'sideways-active-place-v1';
const UNDO_KEY = 'sideways-local-undo-v1';

const AVATARS = ['◉', '✦', '●', '▲', '■', '◆', '☻', '☁', '☀', '☾', '✿', '⌁'];
const COLORS = ['#0a84ff', '#7c6df2', '#bf5af2', '#ff375f', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff'];
const STYLES = ['NOTE', 'LARGE', 'QUIET', 'MONO'];

let profile = readProfile();
let posts = [];
let profileDialog;
let composerDialog;
let renderScheduled = false;
let currentPlaceId = readActivePlace();
let lastWorkspaceError = null;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function workspace() {
  return window.SidewaysWorkspace || null;
}

async function workspaceReady() {
  const api = workspace();
  if (!api) return null;
  try {
    await api.ready?.();
    lastWorkspaceError = null;
    return api;
  } catch (error) {
    lastWorkspaceError = error;
    console.warn('[social] workspace backend unavailable; using compatibility storage', error);
    return null;
  }
}

function openFallbackDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FALLBACK_DB, FALLBACK_DB_VERSION);
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

async function fallbackRequest(storeName, mode, work) {
  const db = await openFallbackDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let request;
      let result;
      try { request = work(store, tx); }
      catch (error) { reject(error); return; }
      if (request) {
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error);
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function defaultProfile() {
  return { id: 'local', name: 'You', handle: '', avatar: '◉', color: '#0a84ff' };
}

function readProfile() {
  try { return { ...defaultProfile(), ...JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') }; }
  catch { return defaultProfile(); }
}

function saveProfile(next) {
  profile = {
    id: 'local',
    name: String(next.name || 'You').trim().slice(0, 40) || 'You',
    handle: String(next.handle || '').trim().replace(/^@/, '').slice(0, 28),
    avatar: AVATARS.includes(next.avatar) ? next.avatar : '◉',
    color: COLORS.includes(next.color) ? next.color : '#0a84ff'
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  window.dispatchEvent(new CustomEvent('sideways:profilechange', { detail: clone(profile) }));
  scheduleRender();
  return clone(profile);
}

function readResults() {
  try { return JSON.parse(localStorage.getItem(RESULTS_KEY) || '{}'); }
  catch { return {}; }
}

function recordResult(detail) {
  if (!['success', 'result'].includes(detail.phase)) return;
  const results = readResults();
  const bucket = results[detail.actionId] || { count: 0, values: {} };
  bucket.count += 1;
  const value = detail.value || detail.style || detail.avatar || detail.color || detail.placeId;
  if (value) bucket.values[value] = (bucket.values[value] || 0) + 1;
  results[detail.actionId] = bucket;
  localStorage.setItem(RESULTS_KEY, JSON.stringify(results));
}

function rankByResults(actionId, options) {
  const values = readResults()[actionId]?.values || {};
  return [...options].sort((a, b) => (values[b] || 0) - (values[a] || 0));
}

async function persistEvent(detail) {
  recordResult(detail);
  try { await fallbackRequest(EVENT_STORE, 'readwrite', store => store.add(detail)); }
  catch (error) { console.warn('[social] action event was not persisted', error); }
}

window.addEventListener('sideways:action', event => void persistEvent(event.detail));

function readActivePlace() {
  return localStorage.getItem(ACTIVE_PLACE_KEY) || 'everything';
}

async function getActivePlace() {
  const api = await workspaceReady();
  if (api?.getActivePlace) {
    const id = await api.getActivePlace();
    if (id) return id;
  }
  return readActivePlace();
}

async function setActivePlace(id) {
  currentPlaceId = id || 'everything';
  localStorage.setItem(ACTIVE_PLACE_KEY, currentPlaceId);
  const api = await workspaceReady();
  await api?.setActivePlace?.(currentPlaceId);
  await loadPosts();
}

async function listPlaces() {
  const api = await workspaceReady();
  if (api?.listPlaces) return api.listPlaces();
  return [
    { id: 'everything', name: 'Everything', icon: 'globe', color: '#9cc7ff', virtual: true },
    { id: 'later', name: 'Later', icon: 'later', color: '#ffd66b', virtual: false },
    { id: 'archive', name: 'Archive', icon: 'archive', color: '#c7cbd4', virtual: true }
  ];
}

async function fallbackListPosts(placeId = 'everything') {
  const all = await fallbackRequest(POST_STORE, 'readonly', store => store.getAll()) || [];
  return all.filter(post => {
    if (placeId === 'archive') return Boolean(post.archived);
    if (post.archived) return false;
    if (placeId === 'everything') return true;
    return (post.placeId || 'everything') === placeId;
  });
}

async function loadPosts() {
  currentPlaceId = await getActivePlace();
  const api = await workspaceReady();
  let values;
  if (api?.listEntities) {
    values = await api.listEntities({ placeId: currentPlaceId, archived: currentPlaceId === 'archive' });
  } else {
    values = await fallbackListPosts(currentPlaceId);
  }
  posts = (values || []).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  scheduleRender();
  return clone(posts);
}

async function getEntity(id) {
  const api = await workspaceReady();
  if (api?.getEntity) return api.getEntity(id);
  return fallbackRequest(POST_STORE, 'readonly', store => store.get(id));
}

async function fallbackPutEntity(post) {
  await fallbackRequest(POST_STORE, 'readwrite', store => store.put(post));
  await loadPosts();
  return clone(post);
}

function rememberUndo(operation) {
  localStorage.setItem(UNDO_KEY, JSON.stringify({ ...operation, at: new Date().toISOString() }));
}

async function fallbackDeleteEntity(id) {
  const previous = await getEntity(id);
  if (previous) rememberUndo({ type: 'restore-entity', entity: previous });
  await fallbackRequest(POST_STORE, 'readwrite', store => store.delete(id));
  await loadPosts();
  return { entityId: id };
}

async function updateEntity(id, patch) {
  const api = await workspaceReady();
  if (api?.updateEntity) {
    const result = await api.updateEntity(id, patch);
    await loadPosts();
    return result;
  }
  const current = await getEntity(id);
  if (!current) throw new Error('POST NOT FOUND');
  rememberUndo({ type: 'put-entity', entity: current });
  return fallbackPutEntity({ ...current, ...patch, id, updatedAt: new Date().toISOString() });
}

async function moveEntity(id, placeId) {
  const api = await workspaceReady();
  if (api?.moveEntity) {
    const result = await api.moveEntity(id, placeId);
    await loadPosts();
    return result;
  }
  return updateEntity(id, { placeId, archived: false });
}

async function archiveEntity(id) {
  const api = await workspaceReady();
  if (api?.archiveEntity) {
    const result = await api.archiveEntity(id);
    await loadPosts();
    return result;
  }
  return updateEntity(id, { archived: true, archivedAt: new Date().toISOString() });
}

async function restoreEntity(id) {
  const api = await workspaceReady();
  if (api?.restoreEntity) {
    const result = await api.restoreEntity(id);
    await loadPosts();
    return result;
  }
  return updateEntity(id, { archived: false, archivedAt: null });
}

async function deleteEntity(id) {
  const api = await workspaceReady();
  if (api?.deleteEntity) {
    const result = await api.deleteEntity(id);
    await loadPosts();
    return result;
  }
  return fallbackDeleteEntity(id);
}

async function undoLast() {
  const api = await workspaceReady();
  if (api?.undo) {
    const result = await api.undo();
    await loadPosts();
    return result;
  }
  let operation;
  try { operation = JSON.parse(localStorage.getItem(UNDO_KEY) || 'null'); }
  catch { operation = null; }
  if (!operation) return { restored: false };
  if (operation.type === 'restore-entity' || operation.type === 'put-entity') await fallbackPutEntity(operation.entity);
  localStorage.removeItem(UNDO_KEY);
  return { restored: true };
}

async function listDrafts() {
  const api = await workspaceReady();
  if (api?.listDrafts) return api.listDrafts();
  const values = await fallbackRequest(DRAFT_STORE, 'readonly', store => store.getAll()) || [];
  return values.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function saveDraft(draft) {
  const normalized = { ...draft, id: draft.id || uid('draft'), updatedAt: new Date().toISOString() };
  const api = await workspaceReady();
  if (api?.saveDraft) return api.saveDraft(normalized);
  await fallbackRequest(DRAFT_STORE, 'readwrite', store => store.put(normalized));
  window.dispatchEvent(new CustomEvent('sideways:workspacechange', { detail: { type: 'draft', id: normalized.id } }));
  return clone(normalized);
}

async function deleteDraft(id) {
  const api = await workspaceReady();
  if (api?.deleteDraft) return api.deleteDraft(id);
  await fallbackRequest(DRAFT_STORE, 'readwrite', store => store.delete(id));
  window.dispatchEvent(new CustomEvent('sideways:workspacechange', { detail: { type: 'draft-delete', id } }));
  return { draftId: id };
}

async function publishDraft(draft, post) {
  const api = await workspaceReady();
  if (api?.publishDraft) {
    const result = await api.publishDraft(draft.id, post);
    await loadPosts();
    return result;
  }
  const db = await openFallbackDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction([DRAFT_STORE, POST_STORE], 'readwrite');
      tx.objectStore(POST_STORE).put(post);
      tx.objectStore(DRAFT_STORE).delete(draft.id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  await loadPosts();
  return { entityId: post.id };
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function optionGrid(values, actionId, selected, onSelect, className) {
  const grid = el('div', className);
  for (const value of rankByResults(actionId, values)) {
    const node = actionButton(actionId, () => onSelect(value), {
      className: `social-option${selected === value ? ' is-selected' : ''}`,
      label: value,
      icon: false,
      payload: { value }
    });
    node.dataset.value = value;
    grid.append(node);
  }
  return grid;
}

function buildProfileDialog() {
  const dialog = el('dialog', 'social-dialog social-profile-dialog');
  dialog.dataset.socialProfile = 'true';
  const shell = el('div', 'social-dialog-shell');
  const head = el('div', 'social-dialog-head');
  head.append(el('h2', '', 'Profile'), actionButton('profile.close', () => closeDialog(dialog), { className: 'social-icon-button', iconOnly: true }));

  const preview = el('div', 'social-profile-preview');
  const avatar = el('span', 'social-profile-avatar', profile.avatar);
  avatar.style.background = profile.color;
  const identity = el('div');
  identity.append(el('strong', '', profile.name), el('span', '', profile.handle ? `@${profile.handle}` : 'Local profile'));
  preview.append(avatar, identity);

  const name = el('input', 'social-input');
  name.name = 'socialName';
  name.maxLength = 40;
  name.placeholder = 'Name';
  name.value = profile.name === 'You' ? '' : profile.name;
  const handle = el('input', 'social-input');
  handle.name = 'socialHandle';
  handle.maxLength = 29;
  handle.placeholder = '@handle';
  handle.value = profile.handle ? `@${profile.handle}` : '';

  let draftAvatar = profile.avatar;
  let draftColor = profile.color;
  const controls = el('div', 'social-profile-controls');
  const avatarHost = el('section', 'social-picker');
  avatarHost.append(el('h3', '', 'Mark'));
  const colorHost = el('section', 'social-picker');
  colorHost.append(el('h3', '', 'Color'));

  const rerenderPickers = () => {
    avatarHost.querySelector('.social-option-grid')?.remove();
    colorHost.querySelector('.social-color-grid')?.remove();
    avatarHost.append(optionGrid(AVATARS, 'profile.avatar', draftAvatar, value => {
      draftAvatar = value;
      avatar.textContent = value;
      rerenderPickers();
    }, 'social-option-grid'));
    colorHost.append(optionGrid(COLORS, 'profile.color', draftColor, value => {
      draftColor = value;
      avatar.style.background = value;
      rerenderPickers();
    }, 'social-color-grid'));
    for (const node of colorHost.querySelectorAll('.social-option')) {
      node.querySelector('.ui-button-label')?.remove();
      node.style.background = node.dataset.value;
      node.setAttribute('aria-label', node.dataset.value);
    }
  };

  name.addEventListener('input', () => { identity.querySelector('strong').textContent = name.value.trim() || 'You'; });
  handle.addEventListener('input', () => { identity.querySelector('span').textContent = handle.value.trim() || 'Local profile'; });
  rerenderPickers();
  controls.append(avatarHost, colorHost);

  const actions = el('div', 'social-dialog-actions');
  actions.append(
    actionButton('profile.random', () => {
      name.value = ['Kai', 'Loop', 'Ghost', 'Local', 'Blue', 'Window'][Math.floor(Math.random() * 6)];
      handle.value = `@${name.value.toLowerCase()}${Math.floor(Math.random() * 99)}`;
      draftAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
      draftColor = COLORS[Math.floor(Math.random() * COLORS.length)];
      identity.querySelector('strong').textContent = name.value;
      identity.querySelector('span').textContent = handle.value;
      avatar.textContent = draftAvatar;
      avatar.style.background = draftColor;
      rerenderPickers();
    }, { className: 'social-secondary' }),
    actionButton('profile.save', () => {
      const saved = saveProfile({ name: name.value, handle: handle.value, avatar: draftAvatar, color: draftColor });
      closeDialog(dialog);
      return { profileId: saved.id };
    }, { className: 'social-primary' })
  );

  shell.append(head, preview, name, handle, controls, actions);
  dialog.append(shell);
  document.body.append(dialog);
  return dialog;
}

function imageFileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('PHOTO DID NOT OPEN'));
      image.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', .82));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function routeToFeed() {
  if (window.SidewaysShell?.openRoute) window.SidewaysShell.openRoute('#/feed');
  else if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo('#/feed');
  else location.hash = '#/feed';
  scheduleRender();
}

function openProfile() {
  profile = readProfile();
  profileDialog?.remove();
  profileDialog = buildProfileDialog();
  openDialog(profileDialog);
}

function composerSnapshot(state) {
  return {
    id: state.draftId,
    text: state.textarea.value,
    image: state.image,
    link: state.linkInput.value.trim(),
    style: state.style,
    placeId: state.placeId,
    remixOf: state.seed.remixOf || null,
    remixText: state.seed.remixText || '',
    editingEntityId: state.seed.editingEntityId || null,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString()
  };
}

function hasDraftContent(draft) {
  return Boolean(draft.text.trim() || draft.image || draft.link || draft.remixOf || draft.editingEntityId);
}

async function buildComposerDialog(seed = {}) {
  const existing = seed.draft || (seed.editingEntityId ? await getEntity(seed.editingEntityId) : null) || {};
  const state = {
    seed,
    draftId: seed.draft?.id || uid('draft'),
    createdAt: existing.createdAt || new Date().toISOString(),
    image: existing.image || seed.image || '',
    style: existing.style || rankByResults('post.style', STYLES)[0] || 'NOTE',
    placeId: existing.placeId || seed.placeId || currentPlaceId === 'archive' ? 'everything' : currentPlaceId,
    saveTimer: null,
    saved: false,
    published: false
  };
  if (!state.placeId || state.placeId === 'archive') state.placeId = 'everything';

  const dialog = el('dialog', 'social-dialog social-composer-dialog');
  dialog.dataset.socialComposer = 'true';
  const shell = el('div', 'social-dialog-shell');
  const head = el('div', 'social-dialog-head');
  head.append(el('h2', '', seed.editingEntityId ? 'Edit post' : seed.remixOf ? 'Remix' : 'New post'), actionButton('post.cancel', () => closeDialog(dialog), { className: 'social-icon-button', iconOnly: true }));

  const author = el('button', 'social-composer-author');
  author.type = 'button';
  bindAction(author, 'profile.open', () => openProfile());
  const renderAuthor = () => {
    author.replaceChildren();
    const avatar = el('span', 'social-mini-avatar', profile.avatar);
    avatar.style.background = profile.color;
    author.append(avatar, el('strong', '', profile.name));
  };
  renderAuthor();

  const remix = el('div', 'social-remix-preview');
  if (seed.remixText || existing.remixText) remix.append(el('span', '', 'Remix'), el('p', '', (seed.remixText || existing.remixText).slice(0, 220)));
  else remix.hidden = true;

  const textarea = el('textarea', 'social-composer-text');
  textarea.maxLength = 5000;
  textarea.placeholder = 'Write something';
  textarea.value = existing.text || seed.text || '';
  state.textarea = textarea;

  const imagePreview = el('div', 'social-image-preview');
  const renderImage = () => {
    imagePreview.replaceChildren();
    if (!state.image) return;
    const image = new Image();
    image.src = state.image;
    image.alt = '';
    imagePreview.append(image);
  };
  renderImage();

  const imageInput = el('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/*';
  imageInput.hidden = true;
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (!file) return;
    state.image = await imageFileToDataURL(file);
    renderImage();
    scheduleDraftSave();
  });
  document.body.append(imageInput);

  const linkInput = el('input', 'social-link-input');
  linkInput.type = 'url';
  linkInput.placeholder = 'https://';
  linkInput.value = existing.link || '';
  linkInput.hidden = !linkInput.value;
  state.linkInput = linkInput;

  const tools = el('div', 'social-composer-tools');
  tools.append(
    actionButton('post.attach', () => imageInput.click(), { className: 'ui-button' }),
    actionButton('post.link', () => {
      linkInput.hidden = false;
      linkInput.focus();
    }, { className: 'ui-button' })
  );

  const styleHost = el('section', 'social-picker');
  styleHost.append(el('h3', '', 'Look'));
  const placeHost = el('section', 'social-picker');
  placeHost.append(el('h3', '', 'Place'));

  const renderStyles = () => {
    styleHost.querySelector('.social-option-grid')?.remove();
    styleHost.append(optionGrid(STYLES, 'post.style', state.style, value => {
      state.style = value;
      renderStyles();
      scheduleDraftSave();
    }, 'social-option-grid'));
  };

  const renderPlaces = async () => {
    placeHost.querySelector('.social-place-picker')?.remove();
    const picker = el('div', 'social-place-picker');
    for (const place of await listPlaces()) {
      if (place.id === 'archive') continue;
      const button = actionButton('post.place', () => {
        state.placeId = place.id;
        void renderPlaces();
        scheduleDraftSave();
      }, {
        className: `ui-button social-place-chip${state.placeId === place.id ? ' is-selected' : ''}`,
        label: place.name,
        icon: place.icon || 'folder',
        payload: { placeId: place.id }
      });
      picker.append(button);
    }
    placeHost.append(picker);
  };

  const status = el('div', 'social-draft-status');
  const setStatus = (label, iconName = 'check') => {
    status.replaceChildren();
    const mark = actionButton('draft.autosave', () => undefined, { className: 'social-draft-indicator', label, icon: iconName });
    mark.disabled = true;
    status.append(mark);
  };

  const saveNow = async () => {
    clearTimeout(state.saveTimer);
    const draft = composerSnapshot(state);
    if (!hasDraftContent(draft)) {
      setStatus('Draft');
      return null;
    }
    setStatus('Saving…', 'draft');
    const saved = await saveDraft(draft);
    state.saved = true;
    setStatus('Saved');
    emitAction('draft.autosave', { phase: 'result', draftId: saved.id || draft.id });
    return saved;
  };

  const scheduleDraftSave = () => {
    clearTimeout(state.saveTimer);
    setStatus('Saving…', 'draft');
    state.saveTimer = setTimeout(() => void saveNow(), 420);
  };

  textarea.addEventListener('input', scheduleDraftSave);
  linkInput.addEventListener('input', scheduleDraftSave);
  renderStyles();
  await renderPlaces();
  setStatus(hasDraftContent(composerSnapshot(state)) ? 'Saved' : 'Draft');

  const actions = el('div', 'social-dialog-actions');
  actions.append(
    actionButton('post.cancel', () => closeDialog(dialog), { className: 'social-secondary', label: 'Close' }),
    actionButton(seed.editingEntityId ? 'post.update' : 'post.publish', async () => {
      await saveNow();
      const draft = composerSnapshot(state);
      if (!draft.text.trim() && !draft.image && !draft.link) {
        textarea.focus();
        throw new Error('EMPTY POST');
      }
      const now = new Date().toISOString();
      const post = {
        id: seed.editingEntityId || uid('post'),
        text: draft.text.trim(),
        image: draft.image,
        link: draft.link,
        style: draft.style,
        placeId: draft.placeId || 'everything',
        remixOf: draft.remixOf,
        remixText: draft.remixText,
        createdAt: existing.createdAt || now,
        updatedAt: now,
        author: { ...profile },
        archived: false,
        source: existing.source || 'sideways'
      };
      let result;
      if (seed.editingEntityId) result = await updateEntity(seed.editingEntityId, post);
      else result = await publishDraft(draft, post);
      state.published = true;
      await deleteDraft(draft.id).catch(() => undefined);
      closeDialog(dialog);
      routeToFeed();
      return { entityId: result?.entityId || post.id };
    }, { className: 'social-primary' })
  );

  shell.append(head, author);
  if (!remix.hidden) shell.append(remix);
  shell.append(textarea, imagePreview, linkInput, tools, styleHost, placeHost, status, actions);
  dialog.append(shell);
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    clearTimeout(state.saveTimer);
    imageInput.remove();
    if (!state.published && hasDraftContent(composerSnapshot(state))) void saveNow();
    else if (!state.published) void deleteDraft(state.draftId).catch(() => undefined);
  }, { once: true });
  dialog._state = state;
  return dialog;
}

async function openComposer(seed = {}) {
  composerDialog?.remove();
  composerDialog = await buildComposerDialog(seed);
  openDialog(composerDialog);
  setTimeout(() => composerDialog.querySelector('.social-composer-text')?.focus(), 80);
  return composerDialog;
}

async function sharePost(post) {
  const text = [post.text, post.link, post.remixText ? `↪ ${post.remixText}` : ''].filter(Boolean).join('\n');
  if (navigator.share) await navigator.share({ title: `${post.author?.name || 'Sideways'}`, text });
  else await navigator.clipboard.writeText(text);
  return { entityId: post.id };
}

function showUndo(message) {
  document.querySelector('[data-os-toast]')?.remove();
  const toast = el('div', 'os-toast');
  toast.dataset.osToast = 'true';
  toast.append(el('span', '', message), actionButton('undo.last', async () => {
    await undoLast();
    toast.remove();
  }, { className: 'os-toast-action' }));
  document.body.append(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => toast.remove(), 6000);
}

async function openMoveSheet(post) {
  const dialog = el('dialog', 'os-sheet os-small-sheet');
  const body = el('div', 'os-sheet-body');
  const head = el('div', 'social-dialog-head');
  head.append(el('h2', '', 'Move to'), actionButton('post.more', () => closeDialog(dialog), { className: 'social-icon-button', icon: 'close', iconOnly: true }));
  const list = el('div', 'social-place-picker');
  for (const place of await listPlaces()) {
    if (['everything', 'archive'].includes(place.id)) continue;
    list.append(actionButton('post.move', async () => {
      await moveEntity(post.id, place.id);
      closeDialog(dialog);
      showUndo(`Moved to ${place.name}`);
    }, { className: 'ui-button social-place-chip', label: place.name, icon: place.icon || 'folder', payload: { entityId: post.id, placeId: place.id } }));
  }
  body.append(head, list);
  dialog.append(body);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  openDialog(dialog);
}

function openEntityMenu(post) {
  const dialog = el('dialog', 'os-sheet os-small-sheet');
  const body = el('div', 'os-sheet-body');
  const head = el('div', 'social-dialog-head');
  head.append(el('h2', '', 'Post'), actionButton('post.more', () => closeDialog(dialog), { className: 'social-icon-button', icon: 'close', iconOnly: true }));
  const menu = el('div', 'os-menu-list');
  menu.append(
    actionButton('post.edit', () => { closeDialog(dialog); void openComposer({ editingEntityId: post.id }); }, { className: 'os-menu-item', payload: { entityId: post.id } }),
    actionButton('post.move', () => { closeDialog(dialog); void openMoveSheet(post); }, { className: 'os-menu-item', payload: { entityId: post.id, placeId: post.placeId || 'everything' } }),
    post.archived
      ? actionButton('post.restore', async () => { await restoreEntity(post.id); closeDialog(dialog); }, { className: 'os-menu-item', payload: { entityId: post.id } })
      : actionButton('post.archive', async () => { await archiveEntity(post.id); closeDialog(dialog); showUndo('Archived'); }, { className: 'os-menu-item', payload: { entityId: post.id } }),
    actionButton('post.delete', async () => { await deleteEntity(post.id); closeDialog(dialog); showUndo('Deleted'); }, { className: 'os-menu-item is-destructive', payload: { entityId: post.id } })
  );
  body.append(head, menu);
  dialog.append(body);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  openDialog(dialog);
}

function postCard(post) {
  const style = String(post.style || 'NOTE').toLowerCase();
  const card = el('article', `social-post-card style-${style}`);
  card.dataset.socialPost = post.id;
  card.dataset.placeId = post.placeId || 'everything';
  if (post.archived) card.dataset.archived = 'true';

  const head = el('header', 'social-post-head');
  const avatar = el('span', 'social-post-avatar', post.author?.avatar || '◉');
  avatar.style.background = post.author?.color || '#0a84ff';
  const identity = el('div', 'social-post-identity');
  identity.append(el('strong', '', post.author?.name || 'You'), el('span', '', post.author?.handle ? `@${post.author.handle}` : post.placeName || post.placeId || 'Everything'));
  head.append(avatar, identity, el('time', '', new Date(post.updatedAt || post.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })));

  const body = el('div', 'social-post-body');
  if (post.remixText) {
    const remix = el('blockquote', 'social-post-remix');
    remix.append(el('span', '', 'Remix'), el('p', '', post.remixText));
    body.append(remix);
  }
  if (post.text) body.append(el('p', 'social-post-text', post.text));
  if (post.link) {
    const link = el('a', 'social-post-link', post.link);
    link.href = post.link;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    body.append(link);
  }
  if (post.image) {
    const image = new Image();
    image.className = 'social-post-image';
    image.src = post.image;
    image.alt = '';
    body.append(image);
  }

  const actions = el('div', 'social-post-actions');
  actions.append(
    actionButton('post.remix', () => openComposer({ remixOf: post.id, remixText: post.text || post.link || 'Post' }), { className: 'social-post-action', payload: { entityId: post.id } }),
    post.placeId === 'later'
      ? actionButton('post.move', () => openMoveSheet(post), { className: 'social-post-action', label: 'Move', payload: { entityId: post.id, placeId: post.placeId } })
      : actionButton('post.later', async () => { await moveEntity(post.id, 'later'); showUndo('Moved to Later'); }, { className: 'social-post-action', payload: { entityId: post.id, placeId: 'later' } }),
    actionButton('post.share', () => sharePost(post), { className: 'social-post-action', payload: { entityId: post.id } }),
    actionButton('post.more', () => openEntityMenu(post), { className: 'social-post-action', iconOnly: true, payload: { entityId: post.id } })
  );

  card.append(head, body, actions);
  return card;
}

function renderSocialPosts() {
  const feed = document.getElementById('feed');
  if (!feed || document.getElementById('feedView')?.hidden) return;
  let stream = feed.querySelector('[data-social-stream]');
  if (!stream) {
    stream = el('section', 'social-stream');
    stream.dataset.socialStream = 'true';
    feed.prepend(stream);
  }
  stream.replaceChildren(...posts.map(postCard));
  stream.hidden = posts.length === 0;
  document.documentElement.dataset.activePlace = currentPlaceId;
}

function coreEntitySeed(card) {
  const title = card.querySelector('.title')?.textContent?.trim() || '';
  const dek = card.querySelector('.dek')?.textContent?.trim() || '';
  const source = card.querySelector('.source-link')?.textContent?.trim() || 'Imported';
  return {
    text: [title, dek].filter(Boolean).join('\n\n'),
    remixText: title || dek || source,
    source,
    externalRef: card.dataset.id || card.querySelector('a[href]')?.href || title.slice(0, 120)
  };
}

async function captureCoreLater(card) {
  const seed = coreEntitySeed(card);
  const draft = await saveDraft({ id: uid('draft'), text: seed.text, placeId: 'later', source: seed.source, externalRef: seed.externalRef, createdAt: new Date().toISOString() });
  const post = {
    id: uid('ref'),
    text: seed.text,
    image: card.querySelector('img')?.src || '',
    link: card.querySelector('a[href]')?.href || '',
    style: 'NOTE',
    placeId: 'later',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    author: { ...profile },
    source: seed.source,
    externalRef: seed.externalRef,
    reference: true,
    archived: false
  };
  await publishDraft(draft, post);
  showUndo('Added to Later');
}

function enhanceCorePosts() {
  for (const card of document.querySelectorAll('#feed .post:not([data-social-enhanced])')) {
    card.dataset.socialEnhanced = 'true';
    const actions = card.querySelector('.actions');
    if (!actions) continue;
    const seed = coreEntitySeed(card);
    actions.append(
      actionButton('post.remix', () => openComposer({ remixText: seed.remixText }), { className: 'social-core-remix', payload: { entityId: seed.externalRef } }),
      actionButton('post.later', () => captureCoreLater(card), { className: 'social-core-remix', payload: { entityId: seed.externalRef, placeId: 'later' } })
    );
  }
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderSocialPosts();
    enhanceCorePosts();
  });
}

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'sideways:profilechange', 'hashchange', 'popstate']) {
  window.addEventListener(eventName, scheduleRender);
}
window.addEventListener('sideways:workspacechange', () => void loadPosts());
window.addEventListener('sideways:placeopen', event => void setActivePlace(event.detail?.placeId || 'everything'));

async function boot() {
  profile = readProfile();
  await loadPosts();
  scheduleRender();
  for (const delay of [100, 400, 1200]) setTimeout(scheduleRender, delay);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
else void boot();

window.SidewaysSocial = Object.freeze({
  openProfile,
  openComposer,
  loadPosts,
  setActivePlace,
  activePlace: () => currentPlaceId,
  listDrafts,
  profile: () => clone(profile),
  posts: () => clone(posts),
  results: readResults,
  workspaceError: () => lastWorkspaceError,
  actionContract: () => window.SidewaysActions?.actionContract?.() || []
});
