import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createDistillingChamber, createEventLog, ChamberError, digest } from '../archie-distilling-chamber.mjs';

test('event stream is ordered, cursor-resumable, and deterministic in shape', () => {
  const log = createEventLog({ runId: 'run-1', clock: () => '2026-01-01T00:00:00.000Z' });
  const a = log.append({ phase: 'observation', task_id: 'a' });
  const b = log.append({ phase: 'intention', task_id: 'b', parent_event_id: a.event_id });
  assert.equal(a.sequence, 1);
  assert.equal(b.sequence, 2);
  assert.deepEqual(log.read(0, 1).events.map(x => x.task_id), ['a']);
  assert.deepEqual(log.read(1, 1).events.map(x => x.task_id), ['b']);
});

test('recursive children preserve causal parent edges', async () => {
  const chamber = createDistillingChamber({
    selectChildren: ({ depth }) => depth === 0 ? [{ id: 'child', input: 2 }] : [],
  });
  await chamber.runEpisode({ id: 'root', input: 1 });
  const events = chamber.events(0, 100).events;
  const rootEffect = events.find(e => e.task_id === 'root' && e.phase === 'verified_effect');
  const childIntent = events.find(e => e.task_id === 'child' && e.phase === 'intention');
  assert.equal(childIntent.parent_event_id, rootEffect.event_id);
  assert.equal(childIntent.recursion_depth, 1);
});

test('repeated states are rejected instead of looping', async () => {
  const chamber = createDistillingChamber();
  await chamber.runEpisode({ id: 'same', input: 1 });
  const second = await chamber.runEpisode({ id: 'same', input: 1 });
  assert.equal(second.phase, 'rejection');
  assert.equal(second.reason, 'repeated_state');
});

test('child and depth budgets are enforced', async () => {
  const chamber = createDistillingChamber({ limits: { max_depth: 1, max_children: 1 }, selectChildren: () => [{ id: 'a' }, { id: 'b' }] });
  await assert.rejects(chamber.runEpisode({ id: 'root' }), error => error instanceof ChamberError && error.code === 'child_limit');
});

test('failed attempts become retained negative lessons', async () => {
  const chamber = createDistillingChamber({ execute: async () => { throw Object.assign(new Error('offline'), { code: 'worker_offline' }); } });
  const result = await chamber.runEpisode({ id: 'broken' });
  assert.equal(result.phase, 'rejection');
  assert.equal(chamber.lessons()[0].failure.code, 'worker_offline');
});

test('evaluation controls admission and weakness evidence', async () => {
  const chamber = createDistillingChamber({ evaluate: async () => ({ accepted: false, score: 0.2, weaknesses: ['novel_task'] }) });
  const result = await chamber.runEpisode({ id: 'novel' });
  assert.equal(result.phase, 'rejection');
  assert.deepEqual(chamber.lessons()[0].weaknesses, ['novel_task']);
});

test('pause, resume, and stop are truthful', async () => {
  const chamber = createDistillingChamber();
  chamber.pause();
  await assert.rejects(chamber.runEpisode({ id: 'x' }), error => error.code === 'paused');
  chamber.resume();
  await chamber.runEpisode({ id: 'x' });
  chamber.stop();
  await assert.rejects(chamber.runEpisode({ id: 'y' }), error => error.code === 'stopped');
});

test('checkpoint is digest-bound and restart evidence is serializable', async () => {
  const chamber = createDistillingChamber({ eventLog: createEventLog({ runId: 'checkpoint-run', clock: () => '2026-01-01T00:00:00.000Z' }) });
  await chamber.runEpisode({ id: 'task' });
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'archie-chamber-')), 'checkpoint.json');
  const checkpoint = await chamber.checkpoint(file);
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  const { digest: recorded, ...unsigned } = parsed;
  assert.equal(recorded, digest(unsigned));
  assert.equal(checkpoint.status.episodes, 1);
});

test('event retention is bounded', () => {
  const log = createEventLog({ maxEvents: 1 });
  log.append({ task_id: 'one' });
  assert.throws(() => log.append({ task_id: 'two' }), error => error.code === 'event_limit');
});
