import { COPY } from './copy.js';
import { createDefaultRegistry } from './imports/registry.js';
import { createImportRuntime } from './imports/runtime.js';

const registry = createDefaultRegistry();
const runtime = createImportRuntime({ registry, chunkSize: 75 });
const state = { files: [], inspection: null, busy: false, platform: '', result: null };

const PLATFORMS = Object.freeze([
  {
    id: 'reddit', name: 'Reddit', mark: 'r/', tone: 'orange',
    description: 'Posts, comments, saved links, and the communities you actually spent time in.',
    exportUrl: 'https://www.reddit.com/settings/data-request',
    action: 'GET REDDIT DATA', accept: '.json,.csv,.zip,text/csv,application/json'
  },
  {
    id: 'instagram', name: 'Instagram', mark: '◎', tone: 'pink',
    description: 'Saved posts, likes, comments, captions, follows, and your own media history.',
    exportUrl: 'https://accountscenter.instagram.com/info_and_permissions/dyi/',
    action: 'GET INSTAGRAM DATA', accept: '.json,.html,.zip,application/json,text/html'
  },
  {
    id: 'tiktok', name: 'TikTok', mark: '♪', tone: 'cyan',
    description: 'Watch history, likes, favorites, comments, searches, and posted videos.',
    exportUrl: 'https://www.tiktok.com/setting/download-your-data',
    action: 'GET TIKTOK DATA', accept: '.json,.txt,.zip,application/json,text/plain'
  },
  {
    id: 'youtube', name: 'YouTube', mark: '▶', tone: 'red',
    description: 'Watch history, searches, subscriptions, playlists, likes, and comments.',
    exportUrl: 'https://takeout.google.com/settings/takeout/custom/youtube',
    action: 'OPEN GOOGLE TAKEOUT', accept: '.json,.html,.csv,.zip,application/json,text/html,text/csv'
  },
  {
    id: 'spotify', name: 'Spotify', mark: '≋', tone: 'green',
    description: 'Listening history and playlists—the clearest map of your taste outside text.',
    exportUrl: 'https://www.spotify.com/account/privacy/',
    action: 'GET SPOTIFY DATA', accept: '.json,.zip,application/json'
  },
  {
    id: 'x', name: 'X / Twitter', mark: 'X', tone: 'black',
    description: 'Posts, likes, bookmarks, follows, and links from your account archive.',
    exportUrl: 'https://x.com/settings/download_your_data',
    action: 'GET X ARCHIVE', accept: '.js,.json,.zip,application/json,text/javascript'
  },
  {
    id: 'browser', name: 'Bookmarks', mark: '★', tone: 'yellow',
    description: 'The links you deliberately kept across Chrome, Safari, Firefox, or Edge.',
    exportUrl: '', action: 'EXPORT FROM YOUR BROWSER', accept: '.html,.htm,text/html'
  },
  {
    id: 'anything', name: 'Anything else', mark: '+', tone: 'violet',
    description: 'PDFs, notes, screenshots, documents, folders, JSON, CSV, RSS, or plain text.',
    exportUrl: '', action: 'CHOOSE ANY FILES', accept: ''
  }
]);

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function bytes(value) {
  const amount = Number(value) || 0;
  if (amount < 1024) return `${amount} B`;
  if (amount < 1024 ** 2) return `${(amount / 1024).toFixed(amount < 10240 ? 1 : 0)} KB`;
  if (amount < 1024 ** 3) return `${(amount / 1024 ** 2).toFixed(amount < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(amount / 1024 ** 3).toFixed(1)} GB`;
}

function button(label, className, action) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function toast(message, kind = 'info') {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const node = el('div', `toast toast-${kind}`, message);
  host.append(node);
  requestAnimationFrame(() => node.classList.add('on'));
  setTimeout(() => { node.classList.remove('on'); setTimeout(() => node.remove(), 220); }, 2600);
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

function makeInput({ directory = false, id = '' } = {}) {
  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  if (id) input.id = id;
  if (directory) {
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }
  input.addEventListener('change', async () => {
    await setFiles(input.files || []);
    input.value = '';
  });
  document.body.append(input);
  return input;
}

const filesInput = makeInput({ id: 'sidewaysImportFiles' });
const folderInput = makeInput({ directory: true, id: 'sidewaysImportFolder' });

function configureFiles(platform) {
  state.platform = platform.id;
  filesInput.accept = platform.accept || '';
}

function chooseFiles(platform) {
  configureFiles(platform);
  if (typeof filesInput.showPicker === 'function') filesInput.showPicker();
  else filesInput.click();
}

function platformFileControl(platform) {
  const control = el('label', 'source-choose', platform.id === 'anything' ? 'CHOOSE FILES' : 'I HAVE THE FILES');
  control.htmlFor = filesInput.id;
  control.setAttribute('role', 'button');
  control.tabIndex = 0;
  control.addEventListener('pointerdown', () => configureFiles(platform));
  control.addEventListener('click', () => configureFiles(platform));
  control.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chooseFiles(platform);
    }
  });
  return control;
}

