import { actionButton } from './actions.js';
import { Workspace } from './workspace.js';
import { SidewaysNetwork } from './network/index.js';
import { networkPostId } from './network/schema.js';

let accountDialog = null;
let pendingReply = null;
let scheduled = false;
let publishing = false;

const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
};

function setStatus(node, text = '', tone = '') {
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
  node.hidden = !text;
}

function field(label, type = 'text', attributes = {}) {
  const wrap = el('label', 'network-field');
  wrap.append(el('span', 'network-field-label', label));
  const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  input.className = 'network-input';
  if (type !== 'textarea') input.type = type;
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'value') input.value = value || '';
    else if (value !== undefined && value !== null) input[key] = value;
  }
  wrap.append(input);
  return { wrap, input };
}

function closeAccount() {
  if (!accountDialog) return;
  if (accountDialog.open && accountDialog.close) accountDialog.close();
  accountDialog.remove();
  accountDialog = null;
}

function openDialog(dialog) {
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute('open', '');
}

function signedOutBody(dialog) {
  let mode = 'signup';
  const body = el('div', 'network-body');
  const note = el('p', 'network-note', 'Public identity lives on the network. Your imports, drafts, collections, feed state, and Ark remain on this device.');
  const email = field('Email', 'email', { autocomplete: 'email', maxLength: 254 });
  const password = field('Password', 'password', { autocomplete: 'new-password', minLength: 10, maxLength: 200 });
  const handle = field('Handle', 'text', { autocomplete: 'username', maxLength: 30, placeholder: 'yourhandle' });
  const displayName = field('Display name', 'text', { autocomplete: 'name', maxLength: 64 });
  const bio = field('Bio', 'textarea', { maxLength: 280, rows: 3 });
  const status = el('p', 'network-status'); status.hidden = true;
  const actions = el('div', 'network-actions');
  const submit = actionButton('network.signup', async () => {
    submit.disabled = true;
    setStatus(status, mode === 'signup' ? 'Creating account…' : 'Signing in…');
    try {
      const result = mode === 'signup'
        ? await SidewaysNetwork.session.signup({ email: email.input.value, password: password.input.value, handle: handle.input.value, displayName: displayName.input.value, bio: bio.input.value })
        : await SidewaysNetwork.session.login({ email: email.input.value, password: password.input.value });
      await SidewaysNetwork.sync.following();
      setStatus(status, `Signed in as @${result.user.handle}.`, 'good');
      setTimeout(() => { closeAccount(); schedule(); }, 250);
      return { userId: result.user.id, mode };
    } catch (error) {
      setStatus(status, error.message || 'Could not connect.', 'error');
      return { cancelled: true, error: error.message };
    } finally { submit.disabled = false; }
  }, { className: 'network-primary', label: 'Create account' });
  const toggle = actionButton('network.login', () => {
    mode = mode === 'signup' ? 'login' : 'signup';
    const signup = mode === 'signup';
    handle.wrap.hidden = !signup;
    displayName.wrap.hidden = !signup;
    bio.wrap.hidden = !signup;
    password.input.autocomplete = signup ? 'new-password' : 'current-password';
    submit.textContent = signup ? 'Create account' : 'Log in';
    toggle.textContent = signup ? 'I already have an account' : 'Create a new account';
    setStatus(status, '');
    return { mode };
  }, { className: 'network-secondary', label: 'I already have an account' });
  actions.append(submit, toggle);
  body.append(note, email.wrap, password.wrap, handle.wrap, displayName.wrap, bio.wrap, status, actions);
  dialog._network = { status };
  return body;
}

