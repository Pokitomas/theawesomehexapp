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
  { id: 'instagram', name: 'Instagram' },
  { id: 'reddit', name: 'Reddit' },
  { id: 'tiktok', name: 'TikTok' },
  { id: 'youtube', name: 'YouTube' },
  { id: 'spotify', name: 'Spotify' },
  { id: 'x', name: 'X' },
  { id: 'browser', name: 'Bookmarks' },
  { id: 'anything', name: 'Anything' }
]);

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function action(label, handler, className = 'import-primary') {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function readSources() {
  try {
    const value = JSON.parse(localStorage.getItem(SOURCE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function getSourceCollection() {
  try {
    return createSourceCollection(readSources());
  } catch {
    localStorage.removeItem(SOURCE_KEY);
    return createSourceCollection();
  }
}

function persistSources(collection) {
  const sources = collection.list();
  localStorage.setItem(SOURCE_KEY, JSON.stringify(sources));
  window.dispatchEvent(new CustomEvent('sideways:websourceschanged', { detail: { sources } }));
}

function makeFileInput({ id, accept = '', backup = false }) {
  const input = element('input');
  input.id = id;
  input.type = 'file';
  input.multiple = !backup;
  input.accept = accept;
  input.hidden = true;
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    input.value = '';
    if (!files.length) return;
    if (backup) await restoreBackup(files[0]);
    else await importFiles(files);
  });
  document.body.append(input);
  return input;
}

const filesInput = makeFileInput({ id: 'sidewaysImportFiles' });
const backupInput = makeFileInput({
  id: 'sidewaysBackupFile',
  accept: '.sideways,application/x-sideways-ark,application/octet-stream',
  backup: true
});

function waitForCoreRefresh() {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('sideways:corpusrefresh', onRefresh);
      window.removeEventListener('sideways:corpusrefresherror', onError);
    };
    const onRefresh = event => {
      cleanup();
      resolve(event.detail || {});
    };
    const onError = event => {
      cleanup();
      reject(new Error(event.detail?.message || 'Refresh failed.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The archive did not refresh.'));
    }, 10000);
    window.addEventListener('sideways:corpusrefresh', onRefresh, { once: true });
    window.addEventListener('sideways:corpusrefresherror', onError, { once: true });
  });
}

async function importFiles(files) {
  if (state.busy || !files.length) return;
  state.busy = true;
  state.mode = 'status';
  state.error = '';
  state.result = {
    capability: 'private',
    ongoingConnection: false,
    provenance: 'Files selected on this device'
  };
  state.detail = 'Reading files locally without uploading them.';
  render();
  try {
    const result = await runtime.import(files);
    const refresh = waitForCoreRefresh();
    window.dispatchEvent(new CustomEvent('sideways:importcomplete', {
      detail: {
        ...result,
        capability: 'private',
        ongoingConnection: false,
        provenance: 'local files'
      }
    }));
    await refresh;
    state.result = { ...state.result, ...result };
    state.detail = `${Number(result.added || 0)} items are Private on this device. ${Number(result.skipped || 0)} duplicates were skipped.`;
  } catch (error) {
    state.error = error?.name === 'AbortError' ? 'Import stopped.' : (error?.message || 'Import failed.');
  } finally {
    state.busy = false;
    render();
  }
}

async function restoreBackup(file) {
  if (state.busy || !file) return;
  state.busy = true;
  state.mode = 'status';
  state.error = '';
  state.result = {
    capability: 'private',
    ongoingConnection: false,
    provenance: 'Sideways backup'
  };
  state.detail = 'Validating the backup and preparing a rollback snapshot.';
  render();
  try {
    const refresh = waitForCoreRefresh();
    const result = await Survival.restoreArk(file);
    await refresh;
    state.result = { ...state.result, ...result };
    state.detail = `${Number(result.added || 0)} records and ${Number(result.assets || 0)} assets were restored transactionally. ${Number(result.skipped || 0)} duplicates were skipped.`;
  } catch (error) {
    state.error = error?.message || 'Restore failed.';
  } finally {
    state.busy = false;
    render();
  }
}

function isStaticDeployment() {
  return window.SidewaysConnectionConfig?.serverBacked !== true;
}

function providerConfigured(config = {}) {
  return Boolean(
    config.clientId &&
    config.redirectUri &&
    config.authorizationEndpoint &&
    (config.allowedRedirects?.length || config.redirectUri)
  );
}

function connectProvider(provider) {
  const config = window.SidewaysConnectionConfig?.providers?.[provider.id] || {};
  const capability = connectionCapability({
    staticDeployment: isStaticDeployment(),
    configured: providerConfigured(config)
  });
  if (capability.state !== 'available') {
    state.error = capability.reason;
    state.mode = 'connect';
    render();
    return;
  }
  try {
    const endpoint = new URL(provider.authorizationPath, location.origin);
    if (endpoint.origin !== location.origin) {
      throw new Error('Connection initiation must remain on this deployment.');
    }
    const returnTo = new URL(location.href);
    returnTo.hash = '#/add';
    endpoint.searchParams.set('return_to', returnTo.href);
    location.assign(endpoint.href);
  } catch (error) {
    state.error = error?.message || 'Connection could not start.';
    state.mode = 'connect';
    render();
  }
}