async function setFiles(files) {
  if (state.busy) return;
  state.files = [...files].filter(Boolean);
  state.result = null;
  state.inspection = state.files.length ? await runtime.inspect(state.files) : null;
  renderPanel();
}

function adapterSummary() {
  const counts = new Map();
  for (const item of state.inspection?.files || []) counts.set(item.adapter.label, (counts.get(item.adapter.label) || 0) + 1);
  return [...counts.entries()].map(([label, count]) => `${label} · ${count}`).join('\n');
}

function capacityCopy() {
  const capacity = state.inspection?.capacity;
  if (!capacity) return 'NOTHING SELECTED';
  if (!capacity.quota) return `${bytes(capacity.requested)} SELECTED`;
  return `${bytes(capacity.requested)} SELECTED · ${bytes(Math.max(0, capacity.remaining))} FREE`;
}

function platformCard(platform) {
  const card = el('article', `source-card source-${platform.tone}${state.platform === platform.id ? ' is-selected' : ''}`);
  card.dataset.platform = platform.id;
  card.dataset.sourceOption = platform.id;
  const head = el('div', 'source-card-head');
  head.append(el('span', 'source-mark', platform.mark), el('h3', '', platform.name));
  const copy = el('p', '', platform.description);
  const actions = el('div', 'source-card-actions');
  if (platform.exportUrl) {
    const exportButton = button(platform.action, 'source-link', () => window.open(platform.exportUrl, '_blank', 'noopener,noreferrer'));
    exportButton.setAttribute('aria-label', `${platform.action} in a new tab`);
    actions.append(exportButton);
  } else if (platform.id === 'browser') {
    actions.append(el('span', 'source-tip', 'Use your browser’s bookmark export, then choose the HTML file.'));
  }
  actions.append(platformFileControl(platform));
  card.append(head, copy, actions);
  return card;
}

function sourceChooser() {
  const section = el('section', 'source-chooser');
  section.dataset.onboardingSource = 'true';
  const intro = el('div', 'source-chooser-copy');
  intro.append(
    el('span', 'import-workbench-kicker', 'START WITH ONE'),
    el('h2', '', COPY.chooseSource),
    el('p', '', COPY.chooseSourceBody)
  );
  const grid = el('div', 'source-card-grid');
  for (const platform of PLATFORMS) grid.append(platformCard(platform));
  section.append(intro, grid);
  return section;
}

function advancedFiles() {
  const section = el('section', 'import-advanced');
  const copy = el('div');
  copy.append(el('strong', '', 'ALREADY HAVE A FOLDER OR A MIX OF FILES?'), el('span', '', 'Choose them directly. Sideways detects the format automatically.'));
  const actions = el('div', 'import-advanced-actions');
  const fileButton = button('', 'import-terminal', () => chooseFiles(PLATFORMS.at(-1)));
  fileButton.dataset.importTerminal = 'files';
  fileButton.append(el('strong', '', 'PICK FILES'), el('span', '', 'One or many files.'));
  const folderButton = button('', 'import-terminal', () => {
    state.platform = 'anything';
    if (typeof folderInput.showPicker === 'function') folderInput.showPicker();
    else folderInput.click();
  });
  folderButton.dataset.importTerminal = 'folder';
  folderButton.append(el('strong', '', 'PICK FOLDER'), el('span', '', 'A full export folder.'));
  actions.append(fileButton, folderButton);
  section.append(copy, actions);
  return section;
}

function importCard() {
  const card = el('section', 'import-workbench-card');
  card.dataset.importWorkbench = 'true';
  card.append(sourceChooser(), advancedFiles());
  return card;
}

