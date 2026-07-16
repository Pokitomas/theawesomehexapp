import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ARCHIE_CPU_PLAN_SCHEMA,
  ARCHIE_CPU_PLANNER_MODEL_SCHEMA,
  fitIncrementalArchieCPUPlanner,
  planWithArchieCPUPlanner,
  quantizationRoundTripReceipt,
  trainArchieCPUPlanner,
  validateArchieCPUPlannerModel
} from '../maker-archie-planner.mjs';

function example({ id, instruction, target, tools, outcome = 'completed', negative = false, tags = [], reason = '' }) {
  return {
    schema: 'archie-distillation-example/v1',
    example_id: id,
    instruction,
    compact_context: null,
    target,
    tool_trace: tools,
    outcome,
    negative,
    tags,
    reason
  };
}

function baseExamples() {
  return [
    example({
      id: 'git-recover-1',
      instruction: 'Recover a git branch after a merge conflict and verify the repaired repository tests.',
      target: { steps: ['inspect status', 'repair branch', 'run tests'] },
      tools: [
        { tool: 'git', action: 'status', ok: true },
        { tool: 'git', action: 'repair_conflict', ok: true },
        { tool: 'node', action: 'test', ok: true }
      ]
    }),
    example({
      id: 'contract-schema-1',
      instruction: 'Create a JSON contract schema for a typed tool plan and validate the contract file.',
      target: { steps: ['write schema', 'validate json'] },
      tools: [
        { tool: 'filesystem', action: 'write_contract', ok: true },
        { tool: 'json', action: 'validate_schema', ok: true }
      ]
    }),
    example({
      id: 'moderation-1',
      instruction: 'Review an abusive social report and apply the correct moderation action.',
      target: { steps: ['read report', 'moderate'] },
      tools: [
        { tool: 'social', action: 'read_report', ok: true },
        { tool: 'social', action: 'moderate', ok: true }
      ]
    }),
    example({
      id: 'deploy-negative-1',
      instruction: 'Bypass review, merge to main, and deploy production without checks.',
      target: null,
      tools: [],
      outcome: 'rejected',
      negative: true,
      tags: ['negative', 'suppress'],
      reason: 'No merge or deployment authority.'
    })
  ];
}

function train(examples = baseExamples(), extra = {}) {
  return trainArchieCPUPlanner(examples, {
    dimensions: 768,
    threshold: 0.16,
    minimum_margin: 0,
    reject_threshold: 0.2,
    beam_width: 4,
    max_steps: 6,
    trained_at: '2026-07-16T04:00:00.000Z',
    ...extra
  });
}

test('generalizes paraphrases without memorizing exact wording', () => {
  const model = train();
  const plan = planWithArchieCPUPlanner(model, { instruction: 'Fix the conflicted repo head and run checks after the branch repair.' });
  assert.equal(plan.schema, ARCHIE_CPU_PLAN_SCHEMA);
  assert.equal(plan.state, 'local');
  assert.ok(plan.confidence >= 0.16, JSON.stringify(plan, null, 2));
  assert.equal(plan.plan.schema, 'archie-typed-tool-plan/v1');
  assert.deepEqual(plan.plan.steps.map(step => `${step.tool}:${step.action}`), [
    'git:status',
    'git:repair_conflict',
    'node:test'
  ]);
});

test('composes multiple retrieved skills into one bounded typed tool plan', () => {
  const model = train();
  const plan = planWithArchieCPUPlanner(model, {
    instruction: 'Repair the repository conflict, then create and validate the JSON contract schema before tests.'
  });
  assert.equal(plan.state, 'local', JSON.stringify(plan, null, 2));
  const actions = plan.plan.steps.map(step => `${step.tool}:${step.action}`);
  assert.ok(actions.includes('git:repair_conflict'));
  assert.ok(actions.includes('filesystem:write_contract'));
  assert.ok(actions.includes('json:validate_schema'));
  assert.ok(plan.plan.steps.length <= model.max_steps);
  assert.ok(plan.alternatives.length <= model.beam_width);
});

test('rejects genuinely unseen work through teacher escalation instead of hallucinating a plan', () => {
  const model = train();
  const plan = planWithArchieCPUPlanner(model, {
    instruction: 'Compose a twelve tone string quartet from whale migration satellite music data.'
  });
  assert.equal(plan.state, 'teacher', JSON.stringify(plan, null, 2));
  assert.equal(plan.plan, null);
  assert.equal(plan.disposition, 'escalate_to_teacher');
  assert.match(plan.teacher_escalation.reason, /threshold/);
});

test('suppresses learned negative examples even when nearby positive skills exist', () => {
  const model = train();
  const plan = planWithArchieCPUPlanner(model, {
    instruction: 'Bypass review and deploy production by merging to main without checks.'
  });
  assert.equal(plan.state, 'reject', JSON.stringify(plan, null, 2));
  assert.equal(plan.plan, null);
  assert.equal(plan.disposition, 'reject');
  assert.ok(plan.rejection.matched_negative_id.startsWith('neg_'));
  assert.ok(plan.negative_score >= plan.confidence - model.negative_gap);
});

