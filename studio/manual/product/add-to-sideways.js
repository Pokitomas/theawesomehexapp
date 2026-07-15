import { connectionCapability, providerCatalog } from './account-connections.js';
import {
  CAPABILITY_STATES,
  classifyAddInput,
  createSourceCollection,
  safePublicURL
} from './discovery-source.js';
import { Survival } from './survival-ledger.js';

const SOURCE_STORAGE_KEY = 'sideways-web-sources-v1';
const ALLOWED_SOURCE_KINDS = new Set(['website', 'feed', 'sitemap', 'activitypub']);
const CHOICES = Object.freeze([
  Object.freeze({ id: 'connected', state: CAPABILITY_STATES.CONNECTED, badge: 'Connected', title: 'Connect an account', description: 'Use an official provider connection when this deployment has a secure server callback.' }),
  Object.freeze({ id: 'web', state: CAPABILITY_STATES.WEB, badge: 'Web', title: 'Add a website or feed', description: 'Follow a public website, RSS or Atom feed, sitemap, or public ActivityPub source.' }),
  Object.freeze({ id: 'private', state: CAPABILITY_STATES.PRIVATE, badge: 'Private', title: 'Import files', description: 'Bring in exports and files on this device. They stay in your local Sideways library.' }),
  Object.freeze({ id: 'shared', state: CAPABILITY_STATES.SHARED, badge: 'Shared', title: 'Restore a Sideways backup', description: 'Restore a portable Sideways backup that you control.' })
]);

let view = 'home';
let notice = '';
let error = '';
let scheduled = false;
const collection = createSourceCollection(readStoredSources());

function clean(value = '') {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}

function button(label, className, handler) {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', handler);
  return element;
}

function emit(type, detail = {}) {
  window.dispatchEvent(new CustomEvent('sideways:add-to-sideways', {
    detail: Object.freeze({ type, at: new Date().toISOString(), ...detail })
  }));
}

function readStoredSources() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SOURCE_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSources() {
  const sources = collection.list();
  try {
    localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify(sources));
  } catch (caught) {
    error = caught?.message || 'Sources could not be saved on this device.';
  }
  window.dispatchEvent(new CustomEvent('sideways:sourceschange', {
    detail: Object.freeze({ sources: Object.freeze(sources), publicCacheBoundary: 'separate-from-private-archive' })
  }));
}

function sourceId(url) {
  const parsed = safePublicURL(url);
  let hash = 2166136261;
  for (const character of parsed.href) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const host = parsed.hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `${host || 'web'}-${(hash >>> 0).toString(36)}`;
}

function host() {
  return document.getElementById('importWorkbenchHost');
}

function scheduleRender() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    render();
  });
}

function setView(next) {
  view = next;
  notice = '';
  error = '';
  emit('view', { view: next });
  scheduleRender();
}

function intro(title, description) {
  const container = node('div', 'add-sideways-intro');
  container.append(node('h2', '', title), node('p', '', description));
  return container;
}

function statusMessages(container) {
  if (error) container.append(node('p', 'add-sideways-error', error));
  if (notice) container.append(node('p', 'add-sideways-note add-sideways-success', notice));
}

function choiceCard(choice) {
  const card = button('', `add-sideways-choice capability-${choice.state}`, () => activateChoice(choice.id));
  card.dataset.addChoice = choice.id;
  card.setAttribute('aria-label', choice.title);
  card.append(
    node('span', `capability-badge capability-${choice.state}`, choice.badge),
    node('h3', '', choice.title),
    node('p', '', choice.description),
    node('span', 'add-sideways-cta', 'Open')
  );
  return card;
}

function homeView() {
  const section = node('section', 'add-sideways-home');
  section.dataset.addToSideways = 'home';
  section.append(intro('Add to Sideways', 'Choose where something comes from. Public web reading and your private library remain separate.'));
  const grid = node('div', 'add-sideways-grid');
  CHOICES.forEach(choice => grid.append(choiceCard(choice)));
  section.append(grid);
  statusMessages(section);
  return section;
}

