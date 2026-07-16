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

test('uses a teacher once, persists the lesson, retrains both routes, and handles the paraphrased recurrence locally', async t => {
  const { runtime, teacherCalls } = await fixture(t);
  const first = await runtime.decide({ instruction: 'Turn field telemetry into a crop irrigation schedule.' });
  assert.equal(first.state, 'teacher', JSON.stringify(first, null, 2));
  assert.equal(first.learning.learned_route.sparse.state, 'local');
  assert.equal(first.learning.learned_route.planner.state, 'local');
  const repeated = await runtime.decide({ instruction: 'Use telemetry readings to schedule irrigation for the crop.' });
  assert.equal(repeated.state, 'local', JSON.stringify(repeated, null, 2));
  assert.equal(teacherCalls(), 1);
  assert.ok(repeated.plan.steps.some(step => step.tool === 'irrigation'));
});

test('fails closed on disagreement when no teacher is allowed', async t => {
  const { runtime } = await fixture(t);
  const unresolved = await runtime.decide({ instruction: 'Compose a twelve-tone string quartet from whale migration data.' }, { allow_teacher: false });
  assert.equal(unresolved.state, 'teacher');
  assert.equal(unresolved.disposition, 'escalate_to_teacher');
  assert.equal(unresolved.plan, null);
});
