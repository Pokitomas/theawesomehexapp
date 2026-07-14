import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../..', import.meta.url);
const text = path => readFile(new URL(path, root), 'utf8');

test('recursive weave sprawl declares a finite dependency graph and cognition boundary', async () => {
  const [planText, note, protocol] = await Promise.all([
    text('notes/recursive-weave-sprawl.json'),
    text('notes/recursive-weave-sprawl.md'),
    text('WEAVE_PROTOCOL.md')
  ]);
  const plan = JSON.parse(planText);
  assert.equal(plan.root, 'recursive-weave');
  assert.ok(plan.lanes.length >= 8);
  assert.equal(new Set(plan.lanes.map(lane => lane.id)).size, plan.lanes.length);
  assert.ok(plan.lanes.some(lane => lane.id === 'safety-bounds'));
  assert.ok(plan.lanes.some(lane => lane.id === 'assembly'));
  assert.match(note, /No hidden chain-of-thought persistence/);
  assert.match(note, /finite budget, deduplication key, stop condition/);
  assert.match(note, /Agents are transient inference organs/);
  assert.match(protocol, /typed collaboration layer/);
});
