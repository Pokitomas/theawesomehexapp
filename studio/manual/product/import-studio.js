import { createDefaultRegistry } from './imports/registry.js';
import { createImportRuntime } from './imports/runtime.js';
import { classifyAddInput, createSourceCollection, safePublicURL } from './discovery-source.js';
import { connectionCapability, providerCatalog } from './account-connections.js';
import { Survival } from './survival-ledger.js';

const registry = createDefaultRegistry();
const runtime = createImportRuntime({ registry, chunkSize: 75 });
const SOURCE_KEY = 'sideways:web-sources:v1';
const state = { busy: false, mode: 'home', result: null, error: '', detail: '' };

const LEGACY_PLATFORMS = Object.freeze([
  { id: 'instagram', name: 'Instagram' }, { id: 'reddit', name: 'Reddit' }, { id: 'tiktok', name: 'TikTok' },
  { id: 'youtube', name: 'YouTube' }, { id: 'spotify', name: 'Spotify' }, { id: 'x', name: 'X' },
  { id: 'browser', name: 'Bookmarks' }, { id: 'anything', name: 'Anything' }
]);

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function button(label, handler, className = 'import-primary') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function readSources() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SOURCE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function sourceCollection() {
  try { return createSourceCollection(readSources()); }
  catch { localStorage.removeItem(SOURCE_KEY); return createSourceCollection(); }
}

function saveSources(collection) {
  const sources = collection.list();
  localStorage.setItem(SOURCE_KEY, JSON.stringify(sources));
  window.dispatchEvent(new CustomEvent('sideways:websourceschanged', { detail: { sources } }));
}

function makeFileInput({ id, accept = '', backup = false } = {}) {
  const input = el('input');
  input.id = id;
  input.type = 'file';
  input.multiple = !backup;
  input.accept = accept;
  input.hidden = true;
  input.addEventListener('change', async () => {
    const chosen = [...(input.files || [])];
    input.value = '';
    if (!chosen.length) return;
    if (backup) await restoreBackup(chosen[0]);
    else await importChosen(chosen);
  });
  document.body.append(input);
  return input;
}

const filesInput = makeFileInput({ id: 'sidewaysImportFiles' });
const backupInput = makeFileInput({ id: 'sidewaysBackupFile', accept: '.sideways,application/x-sideways-ark,application/octet-stream', backup: true });

function waitForCoreRefresh() {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('sideways:corpusrefresh', onRefresh);
      window.removeEventListener('sideways:corpusrefresherror', onError);
    };
    const onRefresh = event => { cleanup(); resolve(event.detail || {}); };
    const onError = event => { cleanup(); reject(new Error(event.detail?.message || 'Refresh failed.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The archive did not refresh.')); }, 10000);
    window.addEventListener('sideways:corpusrefresh', onRefresh, { once: true });
    window.addEventListener('sideways:corpusrefresherror', onError, { once: true });
  });
}

async function importChosen(chosen) {
  if (state.busy || !chosen.length) return;
  state.busy = true;
  state.mode = 'status';
  state.error = '';
  state.result = { capability: 'private', ongoingConnection: false, provenance: 'Files selected on this device' };
  state.detail = 'Reading files locally without uploading them.';
  renderPanel();
  try {
    const result = await runtime.import(chosen);
    const refreshed = waitForCoreRefresh();
    window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { ...result, capability: 'private', ongoingConnection: false, provenance: 'local files' } }));
    await refreshed;
    state.result = { ...state.result, ...result };
    state.detail = `${Number(result.added || 0)} items are Private on this device. ${Number(result.skipped || 0)} duplicates were skipped.`;
  } catch (error) {
    state.error = error?.name === 'AbortError' ? 'Import stopped.' : (error?.message || 'Import failed.');
  } finally {
    state.busy = false;
    renderPanel();
  }
}

async function restoreBackup(file) {
  if (state.busy || !file) return;
  state.busy = true;
  state.mode = 'status';
  state.error = '';
  state.result = { capability: 'private', ongoingConnection: false, provenance: 'Sideways backup' };
  state.detail = 'Validating the backup and preparing a rollback snapshot.';
  renderPanel();
  try {
    const refreshed = waitForCoreRefresh();
    const result = await Survival.restoreArk(file);
    await refreshed;
    state.result = { ...state.result, ...result };
    state.detail = `${Number(result.added || 0)} records and ${Number(result.assets || 0)} assets were restored transactionally. ${Number(result.skipped || 0)} duplicates were skipped.`;
  } catch (error) {
    state.error = error?.message || 'Restore failed.';
  } finally {
    state.busy = false;
    renderPanel();
  }
}

function staticDeployment() {
  return window.SidewaysConnectionConfig?.serverBacked !== true;
}

function providerConfigured(config = {}) {
  return Boolean(config.clientId && config.redirectUri && config.authorizationEndpoint && (config.allowedRedirects?.length || config.redirectUri));
}

