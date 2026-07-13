import { actionButton, bindAction } from './actions.js';
import { icon } from './icons.js';

const CORE_VIEWS = ['feedView', 'addView', 'detailView', 'sourceView', 'savedView', 'profileView'];
const CUSTOM_ROUTES = new Set(['#/places', '#/me']);
let activeRoute = '#/feed';
let createSheet;
let placesView;
let meView;
let installed = false;
let workspaceReady = false;
let placesRenderToken = 0;
let meRenderToken = 0;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function coreRoute(hash) {
  if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo(hash);
  else location.hash = hash;
}

function hideCoreViews() {
  for (const id of CORE_VIEWS) {
    const view = document.getElementById(id);
    if (view) view.hidden = true;
  }
}

function hideCustomViews() {
  if (placesView) placesView.hidden = true;
  if (meView) meView.hidden = true;
}

function setActiveDock(route) {
  const dock = document.querySelector('[data-os-dock]');
  if (!dock) return;
  for (const button of dock.querySelectorAll('[data-route]')) {
    const current = button.dataset.route === route;
    button.classList.toggle('is-active', current);
    button.setAttribute('aria-current', current ? 'page' : 'false');
  }
}

function openRoute(route, options = {}) {
  activeRoute = route;
  hideCustomViews();

  if (route === '#/feed') {
    coreRoute('#/feed');
  } else if (route === '#/places') {
    hideCoreViews();
    placesView.hidden = false;
    renderPlaces();
    if (!options.silent) history.replaceState(null, '', '#/places');
  } else if (route === '#/me') {
    hideCoreViews();
    meView.hidden = false;
    renderMe();
    if (!options.silent) history.replaceState(null, '', '#/me');
  } else if (route === '#/add') {
    coreRoute('#/add');
  }

  setActiveDock(route === '#/add' ? '#/create' : route);
  document.documentElement.dataset.osRoute = route.slice(2) || 'feed';
  window.dispatchEvent(new CustomEvent('sideways:shellroute', { detail: { route } }));
}

function windowControls() {
  const group = el('div', 'os-window-controls');
  group.setAttribute('aria-hidden', 'true');
  for (const name of ['close', 'minimize', 'zoom']) group.append(el('span', `os-window-dot is-${name}`));
  return group;
}

function installTitlebar() {
  const topbar = document.querySelector('.topbar');
  const topline = document.querySelector('.topline');
  if (!topbar || !topline) return;
  topbar.classList.add('os-titlebar');
  topline.classList.add('os-titleline');

  if (!topline.querySelector('.os-window-controls')) topline.prepend(windowControls());

  const brand = document.querySelector('.brand-lockup');
  if (brand) {
    brand.classList.add('os-app-title');
    brand.replaceChildren();
    const mark = el('span', 'os-app-mark');
    mark.append(icon('window'));
    brand.append(mark, el('span', 'os-app-name', 'Sideways'));
    brand.onclick = event => {
      event.preventDefault();
      openRoute('#/feed');
    };
  }

  const status = document.getElementById('corpusStatus');
  if (status) {
    status.classList.add('os-status');
    const text = status.textContent;
    status.replaceChildren(el('span', 'os-status-light'), el('span', 'os-status-text', text));
  }

  const filters = document.querySelector('.type-nav');
  if (filters) filters.classList.add('os-filter-strip');
}

function dockButton(id, route, className = '') {
  const button = actionButton(id, () => {
    if (route === '#/create') showCreateSheet();
    else openRoute(route);
  }, { className: `os-dock-button ${className}`.trim() });
  button.dataset.route = route;
  return button;
}

function installDock() {
  if (document.querySelector('[data-os-dock]')) return;
  const dock = el('nav', 'os-dock');
  dock.dataset.osDock = 'true';
  dock.setAttribute('aria-label', 'Sideways');
  dock.append(
    dockButton('nav.feed', '#/feed'),
    dockButton('nav.places', '#/places'),
    dockButton('nav.create', '#/create', 'is-create'),
    dockButton('nav.me', '#/me')
  );
  document.body.append(dock);
}

function sheetHeader(title, closeId, onClose) {
  const head = el('header', 'os-sheet-header');
  const titleWrap = el('div', 'os-sheet-title');
  titleWrap.append(el('span', 'os-sheet-handle'), el('h2', '', title));
  head.append(titleWrap, actionButton(closeId, onClose, { className: 'os-icon-button', iconOnly: true }));
  return head;
}

function showCreateSheet() {
  if (!createSheet) createSheet = buildCreateSheet();
  if (typeof createSheet.showModal === 'function') createSheet.showModal();
  else createSheet.setAttribute('open', '');
  setActiveDock('#/create');
}

function closeCreateSheet() {
  if (!createSheet) return;
  if (typeof createSheet.close === 'function') createSheet.close();
  else createSheet.removeAttribute('open');
  setActiveDock(activeRoute);
}

function createTile(id, title, description, action) {
  const button = actionButton(id, action, { className: 'os-create-tile', label: title });
  const label = button.querySelector('.ui-button-label');
  if (label && description) label.append(el('small', '', description));
  return button;
}

