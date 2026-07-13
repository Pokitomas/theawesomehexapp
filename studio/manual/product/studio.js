import { COPY } from './copy.js';
import { actionButton, bindAction } from './actions.js';

const STABLE_LABELS = Object.freeze(['ADD', 'KEEP', 'READ', 'SEND', 'FILES +']);
const STABLE_IDS = Object.freeze(['corpusStatus', 'debugPolicy', 'debugState', 'debugPanel']);
const PRODUCT_TITLE = 'Sideways';
const PRODUCT_THEME = '#ececf0';
let appReady = Boolean(window.SidewaysCore?.state?.manifest);
let scheduled = false;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function icon(name, className = 'workspace-icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `./system-icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function actionWithIcon(actionId, iconName, handler, options = {}) {
  const button = actionButton(actionId, handler, options);
  const label = options.label || window.SidewaysActions.action(actionId).label;
  button.replaceChildren(icon(iconName), el('span', 'workspace-button-label', label));
  return button;
}

function routeTo(hash) {
  if (!appReady) {
    window.addEventListener('sideways:ready', () => routeTo(hash), { once: true });
    return;
  }
  if (hash === '#/places') {
    location.hash = hash;
    window.SidewaysWorkspaceUI?.openPlaces?.();
    return;
  }
  if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo(hash);
  else location.hash = hash;
}

function cloneNav(node, actionId, iconName, label, route, ariaLabel = label) {
  if (!node) return null;
  if (node.dataset.workspaceNav === actionId) return node;
  const replacement = node.cloneNode(false);
  replacement.id = node.id;
  replacement.className = `${node.className || ''} workspace-nav-button`.trim();
  replacement.dataset.workspaceNav = actionId;
  replacement.dataset.route = route;
  replacement.removeAttribute('href');
  replacement.replaceChildren(icon(iconName), el('span', 'workspace-button-label', label));
  bindAction(replacement, actionId, event => {
    event.preventDefault();
    routeTo(route);
  }, { ariaLabel, payload: { route } });
  node.replaceWith(replacement);
  return replacement;
}

function installNavigation() {
  const top = document.querySelector('.topline');
  if (!top) return;
  const chromeScope = document.querySelector('.topbar') || document;
  let nav = chromeScope.querySelector('[data-workspace-nav]');
  if (!nav) {
    nav = el('nav', 'workspace-nav');
    nav.dataset.workspaceNav = 'true';
    nav.setAttribute('aria-label', 'Main navigation');
    top.append(nav);
  }

  const navFeed = cloneNav(document.getElementById('navFeed'), 'nav.feed', 'feed', COPY.feed, '#/feed');
  const navAdd = cloneNav(document.getElementById('navAdd'), 'nav.import', 'library', COPY.library, '#/add', 'ADD');
  let navPlaces = document.getElementById('navPlaces');
  if (!navPlaces) {
    navPlaces = actionWithIcon('nav.places', 'pin', () => routeTo('#/places'), { className: 'workspace-nav-button', label: COPY.places, payload: { route: '#/places' } });
    navPlaces.id = 'navPlaces';
  }

  const navSaved = document.getElementById('navSaved');
  if (navSaved) {
    navSaved.hidden = true;
    navSaved.setAttribute('aria-hidden', 'true');
    navSaved.tabIndex = -1;
  }

  let newButton = chromeScope.querySelector('[data-workspace-new]');
  if (!newButton) {
    newButton = actionWithIcon('feed.post', 'compose', () => window.SidewaysWorkspaceUI?.openComposer?.(), { className: 'workspace-new-button', label: 'New' });
    newButton.dataset.workspaceNew = 'true';
  }

  for (const node of [navFeed, navPlaces, navAdd].filter(Boolean)) nav.append(node);
  if (!newButton.isConnected) top.insertBefore(newButton, nav);

  const active = location.hash || '#/feed';
  for (const button of nav.querySelectorAll('.workspace-nav-button')) {
    const route = button.dataset.route || (button.id === 'navPlaces' ? '#/places' : '');
    button.classList.toggle('is-active', route === active || (active === '' && route === '#/feed'));
    if (route) button.setAttribute('aria-current', route === active ? 'page' : 'false');
  }
}

function enhanceBrand() {
  const brand = document.querySelector('.brand-lockup span');
  if (brand && brand.textContent !== COPY.brand) brand.textContent = COPY.brand;
  const brandLink = document.querySelector('.brand-lockup');
  if (brandLink) brandLink.setAttribute('aria-label', `${COPY.brand} home`);
  document.title = PRODUCT_TITLE;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', PRODUCT_THEME);
}

function recordCount() {
  return Number(window.SidewaysCore?.state?.records?.length || document.querySelectorAll('#feed .post').length || 0);
}

function emptyCard() {
  const card = el('section', 'studio-empty-hero');
  card.dataset.studioEmpty = 'true';
  const mark = el('div', 'workspace-empty-mark');
  mark.append(icon('window', 'workspace-empty-symbol'));
  const copy = el('div', 'studio-empty-copy');
  copy.append(el('p', 'workspace-eyebrow', 'Your space'), el('h1', '', COPY.emptyTitle), el('p', '', COPY.emptyBody));
  const actions = el('div', 'studio-launch-actions');
  const post = actionWithIcon('feed.post', 'compose', () => window.SidewaysWorkspaceUI?.openComposer?.(), { className: 'studio-launch-button is-post', label: COPY.emptyPost });
  const imports = actionWithIcon('feed.import', 'import', () => routeTo('#/add'), { className: 'studio-launch-button is-import', label: COPY.emptyImport });
  actions.append(post, imports);
  copy.append(actions);
  card.append(mark, copy);
  return card;
}