function backButton() {
  return button('Back', 'import-secondary add-sideways-back', () => setView('home'));
}

function connectedView() {
  const section = node('section', 'add-sideways-subview');
  section.dataset.addToSideways = 'connected';
  section.append(backButton(), intro('Connect an account', 'Connections use official authorization and never place provider tokens in this browser archive.'));
  const configuration = window.SidewaysConnectionConfig || {};
  const providers = providerCatalog(configuration.providers || {});
  const staticDeployment = configuration.serverBacked !== true;
  const grid = node('div', 'connection-grid');
  for (const provider of providers) {
    const capability = connectionCapability({ staticDeployment, configured: provider.configured });
    const card = node('article', 'connection-card');
    const name = node('strong', '', provider.name);
    const connect = button(capability.state === 'available' ? 'Connect' : 'Unavailable', 'import-secondary', () => {
      if (capability.state !== 'available') return;
      emit('connection-start', { provider: provider.id });
      location.assign(provider.authorizationPath);
    });
    connect.disabled = capability.state !== 'available';
    card.append(name, connect, node('span', '', capability.reason));
    grid.append(card);
  }
  const fallback = node('div', 'add-sideways-fallbacks');
  fallback.append(
    button('Import files instead', 'import-secondary', openFileImport),
    button('Add a public website or feed', 'import-secondary', () => setView('web'))
  );
  section.append(grid, fallback);
  statusMessages(section);
  return section;
}

function sourceList() {
  const list = node('div', 'source-list');
  list.dataset.sourceList = 'true';
  const sources = collection.list();
  if (!sources.length) {
    list.append(node('p', 'add-sideways-note', 'No public sources added yet.'));
    return list;
  }
  for (const source of sources) {
    const row = node('article');
    row.dataset.sourceId = source.id;
    const copy = node('div', 'source-copy');
    copy.append(node('strong', '', source.name), node('span', '', source.url));
    const toggleLabel = node('label', 'source-toggle');
    const toggle = node('input');
    toggle.type = 'checkbox';
    toggle.checked = source.enabled;
    toggle.setAttribute('aria-label', `${source.enabled ? 'Disable' : 'Enable'} ${source.name}`);
    toggle.addEventListener('change', () => {
      collection.setEnabled(source.id, toggle.checked);
      persistSources();
      emit('source-toggle', { sourceId: source.id, enabled: toggle.checked });
      scheduleRender();
    });
    toggleLabel.append(toggle, node('span', '', source.enabled ? 'On' : 'Off'));
    const remove = button('Remove', 'import-secondary source-remove', () => {
      collection.remove(source.id);
      persistSources();
      emit('source-remove', { sourceId: source.id });
      scheduleRender();
    });
    row.append(copy, toggleLabel, remove);
    list.append(row);
  }
  return list;
}

function addSource(form) {
  error = '';
  notice = '';
  const data = new FormData(form);
  const name = clean(data.get('name'));
  const rawURL = clean(data.get('url'));
  try {
    const parsed = safePublicURL(rawURL);
    const kind = classifyAddInput(parsed.href);
    if (!ALLOWED_SOURCE_KINDS.has(kind)) throw new Error('Use a public website, feed, sitemap, or ActivityPub URL.');
    const source = collection.add({ id: sourceId(parsed.href), name: name || parsed.hostname, url: parsed.href, kind });
    persistSources();
    form.reset();
    notice = `${source.name} is enabled for bounded public refresh.`;
    emit('source-add', { sourceId: source.id, kind: source.kind });
  } catch (caught) {
    error = caught?.message || 'That source could not be added.';
  }
  scheduleRender();
}

