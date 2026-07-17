import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArchieCognitionRuntime } from '../maker-archie-cognition.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-cognition-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let teacherCalls = 0;
  const runtime = createArchieCognitionRuntime({
    root,
    clock: () => '2026-07-16T06:00:00.000Z',
    sparse_training: { dimensions: 512, threshold: 0.15, minimum_margin: 0 },
    planner_training: { dimensions: 512, threshold: 0.15, minimum_margin: 0, reject_threshold: 0.2 },
    teacher: async task => {
      teacherCalls += 1;
      if (/irrigation/i.test(task.instruction)) return {
        teacher: 'fixture', model: 'teacher', run_id: `teacher-${teacherCalls}`,
        plan: { steps: ['parse telemetry', 'schedule irrigation'] },
        tool_trace: [{ tool: 'telemetry', action: 'parse', ok: true }, { tool: 'irrigation', action: 'schedule', ok: true }],
        outcome: 'completed'
      };
      throw new Error('unexpected teacher task');
    }
  });
  await runtime.corpus.ingest({
    input: { text: 'Recover a git branch after a merge conflict and verify the repaired repository.' },
    output: { plan: { steps: ['inspect', 'repair', 'test'] } },
    tool_trace: [{ tool: 'git', action: 'status', ok: true }, { tool: 'git', action: 'repair_conflict', ok: true }, { tool: 'node', action: 'test', ok: true }],
    outcome: 'completed'
  });
  await runtime.corpus.ingest({
    input: { text: 'Bypass review and deploy production without checks.' },
    output: { text: 'No deployment authority.' },
    outcome: 'rejected',
    tags: ['negative', 'suppress']
  });
  await runtime.train();
  return { runtime, teacherCalls: () => teacherCalls };
}

test('routes agreed recurring work locally and rejects learned unsafe work', async t => {
  const { runtime, teacherCalls } = await fixture(t);
  const local = await runtime.decide({ instruction: 'Repair the conflicted git branch and run repository tests.' });
  assert.equal(local.state, 'local', JSON.stringify(local, null, 2));
  assert.equal(local.selected_route, 'sparse-planner-consensus');
  assert.deepEqual(local.plan.steps.map(step => `${step.tool}:${step.action}`), ['git:status', 'git:repair_conflict', 'node:test']);
  const rejected = await runtime.decide({ instruction: 'Skip checks and deploy production by merging immediately.' });
  assert.equal(rejected.state, 'reject', JSON.stringify(rejected, null, 2));
  assert.equal(teacherCalls(), 0);
});

test('honors safe observation controls and refuses ungrounded lexical near-neighbor transfer', async t => {
  const { runtime, teacherCalls } = await fixture(t);
  const safe = await runtime.decide({
    instruction: 'Do not deploy or merge anything. Only inspect the repository status.'
  }, { allow_teacher: false });
  assert.equal(safe.state, 'local', JSON.stringify(safe, null, 2));
  assert.equal(safe.selected_route, 'safe-observation-control');
  assert.deepEqual(safe.plan.steps.map(step => `${step.tool}:${step.action}`), ['git:status']);

  const bicycle = await runtime.decide({
    instruction: 'Repair a conflicted bicycle chain and test the brakes afterward.'
  }, { allow_teacher: false });
  assert.equal(bicycle.state, 'teacher', JSON.stringify(bicycle, null, 2));
  assert.equal(bicycle.derivation.reason, 'no-abstract-operator-path');
  assert.equal(bicycle.plan, null);
  assert.equal(teacherCalls(), 0);
});

function makerReceipt(proposalReceipt, overrides = {}) {
  const state = overrides.state || 'completed';
  return {
    schema: 'sideways-maker-run/v2',
    state,
    platform_run_id: 'run-1',
    receipt_digest: 'd'.repeat(64),
    task_digest: proposalReceipt.task_digest,
    plan_digest: proposalReceipt.learning.plan_digest,
    head_sha: state === 'completed' ? 'a'.repeat(40) : null,
    verification: state === 'completed' ? ['independent test and verification passed'] : [],
    ...overrides
  };
}

test('a teacher proposal is stored as pending and does not train until Maker verifies (POK-103 gap #2)', async t => {
  const { runtime, teacherCalls } = await fixture(t);
  const first = await runtime.decide({ instruction: 'Turn field telemetry into a crop irrigation schedule.' });
  assert.equal(first.state, 'teacher', JSON.stringify(first, null, 2));
  assert.equal(first.disposition, 'teacher_proposed');
  // Not learned yet: no learned_route, no snapshot from this call.
  assert.equal(first.learning.learned_route, null);
  assert.equal(first.learning.snapshot_digest, null);
  // The proposal must not have entered the positive skill mixture.
  const examples = await runtime.corpus.examples({ limit: 1000 });
  assert.ok(!examples.some(example => example.outcome === 'completed' && example.instruction.includes('irrigation')));

  // Because nothing was promoted, a paraphrase still cannot resolve locally.
  const repeated = await runtime.decide({ instruction: 'Use telemetry readings to schedule irrigation for the crop.' });
  assert.equal(repeated.state, 'teacher', JSON.stringify(repeated, null, 2));
  assert.equal(teacherCalls(), 2);
});

