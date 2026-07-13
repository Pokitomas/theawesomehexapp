import { COPY } from './copy.js';
import { actionButton, bindAction } from './actions.js';
import { createDefaultRegistry } from './imports/registry.js';
import { createImportRuntime } from './imports/runtime.js';

const registry = createDefaultRegistry();
const runtime = createImportRuntime({ registry, chunkSize: 75 });
const state = { busy: false, platform: '', result: null, error: '' };

const PLATFORMS = Object.freeze([
  { id: 'instagram', name: 'Instagram', mark: '◎', tone: 'pink', exportUrl: 'https://accountscenter.instagram.com/info_and_permissions/dyi/', accept: '.json,.html,.zip,application/json,text/html' },
  { id: 'reddit', name: 'Reddit', mark: 'r/', tone: 'orange', exportUrl: 'https://www.reddit.com/settings/data-request', accept: '.json,.csv,.zip,text/csv,application/json' },
  { id: 'tiktok', name: 'TikTok', mark: '♪', tone: 'cyan', exportUrl: 'https://www.tiktok.com/setting/download-your-data', accept: '.json,.txt,.zip,application/json,text/plain' },
  { id: 'youtube', name: 'YouTube', mark: '▶', tone: 'red', exportUrl: 'https://takeout.google.com/settings/takeout/custom/youtube', accept: '.json,.html,.csv,.zip,application/json,text/html,text/csv' },
  { id: 'spotify', name: 'Spotify', mark: '≋', tone: 'green', exportUrl: 'https://www.spotify.com/account/privacy/', accept: '.json,.zip,application/json' },
  { id: 'x', name: 'X', mark: 'X', tone: 'black', exportUrl: 'https://x.com/settings/download_your_data', accept: '.js,.json,.zip,application/json,text/javascript' },
  { id: 'browser', name: 'Bookmarks', mark: '★', tone: 'yellow', exportUrl: '', accept: '.html,.htm,text/html' },
  { id: 'anything', name: 'Anything', mark: '+', tone: 'violet', exportUrl: '', accept: '' }
]);

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function routeTo(hash) {
  if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo(hash);
  else location.hash = hash;
}

function cleanFeedURL() {
  const target = new URL(location.href);
  for (const key of ['test', 'autorun']) target.searchParams.delete(key);
  target.hash = '#/feed';
  return target.href;
}

function makeInput() {
  const input = el('input');
  input.id = 'sidewaysImportFiles';
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  input.addEventListener('change', async () => {
    const chosen = [...(input.files || [])];
    input.value = '';
    if (chosen.length) await importChosen(chosen);
  });
  document.body.append(input);
  return input;
}

const filesInput = makeInput();

function platformById(id) {
  return PLATFORMS.find(platform => platform.id === id) || PLATFORMS.at(-1);
}

function configureInput(platform) {
  state.platform = platform.id;
  filesInput.accept = platform.accept || '';
}

function openPicker(platform) {
  configureInput(platform);
  if (typeof filesInput.showPicker === 'function') filesInput.showPicker();
  else filesInput.click();
}

function importControl(platform) {
  const id = `import.${platform.id}`;
  const label = el('label', 'source-import', window.SidewaysActions.action(id).label);
  label.htmlFor = filesInput.id;
  label.setAttribute('role', 'button');
  label.tabIndex = 0;
  bindAction(label, id, () => configureInput(platform), { eventName: 'pointerdown', payload: { platform: platform.id } });
  label.addEventListener('click', () => configureInput(platform));
  label.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker(platform);
    }
  });
  return label;
}

function helpControl(platform) {
  if (!platform.exportUrl) return null;
  return actionButton('import.help', () => window.open(platform.exportUrl, '_blank', 'noopener,noreferrer'), {
    className: 'source-help',
    label: '?',
    ariaLabel: `Get ${platform.name} download`,
    payload: { platform: platform.id }
  });
}

function waitForCoreRefresh() {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('sideways:corpusrefresh', onRefresh);
      window.removeEventListener('sideways:corpusrefresherror', onError);
    };
    const onRefresh = event => { cleanup(); resolve(event.detail || {}); };
    const onError = event => { cleanup(); reject(new Error(event.detail?.message || 'REFRESH FAILED')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('REFRESH FAILED')); }, 10000);
    window.addEventListener('sideways:corpusrefresh', onRefresh, { once: true });
    window.addEventListener('sideways:corpusrefresherror', onError, { once: true });
  });
}

