export const ROOM_VERSION = 'sideways-founder-room/v1';
export const STORAGE_KEY = 'sideways:founder-room:round-001';
export const DIRECTIONS = Object.freeze(['memory-social', 'private-remix', 'scene-social']);
export const REACTIONS = Object.freeze(['pull', 'push', 'steal']);

export function normalizeDecision(input = {}) {
  const reactions = {};
  for (const direction of DIRECTIONS) {
    const reaction = String(input?.reactions?.[direction] || '');
    if (REACTIONS.includes(reaction)) reactions[direction] = reaction;
  }
  return {
    version: ROOM_VERSION,
    round: '001',
    reactions,
    note: String(input.note || '').trim().slice(0, 800)
  };
}

export function stableReceipt(input = {}) {
  const normalized = normalizeDecision(input);
  return JSON.stringify(normalized, null, 2) + '\n';
}

export function summarizeDecision(input = {}) {
  const decision = normalizeDecision(input);
  const labels = {
    'memory-social': 'social identity with memory',
    'private-remix': 'private remixable life feed',
    'scene-social': 'scene-first social world'
  };
  const selected = DIRECTIONS
    .filter(direction => decision.reactions[direction])
    .map(direction => `${labels[direction]}: ${decision.reactions[direction]}`);
  return selected.length ? selected.join(' · ') : 'No direction selected yet.';
}

function readStored(storage) {
  try { return normalizeDecision(JSON.parse(storage.getItem(STORAGE_KEY) || '{}')); }
  catch { return normalizeDecision(); }
}

function writeStored(storage, decision) {
  storage.setItem(STORAGE_KEY, JSON.stringify(normalizeDecision(decision)));
}

function downloadReceipt(receipt) {
  const blob = new Blob([receipt], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = 'sideways-founder-round-001.json';
  link.click();
  URL.revokeObjectURL(href);
}

export function mountFounderRoom(doc = document, storage = localStorage) {
  let decision = readStored(storage);
  const note = doc.querySelector('#founder-note');
  const summary = doc.querySelector('#summary');
  const cards = [...doc.querySelectorAll('[data-direction]')];

  const render = () => {
    for (const card of cards) {
      const direction = card.dataset.direction;
      for (const button of card.querySelectorAll('[data-reaction]')) {
        button.setAttribute('aria-pressed', String(decision.reactions[direction] === button.dataset.reaction));
      }
    }
    if (note && note.value !== decision.note) note.value = decision.note;
    if (summary) summary.textContent = summarizeDecision(decision);
  };

  const commit = next => {
    decision = normalizeDecision(next);
    writeStored(storage, decision);
    render();
  };

  for (const card of cards) {
    card.addEventListener('click', event => {
      const button = event.target.closest('[data-reaction]');
      if (!button) return;
      commit({
        ...decision,
        reactions: { ...decision.reactions, [card.dataset.direction]: button.dataset.reaction }
      });
    });
  }

  note?.addEventListener('input', () => commit({ ...decision, note: note.value }));
  doc.querySelector('#copy-receipt')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(stableReceipt(decision));
  });
  doc.querySelector('#download-receipt')?.addEventListener('click', () => downloadReceipt(stableReceipt(decision)));
  doc.querySelector('#reset-room')?.addEventListener('click', () => {
    storage.removeItem(STORAGE_KEY);
    decision = normalizeDecision();
    render();
  });

  render();
  return Object.freeze({ getDecision: () => normalizeDecision(decision) });
}

if (typeof document !== 'undefined' && typeof localStorage !== 'undefined') mountFounderRoom();
