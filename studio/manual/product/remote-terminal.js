const MANIFEST_FALLBACK = Object.freeze({
  protocol: 'sideways-universal-remote/1',
  live: false,
  state: '/api/remote/state?public=1',
  messages: '/api/remote?public=1',
  snapshot: './remote-snapshot.json',
  terminal: '#live-work'
});

let terminalDialog = null;
let launchButton = null;
let refreshTimer = 0;
let currentManifest = MANIFEST_FALLBACK;
let currentState = null;
let refreshing = null;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function decisionLabel(state = {}) {
  if (state.terminal) return 'COMPLETE';
  const labels = { proceed: 'WORKING', pause: 'PAUSED', stop: 'STOPPING', superseded: 'MOVED ON', terminal: 'COMPLETE' };
  return labels[state.decision] || 'WORKING';
}

function shortSha(value = '') {
  return value ? String(value).slice(0, 9) : '—';
}

function relativeTime(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return 'now';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

async function fetchJSON(url, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function discover() {
  const link = document.querySelector('link[rel="service-desc"][data-sideways-remote]');
  const url = link?.href || './.well-known/sideways-remote.json';
  try {
    currentManifest = { ...MANIFEST_FALLBACK, ...(await fetchJSON(url, 3500)) };
  } catch {
    currentManifest = MANIFEST_FALLBACK;
  }
  return currentManifest;
}

function stateURL() {
  const raw = currentManifest.state || MANIFEST_FALLBACK.state;
  const url = new URL(raw, location.href);
  if (currentManifest.session && !url.searchParams.has('session')) url.searchParams.set('session', currentManifest.session);
  if (!url.searchParams.has('public')) url.searchParams.set('public', '1');
  return url;
}

async function snapshotState() {
  const snapshot = new URL(currentManifest.snapshot || MANIFEST_FALLBACK.snapshot, location.href);
  const data = await fetchJSON(snapshot, 2500);
  return { ...(data.state || data), source: 'snapshot' };
}

async function loadState() {
  if (currentManifest.live === false) return snapshotState();
  try {
    const data = await fetchJSON(stateURL(), 5000);
    return { ...(data.state || data), source: 'live' };
  } catch {
    return snapshotState();
  }
}

function buildEvent(message) {
  const row = el('article', 'remote-event');
  const top = el('div', 'remote-event-top');
  top.append(
    el('span', 'remote-event-principal', message.issuer || 'principal'),
    el('time', 'remote-event-time', relativeTime(message.issued_at))
  );
  const summary = el('p', 'remote-event-summary', message.summary || message.payload?.summary || message.payload?.action || 'Work updated.');
  row.append(top, summary);
  if (message.head_sha) row.append(el('code', 'remote-event-head', shortSha(message.head_sha)));
  return row;
}

function render(state) {
  currentState = state;
  const label = decisionLabel(state);
  document.documentElement.dataset.remoteDecision = state.terminal ? 'terminal' : (state.decision || 'proceed');
  document.documentElement.dataset.remoteGeneration = String(state.generation || 1);
  if (launchButton) {
    launchButton.dataset.decision = state.terminal ? 'terminal' : (state.decision || 'proceed');
    launchButton.querySelector('[data-remote-label]').textContent = label;
    launchButton.querySelector('[data-remote-dot]').setAttribute('aria-label', `${label.toLowerCase()} status`);
  }
  if (!terminalDialog) return;
  terminalDialog.dataset.decision = state.terminal ? 'terminal' : (state.decision || 'proceed');
  terminalDialog.querySelector('[data-remote-state]').textContent = label;
  terminalDialog.querySelector('[data-remote-summary]').textContent = state.summary || 'No public work has been reported yet.';
  terminalDialog.querySelector('[data-remote-session]').textContent = state.session || currentManifest.session || 'project session';
  terminalDialog.querySelector('[data-remote-generation]').textContent = `GEN ${state.generation || 1}`;
  terminalDialog.querySelector('[data-remote-head]').textContent = shortSha(state.head_sha);
  terminalDialog.querySelector('[data-remote-blockers]').textContent = String(state.blocker_count || 0);
  terminalDialog.querySelector('[data-remote-claims]').textContent = String((state.claims || []).length);
  terminalDialog.querySelector('[data-remote-source]').textContent = state.source === 'live' ? 'LIVE' : 'BUILD SNAPSHOT';
  const events = terminalDialog.querySelector('[data-remote-events]');
  const messages = [...(state.messages || [])].sort((a, b) => String(b.issued_at || '').localeCompare(String(a.issued_at || ''))).slice(0, 12);
  events.replaceChildren(...(messages.length ? messages.map(buildEvent) : [el('p', 'remote-empty-events', 'No public work events yet.')]));
  const output = terminalDialog.querySelector('[data-sideways-remote-state]');
  output.value = JSON.stringify(state);
  output.textContent = JSON.stringify(state);
  window.dispatchEvent(new CustomEvent('sideways:remoteupdate', { detail: state }));
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (currentManifest === MANIFEST_FALLBACK) await discover();
    const state = await loadState();
    render(state);
    return state;
  })().catch(error => {
    if (launchButton) launchButton.dataset.decision = 'offline';
    throw error;
  }).finally(() => { refreshing = null; });
  return refreshing;
}

