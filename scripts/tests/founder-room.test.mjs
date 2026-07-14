import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DIRECTIONS,
  ROOM_VERSION,
  applyReaction,
  createDecisionStorage,
  normalizeDecision,
  stableReceipt,
  summarizeDecision
} from '../../founder/founder.js';

const html = fs.readFileSync('founder/index.html', 'utf8');
const css = fs.readFileSync('founder/founder.css', 'utf8');

for (const direction of DIRECTIONS) assert.ok(html.includes(`data-direction="${direction}"`));
for (const reaction of ['pull', 'push', 'steal']) assert.ok(html.includes(`data-reaction="${reaction}"`));
assert.ok(html.includes('id="founder-note"'));
assert.ok(html.includes('id="copy-receipt"'));
assert.ok(html.includes('id="download-receipt"'));
assert.ok(html.includes('id="room-status"'));
assert.ok(html.includes('<link rel="icon" href="data:,">'), 'founder room must not emit an implicit favicon 404');
assert.ok(css.includes('@media (max-width: 520px)'));

const normalized = normalizeDecision({
  reactions: {
    'memory-social': 'pull',
    'private-remix': 'steal',
    'scene-social': 'invalid',
    unknown: 'push'
  },
  note: '  make memory social, but steal the remix tools  '
});
assert.deepEqual(normalized, {
  version: ROOM_VERSION,
  round: '001',
  reactions: {
    'memory-social': 'pull',
    'private-remix': 'steal'
  },
  note: 'make memory social, but steal the remix tools'
});

const reacted = applyReaction(normalized, 'scene-social', 'push');
assert.equal(reacted.reactions['scene-social'], 'push');
assert.deepEqual(applyReaction(reacted, 'unknown', 'pull'), reacted);
assert.deepEqual(applyReaction(reacted, 'scene-social', 'invalid'), reacted);

const receipt = stableReceipt(reacted);
assert.equal(receipt, stableReceipt(JSON.parse(receipt)));
assert.ok(receipt.endsWith('\n'));
assert.equal(
  summarizeDecision(normalized),
  'social identity with memory: pull · private remixable life feed: steal'
);
assert.equal(summarizeDecision({}), 'No direction selected yet.');

const memory = new Map();
const storage = createDecisionStorage({
  getItem: key => memory.get(key) || null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: key => memory.delete(key)
});
assert.equal(storage.save(reacted), true);
assert.deepEqual(storage.load(), reacted);
assert.equal(storage.clear(), true);
assert.deepEqual(storage.load(), normalizeDecision());

const brokenStorage = createDecisionStorage({
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); }
});
assert.deepEqual(brokenStorage.load(), normalizeDecision());
assert.equal(brokenStorage.save(reacted), false);
assert.equal(brokenStorage.clear(), false);

console.log('founder room contract ok: three distinct directions produce resilient local decisions and deterministic receipts');
