import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCoordinationMessage,
  authorizeReleaseCommand,
  buildDeploymentReceipt,
  buildIntegrationPlan,
  buildReleaseCandidate,
  buildSmallestRepairLane,
  computeExecutiveMetrics,
  createCoordinationState,
  detectPostDeployDivergence,
  evaluateIntegration,
  evaluateLaneTermination,
  filterExecutiveOutput,
  projectCoordinationState,
  signCoordinationMessage,
  terminalizeGeneration,
  terminateIntegratedBranch
} from '../maker-executive-integration-release.mjs';

const SHA = 'a'.repeat(40), NEXT = 'b'.repeat(40), RESULT = 'c'.repeat(40);
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);

function plan() {
  return buildIntegrationPlan({ repository: 'owner/repo', main_sha: SHA, lanes: [
    { id: 'state', source_sha: SHA, result_sha: NEXT, dependencies: [], receipt_digest: A, evaluation_digest: B, changed_scopes: ['scripts/state.mjs'], status: 'completed' },
    { id: 'control', source_sha: NEXT, result_sha: RESULT, dependencies: ['state'], receipt_digest: B, evaluation_digest: C, changed_scopes: ['scripts/control.mjs'], status: 'completed' }
  ] });
}

test('integration plans dependency order and denies stale heads, collisions, regressions, ownership, receipts, and evaluations', () => {
  const value = plan();
  assert.deepEqual(value.order, ['state', 'control']);
  const admitted = evaluateIntegration({ plan: value, current_main_sha: SHA, expected_integration_head: RESULT, observed_integration_head: RESULT });
  assert.equal(admitted.admitted, true);
  const denied = evaluateIntegration({ plan: value, current_main_sha: NEXT, expected_integration_head: RESULT, observed_integration_head: SHA, collisions: [{}], regressions: [{}], unowned_scopes: ['x'], stale_evaluations: ['e'], missing_receipts: ['r'] });
  assert.equal(denied.action, 'rebase-and-reverify');
  assert.equal(denied.reasons.length, 7);
});

test('smallest repair lanes and branch termination are explicit', () => {
  const repair = buildSmallestRepairLane([{ unit: 'large', scope_size: 10 }, { unit: 'x', scope_size: 1, owned_scopes: ['scripts/x'] }], { source_sha: SHA });
  assert.equal(repair.id, 'repair:x');
  assert.equal(terminateIntegratedBranch({ branch: 'maker/x', reason: 'merged', result_sha: RESULT }).status, 'terminated');
});

test('release candidates separate authorities, bind OIDC and validate exact command context', () => {
  const candidate = buildReleaseCandidate({ repository: 'owner/repo', event: 'workflow_dispatch', head_sha: SHA, build_principal: 'builder', deploy_principal: 'deployer', promotion_principal: 'promoter', environment: 'production', protected_environment: true, oidc_subject: 'repo:owner/repo:environment:production', expected_oidc_subject: 'repo:owner/repo:environment:production', artifact_digest: A, model_digest: B, rollback_target_sha: NEXT, required_gates: ['tests'], passed_gates: ['tests'] });
  const allowed = authorizeReleaseCommand({ candidate, owner: 'owner', repository_name: 'repo', event: 'workflow_dispatch', head_sha: SHA, principal_id: 'deployer', action: 'deploy' });
  assert.equal(allowed.allowed, true);
  assert.throws(() => buildReleaseCandidate({ repository: 'owner/repo', event: 'x', head_sha: SHA, build_principal: 'same', deploy_principal: 'same', promotion_principal: 'other', environment: 'prod', protected_environment: true, oidc_subject: 'x', expected_oidc_subject: 'x', artifact_digest: A, rollback_target_sha: NEXT }), /must be separate/);
});

test('deployment receipts verify live digests and preserve rollback targets', () => {
  const candidate = buildReleaseCandidate({ repository: 'owner/repo', event: 'push', head_sha: SHA, build_principal: 'b', deploy_principal: 'd', promotion_principal: 'p', environment: 'prod', protected_environment: true, oidc_subject: 'sub', expected_oidc_subject: 'sub', artifact_digest: A, model_digest: B, rollback_target_sha: NEXT });
  const receipt = buildDeploymentReceipt({ candidate, live_artifact_digest: A, live_model_digest: B, deployment_url: 'https://example.test', deployed_identity: 'deploy:1' });
  assert.equal(receipt.verified, true);
  const divergence = detectPostDeployDivergence(receipt, { artifact_digest: C, model_digest: B, deployed_identity: 'deploy:2' });
  assert.equal(divergence.divergent, true);
  assert.equal(divergence.rollback_target_sha, NEXT);
});

