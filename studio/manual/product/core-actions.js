import { actionButton, bindAction } from './actions.js';
import { deleteEntry, getRecord } from './workspace-records.js';

const CORE_CONTROLS = Object.freeze([
  ['.source-link', 'record.source'],
  ['.identity-row', 'record.author'],
  ['.actions > [data-action="open"]', 'record.open'],
  ['.actions > [data-action="save"]', 'record.save'],
  ['.actions > [data-action="collect"]', 'record.collect'],
  ['.actions > [data-action="share"]', 'record.share']
]);

let scheduled = false;

function installDelete(card, recordId) {
  if (!recordId || card.querySelector('[data-action-id="post.delete"]')) return;
  const actions = card.querySelector('.actions');
  if (!actions) return;
  const button = actionButton('post.delete', async () => {
    if (!confirm('Delete this item from this device?')) return { cancelled: true };
    await deleteEntry(recordId);
    return { recordId };
  }, {
    className: 'workspace-core-delete',
    label: 'DEL',
    ariaLabel: 'Delete item',
    payload: { recordId }
  });
  actions.append(button);
}

async function contractCard(card) {
  const recordId = Number(card.dataset.id || 0) || 0;
  for (const [selector, actionId] of CORE_CONTROLS) {
    const node = card.querySelector(selector);
    if (!node || node.dataset.actionId) continue;
    const ariaLabel = node.getAttribute('aria-label') || node.textContent.trim();
    bindAction(node, actionId, () => null, { payload: { recordId }, ariaLabel });
  }
  if (!recordId) return;
  const record = await getRecord(recordId);
  const workspaceOwned = String(record?.nativeId || '').startsWith('sideways:');
  if (!workspaceOwned) installDelete(card, recordId);
}

async function contractCoreControls() {
  await Promise.all([...document.querySelectorAll('#feed .post')].map(contractCard));
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(async () => {
    scheduled = false;
    await contractCoreControls();
  });
}

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'sideways:workspacechange', 'hashchange', 'popstate']) {
  window.addEventListener(eventName, schedule);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();
for (const delay of [80, 280, 900]) setTimeout(schedule, delay);

window.SidewaysCoreActions = Object.freeze({ contract: schedule, controls: CORE_CONTROLS });
