import { actionButton } from './actions.js';

const STORAGE_KEY = 'sideways-feed-mode-v1';
const MODES = Object.freeze(['flow', 'stage', 'grid']);
let scheduled = false;
let resizeObserver;
let lastAnchor = '';

function currentMode() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return MODES.includes(stored) ? stored : 'flow';
}

function visibleAnchor() {
  const cards = [...document.querySelectorAll('#feed .post')];
  const viewportTop = Number(getComputedStyle(document.documentElement).getPropertyValue('--future-chrome-height').replace('px', '')) || 0;
  return cards.find(card => {
    const rect = card.getBoundingClientRect();
    return rect.bottom > viewportTop + 12 && rect.top < innerHeight * .72;
  })?.dataset.id || cards[0]?.dataset.id || '';
}

function restoreAnchor(id) {
  if (!id) return;
  requestAnimationFrame(() => {
    document.querySelector(`#feed .post[data-id="${CSS.escape(String(id))}"]`)?.scrollIntoView({ block: 'start' });
  });
}

function setMode(mode, { persist = true, preserve = true } = {}) {
  if (!MODES.includes(mode)) mode = 'flow';
  const anchor = preserve ? visibleAnchor() : '';
  document.documentElement.dataset.feedMode = mode;
  if (persist) localStorage.setItem(STORAGE_KEY, mode);
  for (const button of document.querySelectorAll('[data-feed-mode-button]')) {
    const active = button.dataset.feedModeButton === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (anchor) restoreAnchor(anchor);
  window.dispatchEvent(new CustomEvent('sideways:viewmode', { detail: { mode } }));
  return mode;
}

function modeButton(mode) {
  const id = `view.${mode}`;
  const button = actionButton(id, () => setMode(mode), {
    className: 'future-mode-button',
    label: mode.toUpperCase(),
    payload: { mode }
  });
  button.dataset.feedModeButton = mode;
  button.setAttribute('aria-pressed', 'false');
  return button;
}

function installModeRail() {
  const commandbar = document.querySelector('[data-workspace-commandbar]');
  if (!commandbar) return;
  let rail = commandbar.querySelector('[data-feed-mode-rail]');
  if (!rail) {
    rail = document.createElement('div');
    rail.className = 'future-mode-rail';
    rail.dataset.feedModeRail = 'true';
    rail.setAttribute('role', 'group');
    rail.setAttribute('aria-label', 'Feed layout');
    rail.append(...MODES.map(modeButton));
    commandbar.append(rail);
  }
  setMode(currentMode(), { persist: false, preserve: false });
}

function measureChrome() {
  const topbar = document.querySelector('.topbar');
  const typeNav = document.querySelector('.type-nav');
  const top = topbar?.getBoundingClientRect();
  const tabs = typeNav?.getBoundingClientRect();
  const chromeHeight = Math.max(0, (top?.bottom || 0), (tabs?.bottom || 0));
  document.documentElement.style.setProperty('--future-chrome-height', `${Math.round(chromeHeight)}px`);
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty('--future-visual-top', `${Math.max(0, Math.round(viewport?.offsetTop || 0))}px`);
  document.documentElement.style.setProperty('--future-visual-height', `${Math.round(viewport?.height || innerHeight)}px`);
}

function observeChrome() {
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(measureChrome);
  for (const node of [document.querySelector('.topbar'), document.querySelector('.type-nav')].filter(Boolean)) resizeObserver.observe(node);
  measureChrome();
}

function installGridFocus() {
  const feed = document.getElementById('feed');
  if (!feed || feed.dataset.gridFocusBound) return;
  feed.dataset.gridFocusBound = 'true';
  feed.addEventListener('click', event => {
    if (document.documentElement.dataset.feedMode !== 'grid') return;
    if (event.target.closest('button, a, input, textarea, select, video, audio, iframe')) return;
    const card = event.target.closest('.post');
    if (!card) return;
    const active = card.classList.contains('is-grid-focus');
    for (const other of feed.querySelectorAll('.post.is-grid-focus')) other.classList.remove('is-grid-focus');
    if (!active) {
      card.classList.add('is-grid-focus');
      requestAnimationFrame(() => card.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    }
  });
}

function install() {
  installModeRail();
  installGridFocus();
  observeChrome();
  document.documentElement.dataset.mediaModes = 'ready';
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    install();
  });
}

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'sideways:workspacechange', 'sideways:profilechange', 'hashchange', 'popstate']) {
  window.addEventListener(eventName, schedule);
}
window.visualViewport?.addEventListener('resize', measureChrome);
window.visualViewport?.addEventListener('scroll', measureChrome);
window.addEventListener('resize', measureChrome);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();
for (const delay of [80, 260, 900]) setTimeout(schedule, delay);

window.SidewaysMediaModes = Object.freeze({ setMode, currentMode, modes: MODES });
