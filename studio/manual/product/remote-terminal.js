import { actionButton } from './actions.js';

const DEFAULT_SESSION = 'theawesomehexapp/universal-remote';
const POLL_MS = 15_000;
const BACKGROUND_MS = 60_000;

let dialog = null;
let latest = null;
let pollTimer = 0;
let openButton = null;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function sessionId() {
  return document.querySelector('meta[name="sideways-remote-session"]')?.content || DEFAULT_SESSION;
}

function endpoint() {
  const url = new URL('/api/remote/state', location.origin);
  url.searchParams.set('session', sessionId());
  url.searchParams.set('public', '1');
  return url;
}

function ensureDiscovery() {
  if (document.querySelector('link[data-sideways-remote-state]')) return;
  const link = document.createElement('link');
  link.rel = 'alternate';
  link.type = 'application/json';
  link.title = 'Sideways live work state';
  link.href = endpoint().href;
  link.dataset.sidewaysRemoteState = 'true';
  document.head.append(link);
}

function humanDecision(value) {
  return ({ proceed: 'moving', pause: 'paused', stop: 'stopping', superseded: 'newer work', terminal: 'complete' })[value] || 'waiting';
}

function messageText(message = {}) {
  const payload = message.payload || {};
  return String(payload.action || payload.summary || payload.title || payload.text || 'Work updated.').trim();
}

function shortHead(value) {
  return value ? String(value).slice(0, 9) : '—';
}

