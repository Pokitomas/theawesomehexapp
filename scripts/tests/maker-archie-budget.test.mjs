import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArchieReasoningBudgetController } from '../maker-archie-budget.mjs';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-budget-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function controller(root, options = {}) {
  return createArchieReasoningBudgetController({
    root,
    clock: () => '2026-07-16T04:00:00.000Z',
    total_budget_credits: 150000,
    per_task_ceiling_credits: 30000,
    repair_reserve_credits: 15000,
    evaluation_reserve_credits: 10000,
    ...options
  });
}

test('amortizes repeated recurring tasks after one teacher call', async t => {
  const root = await tempRoot(t);
  const budget = controller(root);
  let calls = 0;
  const recurring = {
    instruction: 'Convert GitHub failure receipts into a repair plan for the Maker lane.',
    novelty: 0.7,
    uncertainty: 0.7,
    expected_recurrence: 12,
    estimated_future_call_savings: 90000,
    estimated_total_tokens: 4000,
    tool_cost: 4000
  };
  const first = await budget.allocate(recurring, {
    idempotency_key: 'repeat-once',
    providers: [{
      id: 'teacher-a',
      call: async () => {
        calls += 1;
        return { result: { plan: ['read receipt', 'classify failure', 'schedule repair'] }, usage: { prompt_tokens: 500, completion_tokens: 250, total_tokens: 750, cost_credits: 1200 } };
      }
    }]
  });
  assert.equal(first.decision.state, 'completed');
  assert.equal(first.learning.recorded_for_amortization, true);
  assert.equal(first.budget.debit.estimated, false);
  assert.deepEqual(first.budget.debit.provider_reported_usage, { prompt_tokens: 500, completion_tokens: 250, total_tokens: 750, cost_credits: 1200 });

  const second = await budget.allocate({ ...recurring, task_id: 'same-again' }, {
    idempotency_key: 'repeat-denied',
    providers: [async () => {
      calls += 1;
      return { result: 'should not be called', usage: { cost_credits: 1 } };
    }]
  });
  assert.equal(second.decision.state, 'denied');
  assert.equal(second.decision.reason, 'repeated_task_amortized_to_local_skill');
  assert.equal(second.budget.debit.charged_credits, 0);
  assert.equal(calls, 1);
});

test('escalates genuinely unknown work with bounded allocation', async t => {
  const root = await tempRoot(t);
  const budget = controller(root, { max_escalation_level: 2, max_escalation_multiplier: 1.5 });
  const receipt = await budget.allocate({
    instruction: 'Infer an unseen native runtime failure mode from sparse kernel telemetry.',
    novelty: 0.95,
    uncertainty: 0.95,
    expected_recurrence: 5,
    prior_local_failures: 2,
    estimated_future_call_savings: 50000,
    tool_cost: 10000
  }, {
    idempotency_key: 'unknown-escalation',
    providers: [async () => ({ result: { plan: ['ask teacher', 'store lesson'] }, usage: { cost_credits: 9000 } })]
  });
  assert.equal(receipt.decision.initial_state, 'approved');
  assert.equal(receipt.decision.initial_reason, 'unknown_task_escalation');
  assert.equal(receipt.decision.escalation_level, 1);
  assert.ok(receipt.budget.allocated_credits <= 15000);
  assert.equal(receipt.decision.state, 'completed');
});

test('denies low-value teacher calls', async t => {
  const root = await tempRoot(t);
  const budget = controller(root);
  let called = false;
  const receipt = await budget.allocate({
    instruction: 'Rewrite a known tiny label that the local model already handles well.',
    novelty: 0.05,
    uncertainty: 0.05,
    expected_recurrence: 0,
    estimated_future_call_savings: 0,
    local_confidence: 0.97,
    tool_cost: 20000
  }, {
    idempotency_key: 'low-value',
    providers: [async () => {
      called = true;
      return { result: 'nope', usage: { cost_credits: 20 } };
    }]
  });
  assert.equal(receipt.decision.state, 'denied');
  assert.equal(receipt.decision.reason, 'teacher_call_value_below_threshold');
  assert.equal(called, false);
});