function closeTerminal() {
  if (terminalDialog?.open && terminalDialog.close) terminalDialog.close();
  else terminalDialog?.removeAttribute('open');
}

function buildTerminal() {
  const dialog = el('dialog', 'remote-terminal');
  dialog.id = 'live-work';
  dialog.dataset.sidewaysRemoteTerminal = 'true';
  const shell = el('section', 'remote-terminal-shell');
  const bar = el('header', 'remote-terminal-bar');
  const title = el('div', 'remote-terminal-title');
  title.append(el('span', 'remote-terminal-light'), el('strong', '', 'LIVE WORK'));
  const close = el('button', 'remote-terminal-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close live work');
  close.addEventListener('click', closeTerminal);
  bar.append(title, close);

  const hero = el('div', 'remote-terminal-hero');
  const state = el('strong', 'remote-terminal-state', 'WORKING');
  state.dataset.remoteState = 'true';
  const summary = el('p', 'remote-terminal-summary', 'Reading current work…');
  summary.dataset.remoteSummary = 'true';
  hero.append(state, summary);

  const facts = el('dl', 'remote-terminal-facts');
  const fact = (name, attr, initial) => {
    const wrap = el('div', 'remote-terminal-fact');
    wrap.append(el('dt', '', name), el('dd', '', initial));
    wrap.lastChild.dataset[attr] = 'true';
    return wrap;
  };
  facts.append(
    fact('SESSION', 'remoteSession', 'project session'),
    fact('GENERATION', 'remoteGeneration', 'GEN 1'),
    fact('HEAD', 'remoteHead', '—'),
    fact('CLAIMS', 'remoteClaims', '0'),
    fact('BLOCKERS', 'remoteBlockers', '0'),
    fact('SOURCE', 'remoteSource', 'BUILD SNAPSHOT')
  );

  const eventsHeader = el('div', 'remote-events-header');
  eventsHeader.append(el('strong', '', 'RECENT'), el('span', '', 'public work only'));
  const events = el('div', 'remote-events');
  events.dataset.remoteEvents = 'true';
  const output = el('output', 'remote-machine-state');
  output.dataset.sidewaysRemoteState = 'true';
  output.hidden = true;

  const footer = el('footer', 'remote-terminal-footer');
  const refreshButton = el('button', 'remote-terminal-refresh', 'REFRESH');
  refreshButton.type = 'button';
  refreshButton.addEventListener('click', () => void refresh());
  const manifestLink = el('a', 'remote-terminal-manifest', 'JSON');
  manifestLink.href = './.well-known/sideways-remote.json';
  manifestLink.target = '_blank';
  manifestLink.rel = 'noopener';
  footer.append(refreshButton, manifestLink);

  shell.append(bar, hero, facts, eventsHeader, events, output, footer);
  dialog.append(shell);
  dialog.addEventListener('click', event => { if (event.target === dialog) closeTerminal(); });
  document.body.append(dialog);
  return dialog;
}

async function openTerminal() {
  if (!terminalDialog?.isConnected) terminalDialog = buildTerminal();
  if (typeof terminalDialog.showModal === 'function') terminalDialog.showModal();
  else terminalDialog.setAttribute('open', '');
  await refresh().catch(() => {});
  return currentState;
}

function installLaunch() {
  if (document.querySelector('[data-sideways-remote-launch]')) return document.querySelector('[data-sideways-remote-launch]');
  const button = el('button', 'remote-terminal-launch');
  button.type = 'button';
  button.dataset.sidewaysRemoteLaunch = 'true';
  button.setAttribute('aria-label', 'Open live work terminal');
  const dot = el('span', 'remote-launch-dot');
  dot.dataset.remoteDot = 'true';
  const label = el('span', '', 'LIVE');
  label.dataset.remoteLabel = 'true';
  button.append(dot, label);
  button.addEventListener('click', () => void openTerminal());
  document.body.append(button);
  return button;
}

async function boot() {
  launchButton = installLaunch();
  terminalDialog = buildTerminal();
  await discover();
  await refresh().catch(() => {});
  clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void refresh().catch(() => {}), 30_000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
else void boot();

window.SidewaysRemote = Object.freeze({
  open: openTerminal,
  close: closeTerminal,
  refresh,
  manifest: () => currentManifest,
  state: () => currentState
});
