import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAdmittedCoordinationMessage,
  assertAdmittedLaneCompletion,
  assertCurrentMutationOwned,
  authorizeAndConsumeExecutiveBudget,
  bindDeviceProfileEvidence,
  bindNonRegressionEvidence,
  buildAdmittedExecutivePlan,
  buildAdmittedFrozenEvaluationContract,
  buildAdmittedIntegrationPlan,
  buildAdmittedMutationReceipt,
  buildAdmittedVerificationContract,
  createAdmittedCoordinationState,
  decideAdmittedModelPromotion,
  evaluateAdmittedFrozenSuite,
  evaluateAdmittedVerification,
  filterAdmittedExecutiveOutput,
  normalizeAdmittedLeaseRegistry,
  parseBoundExecutiveLease,
  validateAdmittedExecutivePlan
} from '../maker-executive-admission.mjs';
import { normalizeAuthorityManifest } from '../maker-executive-controls.mjs';
import { normalizeExecutiveSnapshot } from '../maker-executive-state.mjs';
import { signCoordinationMessage } from '../maker-executive-integration-release.mjs';

const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const NEXT = 'c'.repeat(40);
const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);
const D3 = '3'.repeat(64);
const D4 = '4'.repeat(64);
const D5 = '5'.repeat(64);
const NOW = '2026-07-20T15:00:00.000Z';

function snapshot() {
  return normalizeExecutiveSnapshot({
    repository: 'owner/repo', main_sha: MAIN, observed_at: NOW,
    authority: { write: 'granted' }
  });
}

function leaseMarker(overrides = {}) {
  return `<!-- sideways-maker-lease:v1\n${JSON.stringify({
    schema: 'sideways-maker-lease/v1', session_id: 'session-1', branch: 'maker/one',
    base_branch: 'main', base_sha: MAIN, owned_paths: ['scripts/one/**'], writer_count: 1,
    ...overrides
  })}\n-->`;
}

function activeRegistry(overrides = {}) {
  return {
    repository: 'owner/repo', generation_id: 'g1', main_sha: MAIN,
    leases: [{
      id: 'lease-1', lane_id: 'lane-1', holder_id: 'writer-1', source_sha: MAIN,
      status: 'active', scopes: [{ kind: 'repository', id: 'scripts/one/**' }],
      acquired_at: '2026-07-20T14:00:00.000Z', expires_at: '2026-07-20T16:00:00.000Z', writer_count: 1
    }],
    ...overrides
  };
}

test('binds Maker lease markers to observed pull branch, base, head, and current main', () => {
  const pull = { id: '681', state: 'open', head_ref: 'maker/one', base_ref: 'main', head_sha: HEAD };
  const lease = parseBoundExecutiveLease(leaseMarker(), pull, { current_main_sha: MAIN });
  assert.equal(lease.branch, 'maker/one');
  assert.equal(lease.head_sha, HEAD);
  assert.throws(() => parseBoundExecutiveLease(leaseMarker({ branch: 'maker/forged' }), pull, { current_main_sha: MAIN }), /branch does not match/);
  assert.throws(() => parseBoundExecutiveLease(leaseMarker({ base_sha: NEXT }), pull, { current_main_sha: MAIN }), /stale base SHA/);
});

test('rejects stale or digest-tampered executable plans', () => {
  assert.throws(() => buildAdmittedExecutivePlan({
    snapshot: snapshot(),
    lanes: [{ id: 'lane', source_sha: NEXT, status: 'ready', terminal_condition: 'done', owned_paths: ['scripts/one/**'] }]
  }), /exact snapshot head/);
  const plan = buildAdmittedExecutivePlan({
    snapshot: snapshot(),
    lanes: [{ id: 'lane', status: 'ready', terminal_condition: 'done', owned_paths: ['scripts/one/**'] }]
  });
  const tampered = structuredClone(plan);
  tampered.lanes[0].title = 'forged';
  assert.throws(() => validateAdmittedExecutivePlan(tampered, { snapshot: snapshot() }), /digest mismatch/);
});

test('rejects cyclic lease ancestry and expired mutation authority', () => {
  const cyclic = activeRegistry({ leases: [
    { id: 'a', lane_id: 'a', holder_id: 'a', source_sha: MAIN, status: 'delegated', parent_lease_id: 'b', scopes: [{ kind: 'repository', id: 'scripts/one/**' }], acquired_at: '2026-07-20T14:00:00Z', expires_at: '2026-07-20T16:00:00Z', writer_count: 1 },
    { id: 'b', lane_id: 'b', holder_id: 'b', source_sha: MAIN, status: 'active', parent_lease_id: 'a', scopes: [{ kind: 'repository', id: 'scripts/one/**' }], acquired_at: '2026-07-20T14:00:00Z', expires_at: '2026-07-20T16:00:00Z', writer_count: 1 }
  ] });
  assert.throws(() => normalizeAdmittedLeaseRegistry(cyclic), /parent cycle/);
  const expired = activeRegistry({ leases: [{ ...activeRegistry().leases[0], expires_at: NOW }] });
  assert.throws(() => assertCurrentMutationOwned({ registry: expired, lease_id: 'lease-1', source_sha: MAIN, changed_scopes: [{ kind: 'repository', id: 'scripts/one/file.mjs' }], now: NOW }), /lease expired/);
});