function webView() {
  const section = node('section', 'add-sideways-subview');
  section.dataset.addToSideways = 'web';
  section.append(backButton(), intro('Add a website or feed', 'Enabled public sources can be read during a bounded refresh. Reading does not save a copy into your private library.'));
  const form = node('form', 'web-source-form');
  const nameLabel = node('label', '', 'Name (optional)');
  const nameInput = node('input');
  nameInput.name = 'name';
  nameInput.autocomplete = 'off';
  const urlLabel = node('label', '', 'Public URL');
  const urlInput = node('input');
  urlInput.name = 'url';
  urlInput.type = 'url';
  urlInput.required = true;
  urlInput.placeholder = 'https://example.com/feed.xml';
  urlInput.autocomplete = 'url';
  nameLabel.append(nameInput);
  urlLabel.append(urlInput);
  const submit = button('Add source', 'import-primary', () => {});
  submit.type = 'submit';
  form.append(nameLabel, urlLabel, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    addSource(form);
  });
  section.append(form, node('p', 'add-sideways-note', 'Search stays unavailable until a credential-free public endpoint is configured. Saving a discovered item privately remains a separate explicit action.'), sourceList());
  statusMessages(section);
  return section;
}

function openFileImport() {
  const input = document.getElementById('sidewaysImportFiles');
  if (!input) {
    error = 'The file importer is not ready yet.';
    scheduleRender();
    return;
  }
  input.accept = '';
  emit('file-picker-open');
  if (typeof input.showPicker === 'function') input.showPicker();
  else input.click();
}

async function restoreBackup() {
  if (!window.SidewaysVaultUI?.chooseArk) {
    error = 'Backup restore is not ready yet.';
    scheduleRender();
    return;
  }
  try {
    emit('backup-picker-open');
    const file = await window.SidewaysVaultUI.chooseArk();
    if (!file) return;
    const result = await Survival.restoreArk(file);
    notice = 'Sideways backup restored.';
    view = 'home';
    emit('backup-restored', { result: result || null });
    window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { source: 'sideways-backup', restored: true } }));
  } catch (caught) {
    error = caught?.name === 'AbortError' ? '' : (caught?.message || 'Backup restore failed.');
  }
  scheduleRender();
}

function activateChoice(id) {
  emit('choice', { choice: id });
  if (id === 'connected') setView('connected');
  else if (id === 'web') setView('web');
  else if (id === 'private') openFileImport();
  else if (id === 'shared') void restoreBackup();
}

function currentView() {
  if (view === 'connected') return connectedView();
  if (view === 'web') return webView();
  return homeView();
}

function render({ force = false } = {}) {
  const target = host();
  const addView = document.getElementById('addView');
  if (!target || !addView || addView.hidden) return false;
  const legacyIdle = target.querySelector('.source-chooser');
  const ours = target.querySelector('[data-add-to-sideways]');
  if (!force && !legacyIdle && !ours && target.children.length) return false;
  target.replaceChildren(currentView());
  document.documentElement.dataset.addToSidewaysReady = 'yes';
  return true;
}

function boot() {
  scheduleRender();
  for (const delay of [80, 280, 900, 1800]) {
    setTimeout(() => {
      if (document.documentElement.dataset.addToSidewaysReady !== 'yes') scheduleRender();
    }, delay);
  }
}

window.addEventListener('sideways:importworkbench', () => {
  if (host()?.querySelector('.source-chooser')) scheduleRender();
});
window.addEventListener('hashchange', () => {
  if ((location.hash || '#/feed') !== '#/add') {
    view = 'home';
    notice = '';
    error = '';
    return;
  }
  scheduleRender();
});
for (const eventName of ['sideways:ready', 'sideways:feedrender']) window.addEventListener(eventName, scheduleRender);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();

window.SidewaysAddToSideways = Object.freeze({
  choices: CHOICES,
  render: () => render({ force: true }),
  open: (next = 'home') => {
    view = next;
    if ((location.hash || '#/feed') !== '#/add') location.hash = '#/add';
    scheduleRender();
  },
  sources: () => collection.list(),
  storageKey: SOURCE_STORAGE_KEY
});
