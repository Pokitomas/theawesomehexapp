import { actionButton } from './actions.js';
import { Workspace } from './workspace.js';
import { buildRecord, insertRecord, refreshCorpus } from './workspace-records.js';
import { starterPack } from './starter-pack.js';

const DEVICE_KEY = 'sideways-device-v1';
const LIKE_KEY = 'sideways-likes-v1';
const STARTER_KEY = 'sideways-starter-pack-v1';
const PENDING_PROFILE_KEY = 'sideways-pending-profile-v1';
const BACKEND_TIMEOUT = 9000;

let profileDialog = null;
let handleTimer = 0;
let installing = false;
let renderQueued = false;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function deviceId() {
  let value = localStorage.getItem(DEVICE_KEY);
  if (!value) {
    value = crypto.randomUUID?.() || `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, value);
  }
  return value;
}

function complete(profile = Workspace.profile()) {
  return Boolean(profile.name && profile.name !== 'You' && profile.handle);
}

function initials(name = 'You') {
  return String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || 'Y';
}

function normalizeHandle(value = '') {
  return String(value).replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 30);
}

async function backend(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT);
  try {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function starterUnavailable(error) {
  return error?.name === 'AbortError' || error instanceof TypeError || [404, 405, 501].includes(Number(error?.status));
}

async function starterResult(profile) {
  try {
    return await backend('/api/starter', {
      method: 'POST',
      body: JSON.stringify({ deviceId: deviceId(), profile })
    });
  } catch (error) {
    if (!starterUnavailable(error)) throw error;
    return { version: 1, items: starterPack(profile), source: 'built-in' };
  }
}

async function syncPendingProfile() {
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_PROFILE_KEY) || 'null'); }
  catch { localStorage.removeItem(PENDING_PROFILE_KEY); }
  if (!pending) return false;
  try {
    const result = await backend('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ ...pending, deviceId: deviceId() })
    });
    Workspace.saveProfile(result.profile);
    localStorage.removeItem(PENDING_PROFILE_KEY);
    return true;
  } catch {
    return false;
  }
}

function setStatus(node, text = '', tone = '') {
  node.textContent = text;
  node.dataset.tone = tone;
  node.hidden = !text;
}

function closeProfile() {
  if (!profileDialog) return;
  if (profileDialog.open && profileDialog.close) profileDialog.close();
  profileDialog.remove();
  profileDialog = null;
}

function inputField(label, name, value = '', options = {}) {
  const wrap = el('label', 'frontier-field');
  const top = el('span', 'frontier-field-top');
  top.append(el('span', '', label));
  const note = el('span', 'frontier-field-note', options.note || '');
  top.append(note);
  const input = document.createElement(options.multiline ? 'textarea' : 'input');
  input.name = name;
  input.value = value;
  input.className = 'frontier-input';
  input.autocomplete = options.autocomplete || 'off';
  input.maxLength = options.maxLength || 100;
  if (options.multiline) input.rows = options.rows || 3;
  if (options.placeholder) input.placeholder = options.placeholder;
  wrap.append(top, input);
  return { wrap, input, note };
}

function accentPicker(current, onChange) {
  const fieldset = el('fieldset', 'frontier-accents');
  fieldset.append(el('legend', '', 'Color'));
  for (const value of Workspace.accents) {
    const button = actionButton('profile.accent', () => onChange(value), {
      className: 'frontier-swatch',
      label: value,
      ariaLabel: `Use ${value}`,
      payload: { value }
    });
    button.style.setProperty('--swatch', value);
    button.dataset.value = value;
    button.classList.toggle('is-selected', value === current);
    button.textContent = '';
    fieldset.append(button);
  }
  return fieldset;
}

async function installStarter(status, button) {
  if (installing) return;
  installing = true;
  button.disabled = true;
  setStatus(status, 'Making your feed…');
  try {
    const profile = Workspace.profile();
    const result = await starterResult(profile);
    const existing = new Set((await Workspace.listRecords()).map(record => record.nativeId).filter(Boolean));
    let inserted = 0;
    for (const item of result.items || []) {
      const nativeId = `starter:${item.id}`;
      if (existing.has(nativeId)) continue;
      const record = await buildRecord({
        text: item.text || item.title || '',
        title: item.title || '',
        summary: item.summary || item.text || '',
        url: item.url || '',
        tags: ['sideways:starter', ...(item.tags || [])]
      }, {
        nativeId,
        createdAt: item.published || new Date().toISOString(),
        author: item.author || { name: 'Sideways', handle: '@sideways', url: '', avatar: '' }
      });
      record.source = item.source || 'Sideways';
      record.sourceUrl = item.sourceUrl || '';
      record.type = item.type || 'social';
      record.tags = ['sideways:starter', ...(item.tags || [])];
      await insertRecord(record);
      inserted += 1;
    }
    localStorage.setItem(STARTER_KEY, JSON.stringify({ version: result.version || 1, at: new Date().toISOString() }));
    await refreshCorpus({ action: 'starter', count: inserted });
    setStatus(status, inserted ? `${inserted} good things, ready.` : 'Already here.');
    button.textContent = 'Done';
    setTimeout(closeProfile, 550);
  } catch (error) {
    setStatus(status, error.name === 'AbortError' ? 'The server took too long. Tap again.' : error.message, 'error');
    button.disabled = false;
  } finally {
    installing = false;
  }
}

function starterStep(dialog) {
  const section = el('section', 'frontier-starter-step');
  const status = el('p', 'frontier-status');
  status.hidden = true;
  section.append(
    el('p', 'frontier-kicker', 'Your feed is empty'),
    el('h2', '', 'Want a running start?'),
    el('p', '', 'One tap brings in a small live pack from Sideways. Delete any of it whenever.')
  );
  const actions = el('div', 'frontier-starter-actions');
  const fill = actionButton('profile.start', () => installStarter(status, fill), { className: 'frontier-primary', label: 'Make it alive' });
  const skip = actionButton('profile.skip_start', () => closeProfile(), { className: 'frontier-secondary', label: 'Not yet' });
  actions.append(fill, skip);
  section.append(status, actions);
  dialog.querySelector('[data-frontier-main]').replaceChildren(section);
  const footer = dialog.querySelector('.frontier-footer');
  if (footer) footer.hidden = true;
}

function buildProfileDialog({ onboarding = false } = {}) {
  const profile = Workspace.profile();
  const dialog = el('dialog', 'frontier-dialog');
  dialog.dataset.frontierProfile = 'true';

  const shell = el('section', 'frontier-window');
  const bar = el('header', 'frontier-titlebar');
  const title = el('div', 'frontier-title');
  title.append(el('span', 'frontier-title-dot'), el('span', '', onboarding ? 'Make your profile' : 'Your profile'));
  const close = actionButton('profile.close', closeProfile, { className: 'frontier-close', label: 'Close', ariaLabel: 'Close profile' });
  close.textContent = '×';
  bar.append(title, close);

  const main = el('div', 'frontier-main');
  main.dataset.frontierMain = 'true';
  const hero = el('div', 'frontier-profile-hero');
  let draftAccent = profile.accent || Workspace.accents[0];
  const avatar = el('div', 'frontier-avatar', initials(profile.name));
  avatar.style.setProperty('--profile-accent', draftAccent);
  const heroCopy = el('div');
  const heroName = el('strong', '', profile.name === 'You' ? 'You' : profile.name);
  const heroHandle = el('span', '', profile.handle ? `@${profile.handle}` : 'Pick a handle');
  heroCopy.append(heroName, heroHandle);
  hero.append(avatar, heroCopy);

  const intro = el('div', 'frontier-profile-intro');
  intro.append(el('h1', '', onboarding ? 'Claim a corner of the internet.' : 'Feels like you.'), el('p', '', 'Three fields. No résumé. No personality quiz.'));

  const name = inputField('Name', 'name', profile.name === 'You' ? '' : profile.name, { autocomplete: 'name', maxLength: 48, placeholder: 'What people call you' });
  const handle = inputField('Handle', 'handle', profile.handle ? `@${profile.handle}` : '', { maxLength: 31, placeholder: '@you', note: 'letters, numbers, . _ -' });
  const bio = inputField('A line about you', 'bio', profile.bio || '', { multiline: true, maxLength: 180, rows: 3, placeholder: 'Optional. Keep it human.' });
  const handleStatus = el('p', 'frontier-handle-status');
  handleStatus.hidden = true;

  const accents = accentPicker(draftAccent, value => {
    draftAccent = value;
    avatar.style.setProperty('--profile-accent', value);
    accents.querySelectorAll('.frontier-swatch').forEach(node => node.classList.toggle('is-selected', node.dataset.value === value));
  });

  name.input.addEventListener('input', () => {
    heroName.textContent = name.input.value.trim() || 'You';
    avatar.textContent = initials(name.input.value);
  });
  handle.input.addEventListener('input', () => {
    const normalized = normalizeHandle(handle.input.value);
    handle.input.value = normalized ? `@${normalized}` : '';
    heroHandle.textContent = normalized ? `@${normalized}` : 'Pick a handle';
    clearTimeout(handleTimer);
    if (normalized.length < 2) {
      setStatus(handleStatus, 'Two characters minimum.', 'quiet');
      return;
    }
    setStatus(handleStatus, 'Checking…', 'quiet');
    handleTimer = setTimeout(async () => {
      try {
        const data = await backend(`/api/profile?handle=${encodeURIComponent(normalized)}&deviceId=${encodeURIComponent(deviceId())}`, { method: 'GET' });
        setStatus(handleStatus, data.available ? 'Yours if you want it.' : 'That one is taken.', data.available ? 'good' : 'error');
      } catch {
        setStatus(handleStatus, 'We will save it here and sync when the server is back.', 'quiet');
      }
    }, 350);
  });

  const status = el('p', 'frontier-status');
  status.hidden = true;
  const footer = el('footer', 'frontier-footer');
  const save = actionButton('profile.save', async () => {
    const next = {
      name: name.input.value,
      handle: handle.input.value,
      bio: bio.input.value,
      accent: draftAccent
    };
    const normalizedHandle = normalizeHandle(next.handle);
    if (!next.name.trim()) {
      name.input.focus();
      setStatus(status, 'Give us a name.', 'error');
      return { cancelled: true };
    }
    if (normalizedHandle.length < 2) {
      handle.input.focus();
      setStatus(status, 'Pick a handle with at least two characters.', 'error');
      return { cancelled: true };
    }
    save.disabled = true;
    setStatus(status, 'Saving…');
    let remote = false;
    try {
      const result = await backend('/api/profile', {
        method: 'POST',
        body: JSON.stringify({ ...next, handle: normalizedHandle, deviceId: deviceId() })
      });
      remote = true;
      Workspace.saveProfile(result.profile);
      localStorage.removeItem(PENDING_PROFILE_KEY);
    } catch (error) {
      if (/taken/i.test(error.message)) {
        setStatus(status, error.message, 'error');
        save.disabled = false;
        return { cancelled: true };
      }
      const pending = { ...next, handle: normalizedHandle };
      Workspace.saveProfile(pending);
      localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(pending));
    }
    window.SidewaysWorkspaceUI?.refresh?.();
    const records = await Workspace.listRecords();
    setStatus(status, remote ? 'Saved.' : 'Saved here. The server can catch up later.', remote ? 'good' : 'quiet');
    if (!records.length && !localStorage.getItem(STARTER_KEY)) starterStep(dialog);
    else setTimeout(closeProfile, 350);
    save.disabled = false;
    return { remote, handle: normalizedHandle };
  }, { className: 'frontier-primary', label: onboarding ? 'Make my profile' : 'Save', ariaLabel: onboarding ? 'Make my profile' : 'Save' });
  footer.append(status, save);

  main.append(hero, intro, name.wrap, handle.wrap, handleStatus, bio.wrap, accents);
  shell.append(bar, main, footer);
  dialog.append(shell);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!onboarding || complete()) closeProfile();
  });
  return dialog;
}

export function openProfile(options = {}) {
  closeProfile();
  profileDialog = buildProfileDialog(options);
  document.body.append(profileDialog);
  if (profileDialog.showModal) profileDialog.showModal();
  else profileDialog.setAttribute('open', '');
  setTimeout(() => profileDialog?.querySelector('input')?.focus(), 80);
}

function likes() {
  try { return new Set(JSON.parse(localStorage.getItem(LIKE_KEY) || '[]')); }
  catch { return new Set(); }
}

function saveLikes(set) {
  localStorage.setItem(LIKE_KEY, JSON.stringify([...set]));
}

function addSocialActions(card) {
  if (card.dataset.frontierActions === 'true') return;
  const recordId = Number(card.dataset.id || 0);
  const footer = card.querySelector('.actions');
  if (!recordId || !footer) return;
  card.dataset.frontierActions = 'true';
  const relabel = (selector, label) => {
    const node = footer.querySelector(selector);
    if (!node) return;
    node.replaceChildren(label);
    node.setAttribute('aria-label', label);
    node.dataset.actionLabel = label;
  };
  relabel('[data-action="open"]', 'Open');
  footer.querySelector('[data-action="save"]')?.remove();
  relabel('[data-action="collect"]', 'Save');
  relabel('[data-action="share"]', 'Share');

  const likeSet = likes();
  const like = actionButton('post.like', () => {
    const key = String(recordId);
    if (likeSet.has(key)) likeSet.delete(key); else likeSet.add(key);
    saveLikes(likeSet);
    const active = likeSet.has(key);
    like.classList.toggle('is-active', active);
    like.setAttribute('aria-pressed', String(active));
    const label = active ? 'Liked' : 'Like';
    like.querySelector('span').textContent = label;
    like.setAttribute('aria-label', label);
    like.dataset.actionLabel = label;
    return { recordId, active };
  }, { className: 'frontier-action', label: 'Like', payload: { recordId } });
  like.innerHTML = '<span>Like</span>';
  like.classList.toggle('is-active', likeSet.has(String(recordId)));
  like.setAttribute('aria-pressed', String(likeSet.has(String(recordId))));

  const reply = actionButton('post.reply', async () => {
    const record = await Workspace.getRecord(recordId);
    const target = String(record?.author?.handle || '').replace(/^@/, '');
    await window.SidewaysWorkspaceUI?.openComposer?.({ text: target ? `@${target} ` : '' });
    return { recordId };
  }, { className: 'frontier-action', label: 'Reply', payload: { recordId } });

  const remix = actionButton('post.remix', async () => {
    const record = await Workspace.getRecord(recordId);
    const source = record?.title || record?.summary || 'Something worth carrying forward';
    await window.SidewaysWorkspaceUI?.openComposer?.({ text: `↳ ${source}\n\n` });
    return { recordId };
  }, { className: 'frontier-action', label: 'Remix', payload: { recordId } });

  footer.prepend(like, reply, remix);
}

async function startFromEmpty() {
  if (!complete()) {
    openProfile({ onboarding: true });
    return { onboarding: true };
  }
  const actions = document.querySelector('.studio-launch-actions');
  const button = actions?.querySelector('.studio-launch-button.is-import');
  let status = actions?.querySelector('.frontier-empty-status');
  if (!status && actions) {
    status = el('span', 'frontier-empty-status');
    actions.append(status);
  }
  await installStarter(status || el('span'), button || el('button'));
  return { onboarding: false };
}

function installEmptyStart() {
  const actions = document.querySelector('.studio-launch-actions');
  const button = actions?.querySelector('.studio-launch-button.is-import');
  if (!button) return;
  button.dataset.frontierStart = 'true';
  button.setAttribute('aria-label', 'Start me off');
}

function install() {
  document.documentElement.dataset.frontier = 'ready';
  document.querySelectorAll('[data-workspace-profile-dialog]').forEach(node => node.remove());
  document.querySelectorAll('#feed .post').forEach(addSocialActions);
  installEmptyStart();
}

function queueInstall() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    install();
  });
}

document.addEventListener('click', event => {
  const profile = event.target.closest('#navProfile, [data-action-id="profile.open"]');
  if (!profile) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openProfile({ onboarding: false });
}, true);

for (const name of ['sideways:ready', 'sideways:feedrender', 'sideways:workspacechange', 'sideways:profilechange', 'hashchange', 'popstate']) {
  window.addEventListener(name, queueInstall);
}

async function boot() {
  queueInstall();
  if (complete()) void syncPendingProfile();
  else setTimeout(() => openProfile({ onboarding: true }), 650);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
else void boot();

window.SidewaysFrontier = Object.freeze({ openProfile, startFromEmpty, installStarter: () => {
  const status = el('span');
  const button = el('button');
  return installStarter(status, button);
}, deviceId });