function completionPanel() {
  const panel = el('section', 'import-complete-panel');
  const result = state.result || { added: 0, skipped: 0, failed: 0 };
  panel.append(
    el('span', 'import-workbench-kicker', 'DONE'),
    el('h2', '', COPY.importDone),
    el('p', '', `${result.added} new ${result.added === 1 ? 'item' : 'items'} added${result.skipped ? ` · ${result.skipped} duplicates skipped` : ''}${result.failed ? ` · ${result.failed} files need another look` : ''}.`),
    button(COPY.importOpen, 'import-primary import-open-feed', () => location.assign(cleanFeedURL()))
  );
  return panel;
}

function queuePanel() {
  if (state.result) return completionPanel();
  const panel = el('section', 'import-queue-panel');
  const titleRow = el('div', 'import-queue-title');
  titleRow.append(el('div', '', state.files.length ? `${state.files.length} ${state.files.length === 1 ? 'FILE' : 'FILES'} READY` : 'YOUR SELECTION'), el('span', '', capacityCopy()));
  panel.append(titleRow);

  if (!state.files.length) {
    panel.append(el('p', 'import-empty', COPY.queueEmpty));
    return panel;
  }

  const list = el('ul', 'import-file-list');
  for (const item of state.inspection.files.slice(0, 80)) {
    const row = el('li');
    const copy = el('div');
    copy.append(el('strong', '', item.file.webkitRelativePath || item.file.name), el('span', '', `${item.adapter.label} · ${bytes(item.size)}`));
    row.append(copy);
    list.append(row);
  }
  if (state.files.length > 80) list.append(el('li', 'import-more', `+ ${state.files.length - 80} MORE`));
  panel.append(list);

  const found = adapterSummary();
  if (found) panel.append(el('pre', 'import-adapter-summary', found));

  const status = el('div', 'import-live-status', COPY.importReady);
  status.id = 'importLiveStatus';
  const actions = el('div', 'import-actions');
  const clear = button('CHOOSE DIFFERENT FILES', 'import-secondary', () => setFiles([]));
  const run = button(COPY.importRun, 'import-primary', () => {
    if (state.busy) runtime.stop();
    else void startImport(status, clear, run);
  });
  actions.append(clear, run);
  panel.append(status, actions);
  return panel;
}

async function startImport(status, clear, run) {
  if (state.busy || !state.files.length) return;
  state.busy = true;
  clear.disabled = true;
  run.textContent = 'STOP IMPORT';

  const onFile = event => { status.textContent = `READING ${event.detail.file.name}`; };
  const onProgress = event => { status.textContent = `${event.detail.added} ADDED · ${event.detail.skipped} DUPLICATES · ${event.detail.failed} FAILED`; };
  const onError = event => { status.textContent = `${event.detail.file.name} COULD NOT BE READ`; };
  runtime.addEventListener('file', onFile);
  runtime.addEventListener('progress', onProgress);
  runtime.addEventListener('fileerror', onError);

  try {
    state.result = await runtime.import(state.files);
    state.files = [];
    state.inspection = null;
    toast(`${state.result.added} ADDED TO YOUR FEED`);
    window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: state.result }));
    renderPanel();
  } catch (error) {
    if (error?.name === 'AbortError') {
      status.textContent = 'IMPORT STOPPED';
      toast('IMPORT STOPPED');
    } else {
      status.textContent = error.message || 'IMPORT FAILED';
      toast(error.message || 'IMPORT FAILED', 'error');
    }
    renderPanel();
  } finally {
    state.busy = false;
    runtime.removeEventListener('file', onFile);
    runtime.removeEventListener('progress', onProgress);
    runtime.removeEventListener('fileerror', onError);
  }
}

function renderPanel() {
  const host = document.getElementById('importWorkbenchHost');
  if (!host) return;
  host.replaceChildren(importCard(), queuePanel());
  window.dispatchEvent(new CustomEvent('sideways:importworkbench'));
}

function mount() {
  const addView = document.getElementById('addView');
  if (!addView || addView.hidden) return false;
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

function clearRetryTimers() {
  for (const timer of retryTimers) clearTimeout(timer);
  retryTimers = [];
}

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

for (const eventName of ['hashchange', 'popstate', 'sideways:ready', 'sideways:feedrender']) {
  window.addEventListener(eventName, schedule);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootMount, { once: true });
else bootMount();

window.SidewaysImportWorkbench = Object.freeze({
  registry,
  runtime,
  platforms: PLATFORMS,
  open: () => routeTo('#/add'),
  setFiles,
  mount: schedule
});
