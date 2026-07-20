import crypto from 'node:crypto';
import {
  EXECUTIVE_PLAN_SCHEMA,
  buildExecutivePlan,
  digest,
  normalizeExecutiveSnapshot,
  stableJSONStringify
} from './maker-executive-state.mjs';
import {
  parseExecutiveLeaseMarker,
  synthesizeExecutiveLiveState
} from './maker-executive-live-state.mjs';
import {
  assertMutationOwned,
  normalizeExecutiveLeaseRegistry
} from './maker-executive-delegation.mjs';
import {
  authorizeExecutiveAction,
  buildExecutiveMutationReceipt,
  buildIndependentVerificationContract,
  consumeExecutiveBudget,
  evaluateIndependentVerification,
  normalizeAuthorityManifest
} from './maker-executive-controls.mjs';
import {
  buildFrozenEvaluationContract,
  decideModelPromotion,
  evaluateFrozenSuite
} from './maker-executive-model-evaluation.mjs';
import {
  EXECUTIVE_COORDINATION_SCHEMA,
  applyCoordinationMessage,
  buildIntegrationPlan,
  createCoordinationState,
  filterExecutiveOutput
} from './maker-executive-integration-release.mjs';

export const EXECUTIVE_ADMISSION_SCHEMA = 'sideways-maker-executive-admission/v1';
export const ADMITTED_VERIFICATION_SCHEMA = 'sideways-maker-admitted-verification/v1';
export const ADMITTED_MUTATION_RECEIPT_SCHEMA = 'sideways-maker-admitted-mutation-receipt/v1';
export const ADMITTED_FROZEN_EVALUATION_SCHEMA = 'sideways-maker-admitted-frozen-evaluation/v1';
export const ADMITTED_PROMOTION_SCHEMA = 'sideways-maker-admitted-promotion/v1';

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MUTABLE_LEASE_STATES = new Set(['active', 'delegated']);
const CONTROL_KINDS = new Set(['grant', 'revoke', 'reset', 'terminalize', 'declare_head', 'pause', 'resume', 'stop']);
const BUDGET_KEYS = ['tokens', 'compute_ms', 'storage_bytes', 'workflow_reruns', 'recursive_training'];
const EVIDENCE_OUTPUT_KINDS = new Set(['verified_mutation', 'proven_milestone', 'terminal_result', 'unavailable_external_authority']);
const clean = (value, limit = 8000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, canonical(child)]));
}

function exact(value, pattern, label) {
  const normalized = clean(value, 1000).toLowerCase();
  if (!pattern.test(normalized)) throw new Error(`${label} must be an exact ${pattern === SHA40 ? '40-character commit SHA' : 'SHA-256 digest'}.`);
  return normalized;
}

