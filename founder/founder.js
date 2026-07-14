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

export function applyReaction(input, direction, reaction) {
  const decision = normalizeDecision(input);
  if (!DIRECTIONS.includes(direction) || !REACTIONS.includes(reaction)) return decision;
  return normalizeDecision({
    ...decision,
    reactions: { ...decision.reactions, [direction]: reaction }
  });
}

export function stableReceipt(input = {}) {
  return JSON.stringify(normalizeDecision(input), null, 2) + '\n';
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

export function createDecisionStorage(storage) {
  return Object.freeze({
    load() {
      try { return normalizeDecision(JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')); }
      catch { return normalizeDecision(); }
    },
    save(decision) {
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(normalizeDecision(decision)));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      try {
        storage?.removeItem(STORAGE_KEY);
        return true;
      } catch {
        return false;
      }
    }
  });
}

function downloadReceipt(doc, receipt) {
  const blob = new Blob([receipt], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = href;
  link.download = 'sideways-founder-round-001.json';
  link.click();
  URL.revokeObjectURL(href);
}

export function mountFounderRoom(doc = document, storage = localStorage) {
  const persistence = createDecisionStorage(storage);
  let decision = persistence.load();
  const note = doc.querySelector('#founder-note');
  const summary = doc.querySelector('#summary');
  const status = doc.querySelector('#room-status');
  const cards = [...doc.querySelectorAll('[data-direction]')];

  const setStatus = message => {
    if (status) status.textContent = message;
  };

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
    const persisted = persistence.save(decision);
    setStatus(persisted ? 'Saved locally in this browser.' : 'Browser storage is unavailable. Export before closing this tab.');
    render();
  };

  for (const card of cards) {
    card.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest('[data-reaction]');
      if (!button) return;
      commit(applyReaction(decision, card.dataset.direction, button.dataset.reaction));
    });
  }

  note?.addEventListener('input', () => commit({ ...decision, note: note.value }));
  doc.querySelector('#copy-receipt')?.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(stableReceipt(decision));
      setStatus('Decision receipt copied.');
    } catch {
      setStatus('Clipboard unavailable. Use DOWNLOAD JSON instead.');
    }
  });
  doc.querySelector('#download-receipt')?.addEventListener('click', () => {
    downloadReceipt(doc, stableReceipt(decision));
    setStatus('Decision receipt downloaded.');
  });
  doc.querySelector('#reset-room')?.addEventListener('click', () => {
    const cleared = persistence.clear();
    decision = normalizeDecision();
    setStatus(cleared ? 'Founder room reset.' : 'Room reset in this tab; browser storage could not be cleared.');
    render();
  });

  render();
  return Object.freeze({ getDecision: () => normalizeDecision(decision) });
}

if (typeof document !== 'undefined' && typeof localStorage !== 'undefined') mountFounderRoom();
