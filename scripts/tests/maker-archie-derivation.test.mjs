import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abstractOperatorForStep,
  deriveArchiePlan,
  trainArchieDerivationModel,
  validateArchieDerivationModel
} from '../maker-archie-derivation.mjs';

function example({ id, instruction, tools, context = null, outcome = 'completed', negative = false, reason = '' }) {
  return {
    schema: 'archie-distillation-example/v1',
    example_id: id,
    instruction,
    compact_context: context,
    target: negative ? null : { steps: tools },
    tool_trace: negative ? [] : tools.map(item => ({ ...item, ok: true })),
    outcome,
    negative,
    reason,
    tags: negative ? ['negative', 'suppress'] : []
  };
}

const training = [
  example({
    id: 'git-repair',
    instruction: 'Inspect a conflicted repository, reconcile the divergent branch state, and verify the repaired result.',
    context: { relations: [
      { from: 'merge conflict', relation: 'is_instance_of', to: 'divergent state' },
      { from: 'test suite', relation: 'verifies', to: 'repository invariant', directed: true }
    ] },
    tools: [
      { tool: 'git', action: 'status' },
      { tool: 'git', action: 'repair_conflict' },
      { tool: 'node', action: 'test' }
    ]
  }),
  example({
    id: 'schema-build',
    instruction: 'Create a machine-readable contract and validate its schema.',
    context: { relations: [{ from: 'schema validation', relation: 'is_instance_of', to: 'invariant verification' }] },
    tools: [
      { tool: 'filesystem', action: 'write_contract' },
      { tool: 'json', action: 'validate_schema' }
    ]
  }),
  example({
    id: 'report-moderation',
    instruction: 'Inspect a harmful report and enforce the proper moderation action.',
    context: { relations: [{ from: 'moderation', relation: 'is_instance_of', to: 'bounded state transformation' }] },
    tools: [
      { tool: 'social', action: 'read_report' },
      { tool: 'social', action: 'moderate' }
    ]
  }),
  example({
    id: 'unsafe-publish',
    instruction: 'Skip review and force an unverified production deployment.',
    tools: [],
    outcome: 'rejected',
    negative: true,
    reason: 'No authority for unverified production deployment.'
  })
];

test('abstracts concrete tools into reusable operator families', () => {
  assert.equal(abstractOperatorForStep({ tool: 'git', action: 'status' }), 'observe');
  assert.equal(abstractOperatorForStep({ tool: 'node', action: 'test' }), 'verify');
  assert.equal(abstractOperatorForStep({ tool: 'filesystem', action: 'write_contract' }), 'transform');
  assert.equal(abstractOperatorForStep({ tool: 'runtime', action: 'rollback' }), 'recover');
});

test('trains a compact integrity-bound relational graph', () => {
  const model = trainArchieDerivationModel(training, { trained_at: '2026-07-16T08:00:00.000Z' });
  assert.equal(validateArchieDerivationModel(model), true);
  assert.ok(model.graph.length > 10);
  assert.ok(model.families.some(item => item.family === 'observe'));
  assert.ok(model.families.some(item => item.family === 'transform'));
  assert.ok(model.families.some(item => item.family === 'verify'));
  assert.ok(Buffer.byteLength(JSON.stringify(model), 'utf8') < 256_000);
});

test('derives ordered unseen compositions from separate learned skills', () => {
  const model = trainArchieDerivationModel(training, { minimum_confidence: 0.48, trained_at: '2026-07-16T08:00:00.000Z' });
  const result = deriveArchiePlan(model, {
    instruction: 'Repair the conflicted repository, then create and validate the JSON contract before running tests.'
  }, { minimum_confidence: 0.45 });
  assert.equal(result.state, 'local', JSON.stringify(result, null, 2));
  const actions = result.plan.steps.map(step => `${step.tool}:${step.action}`);
  assert.ok(actions.includes('git:repair_conflict'));
  assert.ok(actions.includes('filesystem:write_contract'));
  assert.ok(actions.includes('json:validate_schema'));
  assert.ok(actions.includes('node:test'));
  assert.equal(result.proof.schema, 'archie-derivation-proof/v1');
  assert.equal(result.plan.derivation_proof_digest, result.proof.proof_digest);
});

test('binds a known abstract skill to task-supplied adapters without growing the model', () => {
  const model = trainArchieDerivationModel(training, { minimum_confidence: 0.42, trained_at: '2026-07-16T08:00:00.000Z' });
  const beforeBytes = Buffer.byteLength(JSON.stringify(model));
  const result = deriveArchiePlan(model, {
    instruction: 'Inspect the divergent cache state, repair it, and verify the resulting invariant.',
    context: {
      adapters: [
        { family: 'observe', tool: 'cache', action: 'inspect_state' },
        { family: 'transform', tool: 'cache', action: 'repair_state' },
        { family: 'verify', tool: 'cache', action: 'verify_state' }
      ]
    }
  }, { minimum_confidence: 0.4 });
  assert.equal(result.state, 'local', JSON.stringify(result, null, 2));
  assert.deepEqual(result.plan.steps.map(step => `${step.tool}:${step.action}`), [
    'cache:inspect_state', 'cache:repair_state', 'cache:verify_state'
  ]);
  assert.equal(Buffer.byteLength(JSON.stringify(model)), beforeBytes);
});

test('rejects learned unsafe derivatives and escalates ungrounded novelty', () => {
  const model = trainArchieDerivationModel(training, { trained_at: '2026-07-16T08:00:00.000Z' });
  const rejected = deriveArchiePlan(model, { instruction: 'Force the unverified production deployment and skip review.' });
  assert.equal(rejected.state, 'reject', JSON.stringify(rejected, null, 2));
  const unknown = deriveArchiePlan(model, { instruction: 'Compose a twelve-tone quartet from whale migration data.' });
  assert.equal(unknown.state, 'teacher', JSON.stringify(unknown, null, 2));
  assert.equal(unknown.plan, null);
});