function instant(value, label) {
  const timestamp = Date.parse(clean(value, 100));
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function without(value, key) {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

function verifyBoundDigest(value, key, label) {
  if (!value || typeof value !== 'object') throw new Error(`${label} is missing.`);
  const claimed = exact(value[key], SHA256, `${label}.${key}`);
  const observed = digest(without(value, key));
  if (claimed !== observed) throw new Error(`${label} digest mismatch.`);
  return value;
}

function uniqueStrings(values, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
  const normalized = values.map(value => clean(value, 500));
  if (!allowEmpty && normalized.some(value => !value)) throw new Error(`${label} contains an empty identity.`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicate identities.`);
  return normalized;
}

function pullRef(pull, side) {
  return clean(pull?.[`${side}_ref`] ?? pull?.[side]?.ref ?? pull?.[side], 300);
}

function pullSha(pull, side) {
  const value = pull?.[`${side}_sha`] ?? pull?.[side]?.sha;
  return value ? exact(value, SHA40, `pull.${side}_sha`) : null;
}

export function parseBoundExecutiveLease(body, pull = {}, { current_main_sha } = {}) {
  const lease = parseExecutiveLeaseMarker(body, pull);
  if (!lease) return null;
  const main = exact(current_main_sha, SHA40, 'current_main_sha');
  const pullId = clean(pull.id ?? pull.number, 200);
  const headRef = pullRef(pull, 'head');
  const baseRef = pullRef(pull, 'base');
  const headSha = pullSha(pull, 'head');
  if (!pullId || !headRef || !baseRef || !headSha) throw new Error('Active Maker pull metadata is incomplete.');
  if (!lease.session_id || !lease.branch || !lease.base_branch) throw new Error('Maker lease marker is missing session or branch identity.');
  if (lease.branch !== headRef) throw new Error('Maker lease branch does not match the observed pull head.');
  if (lease.base_branch !== baseRef) throw new Error('Maker lease base does not match the observed pull base.');
  if (lease.base_sha !== main) throw new Error('Maker lease is bound to a stale base SHA.');
  if (lease.head_sha && lease.head_sha !== headSha) throw new Error('Maker lease projection does not match the observed pull head SHA.');
  return Object.freeze(canonical({ ...lease, head_sha: headSha, source_pr: pullId }));
}

export function synthesizeAdmittedExecutiveLiveState(input = {}) {
  const main = exact(input.main_sha, SHA40, 'main_sha');
  for (const source of input.sources || []) {
    const pulls = source.records?.pulls ?? source.pulls ?? [];
    for (const pull of pulls) {
      if (String(pull?.body || '').includes('sideways-maker-lease:v1')) {
        parseBoundExecutiveLease(pull.body, pull, { current_main_sha: main });
      }
    }
  }
  const result = synthesizeExecutiveLiveState(input);
  const normalized = normalizeExecutiveSnapshot(result.snapshot);
  if (normalized.snapshot_digest !== result.snapshot.snapshot_digest) throw new Error('Synthesized snapshot digest mismatch.');
  return result;
}

export function validateAdmittedExecutivePlan(plan, { snapshot } = {}) {
  if (plan?.schema !== EXECUTIVE_PLAN_SCHEMA) throw new Error('Unsupported executive plan.');
  verifyBoundDigest(plan, 'plan_digest', 'executive plan');
  const resolved = normalizeExecutiveSnapshot(snapshot);
  if (plan.source_snapshot_digest !== resolved.snapshot_digest || plan.source_main_sha !== resolved.main_sha) {
    throw new Error('Executive plan is not bound to the supplied snapshot.');
  }
  const laneIds = uniqueStrings((plan.lanes || []).map(value => value.id), 'executive plan lane ids');
  if (laneIds.length !== plan.lanes.length) throw new Error('Executive plan lane identities are incomplete.');
  for (const lane of plan.lanes) {
    if (exact(lane.source_sha, SHA40, `${lane.id}.source_sha`) !== resolved.main_sha) throw new Error(`Lane ${lane.id} is bound to a stale source SHA.`);
    for (const dependency of lane.dependencies || []) if (!laneIds.includes(clean(dependency, 200))) throw new Error(`Lane ${lane.id} has an unknown dependency.`);
  }
  const rebuilt = buildExecutivePlan({ snapshot: resolved, lanes: plan.lanes, plan_id: plan.plan_id, created_at: plan.created_at });
  if (rebuilt.plan_digest !== plan.plan_digest || stableJSONStringify(rebuilt) !== stableJSONStringify(plan)) throw new Error('Executive plan canonical reconstruction mismatch.');
  return rebuilt;
}

export function buildAdmittedExecutivePlan({ snapshot, lanes = [], plan_id = '', created_at = new Date().toISOString() } = {}) {
  const resolved = normalizeExecutiveSnapshot(snapshot);
  const bound = lanes.map(value => ({ ...value, source_sha: value.source_sha || resolved.main_sha }));
  for (const lane of bound) if (exact(lane.source_sha, SHA40, `${lane.id || 'lane'}.source_sha`) !== resolved.main_sha) throw new Error('Every executable lane must bind the exact snapshot head.');
  return validateAdmittedExecutivePlan(buildExecutivePlan({ snapshot: resolved, lanes: bound, plan_id, created_at }), { snapshot: resolved });
}

function assertNoLeaseCycles(registry) {
  const leases = new Map(registry.leases.map(value => [value.id, value]));
  for (const lease of registry.leases) {
    const seen = new Set([lease.id]);
    let current = lease;
    while (current.parent_lease_id) {
      if (seen.has(current.parent_lease_id)) throw new Error(`Executive lease parent cycle includes ${current.parent_lease_id}.`);
      seen.add(current.parent_lease_id);
      current = leases.get(current.parent_lease_id);
      if (!current) break;
    }
  }
}

export function normalizeAdmittedLeaseRegistry(input = {}) {
  const registry = normalizeExecutiveLeaseRegistry(input);
  if (input.registry_digest && exact(input.registry_digest, SHA256, 'registry.registry_digest') !== registry.registry_digest) throw new Error('Executive lease registry digest mismatch.');
  assertNoLeaseCycles(registry);
  return registry;
}

export function assertCurrentMutationOwned({ registry, lease_id, source_sha, changed_scopes = [], now = new Date().toISOString() } = {}) {
  const current = normalizeAdmittedLeaseRegistry(registry);
  const lease = current.leases.find(value => value.id === clean(lease_id, 200));
  if (!lease || !MUTABLE_LEASE_STATES.has(lease.status)) throw new Error('Mutation requires a mutable lease.');
  if (Date.parse(instant(now, 'now')) >= Date.parse(lease.expires_at)) throw new Error('Mutation denied because the writer lease expired.');
  return assertMutationOwned({ registry: current, lease_id, source_sha, changed_scopes });
}

function normalizedBudget(input = {}, label = 'budget') {
  return Object.fromEntries(BUDGET_KEYS.map(key => {
    const value = Number(input[key] ?? 0);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label}.${key} must be non-negative and finite.`);
    return [key, value];
  }));
}

