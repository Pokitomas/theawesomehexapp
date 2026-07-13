import { actionButton, bindAction, emitAction } from './actions.js';

const DB_NAME = 'sideways-social-v1';
const DB_VERSION = 1;
const POST_STORE = 'posts';
const EVENT_STORE = 'events';
const PROFILE_KEY = 'sideways-social-profile-v1';
const RESULTS_KEY = 'sideways-action-results-v1';

const AVATARS = ['👽', '🫠', '🧿', '🦋', '🐸', '🪩', '🧠', '🦷', '🕷️', '🍒', '💿', '🌞'];
const COLORS = ['#ff5a36', '#ff9bc7', '#72c8ff', '#dfff65', '#ffd85b', '#9278ff', '#64dfa0', '#171714'];
const MOODS = ['LOL', 'REAL', 'HOT', '???', 'OUCH', 'YEAH'];
const STYLES = ['NOTE', 'SHOUT', 'SOFT', 'CHAOS'];
const REACTIONS = ['😂', '🔥', 'REAL', '???'];

let profile = readProfile();
let posts = [];
let profileDialog;
let composerDialog;
let composerSeed = {};
let composerImage = '';
let selectedMood = 'REAL';
let selectedStyle = 'NOTE';
let renderScheduled = false;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(POST_STORE)) {
        const store = db.createObjectStore(POST_STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
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

async function storeRequest(storeName, mode, work) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let request;
      let result;
      try { request = work(store); }
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
  return { name: 'YOU', handle: '', avatar: '👽', color: '#ff5a36' };
}

function readProfile() {
  try {
    return { ...defaultProfile(), ...JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') };
  } catch {
    return defaultProfile();
  }
}

function saveProfile(next) {
  profile = {
    name: String(next.name || 'YOU').trim().slice(0, 40) || 'YOU',
    handle: String(next.handle || '').trim().replace(/^@/, '').slice(0, 28),
    avatar: AVATARS.includes(next.avatar) ? next.avatar : '👽',
    color: COLORS.includes(next.color) ? next.color : '#ff5a36'
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  window.dispatchEvent(new CustomEvent('sideways:profilechange', { detail: profile }));
  scheduleRender();
  return profile;
}

function readResults() {
  try { return JSON.parse(localStorage.getItem(RESULTS_KEY) || '{}'); }
  catch { return {}; }
}

function recordResult(detail) {
  if (detail.phase !== 'success') return;
  const results = readResults();
  const bucket = results[detail.actionId] || { count: 0, values: {} };
  bucket.count += 1;
  const value = detail.value || detail.reaction || detail.style || detail.mood || detail.avatar || detail.color;
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
  try { await storeRequest(EVENT_STORE, 'readwrite', store => store.add(detail)); }
  catch (error) { console.warn('[social] action event not persisted', error); }
}

window.addEventListener('sideways:action', event => void persistEvent(event.detail));

async function loadPosts() {
  posts = (await storeRequest(POST_STORE, 'readonly', store => store.getAll()) || [])
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  scheduleRender();
  return posts;
}

async function putPost(post) {
  await storeRequest(POST_STORE, 'readwrite', store => store.put(post));
  await loadPosts();
  return post;
}

async function deletePost(id) {
  await storeRequest(POST_STORE, 'readwrite', store => store.delete(id));
  await loadPosts();
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
  head.append(el('h2', '', 'ME'), actionButton('profile.close', () => closeDialog(dialog), { className: 'social-icon-button', label: '×' }));

  const preview = el('div', 'social-profile-preview');
  const avatar = el('span', 'social-profile-avatar', profile.avatar);
  avatar.style.background = profile.color;
  const identity = el('div');
  identity.append(el('strong', '', profile.name), el('span', '', profile.handle ? `@${profile.handle}` : '@YOU'));
  preview.append(avatar, identity);

  const name = el('input', 'social-input');
  name.name = 'socialName';
  name.maxLength = 40;
  name.placeholder = 'NAME';
  name.value = profile.name === 'YOU' ? '' : profile.name;
  const handle = el('input', 'social-input');
  handle.name = 'socialHandle';
  handle.maxLength = 29;
  handle.placeholder = '@HANDLE';
  handle.value = profile.handle ? `@${profile.handle}` : '';

  let draftAvatar = profile.avatar;
  let draftColor = profile.color;
  const controls = el('div', 'social-profile-controls');
  const avatarHost = el('section', 'social-picker');
  avatarHost.append(el('h3', '', 'FACE'));
  const colorHost = el('section', 'social-picker');
  colorHost.append(el('h3', '', 'COLOR'));

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
    [...colorHost.querySelectorAll('.social-option')].forEach(node => {
      node.textContent = '';
      node.style.background = node.dataset.value;
    });
  };

  name.addEventListener('input', () => { identity.querySelector('strong').textContent = name.value.trim() || 'YOU'; });
  handle.addEventListener('input', () => { identity.querySelector('span').textContent = handle.value.trim() || '@YOU'; });
  rerenderPickers();
  controls.append(avatarHost, colorHost);

  const actions = el('div', 'social-dialog-actions');
  actions.append(
    actionButton('profile.random', () => {
      name.value = ['KAI', 'LOOP', 'BUG', 'ANGEL', 'GHOST', 'LOCAL'][Math.floor(Math.random() * 6)];
      handle.value = `@${name.value.toLowerCase()}${Math.floor(Math.random() * 99)}`;
      draftAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
      draftColor = COLORS[Math.floor(Math.random() * COLORS.length)];
      preview.querySelector('strong').textContent = name.value;
      preview.querySelector('span').textContent = handle.value;
      avatar.textContent = draftAvatar;
      avatar.style.background = draftColor;
      rerenderPickers();
    }, { className: 'social-secondary' }),
    actionButton('profile.save', () => {
      saveProfile({ name: name.value, handle: handle.value, avatar: draftAvatar, color: draftColor });
      closeDialog(dialog);
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

function buildComposerDialog() {
  const dialog = el('dialog', 'social-dialog social-composer-dialog');
  dialog.dataset.socialComposer = 'true';
  const shell = el('div', 'social-dialog-shell');
  const head = el('div', 'social-dialog-head');
  head.append(el('h2', '', 'POST'), actionButton('post.cancel', () => closeDialog(dialog), { className: 'social-icon-button', label: '×' }));

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
  window.addEventListener('sideways:profilechange', renderAuthor);

  const remix = el('div', 'social-remix-preview');
  const textarea = el('textarea', 'social-composer-text');
  textarea.maxLength = 1800;
  textarea.placeholder = 'SAY IT';
  const imagePreview = el('div', 'social-image-preview');
  const imageInput = el('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/*';
  imageInput.hidden = true;
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (!file) return;
    composerImage = await imageFileToDataURL(file);
    imagePreview.replaceChildren();
    const image = new Image();
    image.src = composerImage;
    image.alt = '';
    imagePreview.append(image);
  });
  document.body.append(imageInput);

  const moodHost = el('section', 'social-picker');
  moodHost.append(el('h3', '', 'MOOD'));
  const styleHost = el('section', 'social-picker');
  styleHost.append(el('h3', '', 'LOOK'));
  const rerenderChoices = () => {
    moodHost.querySelector('.social-option-grid')?.remove();
    styleHost.querySelector('.social-option-grid')?.remove();
    moodHost.append(optionGrid(MOODS, 'post.mood', selectedMood, value => { selectedMood = value; rerenderChoices(); }, 'social-option-grid'));
    styleHost.append(optionGrid(STYLES, 'post.style', selectedStyle, value => { selectedStyle = value; rerenderChoices(); }, 'social-option-grid'));
  };
  rerenderChoices();

  const actions = el('div', 'social-dialog-actions');
  actions.append(
    actionButton('post.attach', () => imageInput.click(), { className: 'social-secondary' }),
    actionButton('post.publish', async () => {
      const text = textarea.value.trim();
      if (!text && !composerImage) {
        textarea.focus();
        throw new Error('EMPTY POST');
      }
      const post = {
        id: uid('post'),
        text,
        image: composerImage,
        mood: selectedMood,
        style: selectedStyle,
        remixOf: composerSeed.remixOf || null,
        remixText: composerSeed.remixText || '',
        createdAt: new Date().toISOString(),
        author: { ...profile },
        reactions: {},
        saved: false
      };
      await putPost(post);
      emitAction('post.publish', { phase: 'result', entityId: post.id, mood: post.mood, style: post.style });
      closeDialog(dialog);
      routeToFeed();
      return { postId: post.id };
    }, { className: 'social-primary' })
  );

  shell.append(head, author, remix, textarea, imagePreview, moodHost, styleHost, actions);
  dialog.append(shell);
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    textarea.value = '';
    composerImage = '';
    composerSeed = {};
    remix.replaceChildren();
    imagePreview.replaceChildren();
  });
  dialog._social = { textarea, remix, imagePreview, renderChoices: rerenderChoices };
  return dialog;
}

function routeToFeed() {
  if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo('#/feed');
  else location.hash = '#/feed';
  scheduleRender();
}

function openProfile() {
  profile = readProfile();
  profileDialog?.remove();
  profileDialog = buildProfileDialog();
  openDialog(profileDialog);
}

function openComposer(seed = {}) {
  composerSeed = seed;
  selectedMood = rankByResults('post.mood', MOODS)[0] || 'REAL';
  selectedStyle = rankByResults('post.style', STYLES)[0] || 'NOTE';
  if (!composerDialog?.isConnected) composerDialog = buildComposerDialog();
  const { textarea, remix, renderChoices } = composerDialog._social;
  textarea.value = seed.text || '';
  remix.replaceChildren();
  if (seed.remixText) remix.append(el('span', '', 'REMIX'), el('p', '', seed.remixText.slice(0, 180)));
  renderChoices();
  openDialog(composerDialog);
  setTimeout(() => textarea.focus(), 60);
}

async function react(post, reaction) {
  post.reactions = { ...(post.reactions || {}) };
  post.reactions[reaction] = Number(post.reactions[reaction] || 0) + 1;
  await putPost(post);
  return { postId: post.id, reaction, count: post.reactions[reaction] };
}

async function toggleSave(post) {
  post.saved = !post.saved;
  await putPost(post);
  return { postId: post.id, saved: post.saved };
}

async function sharePost(post) {
  const text = [post.text, post.remixText ? `↪ ${post.remixText}` : ''].filter(Boolean).join('\n');
  if (navigator.share) await navigator.share({ title: `${post.author.name} on Sideways`, text });
  else await navigator.clipboard.writeText(text);
  return { postId: post.id };
}

function postCard(post) {
  const card = el('article', `social-post-card style-${post.style.toLowerCase()}`);
  card.dataset.socialPost = post.id;
  card.dataset.mood = post.mood;

  const head = el('header', 'social-post-head');
  const avatar = el('span', 'social-post-avatar', post.author.avatar);
  avatar.style.background = post.author.color;
  const identity = el('div', 'social-post-identity');
  identity.append(el('strong', '', post.author.name), el('span', '', post.author.handle ? `@${post.author.handle}` : post.mood));
  head.append(avatar, identity, el('time', '', new Date(post.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase()));

  const body = el('div', 'social-post-body');
  if (post.remixText) {
    const remix = el('blockquote', 'social-post-remix');
    remix.append(el('span', '', 'REMIX'), el('p', '', post.remixText));
    body.append(remix);
  }
  if (post.text) body.append(el('p', 'social-post-text', post.text));
  if (post.image) {
    const image = new Image();
    image.className = 'social-post-image';
    image.src = post.image;
    image.alt = '';
    body.append(image);
  }

  const actions = el('div', 'social-post-actions');
  for (const reaction of rankByResults('post.react', REACTIONS)) {
    const count = Number(post.reactions?.[reaction] || 0);
    actions.append(actionButton('post.react', () => react(post, reaction), {
      className: 'social-reaction',
      label: count ? `${reaction} ${count}` : reaction,
      payload: { entityId: post.id, reaction }
    }));
  }
  actions.append(
    actionButton('post.remix', () => openComposer({ remixOf: post.id, remixText: post.text || post.mood }), { className: 'social-post-action', payload: { entityId: post.id } }),
    actionButton('post.save', () => toggleSave(post), { className: `social-post-action${post.saved ? ' is-active' : ''}`, label: post.saved ? 'SAVED' : 'SAVE', payload: { entityId: post.id } }),
    actionButton('post.share', () => sharePost(post), { className: 'social-post-action', payload: { entityId: post.id } }),
    actionButton('post.delete', () => deletePost(post.id), { className: 'social-post-action social-delete', payload: { entityId: post.id } })
  );

  card.append(head, body, actions);
  return card;
}

function renderSocialPosts() {
  const feed = document.getElementById('feed');
  if (!feed || feed.closest('[hidden]')) return;
  let stream = feed.querySelector('[data-social-stream]');
  if (!stream) {
    stream = el('section', 'social-stream');
    stream.dataset.socialStream = 'true';
    feed.prepend(stream);
  }
  stream.replaceChildren(...posts.map(postCard));
  stream.hidden = posts.length === 0;
}

function enhanceCorePosts() {
  for (const card of document.querySelectorAll('#feed .post:not([data-social-enhanced])')) {
    card.dataset.socialEnhanced = 'true';
    const actions = card.querySelector('.actions');
    if (!actions) continue;
    const text = card.querySelector('.title, .dek')?.textContent?.trim() || 'POST';
    actions.append(actionButton('post.remix', () => openComposer({ remixText: text }), {
      className: 'social-core-remix',
      payload: { entityId: card.dataset.id || text.slice(0, 80) }
    }));
  }
}

function installTopbar() {
  const top = document.querySelector('.topline');
  if (!top || top.querySelector('[data-social-post-button]')) return;
  const post = actionButton('feed.post', () => openComposer(), { className: 'social-top-post' });
  post.dataset.socialPostButton = 'true';
  const add = document.getElementById('navAdd');
  top.insertBefore(post, add || null);

  const profileButton = document.getElementById('navProfile');
  if (profileButton && profileButton.dataset.socialProfileBound !== 'true') {
    const replacement = profileButton.cloneNode(true);
    replacement.textContent = 'ME';
    replacement.dataset.socialProfileBound = 'true';
    bindAction(replacement, 'profile.open', event => {
      event.preventDefault();
      openProfile();
    });
    profileButton.replaceWith(replacement);
  }
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    installTopbar();
    renderSocialPosts();
    enhanceCorePosts();
  });
}

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'hashchange', 'popstate', 'sideways:profilechange']) {
  window.addEventListener(eventName, scheduleRender);
}

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
  profile: () => ({ ...profile }),
  posts: () => posts.map(post => structuredClone(post)),
  results: readResults,
  actionContract: () => window.SidewaysActions?.actionContract?.() || []
});
