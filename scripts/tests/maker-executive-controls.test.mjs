import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeExecutiveAction,
  buildBoundedPatchPlan,
  buildExecutiveMutationReceipt,
  buildIndependentVerificationContract,
  collapseExecutiveHypotheses,
  consumeExecutiveBudget,
  decideExecutiveRollback,
  deleteUnsupportedClaims,
  evaluateIndependentVerification,
  normalizeAuthorityManifest,
  selectSmallestFailedUnit,
  verifyGeneratedReproducibility
} from '../maker-executive-controls.mjs';

const MAIN = 'a'.repeat(40);
const RESULT = 'b'.repeat(40);
const SNAPSHOT = 'c'.repeat(64);
const TREE = 'd'.repeat(64);
const PLAN = 'e'.repeat(64);

function manifest(overrides = {}) {
  return normalizeAuthorityManifest({
    repository: 'owner/repo', generation_id: 'g1', generation_status: 'active', main_sha: MAIN, snapshot_digest: SNAPSHOT,
    grants: [{ principal_id: 'writer', actions: ['mutate', 'build'], scopes: [{ kind: 'repository', id: 'scripts/**' }] }, { principal_id: 'deployer', actions: ['deploy'], scopes: [{ kind: 'deployment', id: 'prod' }] }],
    ceilings: { tokens: 1000, compute_ms: 10000, storage_bytes: 100000, workflow_reruns: 2, recursive_training: 1 },
    spent: { tokens: 100, compute_ms: 1000, storage_bytes: 0, workflow_reruns: 0, recursive_training: 0 },
    recursion_limit: 2,
    promotion_required_gates: ['frozen-eval'], deployment_required_gates: ['protected-env'], passed_gates: [],
    ...overrides
  });
}

test('authority checks exact manifest, head, scope, budgets, terminal state, and deployment locks', () => {
  const value = manifest();
  const allowed = authorizeExecutiveAction({ manifest: value, expected_manifest_digest: value.manifest_digest, principal_id: 'writer', action: 'mutate', source_sha: MAIN, scopes: [{ kind: 'repository', id: 'scripts/a.mjs' }], spend: { tokens: 10 } });
  assert.equal(allowed.allowed, true);
  const denied = authorizeExecutiveAction({ manifest: value, expected_manifest_digest: value.manifest_digest, principal_id: 'deployer', action: 'deploy', source_sha: MAIN, scopes: [{ kind: 'deployment', id: 'prod' }] });
  assert.deepEqual(denied.denial_reasons, ['deployment-locked']);
  const stale = authorizeExecutiveAction({ manifest: value, expected_manifest_digest: 'f'.repeat(64), principal_id: 'writer', action: 'mutate', source_sha: RESULT, scopes: [{ kind: 'repository', id: 'docs/x' }], spend: { tokens: 9999 }, recursion_depth: 3 });
  assert.ok(stale.denial_reasons.includes('authority-manifest-changed'));
  assert.ok(stale.denial_reasons.includes('stale-head'));
  assert.ok(stale.denial_reasons.includes('scope-not-granted'));
  assert.ok(stale.denial_reasons.includes('budget-exceeded:tokens'));
  assert.ok(stale.denial_reasons.includes('recursion-limit-exceeded'));
});

test('budget consumption is compare-and-swap and never consumes denied actions', () => {
  const value = manifest();
  const authorization = authorizeExecutiveAction({ manifest: value, expected_manifest_digest: value.manifest_digest, principal_id: 'writer', action: 'mutate', source_sha: MAIN, scopes: [{ kind: 'repository', id: 'scripts/a.mjs' }], spend: { tokens: 10, compute_ms: 50 } });
  const updated = consumeExecutiveBudget({ manifest: value, expected_manifest_digest: value.manifest_digest, authorization });
  assert.equal(updated.spent.tokens, 110);
  assert.throws(() => consumeExecutiveBudget({ manifest: value, expected_manifest_digest: 'f'.repeat(64), authorization }), /compare-and-swap/);
});

test('bounded patch planning selects the smallest observable mutation and deletes unsupported claims', () => {
  const plan = buildBoundedPatchPlan({ source_sha: MAIN, snapshot_digest: SNAPSHOT, lease_id: 'l1', candidates: [
    { id: 'large', changed_scopes: [{ kind: 'repository', id: 'scripts/a.mjs' }, { kind: 'repository', id: 'scripts/b.mjs' }], changed_bytes: 200, observable_tests: ['test-a', 'test-b'], claims: ['a', 'b'], rollback: 'reset' },
    { id: 'small', changed_scopes: [{ kind: 'repository', id: 'scripts/a.mjs' }], changed_bytes: 100, observable_tests: ['test-a'], claims: ['a'], rollback: 'restore' },
    { id: 'invisible', changed_scopes: [{ kind: 'repository', id: 'scripts/c.mjs' }], changed_bytes: 1, claims: ['c'], rollback: 'restore' }
  ] });
  assert.equal(plan.selected.id, 'small');
  assert.equal(plan.rejected.find(value => value.id === 'invisible').reasons[0], 'behavior-not-observable');
  const admitted = deleteUnsupportedClaims(plan, []);
  assert.deepEqual(admitted.selected.claims, []);
});