async function importChosen(chosen) {
  if (state.busy || !chosen.length) return;
  state.busy = true;
  state.result = null;
  state.error = '';
  renderPanel();

  try {
    state.result = await runtime.import(chosen);
    const refreshed = waitForCoreRefresh();
    window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: state.result }));
    await refreshed;
  } catch (error) {
    state.error = error?.name === 'AbortError' ? 'STOPPED' : (error?.message || 'TRY AGAIN');
  } finally {
    state.busy = false;
    renderPanel();
  }
}

function platformCard(platform) {
  const card = el('article', `source-card source-${platform.tone}${state.platform === platform.id ? ' is-selected' : ''}`);
  card.dataset.platform = platform.id;
  card.dataset.sourceOption = platform.id;
  const head = el('div', 'source-card-head');
  head.append(el('span', 'source-mark', platform.mark), el('h3', '', platform.name));
  const actions = el('div', 'source-card-actions');
  actions.append(importControl(platform));
  const help = helpControl(platform);
  if (help) actions.append(help);
  card.append(head, actions);
  return card;
}

function sourceChooser() {
  const section = el('section', 'source-chooser');
  section.dataset.onboardingSource = 'true';
  const intro = el('div', 'source-chooser-copy');
  intro.append(el('h2', '', COPY.importTitle));
  const grid = el('div', 'source-card-grid');
  for (const platform of PLATFORMS) grid.append(platformCard(platform));
  section.append(intro, grid);
  return section;
}

function importCard() {
  const card = el('section', 'import-workbench-card');
  card.dataset.importWorkbench = 'true';
  card.append(sourceChooser());
  return card;
}

function statusPanel() {
  const platform = platformById(state.platform);
  if (state.busy) {
    const panel = el('section', 'import-progress-panel');
    panel.append(el('span', 'import-workbench-kicker', platform.name.toUpperCase()), el('h2', '', COPY.importBusy), actionButton('import.stop', () => runtime.stop(), { className: 'import-secondary' }));
    return panel;
  }
  if (state.error) {
    const panel = el('section', 'import-error-panel');
    panel.append(el('span', 'import-workbench-kicker', platform.name.toUpperCase()), el('h2', '', state.error), actionButton('import.retry', () => openPicker(platform), { className: 'import-primary' }));
    return panel;
  }
  if (state.result) {
    const panel = el('section', 'import-complete-panel');
    const count = Number(state.result.added || 0);
    panel.append(
      el('span', 'import-workbench-kicker', platform.name.toUpperCase()),
      el('h2', '', COPY.importDone),
      el('strong', 'import-result-count', `${count}`),
      actionButton('import.open_feed', () => location.assign(cleanFeedURL()), { className: 'import-primary import-open-feed' })
    );
    return panel;
  }
  return null;
}

function renderPanel() {
  const host = document.getElementById('importWorkbenchHost');
  if (!host) return;
  host.replaceChildren(statusPanel() || importCard());
  window.dispatchEvent(new CustomEvent('sideways:importworkbench'));
}

function mount() {
  const addView = document.getElementById('addView');
  if (!addView || addView.hidden) return false;
  addView.classList.add('studio-add-modern');
  let host = document.getElementById('importWorkbenchHost');
  if (!host) {
    host = el('div', 'import-workbench');
    host.id = 'importWorkbenchHost';
    addView.append(host);
    renderPanel();
  }
  return true;
}

let scheduled = false;
let retryTimers = [];
function clearRetryTimers() { for (const timer of retryTimers) clearTimeout(timer); retryTimers = []; }
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (mount()) clearRetryTimers();
  });
}
function bootMount() {
  schedule();
  retryTimers = [80, 280, 900, 1800].map(delay => setTimeout(schedule, delay));
}

for (const eventName of ['hashchange', 'popstate', 'sideways:ready', 'sideways:feedrender']) window.addEventListener(eventName, schedule);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootMount, { once: true });
else bootMount();

window.SidewaysImportWorkbench = Object.freeze({ registry, runtime, platforms: PLATFORMS, open: () => routeTo('#/add'), setFiles: importChosen, mount: schedule });
