import { COPY } from './copy.js';

const STABLE_LABELS = Object.freeze(['ADD', 'KEEP', 'READ', 'SEND', 'FILES +']);
const STABLE_IDS = Object.freeze(['corpusStatus', 'debugPolicy', 'debugState', 'debugPanel']);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function proofRow() {
  const row = element('div', 'studio-proof-row');
  for (const item of [COPY.localBadge, COPY.addHint, COPY.storage]) {
    row.append(element('span', '', item));
  }
  return row;
}

function introCard() {
  const card = element('section', 'studio-intro');
  card.dataset.studioIntro = 'true';
  card.append(
    element('span', 'studio-kicker', COPY.kicker),
    element('h1', '', COPY.headline),
    element('p', '', COPY.intro),
    proofRow()
  );
  return card;
}

function emptyCard() {
  const card = element('section', 'studio-empty-hero');
  card.dataset.studioEmpty = 'true';
  card.append(
    element('span', 'studio-local', COPY.ready),
    element('h1', '', COPY.emptyTitle),
    element('p', '', COPY.emptyBody),
    proofRow()
  );
  return card;
}

function enhanceBrand() {
  const brand = document.querySelector('.brand-lockup span');
  if (brand) brand.textContent = COPY.brand;
  const navFeed = document.getElementById('navFeed');
  if (navFeed) navFeed.setAttribute('aria-label', `${COPY.brand}: feed`);
  document.title = 'Sideways — Build Your Feed';
  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.content = '#e9ff3f';
}

function enhanceAddView() {
  const addView = document.getElementById('addView');
  if (!addView || addView.hidden || addView.querySelector('[data-studio-intro]')) return;
  addView.prepend(introCard());
}

function enhanceEmptyFeed() {
  const feed = document.getElementById('feed');
  if (!feed || feed.querySelector('[data-studio-empty]')) return;
  const empty = feed.querySelector('.empty');
  const hasPosts = Boolean(feed.querySelector('.post'));
  if (!hasPosts && empty) {
    empty.hidden = true;
    feed.prepend(emptyCard());
  }
}

function enhanceProfile() {
  const profileView = document.getElementById('profileView');
  if (!profileView || profileView.hidden) return;
  if (!profileView.dataset.studioNamed) {
    profileView.dataset.studioNamed = 'true';
    profileView.setAttribute('aria-label', COPY.profile);
  }
}

function enhanceSaved() {
  const savedView = document.getElementById('savedView');
  if (!savedView || savedView.hidden || savedView.dataset.studioNamed) return;
  savedView.dataset.studioNamed = 'true';
  savedView.setAttribute('aria-label', COPY.saved);
}

function assertCompatibility() {
  for (const id of STABLE_IDS) {
    if (!document.getElementById(id)) {
      console.error(`[studio] stable DOM hook missing: ${id}`);
    }
  }
  const visibleText = document.body?.innerText || '';
  for (const label of STABLE_LABELS) {
    if (!visibleText.includes(label)) {
      console.warn(`[studio] stable phone-test label not currently visible: ${label}`);
    }
  }
}

function enhance() {
  document.documentElement.classList.add('studio-product');
  document.documentElement.dataset.studioReady = 'yes';
  enhanceBrand();
  enhanceAddView();
  enhanceEmptyFeed();
  enhanceProfile();
  enhanceSaved();
}

const observer = new MutationObserver(() => queueMicrotask(enhance));
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['hidden']
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    enhance();
    assertCompatibility();
  }, { once: true });
} else {
  enhance();
  assertCompatibility();
}

window.SidewaysStudio = Object.freeze({
  copy: COPY,
  enhance,
  stableLabels: STABLE_LABELS,
  stableIds: STABLE_IDS
});