test('recomputes authorization before consuming budget', () => {
  const manifest = normalizeAuthorityManifest({
    repository: 'owner/repo', generation_id: 'g1', generation_status: 'active', main_sha: MAIN,
    snapshot_digest: D1,
    grants: [{ principal_id: 'writer', actions: ['mutate'], scopes: [{ kind: 'repository', id: 'scripts/one/**' }] }],
    ceilings: { tokens: 100, compute_ms: 1000, storage_bytes: 1000, workflow_reruns: 2, recursive_training: 1 },
    spent: { tokens: 10, compute_ms: 0, storage_bytes: 0, workflow_reruns: 0, recursive_training: 0 },
    recursion_limit: 1
  });
  const request = { principal_id: 'writer', action: 'mutate', source_sha: MAIN, scopes: [{ kind: 'repository', id: 'scripts/one/file.mjs' }], spend: { tokens: 5 }, recursion_depth: 0, now: NOW };
  assert.throws(() => authorizeAndConsumeExecutiveBudget({ manifest, expected_manifest_digest: manifest.manifest_digest, request, authorization: { allowed: true, manifest_digest: manifest.manifest_digest, requested_spend: { tokens: -10 } } }), /does not match/);
  const next = authorizeAndConsumeExecutiveBudget({ manifest, expected_manifest_digest: manifest.manifest_digest, request });
  assert.equal(next.spent.tokens, 15);
});

test('binds deterministic replay and changed-tensor proof to exact digests', () => {
  const contract = buildAdmittedVerificationContract({
    writer_id: 'writer', verifier_id: 'verifier', source_sha: MAIN, result_sha: HEAD,
    exact_inputs: [{ id: 'input', digest: D1 }], expected_tree_digest: D2,
    required_evidence: ['tree'], negative_tests: ['authority-bypass', 'lease-overlap', 'stale-head', 'artifact-substitution'],
    deterministic_replay: true, expected_replay_digest: D3,
    changed_tensor_required: true, expected_changed_tensor_digest: D4
  });
  const evidence = [
    { type: 'tree' },
    ...['authority-bypass', 'lease-overlap', 'stale-head', 'artifact-substitution'].map(name => ({ type: 'negative-test', name, passed: true }))
  ];
  const result = evaluateAdmittedVerification({
    contract, observed_inputs: [{ id: 'input', digest: D1 }], observed_tree_digest: D2,
    evidence, cases: [], replay_digest: D5, changed_tensor_proof: { changed_tensor_digest: D4 }
  });
  assert.equal(result.ok, false);
  assert(result.failures.some(value => value.type === 'replay-mismatch'));
});

test('mutation receipts cannot self-promote and completion binds the exact lane', () => {
  const verification = { ok: true, verification_digest: D1 };
  const input = {
    repository: 'owner/repo', source_sha: MAIN, result_sha: HEAD, snapshot_digest: D2,
    lease_id: 'lease-1', plan_digest: D3, authority_manifest_digest: D4,
    changed_scopes: [{ kind: 'repository', id: 'scripts/one/file.mjs' }], commands: [{ command: 'node --test' }],
    produced_artifacts: [], verification, rollback_target_sha: MAIN
  };
  assert.throws(() => buildAdmittedMutationReceipt({ ...input, promotion_state: 'promotion:admitted' }), /cannot grant/);
  const receipt = buildAdmittedMutationReceipt(input);
  assert.equal(receipt.status, 'ready');
  assert.equal(receipt.promotion_state, 'promotion:not-admitted');
  const complete = assertAdmittedLaneCompletion({
    lane: { id: 'lease-1', source_sha: MAIN, required_evidence: ['tests'] }, mutation_receipt: receipt,
    evidence: [{ type: 'tests' }], terminal_observed: true, terminal_evidence_digest: D5
  });
  assert.equal(complete.status, 'completed');
  assert.throws(() => assertAdmittedLaneCompletion({ lane: { id: 'other', source_sha: MAIN, required_evidence: ['tests'] }, mutation_receipt: receipt, evidence: [{ type: 'tests' }], terminal_observed: true, terminal_evidence_digest: D5 }), /not bound/);
});

function frozenContract() {
  return buildAdmittedFrozenEvaluationContract({
    case_ids: ['case-1', 'case-2'], suite_digest: D1, prompt_digest: D2, dataset_digest: D3,
    baseline_digest: D4, candidate_digest: D5, evaluator_id: 'evaluator', trainer_id: 'trainer',
    declared_artifact_digests: [D4, D5], minimum_cases: 2, minimum_lower_confidence: 0
  });
}