function connectProvider(provider) {
  const config = window.SidewaysConnectionConfig?.providers?.[provider.id] || {};
  const capability = connectionCapability({ staticDeployment: staticDeployment(), configured: providerConfigured(config) });
  if (capability.state !== 'available') {
    state.error = capability.reason;
    state.mode = 'connect';
    renderPanel();
    return;
  }
  try {
    const endpoint = new URL(provider.authorizationPath, location.origin);
    if (endpoint.origin !== location.origin) throw new Error('Connection initiation must remain on this deployment.');
    const returnTo = new URL(location.href);
    returnTo.hash = '#/add';
    endpoint.searchParams.set('return_to', returnTo.href);
    location.assign(endpoint.href);
  } catch (error) {
    state.error = error?.message || 'Connection could not start.';
    state.mode = 'connect';
    renderPanel();
  }
}

function addWebSource(form) {
  const input = form.elements.sourceURL;
  try {
    const parsed = safePublicURL(input.value);
    const kind = classifyAddInput(parsed.href);
    const collection = sourceCollection();
    const added = collection.add({ url: parsed.href, kind });
    saveSources(collection);
    state.mode = 'status';
    state.result = { source: added, capability: 'web', ongoingConnection: false, provenance: added.url };
    state.error = '';
    state.detail = `${added.name} is enabled as a ${kind === 'feed' ? 'feed' : kind}. Its public material is readable as Web content but is not Private until you explicitly save it.`;
    renderPanel();
  } catch (error) {
    state.error = error?.message || 'That source could not be added.';
    state.mode = 'web';
    renderPanel();
  }
}

function homePanel() {
  const section = el('section', 'add-sideways-home');
  const intro = el('header', 'add-sideways-intro');
  intro.append(el('span', 'import-workbench-kicker', 'ADD TO SIDEWAYS'), el('h2', '', 'Bring something in.'), el('p', '', 'Connect an account, follow a public source, import files, or restore a backup. Sideways always tells you where the material lives.'));
  const grid = el('div', 'add-sideways-grid');
  const choices = [
    ['Connected', 'Connect an account', 'Authorize an official provider without giving Sideways your password.', 'connect'],
    ['Web', 'Add a website or feed', 'Follow a public URL, RSS, Atom, sitemap, or ActivityPub source. Nothing becomes Private automatically.', 'web'],
    ['Private', 'Import files', 'Choose or drop exports, documents, bookmarks, history, and media. Files stay on this device.', 'files'],
    ['Private', 'Restore a Sideways backup', 'Recover an owned .sideways Ark through the transactional restore path.', 'restore']
  ];
  for (const [badge, title, copy, mode] of choices) {
    const card = el('article', 'add-sideways-choice');
    card.dataset.choice = mode;
    card.append(el('span', `capability-badge capability-${badge.toLowerCase()}`, badge), el('h3', '', title), el('p', '', copy), button('Open', () => { state.mode = mode; state.error = ''; renderPanel(); }, 'import-primary'));
    grid.append(card);
  }
  section.append(intro, grid);
  return section;
}

function connectPanel() {
  const section = el('section', 'add-sideways-subview');
  section.append(el('span', 'import-workbench-kicker', 'CONNECTED'), el('h2', '', 'Connect an account'), el('p', 'add-sideways-note', staticDeployment() ? 'This static edition cannot hold account tokens. Official connections appear only on a configured server deployment; file imports and public feeds remain available.' : 'Authorization begins on this deployment and opens on the provider. Tokens remain encrypted on the server, scopes are limited, and disconnect can revoke access.'));
  if (state.error) section.append(el('p', 'add-sideways-error', state.error));
  const grid = el('div', 'connection-grid');
  const config = window.SidewaysConnectionConfig?.providers || {};
  for (const provider of providerCatalog(config)) {
    const providerConfig = config[provider.id] || {};
    const capability = connectionCapability({ staticDeployment: staticDeployment(), configured: providerConfigured(providerConfig) });
    const card = el('article', 'connection-card');
    card.dataset.provider = provider.id;
    card.append(el('strong', '', provider.name), el('span', '', capability.reason));
    const action = button(capability.state === 'available' ? 'Connect' : 'Unavailable', () => connectProvider(provider), capability.state === 'available' ? 'import-primary' : 'import-secondary');
    action.disabled = capability.state !== 'available';
    card.append(action);
    grid.append(card);
  }
  section.append(grid, button('Back', () => { state.mode = 'home'; renderPanel(); }, 'import-secondary'));
  return section;
}

function sourceRow(source, collection) {
  const row = el('article');
  row.dataset.sourceId = source.id;
  const copy = el('div');
  copy.append(el('strong', '', source.name), el('span', '', `${source.kind} · ${source.enabled ? 'On' : 'Off'} · ${source.capability === 'unavailable' ? source.unavailableReason : source.url}`));
  const toggle = button(source.enabled ? 'Turn off' : 'Turn on', () => {
    collection.setEnabled(source.id, !source.enabled);
    saveSources(collection);
    renderPanel();
  }, 'import-secondary');
  const remove = button('Remove', () => {
    collection.remove(source.id);
    saveSources(collection);
    renderPanel();
  }, 'import-secondary');
  row.append(copy, toggle, remove);
  return row;
}

