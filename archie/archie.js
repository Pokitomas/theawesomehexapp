const $ = id => document.getElementById(id);
const STORAGE_KEY = 'archie:knowledge-utility:v2';
const FIELDS = ['objective', 'project', 'base', 'protected', 'proof'];
let deferredInstall = null;

const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const stable = value => JSON.stringify(canonical(value));
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const escapeHtml = value => value.replace(/[<>&]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[character]);

function formState() {
  return Object.fromEntries(FIELDS.map(id => [id, $(id).value.trim()]));
}
function authorities() {
  return [...document.querySelectorAll('.authority input:checked')].map(input => input.value);
}
async function buildPacket() {
  const current = formState();
  const payload = {
    schema: 'archie-objective-packet/v1',
    created_at: new Date().toISOString(),
    objective: current.objective,
    world: { project: current.project || null, base: current.base || null },
    protected_reality: current.protected || null,
    proof_of_done: current.proof || null,
    authority: {
      granted: authorities(),
      human_gates: ['merge', 'production-data', 'credentials', 'external-spending'],
      execution:'not-performed'
    },
    continuity: { surface: 'archie-knowledge-utility', storage: 'local-device', runtime: 'unobserved' },
    claim_boundary: 'This packet records intent and authority. It does not claim execution, model capability, deployment, or completion.'
  };
  return { ...payload, packet_digest: await digest(stable(payload)) };
}
async function render(message = 'Draft saved locally. No model execution claimed.') {
  const current = formState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, authorities: authorities() }));
  const packet = await buildPacket();
  $('packet').textContent = JSON.stringify(packet, null, 2);
  $('packet-card').innerHTML = current.objective
    ? `<strong>PACKET READY</strong><p>${escapeHtml(current.objective).slice(0, 260)}</p>`
    : '<strong>NO OBJECTIVE YET</strong><p>Enter a request to create a portable packet.</p>';
  $('status-message').textContent = message;
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    FIELDS.forEach(id => { $(id).value = saved[id] || ''; });
    if (Array.isArray(saved.authorities)) {
      document.querySelectorAll('.authority input').forEach(input => { input.checked = saved.authorities.includes(input.value); });
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}
async function copyPacket() {
  await navigator.clipboard.writeText(JSON.stringify(await buildPacket(), null, 2));
  await render('Packet copied to clipboard.');
}
async function sharePacket() {
  const text = JSON.stringify(await buildPacket(), null, 2);
  if (navigator.share) await navigator.share({ title: 'Archie objective packet', text });
  else await navigator.clipboard.writeText(text);
  await render(navigator.share ? 'Share sheet opened.' : 'Share unavailable; packet copied instead.');
}
function updateNetwork() {
  $('network-dot').style.background = navigator.onLine ? '#00aa00' : '#ffcc00';
  $('runtime-state').textContent = navigator.onLine ? 'ONLINE / RUNTIME UNOBSERVED' : 'OFFLINE / LOCAL ONLY';
  $('continuity-state').textContent = navigator.onLine ? 'Online; local draft recovered' : 'Offline; local draft recovered';
}

restore();
FIELDS.forEach(id => $(id).addEventListener('input', () => render()));
document.querySelectorAll('.authority input').forEach(input => input.addEventListener('change', () => render()));
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  $('objective').value = button.dataset.prompt;
  $('objective').focus();
  render('Starter inserted. Edit it into the actual finished reality.');
}));
document.querySelectorAll('[data-focus]').forEach(button => button.addEventListener('click', () => {
  const target = button.dataset.focus === 'packet' ? $('packet') : $(button.dataset.focus);
  target?.focus();
}));
document.querySelector('[data-open-packet]').addEventListener('click', () => $('packet').focus());
document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.command === 'new') {
    localStorage.removeItem(STORAGE_KEY);
    FIELDS.forEach(id => { $(id).value = ''; });
    render('New blank request opened.');
  } else if (button.dataset.command === 'copy') copyPacket().catch(() => render('Clipboard access failed.'));
  else if (button.dataset.command === 'help') render('Help: write the result, identify the workspace, protect reality, define proof, then open Maker.');
  else render(`${button.textContent} inspector is visible in the current window.`);
}));
$('copy').addEventListener('click', () => copyPacket().catch(() => render('Clipboard access failed.')));
$('share').addEventListener('click', () => sharePacket().catch(() => render('Sharing failed. The packet remains visible below.')));
$('clear').addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  FIELDS.forEach(id => { $(id).value = ''; });
  document.querySelectorAll('.authority input').forEach(input => { input.checked = ['read', 'research'].includes(input.value); });
  render('Local notebook cleared.');
});
window.addEventListener('online', updateNetwork);
window.addEventListener('offline', updateNetwork);
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstall = event;
  $('install').hidden = false;
});
$('install').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $('install').hidden = true;
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
updateNetwork();
render('Ready. Local organizer only; no model execution claimed.');