function addWebSource(form) {
  const input = form.elements.sourceURL;
  try {
    const url = safePublicURL(input.value);
    const kind = classifyAddInput(url.href);
    const collection = getSourceCollection();
    const source = collection.add({ url: url.href, kind });
    persistSources(collection);
    state.mode = 'status';
    state.error = '';
    state.result = {
      source,
      capability: 'web',
      ongoingConnection: false,
      provenance: source.url
    };
    state.detail = `${source.name} is enabled as a ${kind === 'feed' ? 'feed' : kind}. Its public material is readable as Web content but is not Private until you explicitly save it.`;
    render();
  } catch (error) {
    state.error = error?.message || 'That source could not be added.';
    state.mode = 'web';
    render();
  }
}

function homePanel() {
  const section = element('section', 'add-sideways-home');
  const intro = element('header', 'add-sideways-intro');
  intro.append(
    element('span', 'import-workbench-kicker', 'ADD TO SIDEWAYS'),
    element('h2', '', 'Bring something in.'),
    element('p', '', 'Connect an account, follow a public source, import files, or restore a backup. Sideways always tells you where the material lives.')
  );
  const grid = element('div', 'add-sideways-grid');
  const choices = [
    ['Connected', 'Connect an account', 'Authorize an official provider without giving Sideways your password.', 'connect'],
    ['Web', 'Add a website or feed', 'Follow a public URL, RSS, Atom, sitemap, or ActivityPub source. Nothing becomes Private automatically.', 'web'],
    ['Private', 'Import files', 'Choose or drop exports, documents, bookmarks, history, and media. Files stay on this device.', 'files'],
    ['Private', 'Restore a Sideways backup', 'Recover an owned .sideways Ark through the transactional restore path.', 'restore']
  ];
  for (const [badge, title, copy, mode] of choices) {
    const card = element('article', 'add-sideways-choice');
    card.dataset.choice = mode;
    card.append(
      element('span', `capability-badge capability-${badge.toLowerCase()}`, badge),
      element('h3', '', title),
      element('p', '', copy),
      action('Open', () => {
        state.mode = mode;
        state.error = '';
        render();
      })
    );
    grid.append(card);
  }
  section.append(intro, grid);
  return section;
}

function connectPanel() {
  const section = element('section', 'add-sideways-subview');
  section.append(
    element('span', 'import-workbench-kicker', 'CONNECTED'),
    element('h2', '', 'Connect an account'),
    element(
      'p',
      'add-sideways-note',
      isStaticDeployment()
        ? 'This static edition cannot hold account tokens. Official connections appear only on a configured server deployment; file imports and public feeds remain available.'
        : 'Authorization begins on this deployment and opens on the provider. Tokens remain encrypted on the server, scopes are limited, and disconnect can revoke access.'
    )
  );
  if (state.error) section.append(element('p', 'add-sideways-error', state.error));
  const grid = element('div', 'connection-grid');
  const configuration = window.SidewaysConnectionConfig?.providers || {};
  for (const provider of providerCatalog(configuration)) {
    const config = configuration[provider.id] || {};
    const capability = connectionCapability({
      staticDeployment: isStaticDeployment(),
      configured: providerConfigured(config)
    });
    const card = element('article', 'connection-card');
    card.dataset.provider = provider.id;
    card.append(
      element('strong', '', provider.name),
      element('span', '', capability.reason)
    );
    const button = action(
      capability.state === 'available' ? 'Connect' : 'Unavailable',
      () => connectProvider(provider),
      capability.state === 'available' ? 'import-primary' : 'import-secondary'
    );
    button.disabled = capability.state !== 'available';
    card.append(button);
    grid.append(card);
  }
  section.append(grid, action('Back', () => {
    state.mode = 'home';
    render();
  }, 'import-secondary'));
  return section;
}

function sourceRow(source, collection) {
  const row = element('article');
  row.dataset.sourceId = source.id;
  const copy = element('div');
  const status = source.capability === 'unavailable' ? source.unavailableReason : source.url;
  copy.append(
    element('strong', '', source.name),
    element('span', '', `${source.kind} | ${source.enabled ? 'On' : 'Off'} | ${status}`)
  );
  const toggle = action(source.enabled ? 'Turn off' : 'Turn on', () => {
    collection.setEnabled(source.id, !source.enabled);
    persistSources(collection);
    render();
  }, 'import-secondary');
  const remove = action('Remove', () => {
    collection.remove(source.id);
    persistSources(collection);
    render();
  }, 'import-secondary');
  row.append(copy, toggle, remove);
  return row;
}