function buildCreateSheet() {
  const dialog = el('dialog', 'os-sheet os-create-sheet');
  dialog.dataset.osCreate = 'true';
  const body = el('div', 'os-sheet-body');
  const grid = el('div', 'os-create-grid');
  grid.append(
    createTile('create.post', 'Post', 'Text, photo, link', () => {
      closeCreateSheet();
      window.SidewaysSocial?.openComposer?.();
    }),
    createTile('create.import', 'Import', 'Instagram, Reddit, files', () => {
      closeCreateSheet();
      openRoute('#/add');
    }),
    createTile('create.place', 'New place', 'Make a location', () => {
      closeCreateSheet();
      openRoute('#/places');
      requestAnimationFrame(() => openPlaceCreator());
    })
  );
  body.append(sheetHeader('Create', 'create.close', closeCreateSheet), grid);
  dialog.append(body);
  dialog.addEventListener('close', () => setActiveDock(activeRoute));
  document.body.append(dialog);
  return dialog;
}

function surface(title, iconName) {
  const view = el('section', 'os-workspace-view');
  view.hidden = true;
  const head = el('header', 'os-view-header');
  const iconWrap = el('span', 'os-view-icon');
  iconWrap.append(icon(iconName));
  head.append(iconWrap, el('h1', '', title));
  const content = el('div', 'os-view-content');
  view.append(head, content);
  return { view, content, head };
}

function installCustomViews() {
  const main = document.querySelector('main');
  if (!main) return;
  const places = surface('Places', 'places');
  places.view.id = 'osPlacesView';
  places.view.dataset.osView = 'places';
  placesView = places.view;
  const me = surface('Me', 'me');
  me.view.id = 'osMeView';
  me.view.dataset.osView = 'me';
  meView = me.view;
  main.append(placesView, meView);
}

function fallbackPlaces() {
  return [
    { id: 'everything', name: 'Everything', icon: 'globe', color: '#9cc7ff', virtual: true, count: null },
    { id: 'later', name: 'Later', icon: 'later', color: '#ffd66b', virtual: false, count: null },
    { id: 'archive', name: 'Archive', icon: 'archive', color: '#c7cbd4', virtual: true, count: null }
  ];
}

async function getPlaces() {
  const api = window.SidewaysWorkspace;
  if (!api?.listPlaces) return fallbackPlaces();
  try {
    await api.ready?.();
    workspaceReady = true;
    return await api.listPlaces();
  } catch (error) {
    console.warn('[shell] workspace unavailable', error);
    return fallbackPlaces();
  }
}

function placeCard(place) {
  const card = el('article', 'os-place-card');
  card.dataset.placeId = place.id;
  card.style.setProperty('--place-color', place.color || '#9cc7ff');
  const iconWrap = el('span', 'os-place-icon');
  iconWrap.append(icon(place.icon || 'folder'));
  const copy = el('div', 'os-place-copy');
  copy.append(el('strong', '', place.name), el('span', '', place.count == null ? 'Open' : `${place.count} items`));
  const open = actionButton('place.open', () => openPlace(place.id), { className: 'os-place-open', iconOnly: true, payload: { placeId: place.id } });
  card.append(iconWrap, copy, open);
  return card;
}

async function renderPlaces() {
  if (!placesView) return;
  const token = ++placesRenderToken;
  const places = await getPlaces();
  if (token !== placesRenderToken || !placesView) return;
  const content = placesView.querySelector('.os-view-content');
  content.replaceChildren();
  const toolbar = el('div', 'os-view-toolbar');
  toolbar.append(actionButton('place.create', openPlaceCreator, { className: 'ui-button is-primary' }));
  const grid = el('div', 'os-places-grid');
  for (const place of places) grid.append(placeCard(place));
  content.append(toolbar, grid);
}

function openPlace(placeId) {
  const api = window.SidewaysWorkspace;
  window.dispatchEvent(new CustomEvent('sideways:placeopen', { detail: { placeId } }));
  if (api?.setActivePlace) api.setActivePlace(placeId);
  openRoute('#/feed');
}

function openPlaceCreator() {
  const dialog = el('dialog', 'os-sheet os-small-sheet');
  const body = el('form', 'os-sheet-body');
  body.method = 'dialog';
  const input = el('input', 'os-text-field');
  input.name = 'placeName';
  input.placeholder = 'Name';
  input.maxLength = 30;
  const actions = el('div', 'os-form-actions');
  actions.append(
    actionButton('create.close', () => dialog.close(), { className: 'ui-button', label: 'Cancel' }),
    actionButton('place.create', async event => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) return input.focus();
      const api = window.SidewaysWorkspace;
      if (api?.createPlace) await api.createPlace({ name, icon: 'folder', color: '#a8d8ff' });
      dialog.close();
      await renderPlaces();
    }, { className: 'ui-button is-primary', label: 'Create' })
  );
  body.append(sheetHeader('New place', 'create.close', () => dialog.close()), input, actions);
  dialog.append(body);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  setTimeout(() => input.focus(), 80);
}

