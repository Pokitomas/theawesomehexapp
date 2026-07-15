import { createDefaultRegistry } from './imports/registry.js';
import { createImportRuntime } from './imports/runtime.js';
import { classifyAddInput, createSourceCollection, safePublicURL } from './discovery-source.js';
import { createConnectionState, createPKCE, connectionCapability, providerCatalog } from './account-connections.js';

const registry = createDefaultRegistry();
const runtime = createImportRuntime({ registry, chunkSize: 75 });
const SOURCE_KEY = 'sideways:web-sources:v1';
const CONNECTION_STATE_KEY = 'sideways:connection-state:v1';
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
  localStorage.setItem(SOURCE_KEY, JSON.stringify(collection.list()));
  window.dispatchEvent(new CustomEvent('sideways:websourceschanged', { detail: { sources: collection.list() } }));
}

function makeFileInput({ accept = '', backup = false } = {}) {
  const input = el('input');
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

const filesInput = makeFileInput();
const backupInput = makeFileInput({ accept: '.sideways,application/zip,application/octet-stream', backup: true });

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
  state.result = null;
  state.detail = 'Reading files without uploading them.';
  renderPanel();
  try {
    state.result = await runtime.import(chosen);
    const refreshed = waitForCoreRefresh();
    window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { ...state.result, capability: 'private', ongoingConnection: false } }));
    await refreshed;
    state.detail = `${Number(state.result.added || 0)} items are now private on this device.`;
  } catch (error) {
    state.error = error?.name === 'AbortError' ? 'Import stopped.' : (error?.message || 'Import failed.');
  } finally {
    state.busy = false;
    renderPanel();
  }
}

async function restoreBackup(file) {
  if (state.busy) return;
  state.busy = true;
  state.mode = 'status';
  state.error = '';
  state.result = null;
  state.detail = 'Checking this Sideways backup before restore.';
  renderPanel();
  try {
    const event = new CustomEvent('sideways:restorefile', { detail: { file, handled: false }, cancelable: true });
    window.dispatchEvent(event);
    if (!event.defaultPrevented && !event.detail?.handled) throw new Error('Restore is unavailable until the archive recovery controls are ready.');
    state.result = { restored: true };
    state.detail = 'The backup was handed to the transactional restore system.';
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

async function connectProvider(provider) {
  const config = window.SidewaysConnectionConfig?.providers?.[provider.id] || {};
  const capability = connectionCapability({ staticDeployment: staticDeployment(), configured: Boolean(config.clientId && config.redirectUri && config.authorizationEndpoint) });
  if (capability.state !== 'available') {
    state.error = capability.reason;
    state.mode = 'connect';
    renderPanel();
    return;
  }
  try {
    const pkce = await createPKCE();
    const connectionState = createConnectionState({ providerId: provider.id, redirectUri: config.redirectUri });
    sessionStorage.setItem(CONNECTION_STATE_KEY, JSON.stringify({ ...connectionState, verifier: pkce.verifier }));
    const endpoint = new URL(provider.authorizationPath, location.origin);
    endpoint.search = new URLSearchParams({
      state: connectionState.state,
      nonce: connectionState.nonce,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
      return_to: location.href
    }).toString();
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
    state.result = { source: added };
    state.error = '';
    state.detail = `${added.name} is enabled as a ${kind === 'feed' ? 'feed' : 'website'} source. Its public material is readable but is not part of your private archive until you save it.`;
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
    ['Web', 'Add a website or feed', 'Follow a public URL, RSS or Atom feed. Nothing is copied into your private archive automatically.', 'web'],
    ['Private', 'Import files', 'Read exports, documents and media locally on this device.', 'files'],
    ['Private', 'Restore a Sideways backup', 'Recover an owned .sideways Ark through the transactional restore path.', 'restore']
  ];
  for (const [badge, title, copy, mode] of choices) {
    const card = el('article', 'add-sideways-choice');
    card.append(el('span', `capability-badge capability-${badge.toLowerCase()}`, badge), el('h3', '', title), el('p', '', copy), button('Open', () => { state.mode = mode; state.error = ''; renderPanel(); }, 'import-primary'));
    grid.append(card);
  }
  section.append(intro, grid);
  return section;
}

function connectPanel() {
  const section = el('section', 'add-sideways-subview');
  section.append(el('span', 'import-workbench-kicker', 'CONNECTED'), el('h2', '', 'Connect an account'), el('p', 'add-sideways-note', staticDeployment() ? 'This static edition cannot hold account tokens. Official connections appear only on a configured server deployment; file imports still work here.' : 'Authorization happens on the provider. Sideways receives only the scopes you approve and supports disconnect and revocation.'));
  if (state.error) section.append(el('p', 'add-sideways-error', state.error));
  const grid = el('div', 'connection-grid');
  const config = window.SidewaysConnectionConfig?.providers || {};
  for (const provider of providerCatalog(config)) {
    const providerConfig = config[provider.id] || {};
    const capability = connectionCapability({ staticDeployment: staticDeployment(), configured: Boolean(providerConfig.clientId && providerConfig.redirectUri && providerConfig.authorizationEndpoint) });
    const card = el('article', 'connection-card');
    card.append(el('strong', '', provider.name), el('span', '', capability.reason));
    const action = button(capability.state === 'available' ? 'Connect' : 'Unavailable', () => connectProvider(provider), capability.state === 'available' ? 'import-primary' : 'import-secondary');
    action.disabled = capability.state !== 'available';
    card.append(action);
    grid.append(card);
  }
  section.append(grid, button('Back', () => { state.mode = 'home'; renderPanel(); }, 'import-secondary'));
  return section;
}

function webPanel() {
  const section = el('section', 'add-sideways-subview');
  section.append(el('span', 'import-workbench-kicker', 'WEB'), el('h2', '', 'Add a website or feed'), el('p', 'add-sideways-note', 'Use a public HTTPS URL. Private-network addresses, embedded credentials and unsupported protocols are rejected.'));
  if (state.error) section.append(el('p', 'add-sideways-error', state.error));
  const form = el('form', 'web-source-form');
  const label = el('label', '', 'Website, RSS or Atom URL');
  const input = el('input');
  input.name = 'sourceURL'; input.type = 'url'; input.required = true; input.inputMode = 'url'; input.autocomplete = 'url'; input.placeholder = 'https://example.com/feed.xml';
  label.append(input);
  form.append(label, button('Add source', () => {}, 'import-primary'));
  form.addEventListener('submit', event => { event.preventDefault(); addWebSource(form); });
  const existing = el('div', 'source-list');
  for (const source of readSources()) existing.append(el('p', '', `${source.enabled === false ? 'Off' : 'On'} · ${source.name} · ${source.kind}`));
  section.append(form, existing, button('Back', () => { state.mode = 'home'; renderPanel(); }, 'import-secondary'));
  return section;
}

function statusPanel() {
  const section = el('section', state.error ? 'import-error-panel' : 'import-complete-panel');
  section.append(el('span', 'import-workbench-kicker', state.busy ? 'WORKING' : state.error ? 'NOT ADDED' : 'ADDED'), el('h2', '', state.busy ? 'Keeping this bounded…' : state.error || 'Done'), el('p', 'add-sideways-note', state.detail));
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
  else if (state.mode === 'files') { filesInput.click(); state.mode = 'home'; panel = homePanel(); }
  else if (state.mode === 'restore') { backupInput.click(); state.mode = 'home'; panel = homePanel(); }
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
  sources: () => readSources(),
  mount: schedule
});
