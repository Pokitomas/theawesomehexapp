import { actionButton } from './actions.js';
import { createNetworkActivationGate } from './network-records.js';
import { Workspace } from './workspace.js';

const API = '/api/social';
const TIMEOUT = 9000;
const loadEpoch = createNetworkActivationGate();
let account = null;
let mode = 'discover';
let available = false;
let busy = false;
let shell = null;
let status = null;
let accountDialog = null;
let postDialog = null;
let profileDialog = null;
let decorateQueued = false;

const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
};

async function request(op, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const query = new URLSearchParams({ op });
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && String(value) !== '') query.set(key, String(value));
  }
  const { query: _query, ...fetchOptions } = options;
  try {
    const response = await fetch(`${API}?${query}`, {
      ...fetchOptions,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(fetchOptions.headers || {}) },
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

const unavailable = error => error?.name === 'AbortError' || error instanceof TypeError || [404, 405, 501].includes(Number(error?.status));

function setStatus(message = '', tone = '') {
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
  status.hidden = !message;
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (dialog.open && dialog.close) dialog.close();
  dialog.remove();
}

function syncBusy() {
  shell?.querySelectorAll('button').forEach(button => { button.disabled = busy; });
}

async function run(task) {
  if (busy) return { cancelled: true };
  busy = true;
  syncBusy();
  try { return await task(); }
  finally { busy = false; syncBusy(); }
}

function field(label, name, type = 'text') {
  const wrap = el('label', 'social-field');
  wrap.append(el('span', 'social-field-label', label));
  const input = type === 'textarea' ? el('textarea', 'social-input') : el('input', 'social-input');
  input.name = name;
  if (type !== 'textarea') input.type = type;
  input.autocomplete = type === 'password' ? 'current-password' : 'off';
  wrap.append(input);
  return { wrap, input };
}

function openAccount(kind = 'register') {
  closeDialog(accountDialog);
  const register = kind !== 'login';
  const dialog = el('dialog', 'social-dialog');
  dialog.dataset.socialAccount = kind;
  const windowNode = el('section', 'social-window');
  const bar = el('header', 'social-titlebar');
  bar.append(el('strong', '', register ? 'Join the public feed' : 'Sign in'), actionButton('social.close', () => closeDialog(dialog), { className: 'social-close', label: 'Close' }));
  const body = el('div', 'social-window-body');
  const name = field('Name', 'name');
  const handle = field('Handle', 'handle');
  const password = field('Password', 'password', 'password');
  password.input.minLength = 8;
  password.input.maxLength = 200;
  if (register) body.append(name.wrap);
  body.append(handle.wrap, password.wrap);
  const message = el('p', 'social-dialog-status');
  message.hidden = true;
  const submit = actionButton(register ? 'social.join' : 'social.login', () => run(async () => {
    message.hidden = false;
    message.dataset.tone = '';
    message.textContent = register ? 'Creating account…' : 'Signing in…';
    try {
      const data = await request(register ? 'register' : 'login', {
        method: 'POST',
        body: JSON.stringify({ name: name.input.value, handle: handle.input.value, password: password.input.value })
      });
      account = data.account;
      mode = 'following';
      closeDialog(dialog);
      accountDialog = null;
      renderShell();
      await load('following');
      return { handle: account.handle };
    } catch (error) {
      message.dataset.tone = 'error';
      message.textContent = error.message;
      return { cancelled: true };
    }
  }), { className: 'social-primary', label: register ? 'Join' : 'Sign in' });
  const swap = actionButton(register ? 'social.login' : 'social.join', () => openAccount(register ? 'login' : 'register'), { className: 'social-secondary', label: register ? 'I have an account' : 'Create account' });
  const footer = el('footer', 'social-window-footer');
  footer.append(message, swap, submit);
  windowNode.append(bar, body, footer);
  dialog.append(windowNode);
  document.body.append(dialog);
  accountDialog = dialog;
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  setTimeout(() => (register ? name.input : handle.input).focus(), 50);
}

async function openProfile() {
  if (!account) { openAccount('login'); return; }
  closeDialog(profileDialog);
  const dialog = el('dialog', 'social-dialog');
  dialog.dataset.socialProfile = 'true';
  const windowNode = el('section', 'social-window');
  const bar = el('header', 'social-titlebar');
  bar.append(el('strong', '', 'Public profile'), actionButton('social.close', () => closeDialog(dialog), { className: 'social-close', label: 'Close' }));
  const body = el('div', 'social-window-body');
  const message = el('p', 'social-dialog-status', 'Loading profile…');
  const name = field('Public name', 'name');
  const handle = field('Public handle', 'handle');
  const bio = field('Public bio', 'bio', 'textarea');
  name.input.maxLength = 48;
  handle.input.maxLength = 30;
  bio.input.maxLength = 180;
  bio.input.rows = 4;
  body.append(message, name.wrap, handle.wrap, bio.wrap);
  const save = actionButton('social.profile.save', () => run(async () => {
    message.hidden = false;
    message.dataset.tone = '';
    message.textContent = 'Saving public profile…';
    try {
      const data = await request('profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: name.input.value, handle: handle.input.value, bio: bio.input.value })
      });
      account = data.account;
      message.dataset.tone = 'good';
      message.textContent = `Saved @${account.handle}. Local archive identity was not changed.`;
      renderShell();
      return { handle: account.handle };
    } catch (error) {
      message.dataset.tone = 'error';
      message.textContent = error.message;
      return { cancelled: true };
    }
  }), { className: 'social-primary', label: 'Save profile' });
  const footer = el('footer', 'social-window-footer');
  footer.append(save);
  windowNode.append(bar, body, footer);
  dialog.append(windowNode);
  document.body.append(dialog);
  profileDialog = dialog;
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  try {
    const data = await request('profile', { query: { handle: account.handle } });
    const profile = data.account || account;
    name.input.value = profile.name || '';
    handle.input.value = profile.handle || '';
    bio.input.value = profile.bio || '';
    message.hidden = true;
    setTimeout(() => name.input.focus(), 50);
  } catch (error) {
    message.dataset.tone = 'error';
    message.textContent = error.message;
    save.disabled = true;
  }
}

function openPost(record = null) {
  if (!account) { openAccount('login'); return; }
  closeDialog(postDialog);
  const dialog = el('dialog', 'social-dialog');
  dialog.dataset.socialComposer = 'true';
  const windowNode = el('section', 'social-window');
  const bar = el('header', 'social-titlebar');
  bar.append(el('strong', '', record ? `Reply to @${record.social.authorHandle}` : 'Public post'), actionButton('social.close', () => closeDialog(dialog), { className: 'social-close', label: 'Close' }));
  const body = el('div', 'social-window-body');
  if (record) body.append(el('p', 'social-reply-source', record.text || record.summary || record.title || 'Post'));
  const text = field(record ? 'Your reply' : 'Say something', 'text', 'textarea');
  text.input.maxLength = 4000;
  text.input.rows = 6;
  body.append(text.wrap);
  const message = el('p', 'social-dialog-status');
  message.hidden = true;
  const publish = actionButton('social.post', () => run(async () => {
    message.hidden = false;
    message.dataset.tone = '';
    message.textContent = record ? 'Replying…' : 'Publishing…';
    try {
      await request('post', { method: 'POST', body: JSON.stringify({ text: text.input.value, replyTo: record?.social?.postId || null }) });
      closeDialog(dialog);
      postDialog = null;
      await load(mode);
      return { replyTo: record?.social?.postId || null };
    } catch (error) {
      message.dataset.tone = 'error';
      message.textContent = error.message;
      return { cancelled: true };
    }
  }), { className: 'social-primary', label: record ? 'Reply' : 'Publish' });
  const footer = el('footer', 'social-window-footer');
  footer.append(message, publish);
  windowNode.append(bar, body, footer);
  dialog.append(windowNode);
  document.body.append(dialog);
  postDialog = dialog;
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  setTimeout(() => text.input.focus(), 50);
}

async function load(nextMode = mode) {
  if (!available) return { unavailable: true };
  const requestedMode = nextMode === 'following' && account ? 'following' : 'discover';
  mode = requestedMode;
  const activation = loadEpoch.begin(requestedMode);
  setStatus(requestedMode === 'following' ? 'Loading people you follow…' : 'Loading public posts…');
  try {
    const data = await request(requestedMode === 'following' ? 'feed' : 'discover');
    const projection = await Workspace.projectNetworkPosts(data.posts || [], {
      mode: requestedMode,
      requestedAt: activation.requestedAt,
      activation,
      isCurrent: () => loadEpoch.isCurrent(activation)
    });
    if (!loadEpoch.isCurrent(activation) || projection?.superseded) return { ...data, superseded: true };
    setStatus(`${data.posts?.length || 0} public post${data.posts?.length === 1 ? '' : 's'}.`, 'good');
    renderShell();
    queueDecorate();
    return { ...data, superseded: false };
  } catch (error) {
    if (!loadEpoch.isCurrent(activation)) return { superseded: true };
    if (unavailable(error)) {
      available = false;
      shell?.remove();
      shell = null;
      return { unavailable: true };
    }
    setStatus(error.message, 'error');
    return { error: error.message };
  }
}

async function signOut() {
  await request('logout', { method: 'POST', body: '{}' }).catch(() => {});
  account = null;
  mode = 'discover';
  renderShell();
  return load('discover');
}

function renderShell() {
  if (!available) return;
  const feedView = document.getElementById('feedView');
  const feed = document.getElementById('feed');
  if (!feedView || !feed) return;
  if (!shell) {
    shell = el('section', 'social-spine');
    shell.dataset.socialSpine = 'true';
    feed.before(shell);
  }
  shell.replaceChildren();
  const identity = el('div', 'social-identity');
  identity.append(el('strong', '', account ? `@${account.handle}` : 'PUBLIC FEED'), el('span', '', account ? account.name : 'Server-backed people and posts'));
  const actions = el('div', 'social-spine-actions');
  if (account) {
    actions.append(
      actionButton('social.feed', () => load('following'), { className: `social-command${mode === 'following' ? ' is-active' : ''}`, label: 'FOLLOWING' }),
      actionButton('social.discover', () => load('discover'), { className: `social-command${mode === 'discover' ? ' is-active' : ''}`, label: 'EXPLORE' }),
      actionButton('social.post', () => openPost(), { className: 'social-command social-command-primary', label: 'POST' }),
      actionButton('social.profile', () => openProfile(), { className: 'social-command', label: 'PROFILE' }),
      actionButton('social.refresh', () => load(mode), { className: 'social-command', label: 'REFRESH' }),
      actionButton('social.logout', () => run(signOut), { className: 'social-command', label: 'SIGN OUT' })
    );
  } else {
    actions.append(
      actionButton('social.join', () => openAccount('register'), { className: 'social-command social-command-primary', label: 'JOIN' }),
      actionButton('social.login', () => openAccount('login'), { className: 'social-command', label: 'SIGN IN' }),
      actionButton('social.discover', () => load('discover'), { className: `social-command${mode === 'discover' ? ' is-active' : ''}`, label: 'EXPLORE' })
    );
  }
  status = el('p', 'social-spine-status');
  status.hidden = true;
  shell.append(identity, actions, status);
  syncBusy();
}

async function decorateCard(card) {
  const recordId = Number(card.dataset.id || 0);
  if (!recordId) return;
  const record = await Workspace.getRecord(recordId);
  if (!record?.social?.postId) {
    card.removeAttribute('data-social-post');
    return;
  }
  card.dataset.socialPost = record.social.postId;
  const footer = card.querySelector('.actions');
  if (!footer) return;
  const like = footer.querySelector('[data-action-id="post.like"]');
  if (like) {
    const label = `${record.social.liked ? 'Liked' : 'Like'}${record.social.likeCount ? ` ${record.social.likeCount}` : ''}`;
    like.textContent = label;
    like.setAttribute('aria-label', label);
    like.setAttribute('aria-pressed', String(Boolean(record.social.liked)));
    like.classList.toggle('is-active', Boolean(record.social.liked));
  }
  const reply = footer.querySelector('[data-action-id="post.reply"]');
  if (reply) {
    const label = `Reply${record.social.replyCount ? ` ${record.social.replyCount}` : ''}`;
    reply.textContent = label;
    reply.setAttribute('aria-label', label);
  }
  let follow = footer.querySelector('[data-action-id="social.follow"]');
  if (!record.social.mine) {
    if (!follow) {
      follow = actionButton('social.follow', () => toggleFollow(record), { className: 'frontier-action social-follow', label: 'Follow', payload: { recordId } });
      footer.append(follow);
    }
    const label = record.social.following ? 'Following' : 'Follow';
    follow.textContent = label;
    follow.setAttribute('aria-label', `${label} @${record.social.authorHandle}`);
    follow.classList.toggle('is-active', Boolean(record.social.following));
  } else follow?.remove();
}

async function decorate() {
  await Promise.all([...document.querySelectorAll('#feed .post')].map(decorateCard));
}

function queueDecorate() {
  if (decorateQueued) return;
  decorateQueued = true;
  requestAnimationFrame(() => {
    decorateQueued = false;
    void decorate();
  });
}

async function recordForCard(target) {
  const card = target.closest('#feed .post');
  const recordId = Number(card?.dataset.id || 0);
  return recordId ? Workspace.getRecord(recordId) : null;
}

async function toggleLike(record) {
  if (!account) { openAccount('login'); return { cancelled: true }; }
  const active = !record.social.liked;
  await request('like', { method: 'POST', body: JSON.stringify({ postId: record.social.postId, active }) });
  await load(mode);
  return { active };
}

async function toggleFollow(record) {
  if (!account) { openAccount('login'); return { cancelled: true }; }
  const active = !record.social.following;
  await request('follow', { method: 'POST', body: JSON.stringify({ handle: record.social.authorHandle, active }) });
  await load(mode);
  return { active };
}

document.addEventListener('click', event => {
  const action = event.target.closest('#feed .post [data-action-id="post.like"], #feed .post [data-action-id="post.reply"]');
  if (!action) return;
  const card = action.closest('#feed .post');
  if (!card?.dataset.socialPost) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void recordForCard(action).then(record => {
    if (!record?.social?.postId) return;
    if (action.dataset.actionId === 'post.like') void run(() => toggleLike(record));
    else openPost(record);
  });
}, true);

for (const name of ['sideways:ready', 'sideways:feedrender', 'sideways:corpusrefresh', 'hashchange', 'popstate']) {
  window.addEventListener(name, () => { renderShell(); queueDecorate(); });
}

async function boot() {
  try {
    const data = await request('session');
    available = true;
    account = data.account || null;
    mode = account ? 'following' : 'discover';
    renderShell();
    await load(mode);
  } catch (error) {
    if (!unavailable(error)) console.warn('[social] boot failed', error);
    available = false;
  }
  document.documentElement.dataset.socialReady = available ? 'yes' : 'unavailable';
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
else void boot();

window.SidewaysSocial = Object.freeze({
  available: () => available,
  account: () => account,
  mode: () => mode,
  refresh: () => load(mode),
  discover: () => load('discover'),
  following: () => load('following'),
  join: () => openAccount('register'),
  login: () => openAccount('login'),
  profile: () => openProfile(),
  post: () => openPost()
});