function webPanel() {
  const section = element('section', 'add-sideways-subview');
  section.append(
    element('span', 'import-workbench-kicker', 'WEB'),
    element('h2', '', 'Add a website or feed'),
    element('p', 'add-sideways-note', 'Use a public HTTP or HTTPS URL. Private-network addresses, embedded credentials, secret-like query parameters, and unsupported protocols are rejected. Public material stays separate from your Private archive.')
  );
  if (state.error) section.append(element('p', 'add-sideways-error', state.error));
  const form = element('form', 'web-source-form');
  const label = element('label', '', 'Website, RSS, Atom, sitemap, or ActivityPub URL');
  const input = element('input');
  input.name = 'sourceURL';
  input.type = 'url';
  input.required = true;
  input.inputMode = 'url';
  input.autocomplete = 'url';
  input.placeholder = 'https://example.com/feed.xml';
  label.append(input);
  const submit = action('Add source', () => {});
  submit.type = 'submit';
  form.append(label, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    addWebSource(form);
  });
  const collection = getSourceCollection();
  const list = element('div', 'source-list');
  if (!collection.list().length) {
    list.append(element('p', 'add-sideways-note', 'No public sources added yet.'));
  }
  for (const source of collection.list()) list.append(sourceRow(source, collection));
  section.append(form, list, action('Back', () => {
    state.mode = 'home';
    render();
  }, 'import-secondary'));
  return section;
}

function dropPanel({ backup = false } = {}) {
  const section = element('section', 'add-sideways-subview');
  section.append(
    element('span', 'import-workbench-kicker', 'PRIVATE'),
    element('h2', '', backup ? 'Restore a Sideways backup' : 'Import files'),
    element(
      'p',
      'add-sideways-note',
      backup
        ? 'Choose one .sideways Ark. The restore validates first, snapshots rollback state, and commits records, assets, places, and profile transactionally.'
        : 'Choose files or drop them here. Sideways classifies them after selection, hashes them in bounded work, deduplicates, and writes atomic Private records without reloading the page.'
    )
  );
  if (state.error) section.append(element('p', 'add-sideways-error', state.error));
  const zone = element(
    'div',
    'add-sideways-dropzone',
    backup ? 'Drop one .sideways backup here' : 'Drop files here'
  );
  zone.tabIndex = 0;
  zone.dataset.backup = backup ? 'true' : 'false';
  zone.addEventListener('dragover', event => {
    event.preventDefault();
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', async event => {
    event.preventDefault();
    zone.classList.remove('is-dragging');
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    if (backup) await restoreBackup(files[0]);
    else await importFiles(files);
  });
  const choose = action(
    backup ? 'Choose backup' : 'Choose files',
    () => (backup ? backupInput : filesInput).click()
  );
  section.append(zone, choose, action('Back', () => {
    state.mode = 'home';
    render();
  }, 'import-secondary'));
  return section;
}

function statusPanel() {
  const className = state.busy
    ? 'import-progress-panel'
    : state.error
      ? 'import-error-panel'
      : 'import-complete-panel';
  const section = element('section', className);
  const capability = state.result?.capability || (state.error ? '' : 'private');
  const label = capability ? capability[0].toUpperCase() + capability.slice(1) : '';
  section.append(element(
    'span',
    'import-workbench-kicker',
    state.busy ? 'WORKING' : state.error ? 'NOT ADDED' : 'ADDED'
  ));
  if (label) section.append(element('span', `capability-badge capability-${capability}`, label));
  section.append(
    element('h2', '', state.busy ? 'Keeping this bounded...' : state.error || 'Done'),
    element('p', 'add-sideways-note', state.detail)
  );
  if (!state.error && state.result?.provenance) {
    section.append(element(
      'p',
      'add-sideways-provenance',
      `Provenance: ${state.result.provenance}. Ongoing connection: ${state.result.ongoingConnection ? 'yes' : 'no'}.`
    ));
  }
  if (state.busy) {
    section.append(action('Stop', () => runtime.stop(), 'import-secondary'));
  } else {
    section.append(action('Add something else', () => {
      state.mode = 'home';
      state.result = null;
      state.error = '';
      state.detail = '';
      render();
    }));
  }
  return section;
}

function render() {
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
    host = element('div', 'import-workbench');
    host.id = 'importWorkbenchHost';
    addView.append(host);
  }
  render();
  return true;
}

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    mount();
  });
}

for (const eventName of ['hashchange', 'popstate', 'sideways:ready', 'sideways:feedrender']) {
  window.addEventListener(eventName, schedule);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', schedule, { once: true });
} else {
  schedule();
}

window.SidewaysImportWorkbench = Object.freeze({
  registry,
  runtime,
  platforms: LEGACY_PLATFORMS,
  open: () => {
    if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo('#/add');
    else location.hash = '#/add';
  },
  setFiles: importFiles,
  restoreBackup,
  sources: () => readSources(),
  mount: schedule
});
