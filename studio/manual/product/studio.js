import { COPY } from './copy.js';
import { actionButton } from './actions.js';

const STABLE_LABELS = Object.freeze(['ADD', 'KEEP', 'READ', 'SEND', 'FILES +']);
const STABLE_IDS = Object.freeze(['corpusStatus', 'debugPolicy', 'debugState', 'debugPanel']);
const PRODUCT_TITLE = 'Sideways';
const PRODUCT_THEME = '#0a84ff';
let scheduled = false;
let appReady = Boolean(window.SidewaysCore?.state?.manifest);

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setAttribute(node, name, value) {
  if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function openPost() {
  window.SidewaysSocial?.openComposer?.();
}

function openImport() {
  if (window.SidewaysShell?.showCreate) window.SidewaysShell.showCreate();
  else if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo('#/add');
  else location.hash = '#/add';
}

function emptyCard() {
  const card = element('section', 'studio-empty-hero');
  card.dataset.studioEmpty = 'true';
  const body = element('div', 'studio-empty-copy');
  const actions = element('div', 'studio-launch-actions');
  actions.append(
    actionButton('create.post', openPost, { className: 'studio-launch-button is-post' }),
    actionButton('create.import', openImport, { className: 'studio-launch-button is-import' })
  );
  body.append(element('span', 'studio-local', COPY.ready), element('h1', '', COPY.emptyTitle), actions);
  card.append(body);
  return card;
}

function progressCard(count) {
  const card = element('section', 'studio-progress-card');
  card.dataset.studioProgress = String(count);
  const actions = element('div', 'studio-progress-actions');
  actions.append(
    actionButton('create.post', openPost, { className: 'ui-button', label: 'Post' }),
    actionButton('nav.places', () => window.SidewaysShell?.openPlaces?.(), { className: 'ui-button', label: 'Places' })
  );
  card.append(
    element('span', 'studio-progress-count', `${count} ${count === 1 ? 'item' : 'items'}`),
    element('h2', '', COPY.feedAwake),
    actions
  );
  return card;
}

function recordCount() {
  return Number(window.SidewaysCore?.state?.records?.length || document.querySelectorAll('#feed .post').length || 0);
}

function enhanceBrand() {
  if (document.title !== PRODUCT_TITLE) document.title = PRODUCT_TITLE;
  setAttribute(document.querySelector('meta[name="theme-color"]'), 'content', PRODUCT_THEME);
  setAttribute(document.getElementById('navFeed'), 'aria-label', 'Sideways feed');
}

function enhanceFeed() {
  const feed = document.getElementById('feed');
  if (!feed) return;
  const corePosts = feed.querySelectorAll('.post').length;
  const socialPosts = feed.querySelectorAll('[data-social-post]').length;
  const nativeEmpty = feed.querySelector('.add-empty, .empty');
  const existingHero = feed.querySelector('[data-studio-empty]');
  const existingProgress = feed.querySelector('[data-studio-progress]');
  const coreTotal = recordCount();

  nativeEmpty?.classList.add('studio-native-empty');

  if (!corePosts && !socialPosts && coreTotal === 0 && nativeEmpty) {
    if (!existingHero) feed.prepend(emptyCard());
    existingProgress?.remove();
    return;
  }

  existingHero?.remove();
  const total = coreTotal + socialPosts;
  if (total > 0) {
    if (!existingProgress || existingProgress.dataset.studioProgress !== String(total)) {
      existingProgress?.remove();
      feed.prepend(progressCard(total));
    }
  } else existingProgress?.remove();
}

function enhance() {
  document.documentElement.classList.add('studio-product');
  document.documentElement.dataset.studioReady = appReady ? 'yes' : 'booting';
  enhanceBrand();
  if (!appReady) return;
  enhanceFeed();
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

for (const eventName of ['sideways:feedrender', 'sideways:profilechange', 'sideways:workspacechange', 'hashchange', 'popstate']) {
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
  openPost,
  openImport
});
