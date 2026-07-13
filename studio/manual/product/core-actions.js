import { bindAction } from './actions.js';

const CORE_CONTROLS = Object.freeze([
  ['.source-link', 'record.source'],
  ['.identity-row', 'record.author'],
  ['.actions > [data-action="open"]', 'record.open'],
  ['.actions > [data-action="save"]', 'record.save'],
  ['.actions > [data-action="collect"]', 'record.collect'],
  ['.actions > [data-action="share"]', 'record.share']
]);

let scheduled = false;

function contractCard(card) {
  const recordId = Number(card.dataset.id || 0) || 0;
  for (const [selector, actionId] of CORE_CONTROLS) {
    const node = card.querySelector(selector);
    if (!node || node.dataset.actionId) continue;
    const ariaLabel = node.getAttribute('aria-label') || node.textContent.trim();
    bindAction(node, actionId, () => null, { payload: { recordId }, ariaLabel });
  }
}

function contractCoreControls() {
  for (const card of document.querySelectorAll('#feed .post')) contractCard(card);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    contractCoreControls();
  });
}

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'sideways:workspacechange', 'hashchange', 'popstate']) {
  window.addEventListener(eventName, schedule);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();
for (const delay of [80, 280, 900]) setTimeout(schedule, delay);

window.SidewaysCoreActions = Object.freeze({ contract: schedule, controls: CORE_CONTROLS });
