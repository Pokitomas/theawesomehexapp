import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DIRECTIONS, ROOM_VERSION, normalizeDecision, stableReceipt, summarizeDecision } from '../../founder/founder.js';

const html = fs.readFileSync('founder/index.html', 'utf8');
const css = fs.readFileSync('founder/founder.css', 'utf8');

for (const direction of DIRECTIONS) assert.ok(html.includes(`data-direction="${direction}"`));
for (const reaction of ['pull', 'push', 'steal']) assert.ok(html.includes(`data-reaction="${reaction}"`));
assert.ok(html.includes('id="founder-note"'));
assert.ok(html.includes('id="copy-receipt"'));
assert.ok(html.includes('id="download-receipt"'));
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

const receipt = stableReceipt(normalized);
assert.equal(receipt, stableReceipt(JSON.parse(receipt)));
assert.ok(receipt.endsWith('\n'));
assert.equal(
  summarizeDecision(normalized),
  'social identity with memory: pull · private remixable life feed: steal'
);
assert.equal(summarizeDecision({}), 'No direction selected yet.');

console.log('founder room contract ok: three distinct directions produce a local, normalized, deterministic decision receipt');