function webPanel() {
  const section = el('section', 'add-sideways-subview');
  section.append(el('span', 'import-workbench-kicker', 'WEB'), el('h2', '', 'Add a website or feed'), el('p', 'add-sideways-note', 'Use a public HTTP or HTTPS URL. Private-network addresses, embedded credentials, secret-like query parameters, and unsupported protocols are rejected. Public material stays separate from your Private archive.'));
  if (state.error) section.append(el('p', 'add-sideways-error', state.error));
  const form = el('form', 'web-source-form');
  const label = el('label', '', 'Website, RSS, Atom, sitemap, or ActivityPub URL');
  const input = el('input');
  input.name = 'sourceURL'; input.type = 'url'; input.required = true; input.inputMode = 'url'; input.autocomplete = 'url'; input.placeholder = 'https://example.com/feed.xml';
  label.append(input);
  const submit = button('Add source', () => {}, 'import-primary');
  submit.type = 'submit';
  form.append(label, submit);
  form.addEventListener('submit', event => { event.preventDefault(); addWebSource(form); });
  const collection = sourceCollection();
  const existing = el('div', 'source-list');
  if (!collection.list().length) existing.append(el('p', 'add-sideways-note', 'No public sources added yet.'));
  for (const source of collection.list()) existing.append(sourceRow(source, collection));
  section.append(form, existing, button('Back', () => { state.mode = 'home'; renderPanel(); }, 'import-secondary'));
  return section;
}

function dropPanel({ backup = false } = {}) {
  const section = el('section', 'add-sideways-subview');
  section.append(el('span', 'import-workbench-kicker', 'PRIVATE'), el('h2', '', backup ? 'Restore a Sideways backup' : 'Import files'), el('p', 'add-sideways-note', backup ? 'Choose one .sideways Ark. The restore validates first, snapshots rollback state, and commits records, assets, places, and profile transactionally.' : 'Choose files or drop them here. Sideways classifies them after selection, hashes them in bounded work, deduplicates, and writes atomic Private records without reloading the page.'));
  if (state.error) section.append(el('p', 'add-sideways-error', state.error));
  const zone = el('div', 'add-sideways-dropzone', backup ? 'Drop one .sideways backup here' : 'Drop files here');
  zone.tabIndex = 0;
  zone.dataset.backup = backup ? 'true' : 'false';
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('is-dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', async event => {
    event.preventDefault();
    zone.classList.remove('is-dragging');
    const chosen = [...(event.dataTransfer?.files || [])];
    if (!chosen.length) return;
    if (backup) await restoreBackup(chosen[0]);
    else await importChosen(chosen);
  });
  const choose = button(backup ? 'Choose backup' : 'Choose files', () => (backup ? backupInput : filesInput).click(), 'import-primary');
  section.append(zone, choose, button('Back', () => { state.mode = 'home'; renderPanel(); }, 'import-secondary'));
  return section;
}

function statusPanel() {
  const section = el('section', state.error ? 'import-error-panel' : 'import-complete-panel');
  const capability = state.result?.capability || (state.error ? '' : 'private');
  const label = capability ? capability[0].toUpperCase() + capability.slice(1) : '';
  section.append(el('span', 'import-workbench-kicker', state.busy ? 'WORKING' : state.error ? 'NOT ADDED' : 'ADDED'));
  if (label) section.append(el('span', `capability-badge capability-${capability}`, label));
  section.append(el('h2', '', state.busy ? 'Keeping this bounded…' : state.error || 'Done'), el('p', 'add-sideways-note', state.detail));
  if (!state.error && state.result?.provenance) section.append(el('p', 'add-sideways-provenance', `Provenance: ${state.result.provenance}. Ongoing connection: ${state.result.ongoingConnection ? 'yes' : 'no'}.`));
  if (state.busy) section.append(button('Stop', () => runtime.stop(), 'import-secondary'));
  else section.append(button('Add something else', () => { state.mode = 'home'; state.result = null; state.error = ''; state.detail = ''; renderPanel(); }, 'import-primary'));
  return section;
}

function renderPanel() {
  const host = document.getElementById('importWorkbenchHost');
  if (!host) return;
  let panel;
  if (state.mode === 'connect') panel = connectPanel();
  else if (state.mode === 'web') panel = webPanel();
  else if (state.mode === 'files') panel = dropPanel();
  else if (state.mode === 'restore') panel = dropPanel({ backup: true });
  else if (state.mode === 'status') panel = statusPanel();
  else panel = homePanel();
  host.replaceChildren(panel);
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
  }
  renderPanel();
  return true;
}

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; mount(); });
}
for (const eventName of ['hashchange', 'popstate', 'sideways:ready', 'sideways:feedrender']) window.addEventListener(eventName, schedule);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();

window.SidewaysImportWorkbench = Object.freeze({
  registry,
  runtime,
  platforms: LEGACY_PLATFORMS,
  open: () => { if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo('#/add'); else location.hash = '#/add'; },
  setFiles: importChosen,
  restoreBackup,
  sources: () => readSources(),
  mount: schedule
});