export function authorizeAndConsumeExecutiveBudget({ manifest, expected_manifest_digest, request = {}, authorization = null } = {}) {
  const authority = normalizeAuthorityManifest(manifest);
  const expected = exact(expected_manifest_digest, SHA256, 'expected_manifest_digest');
  if (authority.manifest_digest !== expected) throw new Error('Authority manifest compare-and-swap failed.');
  const spend = normalizedBudget(request.spend, 'request.spend');
  const recomputed = authorizeExecutiveAction({ ...request, spend, manifest: authority, expected_manifest_digest: expected });
  if (!recomputed.allowed) throw new Error(`Executive action is denied: ${recomputed.denial_reasons.join(', ')}.`);
  if (authorization && stableJSONStringify(authorization) !== stableJSONStringify(recomputed)) throw new Error('Caller-supplied authorization does not match the recomputed decision.');
  if (recomputed.manifest_digest !== authority.manifest_digest) throw new Error('Authorization is not bound to the current authority manifest.');
  return consumeExecutiveBudget({ manifest: authority, expected_manifest_digest: expected, authorization: recomputed });
}

export function buildAdmittedVerificationContract(input = {}) {
  const inner = buildIndependentVerificationContract(input);
  const expected_replay_digest = input.deterministic_replay ? exact(input.expected_replay_digest, SHA256, 'expected_replay_digest') : null;
  const expected_changed_tensor_digest = input.changed_tensor_required ? exact(input.expected_changed_tensor_digest, SHA256, 'expected_changed_tensor_digest') : null;
  const body = canonical({ schema: ADMITTED_VERIFICATION_SCHEMA, contract: inner, expected_replay_digest, expected_changed_tensor_digest });
  return Object.freeze({ ...body, admission_contract_digest: digest(body) });
}

export function evaluateAdmittedVerification({ contract, replay_digest = null, changed_tensor_proof = null, ...observed } = {}) {
  if (contract?.schema !== ADMITTED_VERIFICATION_SCHEMA) throw new Error('Unsupported admitted verification contract.');
  verifyBoundDigest(contract, 'admission_contract_digest', 'admitted verification contract');
  verifyBoundDigest(contract.contract, 'contract_digest', 'independent verification contract');
  const result = evaluateIndependentVerification({ contract: contract.contract, replay_digest, changed_tensor_proof, ...observed });
  const failures = [...result.failures];
  if (contract.expected_replay_digest && exact(replay_digest, SHA256, 'replay_digest') !== contract.expected_replay_digest) failures.push({ type: 'replay-mismatch', unit: 'deterministic-replay' });
  if (contract.expected_changed_tensor_digest && exact(changed_tensor_proof?.changed_tensor_digest, SHA256, 'changed_tensor_proof.changed_tensor_digest') !== contract.expected_changed_tensor_digest) failures.push({ type: 'changed-tensor-mismatch', unit: 'changed-tensors' });
  failures.sort((a, b) => String(a.unit).localeCompare(String(b.unit)) || String(a.type).localeCompare(String(b.type)));
  const body = canonical({ ...result, ok: failures.length === 0, failures, admission_contract_digest: contract.admission_contract_digest });
  return Object.freeze({ ...body, verification_digest: digest(body) });
}

