import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createArchiePersonalBrain,
  predictArchiePlan,
  trainArchieSkillMixture
} from '../maker-archie-brain.mjs';

function example({ id, instruction, target, tool = 'git', action = 'repair', negative = false, tags = [] }) {
  return {
    schema: 'archie-distillation-example/v1',
    example_id: id,
    instruction,
    compact_context: null,
    target: negative ? null : target,
    tool_trace: negative ? [] : [{ tool, action, ok: true }],
    outcome: negative ? 'failed' : 'completed',
    negative,
    tags
  };
}

test('collapses exact duplicate documents while preserving capped evidence weight', () => {
  const repeated = example({ id: 'git-1', instruction: 'Repair a conflicted git branch.', target: { steps: ['status', 'repair', 'test'] } });
  const model = trainArchieSkillMixture([
    repeated,
    { ...repeated, example_id: 'git-2' },
    { ...repeated, example_id: 'git-3' },
    { ...repeated, example_id: 'git-4' },
    { ...repeated, example_id: 'git-5' },
    { ...repeated, example_id: 'git-6' }
  ], {
    dimensions: 1024,
    duplicate_weight_cap: 3,
    calibrate_operating_point: false,
    trained_at: '2026-07-18T08:00:00.000Z'
  });

  assert.equal(model.document_count, 6);
  assert.equal(model.unique_document_count, 1);
  assert.equal(model.specialists[0].examples, 6);
  assert.equal(model.specialists[0].unique_examples, 1);
  assert.equal(model.specialists[0].effective_weight, 3);
});

test('selects a deterministic held-out operating point', () => {
  const examples = [
    example({ id: 'g1', instruction: 'Repair a conflicted git branch and run tests.', target: { kind: 'git' }, tool: 'git', action: 'repair' }),
    example({ id: 'g2', instruction: 'Resolve a merge conflict in the repository.', target: { kind: 'git' }, tool: 'git', action: 'repair' }),
    example({ id: 'g3', instruction: 'Fix a broken branch and verify the repository.', target: { kind: 'git' }, tool: 'git', action: 'repair' }),
    example({ id: 'g4', instruction: 'Recover git history after a failed merge.', target: { kind: 'git' }, tool: 'git', action: 'repair' }),
    example({ id: 'm1', instruction: 'Review an abusive report and moderate it.', target: { kind: 'moderation' }, tool: 'social', action: 'moderate' }),
    example({ id: 'm2', instruction: 'Inspect a harassment report and apply moderation.', target: { kind: 'moderation' }, tool: 'social', action: 'moderate' }),
    example({ id: 'm3', instruction: 'Handle a toxic community report safely.', target: { kind: 'moderation' }, tool: 'social', action: 'moderate' }),
    example({ id: 'm4', instruction: 'Moderate a reported abusive social post.', target: { kind: 'moderation' }, tool: 'social', action: 'moderate' }),
    example({ id: 'n1', instruction: 'Compose a string quartet from whale migrations.', target: null, negative: true, tags: ['negative', 'unknown-domain'] })
  ];
  const options = {
    dimensions: 1024,
    threshold: 0.22,
    minimum_margin: 0.03,
    cross_validation_target_precision: 0.75,
    trained_at: '2026-07-18T08:01:00.000Z'
  };
  const first = trainArchieSkillMixture(examples, options);
  const second = trainArchieSkillMixture(examples, options);

  assert.equal(first.operating_point.source, 'deterministic-k-fold');
  assert.equal(first.operating_point.observation_digest, second.operating_point.observation_digest);
  assert.equal(first.threshold, second.threshold);
  assert.equal(first.minimum_margin, second.minimum_margin);
  assert.ok(first.operating_point.evaluated_documents >= 8);
});

test('uses recorded specialist outcomes as an activated reliability gate', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-reliability-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storedExamples = [example({ id: 'git-1', instruction: 'Repair a conflicted git branch.', target: { steps: ['repair'] } })];
  const records = [];
  const corpus = {
    async examples() { return storedExamples; },
    async ingest(record) {
      records.push({
        ...record,
        record_id: `record-${records.length + 1}`,
        input: record.input,
        output: record.output,
        source: record.source,
        outcome: record.outcome
      });
      return { status: 'stored', record_id: `record-${records.length}`, example_id: null };
    },
    async query(specialistId) {
      return records.filter(record => record.input?.context?.specialist_id === specialistId).map(record => ({ record }));
    }
  };
  const brain = createArchiePersonalBrain({
    corpus,
    model_path: path.join(root, 'model.json'),
    clock: () => '2026-07-18T08:02:00.000Z',
    training: {
      dimensions: 1024,
      threshold: 0.05,
      minimum_margin: 0,
      reliability_floor: 0.6,
      reliability_activation_min: 3,
      calibrate_operating_point: false
    }
  });
  const initial = await brain.train();
  const specialistId = initial.specialists[0].specialist_id;
  await brain.recordPlanOutcome({
    specialist_id: specialistId,
    task: 'Repair a conflicted git branch.',
    plan: { steps: ['repair'] },
    state: 'failed',
    run_id: 'reuse-1'
  });
  const retrained = await brain.train();
  const specialist = retrained.specialists[0];
  assert.equal(specialist.reliability.failures, 1);
  assert.equal(specialist.reliability.gate_active, true);
  assert.equal(specialist.reliability.gate_passed, false);

  const prediction = predictArchiePlan(retrained, { instruction: 'Repair a conflicted git branch.' });
  assert.equal(prediction.state, 'escalate');
  assert.equal(prediction.candidate_specialist_id, specialistId);
  assert.equal(prediction.reliability.failures, 1);
});
