import { COPY } from './copy.js';
import { actionButton, bindAction } from './actions.js';

const STABLE_LABELS = Object.freeze(['ADD', 'KEEP', 'READ', 'SEND', 'FILES +']);
const STABLE_IDS = Object.freeze(['corpusStatus', 'debugPolicy', 'debugState', 'debugPanel']);
const PRODUCT_TITLE = 'Sideways';
const PRODUCT_THEME = '#ff5a36';
let scheduled = false;
let appReady = Boolean(window.SidewaysCore?.state?.manifest);

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function setAttribute(node, name, value) {
  if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function routeTo(hash) {
  if (!appReady) {
    window.addEventListener('sideways:ready', () => routeTo(hash), { once: true });
    return;
  }
  if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo(hash);
  else location.hash = hash;
}

function openPost() {
  window.SidewaysSocial?.openComposer?.();
}

function openProfile() {
  window.SidewaysSocial?.openProfile?.();
}

function emptyCard() {
  const card = element('section', 'studio-empty-hero');
  card.dataset.studioEmpty = 'true';
  const top = element('div', 'studio-empty-copy');
  const actions = element('div', 'studio-launch-actions');
  actions.append(
    actionButton('feed.post', openPost, { className: 'studio-launch-button is-post' }),
    actionButton('feed.import', () => routeTo('#/add'), { className: 'studio-launch-button is-import' })
  );
  top.append(element('span', 'studio-local', COPY.ready), element('h1', '', COPY.emptyTitle), actions);
  card.append(top);
  return card;
}

function progressCard(count) {
  const card = element('section', 'studio-progress-card is-awake');
  card.dataset.studioProgress = String(count);
  const actions = element('div', 'studio-progress-actions');
  actions.append(
    actionButton('feed.post', openPost, { className: 'studio-secondary-action' }),
    actionButton('feed.import', () => routeTo('#/add'), { className: 'studio-secondary-action' })
  );
  card.append(
    element('span', 'studio-progress-count', `${count} ${count === 1 ? 'THING' : 'THINGS'}`),
    element('h2', '', COPY.feedAwake),
    actions
  );
  return card;
}

function recordCount() {
  return Number(window.SidewaysCore?.state?.records?.length || document.querySelectorAll('#feed .post').length || 0);
}

function enhanceBrand() {
  setText(document.querySelector('.brand-lockup span'), COPY.brand);
  setAttribute(document.getElementById('navFeed'), 'aria-label', `${COPY.brand}: feed`);
  if (document.title !== PRODUCT_TITLE) document.title = PRODUCT_TITLE;
  setAttribute(document.querySelector('meta[name="theme-color"]'), 'content', PRODUCT_THEME);

  const navFeed = document.getElementById('navFeed');
  const navAdd = document.getElementById('navAdd');
  const navSaved = document.getElementById('navSaved');
  if (navFeed) navFeed.textContent = 'FEED';
  if (navAdd) navAdd.textContent = 'IMPORT';
  if (navSaved) navSaved.textContent = 'SAVED';

  for (const [node, id] of [[navFeed, 'nav.feed'], [navAdd, 'nav.import'], [navSaved, 'nav.saved']]) {
    if (!node || node.dataset.actionBound === 'true') continue;
    node.dataset.actionBound = 'true';
    bindAction(node, id, () => undefined, { payload: { route: node.dataset.route || location.hash } });
  }
}

function enhanceFeed() {
  const feed = document.getElementById('feed');
  if (!feed) return;
  const posts = feed.querySelectorAll('.post').length;
  const socialPosts = feed.querySelectorAll('[data-social-post]').length;
  const nativeEmpty = feed.querySelector('.add-empty, .empty');
  const existingHero = feed.querySelector('[data-studio-empty]');
  const existingProgress = feed.querySelector('[data-studio-progress]');

  if (!posts && !socialPosts && nativeEmpty) {
    nativeEmpty.classList.add('studio-native-empty');
    if (!existingHero) feed.prepend(emptyCard());
    existingProgress?.remove();
    return;
  }

  nativeEmpty?.classList.remove('studio-native-empty');
  existingHero?.remove();
  const total = recordCount() + socialPosts;
  if (total > 0) {
    if (!existingProgress || existingProgress.dataset.studioProgress !== String(total)) {
      existingProgress?.remove();
      feed.prepend(progressCard(total));
    }
  } else existingProgress?.remove();
}

function enhanceViews() {
  const profileView = document.getElementById('profileView');
  if (profileView && !profileView.hidden) setAttribute(profileView, 'aria-label', COPY.profile);
  const savedView = document.getElementById('savedView');
  if (savedView && !savedView.hidden) setAttribute(savedView, 'aria-label', COPY.saved);
}

function enhance() {
  document.documentElement.classList.add('studio-product');
  document.documentElement.dataset.studioReady = appReady ? 'yes' : 'booting';
  enhanceBrand();
  if (!appReady) return;
  enhanceFeed();
  enhanceViews();
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

for (const eventName of ['sideways:feedrender', 'sideways:profilechange', 'hashchange', 'popstate']) {
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
  openProfile
});