function frozenObserved() {
  return { suite_digest: D1, prompt_digest: D2, dataset_digest: D3, baseline_digest: D4, candidate_digest: D5 };
}

test('frozen evaluation rejects repeated cases and emits evidence-bound metrics', () => {
  assert.throws(() => evaluateAdmittedFrozenSuite({
    contract: frozenContract(), observed: frozenObserved(),
    cases: [{ id: 'case-1', passed: true }, { id: 'case-1', passed: true }], accessible_artifact_digests: [D4, D5]
  }), /duplicate identities/);
  const result = evaluateAdmittedFrozenSuite({
    contract: frozenContract(), observed: frozenObserved(),
    cases: [{ id: 'case-1', capability: 'route', passed: true }, { id: 'case-2', capability: 'authority', passed: true }],
    accessible_artifact_digests: [D4, D5]
  });
  assert.equal(result.admitted_metrics, true);
  assert.match(result.evidence_digest, /^[0-9a-f]{64}$/);
});

test('promotion binds evaluation, non-regression, device, gate, and model identities', () => {
  const evaluation = evaluateAdmittedFrozenSuite({
    contract: frozenContract(), observed: frozenObserved(),
    cases: [{ id: 'case-1', passed: true }, { id: 'case-2', passed: true }], accessible_artifact_digests: [D4, D5]
  });
  const nonRegression = bindNonRegressionEvidence({ non_regression: true, regressions: [], gains: [] });
  const device = bindDeviceProfileEvidence({ device_id: 'phone', passed: true, failed_constraints: [] });
  const decision = decideAdmittedModelPromotion({
    evaluation, non_regression: nonRegression, device_profiles: [device], required_gates: { frozen: true },
    identities: { baseline_digest: D4, candidate_digest: D5, suite_digest: D1, dataset_digest: D3 }
  });
  assert.equal(decision.state, 'promotion:admitted');
  assert.equal(decision.evaluation_digest, evaluation.evidence_digest);
  assert.deepEqual(decision.device_profile_digests, [device.profile_digest]);
});

test('integration lanes bind roots to main and children to dependency results', () => {
  const lanes = [
    { id: 'root', source_sha: MAIN, result_sha: HEAD, dependencies: [], receipt_digest: D1, evaluation_digest: D2, changed_scopes: ['scripts/root'], status: 'completed' },
    { id: 'child', source_sha: HEAD, result_sha: NEXT, dependencies: ['root'], receipt_digest: D3, evaluation_digest: D4, changed_scopes: ['scripts/child'], status: 'completed' }
  ];
  const plan = buildAdmittedIntegrationPlan({ repository: 'owner/repo', main_sha: MAIN, lanes });
  assert.deepEqual(plan.order, ['root', 'child']);
  assert.throws(() => buildAdmittedIntegrationPlan({ repository: 'owner/repo', main_sha: MAIN, lanes: [lanes[0], { ...lanes[1], source_sha: MAIN }] }), /dependency result/);
});

test('coordination verifies state CAS and message digest and keeps terminal state immutable', () => {
  const secret = 'secret';
  const state = createAdmittedCoordinationState({ repository: 'owner/repo', main_sha: MAIN, root_principal: 'root' });
  const pause = signCoordinationMessage({ principal_id: 'root', sequence: 1, nonce: 'n1', generation: 0, kind: 'pause', secret });
  assert.throws(() => applyAdmittedCoordinationMessage({ state, expected_state_digest: state.state_digest, message: { ...pause, message_digest: D1 }, secrets: { root: secret } }), /message digest mismatch/);
  assert.throws(() => applyAdmittedCoordinationMessage({ state, expected_state_digest: D1, message: pause, secrets: { root: secret } }), /compare-and-swap/);
  const paused = applyAdmittedCoordinationMessage({ state, expected_state_digest: state.state_digest, message: pause, secrets: { root: secret } });
  const terminal = signCoordinationMessage({ principal_id: 'root', sequence: 2, nonce: 'n2', generation: 0, kind: 'terminalize', previous_digest: pause.message_digest, secret });
  const ended = applyAdmittedCoordinationMessage({ state: paused, expected_state_digest: paused.state_digest, message: terminal, secrets: { root: secret } });
  const resume = signCoordinationMessage({ principal_id: 'root', sequence: 3, nonce: 'n3', generation: 0, kind: 'resume', previous_digest: terminal.message_digest, secret });
  assert.throws(() => applyAdmittedCoordinationMessage({ state: ended, expected_state_digest: ended.state_digest, message: resume, secrets: { root: secret } }), /immutable/);
});

test('narration admission requires exact evidence identity', () => {
  const missing = filterAdmittedExecutiveOutput([{ kind: 'verified_mutation', verified: true, summary: 'done' }]);
  assert.equal(missing.admitted.length, 0);
  const admitted = filterAdmittedExecutiveOutput([{ kind: 'verified_mutation', verified: true, evidence_digest: D1, summary: 'done' }]);
  assert.equal(admitted.admitted.length, 1);
});