test('high-impact hypotheses require competition and an independent adversarial alternative', () => {
  assert.throws(() => collapseExecutiveHypotheses({ implementation_author: 'writer', high_impact: true, hypotheses: [{ id: 'one', statement: 'one', falsification: 'fails', author_id: 'writer' }] }), /competing/);
  const collapsed = collapseExecutiveHypotheses({ implementation_author: 'writer', high_impact: true, hypotheses: [
    { id: 'one', statement: 'minimal patch', falsification: 'test fails', author_id: 'writer', evidence: [{ direction: 'support', weight: 3, provenance: 'test' }] },
    { id: 'two', statement: 'no patch needed', falsification: 'repro succeeds', author_id: 'verifier', adversarial: true, evidence: [{ direction: 'refute', weight: 2, provenance: 'failure' }] }
  ] });
  assert.equal(collapsed.selected.id, 'one');
  assert.equal(collapsed.rejected[0].rejection_reason, 'disproved');
  assert.deepEqual(collapsed.terminated, [{ hypothesis_id: 'two', reason: 'assumption-disproved' }]);
});

test('independent verification binds exact bytes, tree, negative tests, replay, tensors, and case failures', () => {
  const contract = buildIndependentVerificationContract({
    writer_id: 'writer', verifier_id: 'verifier', source_sha: MAIN, result_sha: RESULT,
    exact_inputs: [{ id: 'suite', digest: SNAPSHOT }], expected_tree_digest: TREE,
    required_evidence: ['focused-test', 'tree-proof'],
    negative_tests: ['authority-bypass', 'lease-overlap', 'stale-head', 'artifact-substitution'],
    deterministic_replay: true, changed_tensor_required: true
  });
  const failed = evaluateIndependentVerification({ contract, observed_inputs: [{ id: 'suite', digest: 'f'.repeat(64) }], observed_tree_digest: TREE, evidence: [], cases: [{ id: 'case-2', passed: false, severity: 'high' }] });
  assert.equal(failed.ok, false);
  assert.ok(failed.failures.some(value => value.type === 'input-mismatch'));
  assert.ok(failed.failures.some(value => value.type === 'negative-test-failed'));
  assert.ok(failed.failures.some(value => value.type === 'replay-missing'));
  assert.ok(failed.failures.some(value => value.type === 'changed-tensor-proof-missing'));
  assert.equal(selectSmallestFailedUnit([failed]).unit, 'suite');
});

test('complete independent verification passes with case-level evidence', () => {
  const contract = buildIndependentVerificationContract({
    writer_id: 'writer', verifier_id: 'verifier', source_sha: MAIN, result_sha: RESULT,
    exact_inputs: [{ id: 'suite', digest: SNAPSHOT }], expected_tree_digest: TREE,
    required_evidence: ['focused-test', 'tree-proof'],
    negative_tests: ['authority-bypass', 'lease-overlap', 'stale-head', 'artifact-substitution']
  });
  const evidence = [{ type: 'focused-test' }, { type: 'tree-proof' }, ...contract.negative_tests.map(name => ({ type: 'negative-test', name, passed: true }))];
  const passed = evaluateIndependentVerification({ contract, observed_inputs: [{ id: 'suite', digest: SNAPSHOT }], observed_tree_digest: TREE, evidence, cases: [{ id: 'case-1', passed: true }] });
  assert.equal(passed.ok, true);
  assert.equal(passed.smallest_failed_unit, null);
});

test('generated output reproducibility is exact and mismatch fails closed', () => {
  const result = verifyGeneratedReproducibility([{ id: 'a', digest: SNAPSHOT }], [{ id: 'a', digest: SNAPSHOT }]);
  assert.equal(result.reproducible, true);
  assert.throws(() => verifyGeneratedReproducibility([{ id: 'a', digest: SNAPSHOT }], [{ id: 'a', digest: TREE }]), /not reproducible/);
});

test('rollback is required after verification failure or expected-head movement', () => {
  assert.equal(decideExecutiveRollback({ source_sha: MAIN, current_head_sha: MAIN, verification: { ok: true } }).rollback_required, false);
  const failed = decideExecutiveRollback({ source_sha: MAIN, current_head_sha: RESULT, verification: { ok: false } });
  assert.equal(failed.rollback_required, true);
  assert.deepEqual(failed.denial_reasons, ['expected-head-changed', 'verification-failed']);
});

test('mutation receipts require independent verification and bind source/result/artifacts/rollback', () => {
  assert.throws(() => buildExecutiveMutationReceipt({ verification: { ok: false } }), /passing independent verification/);
  const receipt = buildExecutiveMutationReceipt({
    repository: 'owner/repo', source_sha: MAIN, result_sha: RESULT, snapshot_digest: SNAPSHOT,
    lease_id: 'l1', plan_digest: PLAN, authority_manifest_digest: manifest().manifest_digest,
    changed_scopes: [{ kind: 'repository', id: 'scripts/a.mjs' }], commands: [{ program: 'node', args: ['test.mjs'], exit_code: 0 }],
    produced_artifacts: [{ id: 'artifact:1', digest: TREE }], verification: { ok: true, cases: [{ id: 'case-1', passed: true }] }, rollback_target_sha: MAIN
  });
  assert.equal(receipt.promotion_state, 'promotion:not-admitted');
  assert.match(receipt.receipt_digest, /^[0-9a-f]{64}$/);
});
