import { actionButton } from './actions.js';
import { Survival } from './survival-ledger.js';

let scheduled = false;
let busy = false;
let restoreInput = null;

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function formatBytes(value = 0) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

function fallbackRestoreInput() {
  if (restoreInput) return restoreInput;
  restoreInput = document.createElement('input');
  restoreInput.type = 'file';
  restoreInput.accept = '.sideways,application/x-sideways-ark';
  restoreInput.hidden = true;
  restoreInput.id = 'sidewaysArkRestore';
  document.body.append(restoreInput);
  return restoreInput;
}

async function chooseArk() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Sideways Ark', accept: { 'application/x-sideways-ark': ['.sideways'] } }] });
      return handle ? await handle.getFile() : null;
    } catch (error) {
      if (error?.name === 'AbortError') return null;
      throw error;
    }
  }
  const input = fallbackRestoreInput();
  input.value = '';
  return new Promise(resolve => {
    input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
    input.click();
  });
}

async function run(task) {
  if (busy) return { cancelled: true };
  busy = true;
  schedule();
  try { return await task(); } finally { busy = false; schedule(); }
}

function action(id, handler) {
  const button = actionButton(id, () => run(handler), { className: 'survival-vault-action' });
  button.disabled = busy;
  return button;
}

async function render(host) {
  if (!host?.isConnected) return;
  const [status, audit] = await Promise.all([Survival.status(), Survival.audit({ record: false })]);
  if (!host.isConnected) return;
  const state = node('div', 'survival-vault-state');
  state.append(node('strong', 'survival-vault-grade', status.grade), node('span', 'survival-vault-count', `${audit.records}/${audit.assets}`), node('span', 'survival-vault-bytes', formatBytes(audit.bytes)));
  const actions = node('div', 'survival-vault-actions');
  actions.append(
    action('vault.persist', async () => ({ durability: await window.SidewaysWorkspace.durability({ request: true }), mirror: await Survival.mirrorAll() })),
    action('vault.audit', () => Survival.audit()),
    action('vault.export', () => Survival.exportArk()),
    action('vault.restore', async () => {
      const file = await chooseArk();
      if (!file) return { cancelled: true };
      return Survival.restoreArk(file);
    })
  );
  host.replaceChildren(state, actions);
  host.dataset.grade = status.grade;
  host.setAttribute('aria-label', `Storage ${status.grade}. ${audit.records} records. ${audit.assets} assets.`);
}

function mount() {
  const addView = document.getElementById('addView');
  if (!addView) return;
  let host = addView.querySelector('section[data-survival-vault]');
  if (!host) {
    host = node('section', 'survival-vault');
    host.dataset.survivalVault = 'true';
    const importHost = document.getElementById('importWorkbenchHost');
    if (importHost) importHost.before(host);
    else addView.prepend(host);
  }
  void render(host).catch(error => console.warn('[vault] render failed', error));
  document.documentElement.dataset.vaultReady = 'yes';
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; mount(); });
}

for (const eventName of ['hashchange', 'popstate', 'sideways:ready', 'sideways:workspacechange', 'sideways:survivalchange', 'sideways:importworkbench']) window.addEventListener(eventName, schedule);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();
for (const delay of [120, 480, 1200]) setTimeout(schedule, delay);

window.SidewaysVaultUI = Object.freeze({ refresh: schedule, chooseArk });