test('signed coordination rejects replay and repository truth invalidates stale claims', () => {
  const secrets = { root: 'secret', member: 'member-secret' };
  let state = createCoordinationState({ repository: 'owner/repo', main_sha: SHA, root_principal: 'root' });
  let previous = null;
  const apply = (kind, payload, principal = 'root', secret = secrets[principal]) => {
    const message = signCoordinationMessage({ principal_id: principal, sequence: state.messages.length + 1, nonce: `n${state.messages.length + 1}`, generation: state.generation, kind, payload, previous_digest: previous, secret });
    state = applyCoordinationMessage({ state, message, secrets });
    previous = message.message_digest;
    return message;
  };
  apply('grant', { principal_id: 'member', role: 'member' });
  const claim = apply('claim', { id: 'claim:1', statement: 'head is valid', main_sha: SHA }, 'member');
  apply('declare_head', { main_sha: NEXT });
  assert.equal(state.claims['claim:1'].valid, false);
  assert.throws(() => applyCoordinationMessage({ state, message: claim, secrets }), /sequence mismatch|replay/);
  assert.equal(projectCoordinationState(state).main_sha, NEXT);
  assert.ok(projectCoordinationState(state, { private_projection: true }).principals.root);
});

test('generation reset invalidates prior claims and advances replay generation', () => {
  const secrets = { root: 'secret' };
  let state = createCoordinationState({ repository: 'owner/repo', main_sha: SHA, root_principal: 'root' });
  const claim = signCoordinationMessage({ principal_id: 'root', sequence: 1, nonce: 'n1', generation: 0, kind: 'claim', payload: { id: 'c', statement: 'x', main_sha: SHA }, secret: secrets.root });
  state = applyCoordinationMessage({ state, message: claim, secrets });
  const reset = signCoordinationMessage({ principal_id: 'root', sequence: 2, nonce: 'n2', generation: 0, kind: 'reset', previous_digest: claim.message_digest, secret: secrets.root });
  state = applyCoordinationMessage({ state, message: reset, secrets });
  assert.equal(state.generation, 1);
  assert.equal(state.claims.c.valid, false);
});

test('self-monitoring measures verified transitions rather than activity volume', () => {
  const metrics = computeExecutiveMetrics([{ type: 'verified_transition', at_ms: 0 }, { type: 'verified_transition', at_ms: 3600000 }, { type: 'duplicate_work' }, { type: 'stale_mutation' }, { type: 'lease_contention' }, { type: 'verification', latency_ms: 100 }, { type: 'evidence_defect' }, { type: 'rollback' }, { type: 'promotion_rejection', reason: 'regression' }, { type: 'compute', compute_ms: 1000 }, { type: 'admitted_capability_gain', gain: 2 }, { type: 'claim_calibration', claimed: 0.9, observed: 0.6 }]);
  assert.equal(metrics.verified_transitions, 2);
  assert.equal(metrics.throughput_per_hour, 2);
  assert.equal(metrics.compute_ms_per_admitted_gain, 500);
  assert.ok(metrics.mean_claim_calibration_error > 0);
});

test('lane completion requires mutation, evidence, and terminal agreement', () => {
  assert.equal(evaluateLaneTermination({ lane_id: 'x', mutation_receipt: { receipt_digest: A }, evidence_complete: true, terminal_observed: true }).status, 'completed');
  assert.equal(evaluateLaneTermination({ lane_id: 'x', mutation_receipt: { receipt_digest: A }, evidence_complete: false, terminal_observed: true }).status, 'blocked');
  assert.equal(evaluateLaneTermination({ lane_id: 'x', termination_reason: 'disproof' }).status, 'terminated');
});

test('generation terminalization requires released scopes and preserves blockers and restart state', () => {
  assert.throws(() => terminalizeGeneration({ generation_id: 'g1', main_sha: SHA, snapshot_digest: A, leases: [{ status: 'active' }] }), /mutable scopes/);
  const result = terminalizeGeneration({ generation_id: 'g1', main_sha: SHA, snapshot_digest: A, leases: [{ status: 'released' }], blockers: [{ id: 'b1', active: true }], lanes: [{ id: 'done', status: 'completed' }, { id: 'open', status: 'blocked' }] });
  assert.equal(result.status, 'terminal');
  assert.deepEqual(result.restart_state.incomplete_lanes, ['open']);
});

test('narration filters summaries, speculation, reads, failed hypotheses, and token volume', () => {
  const result = filterExecutiveOutput([{ kind: 'verified_mutation', verified: true, text: 'changed' }, { kind: 'proven_milestone', verified: true, activity_summary: true }, { kind: 'terminal_result', verified: true, token_volume: 100 }, { kind: 'other', verified: true }]);
  assert.equal(result.admitted.length, 1);
  assert.equal(result.rejected.length, 3);
  assert.ok(result.rejected.some(value => value.rejection_reason === 'narration-is-not-completion-evidence'));
});
