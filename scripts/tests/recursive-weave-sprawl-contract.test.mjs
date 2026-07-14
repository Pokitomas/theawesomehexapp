import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../..', import.meta.url);
const text = path => readFile(new URL(path, root), 'utf8');

test('recursive weave sprawl declares a finite acyclic dependency graph and cognition boundary', async () => {
  const [planText, note, protocol] = await Promise.all([
    text('notes/recursive-weave-sprawl.json'),
    text('notes/recursive-weave-sprawl.md'),
    text('WEAVE_PROTOCOL.md')
  ]);
  const plan = JSON.parse(planText);
  assert.equal(plan.root, 'recursive-weave');
  assert.ok(plan.lanes.length >= 8);
  const ids = new Set(plan.lanes.map(lane => lane.id));
  assert.equal(ids.size, plan.lanes.length);
  for (const lane of plan.lanes) {
    assert.ok(lane.owns.length > 0, lane.id);
    for (const dependency of lane.depends_on) assert.ok(ids.has(dependency), `${lane.id}:${dependency}`);
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(plan.lanes.map(lane => [lane.id, lane]));
  const walk = id => {
    assert.ok(!visiting.has(id), `cycle:${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on) walk(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) walk(id);
  assert.ok(ids.has('safety-bounds'));
  assert.ok(ids.has('assembly'));
  assert.match(note, /No hidden chain-of-thought persistence/);
  assert.match(note, /finite budget, deduplication key, stop condition/);
  assert.match(note, /Agents are transient inference organs/);
  assert.match(protocol, /typed collaboration layer/);
});