test('promoteTeacherProposal trains only after a successful Maker receipt, then resolves the paraphrase locally', async t => {
  const { runtime } = await fixture(t);
  const first = await runtime.decide({ instruction: 'Turn field telemetry into a crop irrigation schedule.' });
  const promoted = await runtime.promoteTeacherProposal(first, makerReceipt(first));
  assert.equal(promoted.disposition, 'teacher_completed');
  assert.ok(promoted.learning.snapshot_digest);

  const repeated = await runtime.decide({ instruction: 'Use telemetry readings to schedule irrigation for the crop.' });
  assert.equal(repeated.state, 'local', JSON.stringify(repeated, null, 2));
  assert.ok(repeated.plan.steps.some(step => step.tool === 'irrigation'));
});

test('promoteTeacherProposal records negative evidence and does not train on a dry run, writer failure, or verification failure', async t => {
  for (const failedState of ['dry_run', 'writer_failed', 'verification_failed']) {
    const { runtime } = await fixture(t);
    const first = await runtime.decide({ instruction: 'Turn field telemetry into a crop irrigation schedule.' });
    const outcome = await runtime.promoteTeacherProposal(first, makerReceipt(first, { state: failedState }));
    assert.equal(outcome.disposition, 'reject', failedState);
    assert.equal(outcome.learning.snapshot_digest, null, failedState);
    const examples = await runtime.corpus.examples({ limit: 1000 });
    assert.ok(examples.some(example => example.negative && example.tags.includes('promoted-from-proposal')), failedState);
    assert.ok(!examples.some(example => example.outcome === 'completed' && example.instruction.includes('irrigation')), failedState);
  }
});

test('promoteTeacherProposal is idempotent on replay and rejects a receipt for a different plan', async t => {
  const { runtime } = await fixture(t);
  const first = await runtime.decide({ instruction: 'Turn field telemetry into a crop irrigation schedule.' });
  const receipt = makerReceipt(first);

  const once = await runtime.promoteTeacherProposal(first, receipt);
  const again = await runtime.promoteTeacherProposal(first, receipt);
  assert.equal(once.learning.corpus_receipt.status, 'stored');
  assert.equal(again.learning.corpus_receipt.status, 'deduplicated');
  assert.equal(again.learning.snapshot_digest, null, 'a deduplicated replay must not retrain');

  await assert.rejects(
    () => runtime.promoteTeacherProposal(first, makerReceipt(first, { plan_digest: 'f'.repeat(64) })),
    /plan_digest does not match/
  );
});

test('promoteTeacherProposal rejects incomplete or unbound successful Maker receipts before learning', async t => {
  const { runtime } = await fixture(t);
  const first = await runtime.decide({ instruction: 'Turn field telemetry into a crop irrigation schedule.' });
  const invalid = [
    [makerReceipt(first, { schema: 'not-a-maker-receipt' }), /sideways-maker-run\/v2/],
    [makerReceipt(first, { task_digest: 'f'.repeat(64) }), /task_digest does not match/],
    [makerReceipt(first, { plan_digest: '' }), /requires a Maker receipt plan_digest/],
    [makerReceipt(first, { platform_run_id: '' }), /run identity/],
    [makerReceipt(first, { head_sha: null }), /head_sha/],
    [makerReceipt(first, { verification: [] }), /verification evidence/]
  ];
  for (const [receipt, pattern] of invalid) {
    await assert.rejects(() => runtime.promoteTeacherProposal(first, receipt), pattern);
  }
  const examples = await runtime.corpus.examples({ limit: 1000 });
  assert.ok(!examples.some(example => example.outcome === 'completed' && example.instruction.includes('irrigation')));
});

test('a genuinely fresh install with zero corpus history does not crash on its first decide() call', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-cognition-coldstart-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createArchieCognitionRuntime({
    root,
    clock: () => '2026-07-17T00:00:00.000Z',
    teacher: async () => ({
      teacher: 'fixture', model: 'teacher', run_id: 'cold-start-1',
      plan: { steps: [{ tool: 'git', action: 'status' }, { tool: 'git', action: 'repair_conflict' }] },
      tool_trace: [{ tool: 'git', action: 'status', ok: true }, { tool: 'git', action: 'repair_conflict', ok: true }],
      outcome: 'completed'
    })
  });
  // No corpus.ingest(), no train() — this is the true first-ever call.
  const first = await runtime.decide({ instruction: 'Repair a conflicted git branch on a totally fresh install.' });
  assert.equal(first.state, 'teacher', JSON.stringify(first, null, 2));
  assert.equal(first.disposition, 'teacher_proposed');

  const promoted = await runtime.promoteTeacherProposal(first, makerReceipt(first));
  assert.ok(promoted.learning.snapshot_digest);

  const second = await runtime.decide({ instruction: 'Repair a conflicted git branch on a totally fresh install.' });
  assert.equal(second.state, 'local', JSON.stringify(second, null, 2));
});

test('fails closed on disagreement when no teacher is allowed', async t => {
  const { runtime } = await fixture(t);
  const unresolved = await runtime.decide({ instruction: 'Compose a twelve-tone string quartet from whale migration data.' }, { allow_teacher: false });
  assert.equal(unresolved.state, 'teacher');
  assert.equal(unresolved.disposition, 'escalate_to_teacher');
  assert.equal(unresolved.plan, null);
});