function feedHeader(count) {
  const header = el('header', 'workspace-feed-header');
  header.dataset.workspaceFeedHeader = String(count);
  const copy = el('div');
  copy.append(el('p', 'workspace-eyebrow', count ? `${count} ${count === 1 ? 'item' : 'items'}` : 'Local feed'), el('h1', '', COPY.feedTitle), el('p', '', COPY.feedSubtitle));
  const actions = el('div', 'workspace-feed-actions');
  actions.append(
    actionWithIcon('feed.post', 'compose', () => window.SidewaysWorkspaceUI?.openComposer?.(), { className: 'workspace-primary', label: 'New post' }),
    actionWithIcon('feed.import', 'import', () => routeTo('#/add'), { className: 'workspace-secondary', label: 'Import' })
  );
  header.append(copy, actions);
  return header;
}

function enhanceFeed() {
  const feed = document.getElementById('feed');
  if (!feed) return;
  const count = recordCount();
  const nativeEmpty = feed.querySelector('.add-empty, .empty');
  if (nativeEmpty) nativeEmpty.classList.add('studio-native-empty');
  const empty = feed.querySelector('[data-studio-empty]');
  const header = feed.querySelector('[data-workspace-feed-header]');
  if (!count && !feed.querySelector('.post')) {
    header?.remove();
    if (!empty) feed.prepend(emptyCard());
  } else {
    empty?.remove();
    if (!header || header.dataset.workspaceFeedHeader !== String(count)) {
      header?.remove();
      feed.prepend(feedHeader(count));
    }
  }
}

function libraryHeader() {
  const header = el('header', 'workspace-library-header');
  header.dataset.workspaceLibraryHeader = 'true';
  const copy = el('div');
  copy.append(el('p', 'workspace-eyebrow', 'Library'), el('h1', '', COPY.libraryTitle), el('p', '', 'Imports stay on this device and enter the same feed as your posts.'));
  const saved = actionWithIcon('library.saved', 'bookmark', () => routeTo('#/saved'), { className: 'workspace-secondary', label: 'Open saved' });
  header.append(copy, saved);
  return header;
}

function enhanceLibrary() {
  const view = document.getElementById('addView');
  if (!view) return;
  if (!view.querySelector('[data-workspace-library-header]')) view.prepend(libraryHeader());
}

function enhanceSaved() {
  const view = document.getElementById('savedView');
  if (!view || view.querySelector('[data-workspace-saved-header]')) return;
  const header = el('header', 'workspace-route-header workspace-saved-header');
  header.dataset.workspaceSavedHeader = 'true';
  const copy = el('div');
  copy.append(el('p', 'workspace-eyebrow', 'Library'), el('h1', '', 'Saved'), el('p', '', 'Things you kept for later.'));
  header.append(copy);
  view.prepend(header);
}

function enhance() {
  document.documentElement.classList.add('studio-product', 'workspace-product');
  document.documentElement.dataset.studioReady = appReady ? 'yes' : 'booting';
  enhanceBrand();
  installNavigation();
  if (!appReady) return;
  enhanceFeed();
  enhanceLibrary();
  enhanceSaved();
}

function scheduleEnhance() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    enhance();
  });
}

function bootEnhancers() {
  scheduleEnhance();
  for (const delay of [80, 280, 900, 1800]) setTimeout(scheduleEnhance, delay);
}

function assertCompatibility() {
  for (const id of STABLE_IDS) {
    if (!document.getElementById(id)) console.error(`[studio] stable DOM hook missing: ${id}`);
  }
  const corpus = `${document.documentElement.innerHTML}\n${window.SidewaysCore ? 'ADD KEEP READ SEND FILES +' : ''}`;
  for (const label of STABLE_LABELS) {
    if (!corpus.includes(label)) console.warn(`[studio] stable phone-test label missing: ${label}`);
  }
}

for (const eventName of ['sideways:feedrender', 'sideways:profilechange', 'sideways:workspacechange', 'sideways:placeschange', 'hashchange', 'popstate']) {
  window.addEventListener(eventName, scheduleEnhance);
}
window.addEventListener('sideways:importcomplete', bootEnhancers);
window.addEventListener('sideways:ready', () => {
  appReady = true;
  bootEnhancers();
  assertCompatibility();
});

function bootStudio() {
  scheduleEnhance();
  if (appReady) {
    bootEnhancers();
    assertCompatibility();
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStudio, { once: true });
else bootStudio();

window.SidewaysStudio = Object.freeze({
  copy: COPY,
  enhance: scheduleEnhance,
  stableLabels: STABLE_LABELS,
  stableIds: STABLE_IDS,
  openPost: () => window.SidewaysWorkspaceUI?.openComposer?.(),
  openProfile: () => window.SidewaysWorkspaceUI?.openProfile?.()
});
