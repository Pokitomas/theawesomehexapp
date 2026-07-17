import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArchieLinuxCorpus } from '../maker-archie-corpus.mjs';
import {
  createArchiePersonalBrain,
  predictArchiePlan,
  trainArchieSkillMixture
} from '../maker-archie-brain.mjs';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-brain-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function example({ id, instruction, target, tools }) {
  return {
    schema: 'archie-distillation-example/v1',
    example_id: id,
    instruction,
    compact_context: null,
    target,
    tool_trace: tools,
    outcome: 'completed'
  };
}

test('trains a local mixture of tiny skill specialists and escalates genuinely unknown work', () => {
  const gitPlan = { steps: ['inspect status', 'repair branch', 'rerun tests'] };
  const moderationPlan = { steps: ['load report', 'inspect context', 'apply moderation action'] };
  const model = trainArchieSkillMixture([
    example({
      id: 'git-1',
      instruction: 'Recover a git branch after a merge conflict and verify the repaired repository.',
      target: gitPlan,
      tools: [
        { tool: 'git', action: 'status', ok: true },
        { tool: 'git', action: 'reset', ok: true },
        { tool: 'node', action: 'test', ok: true }
      ]
    }),
    example({
      id: 'moderation-1',
      instruction: 'Review an abusive social report and apply the correct moderation action.',
      target: moderationPlan,
      tools: [
        { tool: 'social', action: 'read_report', ok: true },
        { tool: 'social', action: 'moderate', ok: true }
      ]
    })
  ], { dimensions: 512, threshold: 0.15, minimum_margin: 0.02, trained_at: '2026-07-16T03:00:00.000Z' });

  assert.equal(model.specialist_count, 2);
  assert.equal(model.document_count, 2);
  const local = predictArchiePlan(model, { instruction: 'Please repair this conflicted git branch, then run repository tests.' });
  assert.equal(local.state, 'local');
  assert.deepEqual(local.plan, gitPlan);
  assert.ok(local.confidence > 0.15);

  const unknown = predictArchiePlan(model, { instruction: 'Compose a twelve-tone string quartet from whale migration data.' });
  assert.equal(unknown.state, 'escalate');
  assert.equal(unknown.plan, null);
});

test('stores teacher proposals as pending and excludes them from positive local learning', async t => {
  const root = await tempRoot(t);
  const corpus = createArchieLinuxCorpus({ root: path.join(root, 'corpus'), clock: () => '2026-07-16T03:01:00.000Z' });
  await corpus.ingest({
    kind: 'seed',
    input: { text: 'Recover a git branch after a merge conflict.' },
    output: { plan: { steps: ['git status', 'git reset', 'test'] } },
    tool_trace: [{ tool: 'git', action: 'repair', ok: true }],
    outcome: 'completed',
    source: { system: 'seed' }
  });

  let teacherCalls = 0;
  const brain = createArchiePersonalBrain({
    corpus,
    model_path: path.join(root, 'models', 'archie-skills.json'),
    clock: () => '2026-07-16T03:01:00.000Z',
    training: { dimensions: 512, threshold: 0.16, minimum_margin: 0.02 },
    teacher: async task => {
      teacherCalls += 1;
      return {
        teacher: 'frontier-teacher',
        model: 'teacher-model',
        run_id: `teacher-${teacherCalls}`,
        cost_usd: 0.25,
        plan: { steps: ['parse telemetry', 'estimate soil state', 'emit irrigation schedule'] },
        tool_trace: [
          { tool: 'telemetry', action: 'parse', ok: true },
          { tool: 'irrigation', action: 'schedule', ok: true }
        ],
        outcome: 'completed',
        text: `proposed ${task.instruction}`,
        receipt: { receipt_digest: `receipt-${teacherCalls}` }
      };
    }
  });

  const task = { subject: 'farm-one', instruction: 'Turn satellite telemetry into a crop irrigation schedule.' };
  const first = await brain.plan(task);
  assert.equal(first.state, 'teacher');
  assert.equal(teacherCalls, 1);
  assert.equal(first.corpus_record.status, 'stored');
  assert.equal(first.learned_plan, null);

  const second = await brain.plan(task);
  assert.equal(second.state, 'teacher');
  assert.equal(teacherCalls, 2);
  assert.equal((await corpus.examples()).length, 1);
  const pending = await corpus.findBySourceRunId('teacher-1', { kind: 'archie_teacher_plan' });
  assert.equal(pending.outcome, 'proposed');
  assert.ok(pending.tags.includes('exclude-positive-distillation'));
});

test('refuses a tampered locally trained model', async t => {
  const root = await tempRoot(t);
  const corpus = createArchieLinuxCorpus({ root: path.join(root, 'corpus'), clock: () => '2026-07-16T03:02:00.000Z' });
  await corpus.ingest({
    input: { text: 'Repair a failed tool call.' },
    output: { plan: { steps: ['inspect error', 'retry safely'] } },
    tool_trace: [{ tool: 'runtime', action: 'recover', ok: true }],
    outcome: 'completed'
  });
  const modelPath = path.join(root, 'models', 'archie-skills.json');
  const brain = createArchiePersonalBrain({ corpus, model_path: modelPath, clock: () => '2026-07-16T03:02:00.000Z' });
  await brain.train();
  const model = JSON.parse(await fs.readFile(modelPath, 'utf8'));
  model.threshold = 0;
  await fs.writeFile(modelPath, JSON.stringify(model), 'utf8');
  await assert.rejects(brain.load(), /integrity check failed/);
});
