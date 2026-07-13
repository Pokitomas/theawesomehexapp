import { createDefaultRegistry } from './imports/registry.js';
import { createImportRuntime } from './imports/runtime.js';

const registry = createDefaultRegistry();
const runtime = createImportRuntime({ registry, chunkSize: 75 });
const state = { files: [], inspection: null, busy: false };

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

function makeInput({ directory = false } = {}) {
  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
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

const filesInput = makeInput();
const folderInput = makeInput({ directory: true });

async function setFiles(files) {
  if (state.busy) return;
  state.files = [...files].filter(Boolean);
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
  if (!capacity) return 'NO FILES YET';
  if (!capacity.quota) return `${bytes(capacity.requested)} READY`;
  return `${bytes(capacity.requested)} READY · ${bytes(Math.max(0, capacity.remaining))} FREE`;
}

function terminal(label, help, action) {
  const node = button('', 'import-terminal', action);
  node.append(el('strong', '', label), el('span', '', help));
  return node;
}

function importCard() {
  const card = el('section', 'import-workbench-card');
  card.dataset.importWorkbench = 'true';
  const top = el('div', 'import-workbench-top');
  top.append(
    el('span', 'import-workbench-kicker', 'BRING YOUR OWN INTERNET'),
    el('h2', '', 'PUT IN A REAL EXPORT.'),
    el('p', '', 'Pick files from X, Reddit, Mastodon, browser bookmarks, RSS, JSON, CSV, or plain text. Sideways reads them here and writes them into the same local library the feed already uses.')
  );

  const terminals = el('div', 'import-terminal-grid');
  terminals.append(
    terminal('PICK FILES', 'One or many files.', () => filesInput.click()),
    terminal('PICK FOLDER', 'A whole export folder.', () => folderInput.click()),
    terminal('USE NORMAL ADD', 'PDF, Office, images, audio, video, ZIP packs.', () => routeTo('#/add')),
    terminal('OPEN SAVED PACK', 'A Sideways pack you made before.', () => document.getElementById('packPicker')?.click())
  );

  const support = el('div', 'import-support-row');
  for (const adapter of registry.list()) support.append(el('span', '', adapter.label));
  card.append(top, terminals, support);
  return card;
}

function queuePanel() {
  const panel = el('section', 'import-queue-panel');
  const titleRow = el('div', 'import-queue-title');
  titleRow.append(el('div', '', state.files.length ? `${state.files.length} FILES READY` : 'NO FILES YET'), el('span', '', capacityCopy()));
  panel.append(titleRow);

  if (!state.files.length) {
    panel.append(el('p', 'import-empty', 'Pick an export. Nothing is uploaded anywhere.'));
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

  const status = el('div', 'import-live-status', 'READY');
  status.id = 'importLiveStatus';
  const actions = el('div', 'import-actions');
  const clear = button('CLEAR', 'import-secondary', () => setFiles([]));
  const run = button('PUT THEM IN', 'import-primary', () => startImport(status, clear, run));
  actions.append(clear, run);
  panel.append(status, actions);
  return panel;
}

async function startImport(status, clear, run) {
  if (state.busy || !state.files.length) return;
  state.busy = true;
  clear.disabled = true;
  run.textContent = 'STOP';
  const stop = () => runtime.stop();
  run.addEventListener('click', stop, { once: true });

  const onFile = event => { status.textContent = `READING ${event.detail.file.name} · ${event.detail.adapter.label}`; };
  const onProgress = event => { status.textContent = `${event.detail.added} IN · ${event.detail.skipped} SAME · ${event.detail.failed} FAILED`; };
  const onError = event => { status.textContent = `${event.detail.file.name} FAILED · ${event.detail.error.message}`; };
  runtime.addEventListener('file', onFile);
  runtime.addEventListener('progress', onProgress);
  runtime.addEventListener('fileerror', onError);

  try {
    const result = await runtime.import(state.files);
    status.textContent = `DONE · ${result.added} IN · ${result.skipped} SAME · ${result.failed} FAILED`;
    toast(`${result.added} IN${result.skipped ? ` · ${result.skipped} SAME` : ''}`);
    state.files = [];
    state.inspection = null;
    setTimeout(() => location.reload(), 650);
  } catch (error) {
    if (error?.name === 'AbortError') {
      status.textContent = 'STOPPED';
      toast('STOPPED');
    } else {
      status.textContent = error.message || 'IMPORT FAILED';
      toast(error.message || 'IMPORT FAILED', 'error');
    }
    state.busy = false;
    renderPanel();
  } finally {
    runtime.removeEventListener('file', onFile);
    runtime.removeEventListener('progress', onProgress);
    runtime.removeEventListener('fileerror', onError);
  }
}

function renderPanel() {
  const host = document.getElementById('importWorkbenchHost');
  if (!host) return;
  host.replaceChildren(importCard(), queuePanel());
}

function mount() {
  const addView = document.getElementById('addView');
  if (!addView || addView.hidden || document.getElementById('importWorkbenchHost')) return;
  const host = el('div', 'import-workbench');
  host.id = 'importWorkbenchHost';
  addView.append(host);
  renderPanel();
}

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; mount(); });
}

new MutationObserver(schedule).observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
window.addEventListener('hashchange', schedule);
window.addEventListener('sideways:ready', schedule);
window.addEventListener('sideways:feedrender', schedule);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();

window.SidewaysImportWorkbench = Object.freeze({ registry, runtime, open: () => routeTo('#/add'), setFiles });
