import { Workspace } from './workspace.js';

const API = '/api/social';
const ACTION_ID = 'social.post.remove';
const TIMEOUT = 9000;
let decorateQueued = false;

function emit(phase, detail = {}) {
  window.dispatchEvent(new CustomEvent('sideways:action', {
    detail: Object.freeze({
      actionId: ACTION_ID,
      surface: 'social',
      intent: 'deactivate_public_post',
      at: new Date().toISOString(),
      phase,
      ...detail
    })
  }));
}

function socialStatus(message, tone = '') {
  const status = document.querySelector('[data-social-spine] .social-spine-status');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
  status.hidden = !message;
}

async function requestRemoval(postId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(`${API}?op=post-state`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId, active: false }),
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

async function removePost(record, button) {
  const postId = record?.social?.postId;
  if (!record?.social?.mine || !postId) return { cancelled: true };
  if (!window.confirm('Remove this public post? Your private archive records will not be changed.')) {
    emit('cancelled', { postId });
    return { cancelled: true };
  }

  button.disabled = true;
  emit('start', { postId });
  socialStatus('Removing public post…');
  try {
    await requestRemoval(postId);
    emit('success', { postId });
    socialStatus('Public post removed. Private archive unchanged.', 'good');
    await window.SidewaysSocial?.refresh?.();
    return { postId, active: false };
  } catch (error) {
    const unavailable = [404, 405, 501].includes(Number(error?.status));
    const message = unavailable
      ? 'Post removal requires the relational social deployment.'
      : (error?.name === 'AbortError' ? 'Post removal timed out.' : error.message);
    emit('error', { postId, error: message });
    socialStatus(message, 'error');
    button.disabled = false;
    return { cancelled: true, error: message };
  }
}

async function decorateCard(card) {
  const recordId = Number(card.dataset.id || 0);
  if (!recordId || card.querySelector(`[data-action-id="${ACTION_ID}"]`)) return;
  const record = await Workspace.getRecord(recordId);
  if (!record?.social?.mine || !record.social.postId) return;
  const footer = card.querySelector('.actions');
  if (!footer) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'frontier-action social-post-remove';
  button.dataset.actionId = ACTION_ID;
  button.dataset.actionIntent = 'deactivate_public_post';
  button.textContent = 'Remove';
  button.setAttribute('aria-label', 'Remove this public post');
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    void removePost(record, button);
  });
  footer.append(button);
}

async function decorate() {
  await Promise.all([...document.querySelectorAll('#feed .post[data-social-post]')].map(decorateCard));
}

function queueDecorate() {
  if (decorateQueued) return;
  decorateQueued = true;
  requestAnimationFrame(() => {
    decorateQueued = false;
    void decorate();
  });
}

for (const name of ['sideways:ready', 'sideways:feedrender', 'sideways:corpusrefresh', 'hashchange', 'popstate']) {
  window.addEventListener(name, queueDecorate);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', queueDecorate, { once: true });
else queueDecorate();

window.SidewaysSocialAuthorControls = Object.freeze({ refresh: queueDecorate });