function signedInBody(dialog, identity) {
  const body = el('div', 'network-body');
  const identityCard = el('section', 'network-identity');
  identityCard.append(el('strong', '', identity.displayName), el('span', '', `@${identity.handle}`), el('p', '', identity.bio || 'Public identity'));
  const privacy = el('p', 'network-note', 'This public identity and its posts follow you across devices. The private workspace below does not upload or transfer automatically.');
  const find = field('Find a handle to follow', 'text', { maxLength: 30, placeholder: 'otherperson' });
  const status = el('p', 'network-status'); status.hidden = true;
  const actions = el('div', 'network-actions');
  const follow = actionButton('user.follow', async () => {
    follow.disabled = true;
    try {
      const result = await SidewaysNetwork.profile.get(find.input.value);
      if (result.user.id === identity.id) throw new Error('That is your account.');
      await SidewaysNetwork.graph.follow(result.user.id);
      await SidewaysNetwork.sync.following();
      setStatus(status, `Following @${result.user.handle}.`, 'good');
      return { userId: result.user.id };
    } catch (error) {
      setStatus(status, error.message || 'Could not follow.', 'error');
      return { cancelled: true, error: error.message };
    } finally { follow.disabled = false; }
  }, { className: 'network-primary', label: 'Follow' });
  const sync = actionButton('network.sync', async () => {
    sync.disabled = true;
    try {
      const result = await SidewaysNetwork.sync.following();
      setStatus(status, `${result.cache.count} public posts synced.`, 'good');
      return result.cache;
    } catch (error) {
      setStatus(status, error.message || 'Could not sync.', 'error');
      return { cancelled: true, error: error.message };
    } finally { sync.disabled = false; }
  }, { className: 'network-secondary', label: 'Sync feed' });
  const logout = actionButton('network.logout', async () => {
    await SidewaysNetwork.session.logout();
    await SidewaysNetwork.sync.clearNetworkCache();
    closeAccount(); schedule();
    return { signedOut: true };
  }, { className: 'network-secondary is-danger', label: 'Log out' });
  actions.append(follow, sync, logout);
  body.append(identityCard, privacy, find.wrap, status, actions);
  dialog._network = { status };
  return body;
}

function buildAccountDialog() {
  const dialog = el('dialog', 'network-dialog');
  dialog.dataset.networkAccountDialog = 'true';
  const shell = el('section', 'network-window');
  const bar = el('header', 'network-bar');
  bar.append(el('strong', '', SidewaysNetwork.session.signedIn() ? 'Network account' : 'Join Sideways'), actionButton('network.close', closeAccount, { className: 'network-close', label: 'Close' }));
  const identity = SidewaysNetwork.profile.identity();
  shell.append(bar, identity ? signedInBody(dialog, identity) : signedOutBody(dialog));
  dialog.append(shell);
  dialog.addEventListener('close', () => { dialog.remove(); accountDialog = null; }, { once: true });
  return dialog;
}

function openAccount() {
  closeAccount();
  accountDialog = buildAccountDialog();
  document.body.append(accountDialog);
  openDialog(accountDialog);
  setTimeout(() => accountDialog?.querySelector('input')?.focus(), 40);
}

function installAccountLauncher() {
  let button = document.querySelector('[data-sideways-account-launch]');
  if (!button) {
    button = actionButton('network.account', openAccount, { className: 'network-launch', label: 'JOIN' });
    button.dataset.sidewaysAccountLaunch = 'true';
  }
  const identity = SidewaysNetwork.profile.identity();
  button.textContent = identity ? `@${identity.handle}` : 'JOIN';
  button.setAttribute('aria-label', identity ? `Network account @${identity.handle}` : 'Join Sideways network');
  const host = document.querySelector('[data-workspace-title-actions]') || document.querySelector('.topline');
  if (host && button.parentElement !== host) host.prepend(button);
}

function augmentComposer() {
  const dialog = document.querySelector('[data-workspace-composer]');
  if (!dialog) return;
  let control = dialog.querySelector('[data-network-publish-control]');
  if (!control) {
    control = el('label', 'network-publish-control');
    control.dataset.networkPublishControl = 'true';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = SidewaysNetwork.session.signedIn();
    checkbox.disabled = !SidewaysNetwork.session.signedIn();
    checkbox.dataset.networkPublic = 'true';
    control.append(checkbox, el('span', '', checkbox.disabled ? 'Local only — join to publish publicly' : 'Publish publicly'));
    dialog.querySelector('.workspace-composer-tools')?.before(control);
  }
  let reply = dialog.querySelector('[data-network-reply-context]');
  if (pendingReply) {
    if (!reply) {
      reply = el('div', 'network-reply-context');
      reply.dataset.networkReplyContext = 'true';
      dialog.querySelector('.workspace-composer-body')?.prepend(reply);
    }
    reply.textContent = `Replying to @${pendingReply.handle || 'user'}`;
  } else reply?.remove();
}