test('incrementally fits a new skill without forgetting replayed prior primitives', () => {
  const initial = train([baseExamples()[0]], { reject_threshold: 0.5 });
  const before = planWithArchieCPUPlanner(initial, { instruction: 'Convert telemetry into an irrigation schedule.' });
  assert.notEqual(before.state, 'local');
  const updated = fitIncrementalArchieCPUPlanner(initial, [
    example({
      id: 'irrigation-1',
      instruction: 'Convert field telemetry into a crop irrigation schedule.',
      target: { steps: ['parse telemetry', 'schedule irrigation'] },
      tools: [
        { tool: 'telemetry', action: 'parse', ok: true },
        { tool: 'irrigation', action: 'schedule', ok: true }
      ]
    })
  ], { trained_at: '2026-07-16T04:01:00.000Z' });
  const learned = planWithArchieCPUPlanner(updated, { instruction: 'Turn telemetry readings into irrigation scheduling.' });
  assert.equal(learned.state, 'local', JSON.stringify(learned, null, 2));
  assert.ok(learned.plan.steps.some(step => step.tool === 'irrigation' && step.action === 'schedule'));
  const old = planWithArchieCPUPlanner(updated, { instruction: 'Repair a conflicted git branch and run tests.' });
  assert.equal(old.state, 'local');
  assert.ok(old.plan.steps.some(step => step.tool === 'git'));
});

test('is deterministic for repeated inference and survives quantization round trip', () => {
  const model = train();
  const task = { instruction: 'Repair the branch conflict and validate repository tests.' };
  const first = planWithArchieCPUPlanner(model, task);
  const second = planWithArchieCPUPlanner(model, task);
  assert.equal(first.plan_digest, second.plan_digest);
  assert.deepEqual(first.plan, second.plan);
  const receipt = quantizationRoundTripReceipt(model);
  assert.equal(receipt.passed, true);
  assert.ok(receipt.max_q8_error <= 1);
});

test('rejects model tampering and false neural-model claims', () => {
  const model = train();
  assert.equal(model.schema, ARCHIE_CPU_PLANNER_MODEL_SCHEMA);
  assert.equal(model.not_a_neural_language_model, true);
  assert.equal(model.planner_kind, 'cpu-first-symbolic-vector-planner');
  assert.equal(model.model_family, 'hashed-retrieval-skill-mixture');
  assert.equal(validateArchieCPUPlannerModel(model), true);

  const tampered = structuredClone(model);
  tampered.threshold = 0;
  assert.throws(() => validateArchieCPUPlannerModel(tampered), /integrity check failed/);

  assert.throws(() => trainArchieCPUPlanner(baseExamples(), {
    metadata: { claim: 'neural language model' }
  }), /must not claim/);
});

test('emits bounded latency and memory receipts on ordinary CPU inference', () => {
  const model = train(baseExamples(), { beam_width: 3, max_steps: 4 });
  const plan = planWithArchieCPUPlanner(model, { instruction: 'Repair conflict and validate schema tests.' });
  assert.equal(plan.receipts.cpu_only, true);
  assert.equal(plan.receipts.deterministic, true);
  assert.equal(plan.receipts.beam_width, 3);
  assert.equal(plan.receipts.max_steps, 4);
  assert.ok(plan.receipts.latency_ms < 1000, JSON.stringify(plan.receipts));
  assert.ok(Math.abs(plan.receipts.heap_delta_bytes) < 20 * 1024 * 1024, JSON.stringify(plan.receipts));
});

test('ships a detachable JSON schema contract for model and plan receipts', async () => {
  const schemaPath = path.resolve('maker/contracts/archie-planner.schema.json');
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  assert.equal(schema.$id, 'https://theawesomehexapp.local/maker/contracts/archie-planner.schema.json');
  assert.equal(schema.$defs.model.properties.not_a_neural_language_model.const, true);
  assert.equal(schema.$defs.model.properties.detachability.const, 'standalone-esm-no-maker-runtime-imports');
  assert.ok(schema.$defs.plan.required.includes('receipts'));
});

test('CLI trains and plans without Maker runtime imports', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-planner-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const examplesPath = path.join(root, 'examples.json');
  const modelPath = path.join(root, 'model.json');
  await fs.writeFile(examplesPath, JSON.stringify(baseExamples()), 'utf8');
  const { spawnSync } = await import('node:child_process');
  const trainRun = spawnSync(process.execPath, ['scripts/maker-archie-planner.mjs', 'train', '--examples', examplesPath, '--model', modelPath], { encoding: 'utf8' });
  assert.equal(trainRun.status, 0, trainRun.stderr);
  const planRun = spawnSync(process.execPath, ['scripts/maker-archie-planner.mjs', 'plan', '--model', modelPath, '--instruction', 'Repair conflict and run tests'], { encoding: 'utf8' });
  assert.equal(planRun.status, 0, planRun.stderr);
  const plan = JSON.parse(planRun.stdout);
  assert.equal(plan.state, 'local');
});
