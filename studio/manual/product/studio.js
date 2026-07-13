import { COPY } from './copy.js';

const STABLE_LABELS = Object.freeze(['ADD', 'KEEP', 'READ', 'SEND', 'FILES +']);
const STABLE_IDS = Object.freeze(['corpusStatus', 'debugPolicy', 'debugState', 'debugPanel']);
const PROFILE_KEY = 'sideways-local-profile-v1';
const PRODUCT_TITLE = 'Sideways — Your history, recomposed';
const PRODUCT_THEME = '#ff5a36';
let scheduled = false;
let storagePromise = null;

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
  if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo(hash);
  else location.hash = hash;
}

function readProfile() {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    return {
      name: String(value.name || '').slice(0, 80),
      handle: String(value.handle || '').replace(/^@/, '').slice(0, 48)
    };
  } catch {
    return { name: '', handle: '' };
  }
}

function writeProfile(profile) {
  const clean = {
    name: String(profile.name || '').trim().slice(0, 80),
    handle: String(profile.handle || '').trim().replace(/^@/, '').slice(0, 48)
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(clean));
  window.dispatchEvent(new CustomEvent('sideways:profilelocal', { detail: clean }));
  return clean;
}

function proofRow() {
  const row = element('div', 'studio-proof-row');
  for (const item of [COPY.localBadge, COPY.privacy]) row.append(element('span', '', item));
  return row;
}

function actionButton(label, className, action) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function profileSetup() {
  const profile = readProfile();
  const form = element('form', 'studio-profile-setup');
  form.dataset.studioProfileSetup = 'true';

  const heading = element('div', 'studio-profile-copy');
  heading.append(
    element('span', 'studio-step-label', '1 OF 2'),
    element('h2', '', profile.name ? `WELCOME BACK, ${profile.name}.` : COPY.profileTitle),
    element('p', '', COPY.profileBody)
  );

  const fields = element('div', 'studio-profile-fields');
  const nameLabel = element('label', 'studio-field');
  nameLabel.append(element('span', '', COPY.profileName));
  const name = element('input');
  name.name = 'name';
  name.autocomplete = 'name';
  name.placeholder = 'Kai';
  name.value = profile.name;
  name.maxLength = 80;
  nameLabel.append(name);

  const handleLabel = element('label', 'studio-field');
  handleLabel.append(element('span', '', COPY.profileHandle));
  const handle = element('input');
  handle.name = 'handle';
  handle.autocomplete = 'username';
  handle.placeholder = '@you';
  handle.value = profile.handle ? `@${profile.handle}` : '';
  handle.maxLength = 49;
  handleLabel.append(handle);
  fields.append(nameLabel, handleLabel);

  const persistDraft = () => writeProfile({ name: name.value, handle: handle.value });
  name.addEventListener('input', persistDraft);
  handle.addEventListener('input', persistDraft);
  form.addEventListener('change', persistDraft);

  const actions = element('div', 'studio-hero-actions');
  const submit = actionButton(COPY.profileSave, 'studio-primary-action', () => persistDraft());
  submit.type = 'submit';
  submit.dataset.onboardingStart = 'true';
  const skip = actionButton(COPY.profileSkip, 'studio-secondary-action', () => routeTo('#/add'));
  actions.append(submit, skip);

  form.addEventListener('submit', event => {
    event.preventDefault();
    persistDraft();
    routeTo('#/add');
  });

  form.append(heading, fields, actions);
  return form;
}

function introCard() {
  const card = element('section', 'studio-intro');
  card.dataset.studioIntro = 'true';
  const header = element('div', 'studio-intro-copy');
  header.append(
    element('span', 'studio-step-label', '2 OF 2'),
    element('h1', '', COPY.importTitle),
    element('p', '', COPY.importBody)
  );
  card.append(header, proofRow(), storageCard());
  return card;
}

function emptyCard() {
  const card = element('section', 'studio-empty-hero');
  card.dataset.studioEmpty = 'true';
  const top = element('div', 'studio-empty-copy');
  top.append(
    element('span', 'studio-local', COPY.ready),
    element('h1', '', COPY.emptyTitle),
    element('p', '', COPY.emptyBody)
  );
  card.append(top, profileSetup(), proofRow());
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
  if (!awake) card.append(actionButton('ADD ANOTHER APP', 'studio-secondary-action', () => routeTo('#/add')));
  return card;
}

function storageCard() {
  const card = element('section', 'studio-storage-card');
  card.dataset.studioStorage = 'true';
  card.append(element('strong', '', COPY.storageUnknown), element('span', '', COPY.privacy));
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
    card.append(actionButton(COPY.storageAction, 'studio-storage-action', async event => {
      event.currentTarget.disabled = true;
      const granted = await navigator.storage.persist().catch(() => false);
      storagePromise = null;
      if (!granted) event.currentTarget.disabled = false;
      await refreshStorage(card);
    }));
  } else if (state.persisted && existing) existing.remove();
}

function enhanceBrand() {
  setText(document.querySelector('.brand-lockup span'), COPY.brand);
  setAttribute(document.getElementById('navFeed'), 'aria-label', `${COPY.brand}: feed`);
  if (document.title !== PRODUCT_TITLE) document.title = PRODUCT_TITLE;
  setAttribute(document.querySelector('meta[name="theme-color"]'), 'content', PRODUCT_THEME);
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
  const nativeEmpty = feed.querySelector('.add-empty, .empty');
  const existingHero = feed.querySelector('[data-studio-empty]');
  const existingProgress = feed.querySelector('[data-studio-progress]');

  if (!posts && nativeEmpty) {
    nativeEmpty.classList.add('studio-native-empty');
    if (!existingHero) feed.prepend(emptyCard());
    existingProgress?.remove();
    return;
  }

  nativeEmpty?.classList.remove('studio-native-empty');
  existingHero?.remove();
  const total = Number(window.SidewaysCore?.state?.records?.length || posts);
  if (total > 0 && total < 20) {
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
  document.documentElement.dataset.studioReady = 'yes';
  enhanceBrand();
  enhanceAddView();
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

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'hashchange', 'popstate']) {
  window.addEventListener(eventName, scheduleEnhance);
}
window.addEventListener('sideways:importcomplete', bootEnhancers);

function bootStudio() {
  bootEnhancers();
  assertCompatibility();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStudio, { once: true });
else bootStudio();

window.SidewaysStudio = Object.freeze({
  copy: COPY,
  enhance: scheduleEnhance,
  stableLabels: STABLE_LABELS,
  stableIds: STABLE_IDS,
  profile: { read: readProfile, write: writeProfile },
  refreshStorage: () => {
    storagePromise = null;
    document.querySelectorAll('[data-studio-storage]').forEach(node => void refreshStorage(node));
  }
});
