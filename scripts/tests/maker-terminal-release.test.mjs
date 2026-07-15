import assert from 'node:assert/strict';
import test from 'node:test';
import { createMakerTerminalRelease, terminalReleaseForNativeAgent } from '../maker-terminal-release.mjs';
import './maker-engine.contract.mjs';

function deterministicNow() {
  let tick = 0;
  return () => new Date(Date.parse('2026-07-15T08:00:00.000Z') + tick++).toISOString();
}

test('Maker terminal release accounts work and participant before commit', () => {
  const lifecycle = createMakerTerminalRelease({
    generation_id: 'maker-generation-1',
    outer_receipt_id: 'issue-245',
    participant_sessions: ['planner', 'implementer'],
    assignments: ['planning', 'implementation', 'verification'],
    now: deterministicNow()
  });
  lifecycle.prepare('verified outcome reached');
  lifecycle.account('planning', 'completed', 'plan folded');
  lifecycle.account('implementation', 'completed', 'patch finished');
  lifecycle.account('verification', 'completed', 'witnesses passed');
  lifecycle.release('planner', 'planning complete');
  lifecycle.release('implementer', 'implementation complete');
  const state = lifecycle.commit();
  assert.equal(state.status, 'terminal_release_committed');
  assert.equal(state.commit.completed_count, 3);
  assert.equal(state.commit.participant_count, 2);
});

test('Maker cannot commit missing work or admit work after prepare', () => {
  const lifecycle = createMakerTerminalRelease({
    generation_id: 'maker-generation-2',
    outer_receipt_id: 'issue-245',
    assignments: ['implementation'],
    now: deterministicNow()
  });
  lifecycle.prepare('budget exhausted');
  assert.throws(() => lifecycle.start('late-work'), /cannot admit new work/);
  assert.throws(() => lifecycle.commit(), /unaccounted work/);
  lifecycle.account('implementation', 'quarantined', 'budget exhausted');
  lifecycle.release('native-implementation', 'budget exhausted');
  assert.equal(lifecycle.commit().commit.quarantined_count, 1);
});

test('duplicate receipts are idempotent only when content is unchanged', () => {
  const lifecycle = createMakerTerminalRelease({
    generation_id: 'maker-generation-3',
    outer_receipt_id: 'issue-245',
    now: deterministicNow()
  });
  lifecycle.prepare('finished');
  lifecycle.account('implementation', 'completed', 'finished');
  lifecycle.account('implementation', 'completed', 'finished');
  assert.throws(() => lifecycle.account('implementation', 'quarantined', 'changed'), /Changed duplicate/);
  lifecycle.release('native-implementation', 'finished');
  lifecycle.release('native-implementation', 'finished');
  assert.throws(() => lifecycle.release('native-implementation', 'changed'), /Changed duplicate/);
  lifecycle.commit();
  assert.throws(() => lifecycle.start('resurrection'), /cannot admit new work/);
});

test('native agent terminal helper distinguishes completion from quarantine', () => {
  const finished = terminalReleaseForNativeAgent({ status: 'finished', now: deterministicNow() });
  const exhausted = terminalReleaseForNativeAgent({ status: 'budget_exhausted', generation_id: 'next', now: deterministicNow() });
  assert.equal(finished.commit.completed_count, 1);
  assert.equal(exhausted.commit.quarantined_count, 1);
  assert.notEqual(finished.generation_id, exhausted.generation_id);
});