export function buildAdmittedMutationReceipt(input = {}) {
  if (input.promotion_state && input.promotion_state !== 'promotion:not-admitted') throw new Error('Mutation receipts cannot grant model promotion.');
  const lowLevel = buildExecutiveMutationReceipt({ ...input, promotion_state: 'promotion:not-admitted' });
  const body = canonical({
    ...without(lowLevel, 'receipt_digest'),
    schema: ADMITTED_MUTATION_RECEIPT_SCHEMA,
    status: 'ready',
    low_level_receipt_digest: lowLevel.receipt_digest,
    promotion_state: 'promotion:not-admitted'
  });
  return Object.freeze({ ...body, receipt_digest: digest(body) });
}

export function assertAdmittedLaneCompletion({ lane, mutation_receipt, evidence = [], terminal_observed = false, terminal_evidence_digest } = {}) {
  verifyBoundDigest(mutation_receipt, 'receipt_digest', 'mutation receipt');
  if (mutation_receipt.schema !== ADMITTED_MUTATION_RECEIPT_SCHEMA || mutation_receipt.status !== 'ready') throw new Error('Lane completion requires an admitted ready mutation receipt.');
  if (!lane?.id || mutation_receipt.lease_id !== lane.id) throw new Error('Mutation receipt is not bound to the completing lane.');
  if (lane.source_sha && mutation_receipt.source_sha !== exact(lane.source_sha, SHA40, 'lane.source_sha')) throw new Error('Mutation receipt source SHA does not match the lane.');
  const types = new Set(uniqueStrings(evidence.map(value => value.type), 'completion evidence types'));
  for (const required of lane.required_evidence || []) if (!types.has(clean(required, 500))) throw new Error(`Lane completion is missing evidence ${required}.`);
  if (terminal_observed !== true) throw new Error('Lane terminal condition is not independently observed.');
  const terminalDigest = exact(terminal_evidence_digest, SHA256, 'terminal_evidence_digest');
  const body = canonical({ lane_id: lane.id, status: 'completed', receipt_digest: mutation_receipt.receipt_digest, terminal_evidence_digest: terminalDigest });
  return Object.freeze({ ...body, completion_digest: digest(body) });
}

export function buildAdmittedFrozenEvaluationContract({ case_ids = [], ...input } = {}) {
  const ids = uniqueStrings(case_ids, 'frozen evaluation case ids').sort();
  if (!ids.length) throw new Error('Frozen evaluation requires an explicit case manifest.');
  if (!clean(input.trainer_id, 300) || !clean(input.evaluator_id, 300)) throw new Error('Frozen evaluation requires trainer and evaluator identities.');
  const declared = uniqueStrings(input.declared_artifact_digests || [], 'declared artifact digests').map((value, index) => exact(value, SHA256, `declared_artifact_digests[${index}]`));
  const baseline = exact(input.baseline_digest, SHA256, 'baseline_digest');
  const candidate = exact(input.candidate_digest, SHA256, 'candidate_digest');
  if (!declared.includes(baseline) || !declared.includes(candidate)) throw new Error('Frozen evaluator declarations must include baseline and candidate artifacts.');
  const inner = buildFrozenEvaluationContract({ ...input, baseline_digest: baseline, candidate_digest: candidate, declared_artifact_digests: declared });
  const body = canonical({ schema: ADMITTED_FROZEN_EVALUATION_SCHEMA, contract: inner, case_ids: ids, case_ids_digest: digest(ids) });
  return Object.freeze({ ...body, admission_contract_digest: digest(body) });
}