async function decorateNetworkCards() {
  const cards = [...document.querySelectorAll('#feed .post')];
  await Promise.all(cards.map(async card => {
    const id = Number(card.dataset.id || 0);
    if (!id) return;
    const record = await Workspace.getRecord(id);
    const postId = networkPostId(record || {});
    if (postId) {
      card.dataset.networkPostId = postId;
      card.dataset.networkAuthorHandle = String(record.author?.handle || '').replace(/^@/, '');
    } else {
      delete card.dataset.networkPostId;
      delete card.dataset.networkAuthorHandle;
    }
  }));
}

function paintLike(button, active) {
  button.classList.toggle('is-active', active);
  button.setAttribute('aria-pressed', String(active));
  const label = active ? 'Liked' : 'Like';
  const span = button.querySelector('span');
  if (span) span.textContent = label; else button.textContent = label;
  button.setAttribute('aria-label', label);
  button.dataset.actionLabel = label;
}

async function publishPublic(button, dialog) {
  if (publishing) return;
  const checkbox = dialog.querySelector('[data-network-public]');
  if (!checkbox?.checked) return false;
  if (!SidewaysNetwork.session.signedIn()) { openAccount(); return true; }
  const text = dialog.querySelector('.workspace-composer-text')?.value.trim() || '';
  const hasImage = Boolean(dialog.querySelector('.workspace-image-preview img'));
  const status = dialog.querySelector('.workspace-inline-status');
  if (hasImage) { setStatus(status, 'Public alpha is text-only. Remove the photo or publish locally.', 'error'); return true; }
  if (!text) { setStatus(status, 'Write something first.', 'error'); return true; }
  publishing = true;
  button.disabled = true;
  setStatus(status, pendingReply ? 'Publishing reply…' : 'Publishing publicly…');
  try {
    const result = await SidewaysNetwork.posts.create({ body: text, replyToId: pendingReply?.id || null, visibility: 'public' });
    await Workspace.clearDraft();
    await SidewaysNetwork.sync.following();
    pendingReply = null;
    if (dialog.open && dialog.close) dialog.close();
    if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo('#/feed');
    return { postId: result.post.id };
  } catch (error) {
    setStatus(status, error.message || 'Could not publish.', 'error');
    return { error: error.message };
  } finally { publishing = false; button.disabled = false; }
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action-id]');
  if (!target) return;
  const actionId = target.dataset.actionId;
  if (actionId === 'post.publish') {
    const dialog = target.closest('[data-workspace-composer]');
    if (!dialog?.querySelector('[data-network-public]')?.checked) return;
    event.preventDefault(); event.stopImmediatePropagation();
    await publishPublic(target, dialog);
    return;
  }
  if (!['post.reply', 'post.like'].includes(actionId)) return;
  const card = target.closest('.post');
  const postId = card?.dataset.networkPostId || '';
  if (!postId) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (actionId === 'post.reply') {
    pendingReply = { id: postId, handle: card.dataset.networkAuthorHandle || '' };
    await window.SidewaysWorkspaceUI?.openComposer?.({ text: pendingReply.handle ? `@${pendingReply.handle} ` : '' });
    augmentComposer();
    return;
  }
  const wasActive = target.getAttribute('aria-pressed') === 'true';
  paintLike(target, !wasActive);
  try {
    if (wasActive) await SidewaysNetwork.posts.unlike(postId); else await SidewaysNetwork.posts.like(postId);
    await SidewaysNetwork.sync.following();
  } catch (error) {
    paintLike(target, wasActive);
    console.warn('[network] like failed', error);
  }
}, true);

function install() {
  installAccountLauncher();
  augmentComposer();
  void decorateNetworkCards().catch(error => console.warn('[network] card decoration failed', error));
  document.documentElement.dataset.sidewaysNetwork = SidewaysNetwork.session.signedIn() ? 'signed-in' : 'ready';
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; install(); });
}

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'sideways:workspacechange', 'sideways:networksession', 'sideways:networkidentity', 'sideways:networkready', 'hashchange', 'popstate']) window.addEventListener(eventName, schedule);
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();
for (const delay of [80, 320, 900]) setTimeout(schedule, delay);

window.SidewaysNetworkUI = Object.freeze({ openAccount, refresh: schedule });