async function renderMe() {
  if (!meView) return;
  const token = ++meRenderToken;
  const profile = window.SidewaysSocial?.profile?.() || { name: 'You', handle: '', avatar: '◉', color: '#9cc7ff' };
  const posts = window.SidewaysSocial?.posts?.() || [];
  const [drafts, places, archive] = await Promise.all([
    window.SidewaysWorkspace?.listDrafts ? window.SidewaysWorkspace.listDrafts() : [],
    getPlaces(),
    window.SidewaysWorkspace?.listArchived ? window.SidewaysWorkspace.listArchived() : []
  ]);
  if (token !== meRenderToken || !meView) return;

  const content = meView.querySelector('.os-view-content');
  content.replaceChildren();
  const hero = el('section', 'os-me-hero');
  const avatar = el('span', 'os-me-avatar', profile.avatar || '◉');
  avatar.style.setProperty('--profile-color', profile.color || '#9cc7ff');
  const copy = el('div', 'os-me-copy');
  copy.append(el('h2', '', profile.name || 'You'), el('span', '', profile.handle ? `@${profile.handle}` : 'Local profile'));
  hero.append(avatar, copy, actionButton('profile.open', () => window.SidewaysSocial?.openProfile?.(), { className: 'ui-button', label: 'Edit' }));

  const stats = el('div', 'os-me-stats');
  for (const [value, label] of [[posts.length, 'Posts'], [drafts.length, 'Drafts'], [places.filter(place => !place.virtual).length, 'Places']]) {
    const stat = el('div', 'os-stat');
    stat.append(el('strong', '', String(value)), el('span', '', label));
    stats.append(stat);
  }

  const sections = el('div', 'os-me-sections');
  const draftSection = el('section', 'os-me-section');
  draftSection.append(el('h3', '', 'Drafts'));
  if (drafts.length) {
    for (const draft of drafts) {
      const row = el('article', 'os-list-row');
      row.append(icon('draft'), el('span', '', draft.text?.slice(0, 60) || 'Untitled draft'), actionButton('draft.resume', () => window.SidewaysSocial?.openComposer?.({ draft }), { className: 'os-row-action', iconOnly: true, payload: { draftId: draft.id } }));
      draftSection.append(row);
    }
  } else draftSection.append(el('p', 'os-empty-note', 'No drafts'));

  const archiveSection = el('section', 'os-me-section');
  archiveSection.append(el('h3', '', 'Archive'));
  if (archive.length) archiveSection.append(...archive.slice(0, 8).map(item => el('div', 'os-list-row', item.text || item.title || 'Archived item')));
  else archiveSection.append(el('p', 'os-empty-note', 'Nothing archived'));

  sections.append(draftSection, archiveSection);
  content.append(hero, stats, sections);
}

function installCoreAliases() {
  const aliases = [
    [document.getElementById('navFeed'), 'nav.feed', '#/feed'],
    [document.getElementById('navAdd'), 'nav.create', '#/create'],
    [document.getElementById('navSaved'), 'nav.places', '#/places'],
    [document.getElementById('navProfile'), 'nav.me', '#/me']
  ];
  for (const [node, actionId, route] of aliases) {
    if (!node || node.dataset.osAlias === 'true') continue;
    const replacement = node.cloneNode(true);
    replacement.dataset.osAlias = 'true';
    replacement.textContent = actionId === 'nav.places' ? 'PLACES' : actionId === 'nav.create' ? 'CREATE' : actionId === 'nav.me' ? 'ME' : 'FEED';
    bindAction(replacement, actionId, event => {
      event.preventDefault();
      if (route === '#/create') showCreateSheet();
      else openRoute(route);
    });
    node.replaceWith(replacement);
  }
}

function syncFromHash() {
  const hash = location.hash || '#/feed';
  if (CUSTOM_ROUTES.has(hash)) openRoute(hash, { silent: true });
  else if (hash === '#/add') {
    activeRoute = '#/feed';
    setActiveDock('#/create');
  } else {
    activeRoute = '#/feed';
    hideCustomViews();
    setActiveDock('#/feed');
  }
}

function install() {
  if (installed) return;
  installed = true;
  document.documentElement.classList.add('os-product');
  installTitlebar();
  installDock();
  installCustomViews();
  installCoreAliases();
  syncFromHash();
}

window.addEventListener('hashchange', syncFromHash);
window.addEventListener('popstate', syncFromHash);
window.addEventListener('sideways:ready', install, { once: true });
window.addEventListener('sideways:workspacechange', () => {
  if (!placesView?.hidden) void renderPlaces();
  if (!meView?.hidden) void renderMe();
});
window.addEventListener('sideways:profilechange', () => { if (!meView?.hidden) void renderMe(); });

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();

window.SidewaysShell = Object.freeze({
  openRoute,
  showCreate: showCreateSheet,
  openPlaces: () => openRoute('#/places'),
  openMe: () => openRoute('#/me'),
  refreshPlaces: renderPlaces,
  refreshMe: renderMe,
  workspaceReady: () => workspaceReady
});
