import assert from 'node:assert/strict';
import test from 'node:test';
import {
  archieMakerValueDigest,
  createArchieMakerRoutingDecision
} from '../maker-archie-runtime-contract.mjs';
import { resolveArchieMakerLaunch } from '../maker-archie-launch.mjs';

const baseSha = 'a'.repeat(40);
const executionKey = 'k'.repeat(64);

function plan() {
  return {
    title: 'Route Maker through Archie once',
    branch_slug: 'archie-decision-spine',
    selected_lane: 'operator',
    why_now: 'The default launcher needs one typed truth boundary.',
    owned_paths: ['scripts/maker-archie-launch.mjs'],
    implementation_prompt: 'Preserve exact recurrence authority and make every fallback explicit.',
    focused_tests: ['node --test scripts/tests/maker-archie-launch.test.mjs'],
    deferred: ['Derived execution remains blocked until POK-35.']
  };
}

function recurrence({ base = baseSha } = {}) {
  return {
    status: 'local',
    source: 'native-maker-recall',
    plan: plan(),
    specialist_id: 'skill_exact_recurrence',
    confidence: 0.98,
    margin: 0.52,
    model_digest: 'model-fixture',
    execution_eligible: true,
    execution_basis: {
      kind: 'normalized-exact-verified-recurrence',
      example_id: 'example-fixture',
      base_sha: base
    }
  };
}

function decision(recall) {
  return createArchieMakerRoutingDecision({
    request: 'Complete the bounded repair.',
    repository: '/tmp/repository',
    baseBranch: 'main',
    baseSha,
    recall,
    clock: () => '2026-07-17T12:00:00.000Z'
  });
}

test('normalizes every Archie routing state without expanding execution authority', () => {
  const local = decision(recurrence());
  assert.equal(local.state, 'local_recurrence');
  assert.equal(local.executable, true);
  assert.match(local.recurrence.plan_digest, /^[a-f0-9]{64}$/);

  const proof = { schema: 'archie-derived-proof/v1', trace_digest: 'b'.repeat(64) };
  const derived = decision({
    status: 'derived_candidate',
    candidate: {
      candidate_id: 'candidate-fixture',
      source: 'archie-derivation',
      plan: plan(),
      proof,
      proof_digest: archieMakerValueDigest(proof)
    }
  });
  assert.equal(derived.state, 'derived_candidate');
  assert.equal(derived.executable, false);
  assert.equal(derived.candidate.candidate_id, 'candidate-fixture');

  for (const state of ['teacher_required', 'rejected', 'miss', 'failed']) {
    const routed = decision({ status: state, reason: `${state} fixture` });
    assert.equal(routed.state, state);
    assert.equal(routed.executable, false);
    assert.equal(routed.reason, `${state} fixture`);
  }
});

test('stale, advisory, malformed, and unknown inputs fail closed into explicit non-executable states', () => {
  const stale = decision(recurrence({ base: 'c'.repeat(40) }));
  assert.equal(stale.state, 'miss');
  assert.equal(stale.executable, false);

  const advisory = decision({ ...recurrence(), execution_eligible: false, execution_basis: null });
  assert.equal(advisory.state, 'miss');

  const malformedDerived = decision({
    status: 'derived_candidate',
    candidate: { plan: plan(), proof: { trace: 'tampered' }, proof_digest: 'd'.repeat(64) }
  });
  assert.equal(malformedDerived.state, 'failed');
  assert.match(malformedDerived.reason, /proof integrity/i);

  const unknown = decision({ status: 'magical_superintelligence' });
  assert.equal(unknown.state, 'failed');
  assert.match(unknown.reason, /unsupported/i);
});

test('resolves exactly one recall and emits HMAC execution authority only for exact recurrence', async () => {
  let calls = 0;
  const resolved = await resolveArchieMakerLaunch({
    repoRoot: '/tmp/repository',
    request: 'Complete the bounded repair.',
    baseBranch: 'main',
    baseSha,
    env: {},
    executionKey,
    clock: () => '2026-07-17T12:00:00.000Z',
    recall: async () => {
      calls += 1;
      return recurrence();
    }
  });

  assert.equal(calls, 1);
  assert.equal(resolved.decision.state, 'local_recurrence');
  assert.equal(resolved.execution_decision.schema, 'sideways-archie-maker-decision/v1');
  assert.equal(resolved.execution_key, executionKey);
  assert.equal(resolved.receipt.selected_state, 'local_recurrence');
  assert.equal(resolved.receipt.executable, true);
  assert.match(resolved.receipt.exact_recurrence_decision_digest, /^[a-f0-9]{64}$/);
});

test('derived candidates remain inspectable but cannot reach Maker execution before admission', async () => {
  const proof = { schema: 'archie-derived-proof/v1', trace_digest: 'e'.repeat(64) };
  const resolved = await resolveArchieMakerLaunch({
    repoRoot: '/tmp/repository',
    request: 'Derive a new repair.',
    baseBranch: 'main',
    baseSha,
    env: {},
    clock: () => '2026-07-17T12:00:00.000Z',
    recall: async () => ({
      status: 'derived_candidate',
      candidate: { plan: plan(), proof, proof_digest: archieMakerValueDigest(proof) }
    })
  });

  assert.equal(resolved.decision.state, 'derived_candidate');
  assert.equal(resolved.execution_decision, null);
  assert.equal(resolved.execution_key, null);
  assert.equal(resolved.receipt.executable, false);
  assert.equal(resolved.receipt.exact_recurrence_decision_digest, null);
});

test('ARCHIE_DISABLED bypasses recall and the decision spine while preserving an explicit launcher receipt', async () => {
  let calls = 0;
  const resolved = await resolveArchieMakerLaunch({
    repoRoot: '/tmp/repository',
    request: 'Run ordinary Maker.',
    baseBranch: 'main',
    baseSha,
    env: { ARCHIE_DISABLED: 'true' },
    clock: () => '2026-07-17T12:00:00.000Z',
    recall: async () => {
      calls += 1;
      return recurrence();
    }
  });

  assert.equal(calls, 0);
  assert.equal(resolved.bypassed, true);
  assert.equal(resolved.decision, null);
  assert.equal(resolved.execution_decision, null);
  assert.equal(resolved.receipt.bypassed, true);
  assert.equal(resolved.receipt.selected_state, null);
  assert.equal(resolved.receipt.source, 'archie-disabled');
  assert.match(resolved.receipt.reason, /ordinary Maker compatibility/i);
});