export function evaluateAdmittedFrozenSuite({ contract, observed = {}, cases = [], accessible_artifact_digests = [] } = {}) {
  if (contract?.schema !== ADMITTED_FROZEN_EVALUATION_SCHEMA) throw new Error('Unsupported admitted frozen evaluation contract.');
  verifyBoundDigest(contract, 'admission_contract_digest', 'admitted frozen evaluation contract');
  verifyBoundDigest(contract.contract, 'contract_digest', 'frozen evaluation contract');
  const ids = uniqueStrings(cases.map(value => value.id), 'observed frozen case ids').sort();
  if (stableJSONStringify(ids) !== stableJSONStringify(contract.case_ids) || digest(ids) !== contract.case_ids_digest) throw new Error('Observed frozen cases do not match the frozen case manifest.');
  const result = evaluateFrozenSuite({ contract: contract.contract, observed, cases, accessible_artifact_digests });
  const observed_identities = canonical(Object.fromEntries(['suite_digest', 'prompt_digest', 'dataset_digest', 'baseline_digest', 'candidate_digest'].map(key => [key, exact(observed[key], SHA256, `observed.${key}`)])));
  const body = canonical({ ...result, admission_contract_digest: contract.admission_contract_digest, observed_identities });
  return Object.freeze({ ...body, evidence_digest: digest(body) });
}

export function bindNonRegressionEvidence(comparison = {}) {
  const body = canonical({ ...comparison });
  return Object.freeze({ ...body, comparison_digest: digest(body) });
}

export function bindDeviceProfileEvidence(profile = {}) {
  if (!clean(profile.device_id, 300)) throw new Error('Device profile evidence requires device_id.');
  const body = canonical({ ...profile });
  return Object.freeze({ ...body, profile_digest: digest(body) });
}

export function decideAdmittedModelPromotion({ evaluation, non_regression, device_profiles = [], required_gates = {}, identities = {} } = {}) {
  verifyBoundDigest(evaluation, 'evidence_digest', 'frozen evaluation evidence');
  verifyBoundDigest(non_regression, 'comparison_digest', 'non-regression evidence');
  if (!device_profiles.length) throw new Error('Model promotion requires at least one device profile.');
  for (const profile of device_profiles) verifyBoundDigest(profile, 'profile_digest', `device profile ${profile.device_id || 'unknown'}`);
  if (!Object.keys(required_gates).length) throw new Error('Model promotion requires explicit gates.');
  const normalizedIdentities = canonical(Object.fromEntries(['baseline_digest', 'candidate_digest', 'suite_digest', 'dataset_digest'].map(key => [key, exact(identities[key], SHA256, `identities.${key}`)])));
  for (const [key, value] of Object.entries(normalizedIdentities)) if (evaluation.observed_identities?.[key] !== value) throw new Error(`Promotion identity ${key} is not bound to the admitted evaluation.`);
  const lowLevel = decideModelPromotion({ evaluation, non_regression, device_profiles, required_gates, identities: normalizedIdentities });
  const body = canonical({
    ...without(lowLevel, 'decision_digest'),
    schema: ADMITTED_PROMOTION_SCHEMA,
    evaluation_digest: evaluation.evidence_digest,
    non_regression_digest: non_regression.comparison_digest,
    device_profile_digests: device_profiles.map(value => value.profile_digest).sort(),
    identities: normalizedIdentities
  });
  return Object.freeze({ ...body, decision_digest: digest(body) });
}

export function buildAdmittedIntegrationPlan({ repository, main_sha, lanes = [] } = {}) {
  const head = exact(main_sha, SHA40, 'main_sha');
  const ids = uniqueStrings(lanes.map(value => value.id), 'integration lane ids');
  const byId = new Map(lanes.map(value => [clean(value.id, 200), value]));
  for (const lane of lanes) {
    const source = exact(lane.source_sha, SHA40, `${lane.id}.source_sha`);
    const dependencies = uniqueStrings(lane.dependencies || [], `${lane.id}.dependencies`, { allowEmpty: false });
    if (!dependencies.length && source !== head) throw new Error(`Root integration lane ${lane.id} is not bound to main.`);
    if (dependencies.length) {
      for (const dependency of dependencies) if (!ids.includes(dependency)) throw new Error(`Integration lane ${lane.id} has an unknown dependency.`);
      const dependencyResults = dependencies.map(dependency => exact(byId.get(dependency).result_sha, SHA40, `${dependency}.result_sha`));
      if (!dependencyResults.includes(source)) throw new Error(`Integration lane ${lane.id} is not bound to a dependency result.`);
    }
  }
  const plan = buildIntegrationPlan({ repository, main_sha: head, lanes });
  verifyBoundDigest(plan, 'plan_digest', 'integration plan');
  return plan;
}