function timeLabel(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function render(data, { fallback = false } = {}) {
  latest = data;
  const state = data?.state || data || {};
  document.documentElement.dataset.remoteDecision = state.decision || 'unknown';
  if (openButton) {
    openButton.dataset.decision = state.decision || 'unknown';
    openButton.querySelector('[data-remote-dot]')?.setAttribute('data-state', state.decision || 'unknown');
    openButton.title = `Live work: ${humanDecision(state.decision)}`;
  }
  if (!dialog?.isConnected) return;

  const status = dialog.querySelector('[data-remote-status]');
  const head = dialog.querySelector('[data-remote-head]');
  const generation = dialog.querySelector('[data-remote-generation]');
  const claims = dialog.querySelector('[data-remote-claims]');
  const blockers = dialog.querySelector('[data-remote-blockers]');
  const timeline = dialog.querySelector('[data-remote-timeline]');
  const note = dialog.querySelector('[data-remote-note]');

  status.textContent = humanDecision(state.decision);
  status.dataset.decision = state.decision || 'unknown';
  head.textContent = shortHead(state.head_sha || data?.base_head);
  generation.textContent = String(state.generation || data?.generation || '—');
  claims.textContent = String(Array.isArray(state.claims) ? state.claims.length : Object.keys(state.claims || {}).length);
  blockers.textContent = String(state.blocker_count || 0);
  note.textContent = fallback ? 'Static bootstrap report. The live backend is not connected on this origin.' : 'Read-only live project state. Controls and credentials never enter the browser.';

  timeline.replaceChildren();
  const messages = Array.isArray(data?.messages) ? [...data.messages].reverse() : [];
  if (!messages.length) {
    timeline.append(el('p', 'remote-terminal-empty', fallback ? (data?.intent || 'Build report ready.') : 'No public work messages yet.'));
  } else {
    for (const message of messages.slice(0, 18)) {
      const item = el('article', 'remote-terminal-message');
      const meta = el('header', 'remote-terminal-message-meta');
      meta.append(el('strong', '', message.issuer || 'principal'), el('time', '', timeLabel(message.issued_at)));
      const text = el('p', '', messageText(message));
      item.append(meta, text);
      if (message.head_sha) item.append(el('code', '', shortHead(message.head_sha)));
      timeline.append(item);
    }
  }
  window.dispatchEvent(new CustomEvent('sideways:remoteupdate', { detail: { data, fallback } }));
}

async function fetchBootstrap() {
  const response = await fetch('./remote-session.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`bootstrap ${response.status}`);
  return response.json();
}

async function refresh({ quiet = false } = {}) {
  try {
    const response = await fetch(endpoint(), { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`live state ${response.status}`);
    const data = await response.json();
    render(data);
    return data;
  } catch (error) {
    try {
      const bootstrap = await fetchBootstrap();
      render(bootstrap, { fallback: true });
      return bootstrap;
    } catch {
      if (!quiet && dialog?.isConnected) {
        render({ state: { decision: 'unknown', generation: null, claims: [], blocker_count: 0 }, messages: [] }, { fallback: true });
        dialog.querySelector('[data-remote-note]').textContent = 'Live work is unavailable on this origin.';
      }
      return null;
    }
  }
}

function closeTerminal() {
  clearInterval(pollTimer);
  pollTimer = 0;
  if (dialog?.open && dialog.close) dialog.close();
  else dialog?.removeAttribute('open');
}

function buildDialog() {
  const node = el('dialog', 'remote-terminal');
  node.dataset.remoteTerminal = 'true';
  node.setAttribute('aria-label', 'Live work terminal');

  const windowNode = el('section', 'remote-terminal-window');
  const titlebar = el('header', 'remote-terminal-titlebar');
  const title = el('div', 'remote-terminal-title');
  title.append(el('span', 'remote-terminal-light'), el('strong', '', 'LIVE WORK'));
  const close = actionButton('remote.close', closeTerminal, { className: 'remote-terminal-close', label: 'Close', ariaLabel: 'Close live work' });
  close.textContent = '×';
  titlebar.append(title, close);

  const body = el('div', 'remote-terminal-body');
  const summary = el('section', 'remote-terminal-summary');
  const stat = (label, hook) => {
    const box = el('div', 'remote-terminal-stat');
    box.append(el('span', '', label), el('strong', '', '—'));
    box.lastChild.dataset[hook] = 'true';
    return box;
  };
  summary.append(stat('STATE', 'remoteStatus'), stat('HEAD', 'remoteHead'), stat('GEN', 'remoteGeneration'), stat('CLAIMS', 'remoteClaims'), stat('BLOCKERS', 'remoteBlockers'));

  const timelineHeader = el('div', 'remote-terminal-section-title');
  timelineHeader.append(el('span', '', 'CURRENT WORK'), actionButton('remote.refresh', () => refresh(), { className: 'remote-terminal-refresh', label: 'Refresh' }));
  const timeline = el('div', 'remote-terminal-timeline');
  timeline.dataset.remoteTimeline = 'true';
  const note = el('p', 'remote-terminal-note');
  note.dataset.remoteNote = 'true';
  body.append(summary, timelineHeader, timeline, note);
  windowNode.append(titlebar, body);
  node.append(windowNode);
  node.addEventListener('close', () => { clearInterval(pollTimer); pollTimer = 0; });
  document.body.append(node);
  return node;
}

function openTerminal() {
  if (!dialog?.isConnected) dialog = buildDialog();
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute('open', '');
  if (latest) render(latest);
  void refresh();
  clearInterval(pollTimer);
  pollTimer = window.setInterval(() => void refresh({ quiet: true }), POLL_MS);
}

function install() {
  ensureDiscovery();
  if (!document.querySelector('meta[name="sideways-remote-session"]')) {
    const meta = document.createElement('meta');
    meta.name = 'sideways-remote-session';
    meta.content = DEFAULT_SESSION;
    document.head.append(meta);
  }
  openButton = actionButton('remote.open', openTerminal, { className: 'remote-terminal-open', label: 'Live work', ariaLabel: 'Open live work' });
  openButton.dataset.remoteOpen = 'true';
  openButton.replaceChildren(el('span', 'remote-terminal-open-dot'), el('span', '', 'LIVE'));
  openButton.firstChild.dataset.remoteDot = 'true';
  document.body.append(openButton);
  void refresh({ quiet: true });
  window.setInterval(() => { if (!dialog?.open) void refresh({ quiet: true }); }, BACKGROUND_MS);
}

window.SidewaysRemoteTerminal = Object.freeze({ open: openTerminal, refresh, state: () => latest, endpoint: () => endpoint().href });

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
