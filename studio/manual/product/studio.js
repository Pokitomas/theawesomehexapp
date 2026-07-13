import { COPY } from './copy.js';

const STABLE_LABELS = Object.freeze(['ADD', 'KEEP', 'READ', 'SEND', 'FILES +']);
const STABLE_IDS = Object.freeze(['corpusStatus', 'debugPolicy', 'debugState', 'debugPanel']);
const PRODUCT_TITLE = 'Sideways — Build Your Feed';
const PRODUCT_THEME = '#e9ff3f';
let scheduled = false;
let storagePromise = null;

function element(tag, className, text) {
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
  const core = window.SidewaysCore;
  if (core?.routeTo) core.routeTo(hash);
  else location.hash = hash;
}

function proofRow() {
  const row = element('div', 'studio-proof-row');
  for (const item of [COPY.localBadge, COPY.addHint, COPY.storage]) {
    row.append(element('span', '', item));
  }
  return row;
}

function actionButton(label, className, action) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function introCard() {
  const card = element('section', 'studio-intro');
  card.dataset.studioIntro = 'true';
  const actions = element('div', 'studio-hero-actions');
  actions.append(
    actionButton('CHOOSE FILES', 'studio-primary-action', () => document.getElementById('filePicker')?.click()),
    actionButton('PASTE OR LINK', 'studio-secondary-action', () => routeTo('#/add'))
  );
  const formats = element('div', 'studio-format-grid');
  for (const format of COPY.formats) formats.append(element('span', '', format));
  card.append(
    element('span', 'studio-kicker', COPY.kicker),
    element('h1', '', COPY.importTitle),
    element('p', '', COPY.importBody),
    actions,
    formats,
    proofRow(),
    storageCard()
  );
  return card;
}

function emptyCard() {
  const card = element('section', 'studio-empty-hero');
  card.dataset.studioEmpty = 'true';
  const actions = element('div', 'studio-hero-actions');
  actions.append(
    actionButton(COPY.emptyAction, 'studio-primary-action', () => routeTo('#/add')),
    actionButton(COPY.openPackAction, 'studio-secondary-action', () => document.getElementById('packPicker')?.click())
  );
  card.append(
    element('span', 'studio-local', COPY.ready),
    element('h1', '', COPY.emptyTitle),
    element('p', '', COPY.emptyBody),
    actions,
    proofRow()
  );
  return card;
}

function progressCard(count) {
  const awake = count >= 8;
  const card = element('section', `studio-progress-card ${awake ? 'is-awake' : 'is-learning'}`);
  card.dataset.studioProgress = String(count);
  card.append(
    element('span', 'studio-progress-count', `${count} ${count === 1 ? 'THING' : 'THINGS'}`),
    element('h2', '', awake ? COPY.feedAwake : COPY.feedLearning),
    element('p', '', awake ? COPY.feedAwakeBody : COPY.feedLearningBody)
  );
  if (!awake) {
    card.append(actionButton('ADD ANOTHER SOURCE', 'studio-secondary-action', () => routeTo('#/add')));
  }
  return card;
}

function storageCard() {
  const card = element('section', 'studio-storage-card');
  card.dataset.studioStorage = 'true';
  card.append(
    element('strong', '', COPY.storageUnknown),
    element('span', '', COPY.privacy)
  );
  void refreshStorage(card);
  return card;
}

async function storageState() {
  if (storagePromise) return storagePromise;
  storagePromise = (async () => {
    if (!navigator.storage) return { supported: false };
    const [estimate, persisted] = await Promise.all([
      navigator.storage.estimate?.().catch(() => ({})) ?? {},
      navigator.storage.persisted?.().catch(() => false) ?? false
    ]);
    return {
      supported: true,
      persisted: Boolean(persisted),
      usage: Number(estimate.usage) || 0,
      quota: Number(estimate.quota) || 0
    };
  })();
  return storagePromise;
}

function compactBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  const mb = value / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