test('uses safety override to approve otherwise low-value work', async t => {
  const root = await tempRoot(t);
  const budget = controller(root);
  const receipt = await budget.allocate({
    instruction: 'Inspect a suspicious instruction for secret exposure before local execution.',
    novelty: 0.05,
    uncertainty: 0.1,
    expected_recurrence: 0,
    estimated_future_call_savings: 0,
    safety_risk: 0.95,
    tool_cost: 5000
  }, {
    idempotency_key: 'safety-override',
    providers: [async () => ({ result: { verdict: 'block' }, usage: { cost_credits: 500 } })]
  });
  assert.equal(receipt.decision.initial_state, 'approved');
  assert.equal(receipt.decision.initial_reason, 'safety_override');
  assert.equal(receipt.decision.safety_override, true);
  assert.equal(receipt.budget.reservations.protected_for_routine_calls, false);
  assert.equal(receipt.decision.state, 'completed');
});

test('denies routine work when global budget is exhausted by reservations', async t => {
  const root = await tempRoot(t);
  const budget = controller(root, { total_budget_credits: 26000, repair_reserve_credits: 15000, evaluation_reserve_credits: 10000 });
  await budget.allocate({
    instruction: 'High value first teacher call.',
    novelty: 0.9,
    uncertainty: 0.9,
    expected_recurrence: 10,
    estimated_future_call_savings: 90000,
    tool_cost: 1000
  }, {
    idempotency_key: 'first-spend',
    providers: [async () => ({ result: 'ok', usage: { cost_credits: 1000 } })]
  });
  const denied = await budget.allocate({
    instruction: 'Another routine task that would invade repair and evaluation reserves.',
    novelty: 0.9,
    uncertainty: 0.9,
    expected_recurrence: 10,
    estimated_future_call_savings: 90000,
    tool_cost: 1000
  }, {
    idempotency_key: 'budget-exhausted',
    providers: [async () => ({ result: 'should not happen', usage: { cost_credits: 1000 } })]
  });
  assert.equal(denied.decision.state, 'denied');
  assert.equal(denied.decision.reason, 'global_budget_exhausted');
  assert.equal(denied.budget.routine_available_before_credits, 0);
});

test('falls back to the next provider after a provider failure', async t => {
  const root = await tempRoot(t);
  const budget = controller(root, { max_provider_attempts: 3 });
  const receipt = await budget.allocate({
    instruction: 'Route a novel repair through the fallback teacher.',
    novelty: 0.9,
    uncertainty: 0.8,
    expected_recurrence: 6,
    estimated_future_call_savings: 40000,
    tool_cost: 4000
  }, {
    idempotency_key: 'fallback',
    providers: [
      { id: 'teacher-down', call: async () => { throw new Error('provider offline'); } },
      { id: 'teacher-backup', call: async () => ({ result: { plan: ['fallback worked'] }, usage: { cost_credits: 700 } }) }
    ]
  });
  assert.equal(receipt.decision.state, 'completed');
  assert.equal(receipt.decision.reason, 'provider_fallback_completed');
  assert.deepEqual(receipt.provider_attempts.map(attempt => attempt.status), ['failed', 'completed']);
  assert.equal(receipt.provider_attempts[1].fallback, true);
});

