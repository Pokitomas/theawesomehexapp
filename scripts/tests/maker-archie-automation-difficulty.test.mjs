import assert from 'node:assert/strict';
import test from 'node:test';
import { inferAutomationDifficulty } from '../maker-archie-automation-difficulty.mjs';

function episode(overrides = {}) {
  return {
    id: 'episode',
    outcome: { status: 'completed' },
    events: [
      { type: 'request' },
      { type: 'plan' },
      { type: 'tool-call', payload: { tool: 'git' } },
      { type: 'tool-result', payload: { tool: 'git' } },
      { type: 'outcome' }
    ],
    difficulty: {
      steps: 5,
      retries: 0,
      human_interventions: 0,
      overrides: 0,
      corrections: 0,
      rollbacks: 0,
      context_bytes: 4000,
      elapsed_ms: 2000,
      environment_count: 1,
      ambiguity: 0.05,
      recurrence: 0.4,
      ...overrides
    }
  };
}

test('automation friction produces a deterministic, explicitly provisional sizing and distillation receipt', () => {
  const result = inferAutomationDifficulty([episode()], { generated_at: '2026-07-17T21:00:00.000Z' });
  assert.equal(result.schema, 'archie-automation-difficulty/v1');
  assert.equal(result.launch_sizing_hypothesis.empirical_status, 'hypothesis-not-admission');
  assert.equal(result.launch_sizing_hypothesis.class, 'small-specialist');
  assert.ok(result.distillation_methods.some(item => item.method === 'preference-distillation'));
  assert.match(result.inference_digest, /^[a-f0-9]{64}$/);
});

test('heavy human-machine difficulty raises the candidate model and context hypothesis without claiming admission', () => {
  const hard = inferAutomationDifficulty([
    episode({ steps: 180, retries: 18, human_interventions: 14, overrides: 9, corrections: 20, rollbacks: 6, context_bytes: 900000, elapsed_ms: 36_000_000, environment_count: 12, ambiguity: 0.9, recurrence: 0.85 }),
    { ...episode({ steps: 240, retries: 25, human_interventions: 20, overrides: 12, corrections: 30, rollbacks: 8, context_bytes: 1_200_000, elapsed_ms: 60_000_000, environment_count: 16, ambiguity: 0.95, recurrence: 0.9 }), id: 'episode-2', outcome: { status: 'partial' } }
  ], { generated_at: '2026-07-17T21:00:00.000Z' });
  assert.ok(hard.aggregate.difficulty_score >= 0.68);
  assert.match(hard.launch_sizing_hypothesis.class, /heavy/);
  assert.equal(hard.launch_sizing_hypothesis.minimum_context_hypothesis, 131072);
  assert.match(hard.launch_sizing_hypothesis.admission_requirement, /hidden held-out/);
  assert.ok(hard.capability_pressure.human_intent_modeling > 0.6);
});