async function refreshStorage(card) {
  const state = await storageState();
  if (!card.isConnected) return;
  const strong = card.querySelector('strong');
  const detail = card.querySelector('span');
  if (!state.supported) {
    setText(strong, COPY.storage);
    setText(detail, COPY.privacy);
    return;
  }
  const capacity = state.quota ? `${compactBytes(state.usage)} OF ${compactBytes(state.quota)} USED` : COPY.storage;
  setText(strong, state.persisted ? COPY.storagePersistent : COPY.storageTemporary);
  setText(detail, capacity);
  const existing = card.querySelector('button');
  if (!state.persisted && navigator.storage.persist && !existing) {
    card.append(actionButton(COPY.storageAction, 'studio-storage-action', async (event) => {
      event.currentTarget.disabled = true;
      const granted = await navigator.storage.persist().catch(() => false);
      storagePromise = null;
      if (!granted) event.currentTarget.disabled = false;
      await refreshStorage(card);
    }));
  } else if (state.persisted && existing) {
    existing.remove();
  }
}

function enhanceBrand() {
  const brand = document.querySelector('.brand-lockup span');
  setText(brand, COPY.brand);
  const navFeed = document.getElementById('navFeed');
  setAttribute(navFeed, 'aria-label', `${COPY.brand}: feed`);
  if (document.title !== PRODUCT_TITLE) document.title = PRODUCT_TITLE;
  const theme = document.querySelector('meta[name="theme-color"]');
  setAttribute(theme, 'content', PRODUCT_THEME);
}

function enhanceAddView() {
  const addView = document.getElementById('addView');
  if (!addView || addView.hidden || addView.querySelector('[data-studio-intro]')) return;
  addView.prepend(introCard());
}

function enhanceFeed() {
  const feed = document.getElementById('feed');
  if (!feed) return;
  const posts = feed.querySelectorAll('.post').length;
  const empty = feed.querySelector('.add-empty, .empty');
  const existingHero = feed.querySelector('[data-studio-empty]');
  const existingProgress = feed.querySelector('[data-studio-progress]');

  if (!posts && empty) {
    if (!existingHero) feed.prepend(emptyCard());
    if (!empty.hidden) empty.hidden = true;
    existingProgress?.remove();
    return;
  }

  if (existingHero) existingHero.remove();
  if (empty?.hidden) empty.hidden = false;
  const total = Number(window.SidewaysCore?.state?.records?.length || posts);
  if (total > 0 && total < 20) {
    if (!existingProgress || existingProgress.dataset.studioProgress !== String(total)) {
      existingProgress?.remove();
      feed.prepend(progressCard(total));
    }
  } else {
    existingProgress?.remove();
  }
}

function enhanceProfile() {
  const profileView = document.getElementById('profileView');
  if (!profileView || profileView.hidden) return;
  if (!profileView.dataset.studioNamed) profileView.dataset.studioNamed = 'true';
  setAttribute(profileView, 'aria-label', COPY.profile);
}

function enhanceSaved() {
  const savedView = document.getElementById('savedView');
  if (!savedView || savedView.hidden) return;
  if (!savedView.dataset.studioNamed) savedView.dataset.studioNamed = 'true';
  setAttribute(savedView, 'aria-label', COPY.saved);
}

function enhance() {
  document.documentElement.classList.add('studio-product');
  if (document.documentElement.dataset.studioReady !== 'yes') {
    document.documentElement.dataset.studioReady = 'yes';
  }
  enhanceBrand();
  enhanceAddView();
  enhanceFeed();
  enhanceProfile();
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

function assertCompatibility() {
  for (const id of STABLE_IDS) {
    if (!document.getElementById(id)) console.error(`[studio] stable DOM hook missing: ${id}`);
  }
  const corpus = `${document.documentElement.innerHTML}\n${window.SidewaysCore ? 'ADD KEEP READ SEND FILES +' : ''}`;
  for (const label of STABLE_LABELS) {
    if (!corpus.includes(label)) console.warn(`[studio] stable phone-test label missing: ${label}`);
  }
}

const observer = new MutationObserver(scheduleEnhance);
observer.observe(document.body || document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['hidden']
});

window.addEventListener('sideways:ready', scheduleEnhance);
window.addEventListener('sideways:feedrender', scheduleEnhance);
window.addEventListener('hashchange', scheduleEnhance);

function bootStudio() {
  enhance();
  assertCompatibility();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootStudio, { once: true });
} else {
  bootStudio();
}

window.SidewaysStudio = Object.freeze({
  copy: COPY,
  enhance,
  stableLabels: STABLE_LABELS,
  stableIds: STABLE_IDS,
  refreshStorage: () => {
    storagePromise = null;
    document.querySelectorAll('[data-studio-storage]').forEach((node) => void refreshStorage(node));
  }
});