function coordinationMessageBody(message) {
  return canonical({
    schema: message.schema,
    principal_id: clean(message.principal_id, 200),
    sequence: Number(message.sequence),
    nonce: clean(message.nonce, 300),
    generation: Number(message.generation),
    kind: clean(message.kind, 100),
    payload: message.payload || {},
    previous_digest: message.previous_digest || null
  });
}

function expectedHmac(secret, body) {
  return crypto.createHmac('sha256', secret).update(stableJSONStringify(body)).digest('hex');
}

function secureEqual(left, right) {
  const a = Buffer.from(clean(left, 200), 'utf8');
  const b = Buffer.from(clean(right, 200), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createAdmittedCoordinationState(input = {}) {
  const state = createCoordinationState(input);
  verifyBoundDigest(state, 'state_digest', 'coordination state');
  return state;
}

export function applyAdmittedCoordinationMessage({ state, expected_state_digest, message, secrets = {} } = {}) {
  verifyBoundDigest(state, 'state_digest', 'coordination state');
  if (state.state_digest !== exact(expected_state_digest, SHA256, 'expected_state_digest')) throw new Error('Coordination state compare-and-swap failed.');
  if (state.session_status === 'terminal') throw new Error('Terminal coordination state is immutable.');
  if (message?.schema !== EXECUTIVE_COORDINATION_SCHEMA) throw new Error('Unsupported coordination message schema.');
  const body = coordinationMessageBody(message);
  const secret = secrets[body.principal_id];
  if (!secret || !secureEqual(expectedHmac(secret, body), message.signature)) throw new Error('Coordination signature invalid.');
  const observedDigest = digest({ ...body, signature: message.signature });
  if (observedDigest !== exact(message.message_digest, SHA256, 'message.message_digest')) throw new Error('Coordination message digest mismatch.');
  const principal = state.principals?.[body.principal_id];
  if (CONTROL_KINDS.has(body.kind) && principal?.role !== 'root') throw new Error('Coordination control action requires root principal.');
  if (body.kind === 'resume' && state.session_status !== 'paused' && state.session_status !== 'stopped') throw new Error('Coordination state is not resumable.');
  for (const kind of ['grant', 'revoke', 'add_blocker', 'remove_blocker', 'claim']) if (body.kind === kind && !clean(body.payload.id ?? body.payload.principal_id, 200)) throw new Error(`Coordination ${kind} requires a target identity.`);
  const canonicalMessage = Object.freeze({ ...body, signature: message.signature, message_digest: observedDigest });
  const next = applyCoordinationMessage({ state, message: canonicalMessage, secrets });
  verifyBoundDigest(next, 'state_digest', 'next coordination state');
  return next;
}

export function filterAdmittedExecutiveOutput(outputs = []) {
  const hardened = outputs.map(output => {
    const kind = clean(output.kind, 100);
    const evidenceDigest = output.evidence_digest ? exact(output.evidence_digest, SHA256, `${kind}.evidence_digest`) : null;
    const verified = output.verified === true && EVIDENCE_OUTPUT_KINDS.has(kind) && Boolean(evidenceDigest);
    return { ...output, verified };
  });
  return filterExecutiveOutput(hardened);
}

export const admissionBoundary = Object.freeze({
  schema: EXECUTIVE_ADMISSION_SCHEMA,
  claim_boundary: 'Only functions exported by this module compose low-level executive contracts into an admitted decision boundary. Low-level modules remain construction primitives and do not independently authorize mutation, promotion, release, coordination, completion, or narration.'
});