test('marks missing provider usage as an explicit estimate without fabricating token counts', async t => {
  const root = await tempRoot(t);
  const budget = controller(root);
  const receipt = await budget.allocate({
    instruction: 'Budget a teacher call whose provider did not report usage.',
    novelty: 0.85,
    uncertainty: 0.85,
    expected_recurrence: 3,
    estimated_future_call_savings: 15000,
    estimated_prompt_tokens: 2000,
    estimated_completion_tokens: 1000
  }, {
    idempotency_key: 'missing-usage',
    providers: [async () => ({ result: { plan: ['missing usage recorded'] } })]
  });
  assert.equal(receipt.decision.state, 'completed');
  assert.equal(receipt.budget.debit.estimated, true);
  assert.equal(receipt.budget.debit.reason, 'provider_usage_missing');
  assert.equal(receipt.budget.debit.provider_reported_usage, null);
  assert.equal(receipt.budget.debit.estimated_usage.estimated, true);
  assert.equal(receipt.budget.debit.estimated_usage.total_tokens, null);
  assert.equal(receipt.budget.debit.token_usage.total_tokens, null);
  assert.equal(receipt.budget.debit.token_usage.estimated, true);
});

test('cancels before provider execution and preserves a durable receipt', async t => {
  const root = await tempRoot(t);
  const budget = controller(root);
  let called = false;
  const receipt = await budget.allocate({
    instruction: 'This task is cancelled before escalation.',
    novelty: 0.9,
    uncertainty: 0.9,
    expected_recurrence: 8,
    estimated_future_call_savings: 50000,
    tool_cost: 3000,
    cancelled: true
  }, {
    idempotency_key: 'cancelled',
    providers: [async () => {
      called = true;
      return { result: 'should not execute', usage: { cost_credits: 1 } };
    }]
  });
  assert.equal(receipt.decision.state, 'cancelled');
  assert.equal(receipt.decision.reason, 'cancelled_before_allocation');
  assert.equal(called, false);
  const history = await budget.history();
  assert.equal(history.length, 1);
  assert.equal(history[0].receipt_digest, receipt.receipt_digest);
});

test('replays idempotent requests without spending or calling a provider twice', async t => {
  const root = await tempRoot(t);
  const budget = controller(root);
  let calls = 0;
  const task = {
    instruction: 'Plan one durable replayable teacher request.',
    novelty: 0.8,
    uncertainty: 0.8,
    expected_recurrence: 4,
    estimated_future_call_savings: 30000,
    tool_cost: 2000
  };
  const options = {
    idempotency_key: 'same-request',
    providers: [async () => {
      calls += 1;
      return { result: { plan: ['once'] }, usage: { cost_credits: 333 } };
    }]
  };
  const first = await budget.allocate(task, options);
  const second = await budget.allocate(task, options);
  assert.equal(calls, 1);
  assert.equal(second.replayed, true);
  assert.equal(second.receipt_digest, first.receipt_digest);
  assert.equal(await budget.spent(), 333);
});

test('rejects tampered durable receipts', async t => {
  const root = await tempRoot(t);
  const budget = controller(root);
  await budget.allocate({
    instruction: 'Create a durable receipt that will be tampered.',
    novelty: 0.8,
    uncertainty: 0.8,
    expected_recurrence: 2,
    estimated_future_call_savings: 10000,
    tool_cost: 1000
  }, {
    idempotency_key: 'tamper',
    providers: [async () => ({ result: 'ok', usage: { cost_credits: 222 } })]
  });
  const ledgerPath = path.join(root, 'ledger.jsonl');
  const content = await fs.readFile(ledgerPath, 'utf8');
  await fs.writeFile(ledgerPath, content.replace('provider_completed', 'provider_forged'), 'utf8');
  await assert.rejects(budget.history(), /tamper detected/);
});

test('makes deterministic decisions for equivalent inputs', async t => {
  const rootA = await tempRoot(t);
  const rootB = await tempRoot(t);
  const a = controller(rootA);
  const b = controller(rootB);
  const task = {
    instruction: 'Deterministically budget the same recurring unknown task.',
    novelty: 0.77,
    uncertainty: 0.66,
    expected_recurrence: 7,
    estimated_future_call_savings: 21000,
    tool_cost: 3000,
    context: { repo: 'Pokitomas/theawesomehexapp' }
  };
  const left = await a.decide(task, { idempotency_key: 'deterministic' });
  const right = await b.decide(task, { idempotency_key: 'deterministic' });
  assert.deepEqual(left, right);
  assert.equal(left.state, 'approved');
});
