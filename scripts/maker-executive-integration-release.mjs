import crypto from 'node:crypto';

export const EXECUTIVE_INTEGRATION_SCHEMA = 'sideways-maker-executive-integration/v1';
export const EXECUTIVE_RELEASE_SCHEMA = 'sideways-maker-executive-release/v1';
export const EXECUTIVE_COORDINATION_SCHEMA = 'sideways-maker-executive-coordination/v1';
export const EXECUTIVE_TERMINATION_SCHEMA = 'sideways-maker-executive-termination/v1';

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MUTABLE_LEASE_STATES = new Set(['active', 'delegated']);
const OUTPUT_KINDS = new Set(['verified_mutation', 'proven_milestone', 'terminal_result', 'unavailable_external_authority']);
const clean = (value, limit = 8000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}

export const stableJSONStringify = value => JSON.stringify(canonical(value));
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');

function exact(value, pattern, label) {
  const normalized = clean(value, 1000).toLowerCase();
  if (!pattern.test(normalized)) throw new Error(`${label} must be an exact ${pattern === SHA40 ? '40-character commit SHA' : 'SHA-256 digest'}.`);
  return normalized;
}

function repository(value) {
  const normalized = clean(value, 300);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error('repository must be owner/name.');
  return normalized;
}

function topologicalOrder(lanes) {
  const index = new Map(lanes.map(value => [value.id, value]));
  const temporary = new Set();
  const permanent = new Set();
  const order = [];
  function visit(id) {
    if (permanent.has(id)) return;
    if (temporary.has(id)) throw new Error(`Integration dependency cycle includes ${id}.`);
    const lane = index.get(id);
    if (!lane) throw new Error(`Integration dependency ${id} is missing.`);
    temporary.add(id);
    for (const dependency of lane.dependencies) visit(dependency);
    temporary.delete(id);
    permanent.add(id);
    order.push(id);
  }
  for (const lane of lanes) visit(lane.id);
  return order;
}

export function buildIntegrationPlan({ repository: repo, main_sha, lanes = [] } = {}) {
  const head = exact(main_sha, SHA40, 'main_sha');
  const normalized = lanes.map((input, index) => {
    const id = clean(input.id || `lane-${index + 1}`, 200);
    const body = canonical({
      id,
      source_sha: exact(input.source_sha, SHA40, `${id}.source_sha`),
      result_sha: exact(input.result_sha, SHA40, `${id}.result_sha`),
      dependencies: [...new Set((input.dependencies || []).map(value => clean(value, 200)))].sort(),
      receipt_digest: exact(input.receipt_digest, SHA256, `${id}.receipt_digest`),
      evaluation_digest: exact(input.evaluation_digest, SHA256, `${id}.evaluation_digest`),
      changed_scopes: (input.changed_scopes || []).map(value => clean(value, 1000)).sort(),
      status: clean(input.status, 40)
    });
    if (!id || body.status !== 'completed' || !body.changed_scopes.length) throw new Error(`Integration lane ${id} is not complete.`);
    return body;
  });
  if (new Set(normalized.map(value => value.id)).size !== normalized.length) throw new Error('Integration lane IDs must be unique.');
  const body = canonical({ schema: EXECUTIVE_INTEGRATION_SCHEMA, repository: repository(repo), main_sha: head, lanes: normalized, order: topologicalOrder(normalized) });
  return Object.freeze({ ...body, plan_digest: digest(body) });
}

export function evaluateIntegration({ plan, current_main_sha, expected_integration_head, observed_integration_head, collisions = [], regressions = [], unowned_scopes = [], stale_evaluations = [], missing_receipts = [] } = {}) {
  if (plan?.schema !== EXECUTIVE_INTEGRATION_SCHEMA) throw new Error('Unsupported integration plan.');
  const reasons = [];
  const current = exact(current_main_sha, SHA40, 'current_main_sha');
  const expected = exact(expected_integration_head, SHA40, 'expected_integration_head');
  const observed = exact(observed_integration_head, SHA40, 'observed_integration_head');
  if (current !== plan.main_sha) reasons.push('main-advanced-rebase-and-reverify');
  if (observed !== expected) reasons.push('expected-head-mismatch');
  if (collisions.length) reasons.push('integration-collision');
  if (regressions.length) reasons.push('integration-regression');
  if (unowned_scopes.length) reasons.push('unowned-scope');
  if (stale_evaluations.length) reasons.push('stale-evaluation');
  if (missing_receipts.length) reasons.push('missing-receipt');
  return Object.freeze({ admitted: reasons.length === 0, reasons, action: reasons.includes('main-advanced-rebase-and-reverify') ? 'rebase-and-reverify' : reasons.length ? 'create-repair-lane' : 'consume-in-order', order: plan.order, evidence: { collisions, regressions, unowned_scopes, stale_evaluations, missing_receipts } });
}

export function buildSmallestRepairLane(failures = [], { source_sha } = {}) {
  const head = exact(source_sha, SHA40, 'source_sha');
  if (!failures.length) throw new Error('Repair lane requires failures.');
  const selected = [...failures].sort((a, b) => Number(a.scope_size ?? Infinity) - Number(b.scope_size ?? Infinity) || String(a.unit || '').length - String(b.unit || '').length || String(a.unit).localeCompare(String(b.unit)))[0];
  const body = canonical({ id: `repair:${clean(selected.unit || selected.type, 200)}`, source_sha: head, owned_scopes: (selected.owned_scopes || []).map(value => clean(value, 1000)).sort(), required_evidence: [...new Set(selected.required_evidence || ['focused-reverification'])].sort(), terminal_condition: clean(selected.terminal_condition || `repair and independently reverify ${selected.unit || selected.type}`, 2000), failure: selected });
  return Object.freeze({ ...body, repair_digest: digest(body) });
}

export function terminateIntegratedBranch({ branch, reason, result_sha } = {}) {
  const allowed = ['merged', 'superseded', 'disproved'];
  const normalized = clean(reason, 40);
  if (!allowed.includes(normalized)) throw new Error('Branch termination requires merged, superseded, or disproved reason.');
  return Object.freeze({ branch: clean(branch, 300), status: 'terminated', reason: normalized, result_sha: exact(result_sha, SHA40, 'result_sha') });
}

export function buildReleaseCandidate(input = {}) {
  const body = canonical({
    schema: EXECUTIVE_RELEASE_SCHEMA,
    repository: repository(input.repository),
    event: clean(input.event, 200),
    head_sha: exact(input.head_sha, SHA40, 'head_sha'),
    build_principal: clean(input.build_principal, 200),
    deploy_principal: clean(input.deploy_principal, 200),
    promotion_principal: clean(input.promotion_principal, 200),
    environment: clean(input.environment, 200),
    protected_environment: input.protected_environment === true,
    oidc_subject: clean(input.oidc_subject, 1000),
    expected_oidc_subject: clean(input.expected_oidc_subject, 1000),
    artifact_digest: exact(input.artifact_digest, SHA256, 'artifact_digest'),
    model_digest: input.model_digest ? exact(input.model_digest, SHA256, 'model_digest') : null,
    rollback_target_sha: exact(input.rollback_target_sha, SHA40, 'rollback_target_sha'),
    required_gates: [...new Set((input.required_gates || []).map(value => clean(value, 200)))].sort(),
    passed_gates: [...new Set((input.passed_gates || []).map(value => clean(value, 200)))].sort()
  });
  if (!body.event || !body.environment || !body.protected_environment) throw new Error('Release candidate requires a protected environment.');
  if (new Set([body.build_principal, body.deploy_principal, body.promotion_principal]).size !== 3) throw new Error('Build, deploy, and promotion principals must be separate.');
  if (!body.oidc_subject || body.oidc_subject !== body.expected_oidc_subject) throw new Error('OIDC deployment identity mismatch.');
  return Object.freeze({ ...body, candidate_digest: digest(body) });
}

export function authorizeReleaseCommand({ candidate, owner, repository_name, event, head_sha, principal_id, action } = {}) {
  if (candidate?.schema !== EXECUTIVE_RELEASE_SCHEMA) throw new Error('Unsupported release candidate.');
  const reasons = [];
  const [expectedOwner, expectedRepo] = candidate.repository.split('/');
  if (clean(owner, 200) !== expectedOwner) reasons.push('owner-mismatch');
  if (clean(repository_name, 200) !== expectedRepo) reasons.push('repository-mismatch');
  if (clean(event, 200) !== candidate.event) reasons.push('event-mismatch');
  if (exact(head_sha, SHA40, 'head_sha') !== candidate.head_sha) reasons.push('head-mismatch');
  const expectedPrincipal = { build: candidate.build_principal, deploy: candidate.deploy_principal, promote: candidate.promotion_principal }[action];
  if (!expectedPrincipal || clean(principal_id, 200) !== expectedPrincipal) reasons.push('principal-mismatch');
  const missing = candidate.required_gates.filter(value => !candidate.passed_gates.includes(value));
  if (missing.length) reasons.push('required-gates-missing');
  return Object.freeze({ allowed: reasons.length === 0, action, reasons, candidate_digest: candidate.candidate_digest });
}

export function buildDeploymentReceipt({ candidate, live_artifact_digest, live_model_digest = null, deployment_url, deployed_identity } = {}) {
  if (candidate?.schema !== EXECUTIVE_RELEASE_SCHEMA) throw new Error('Unsupported release candidate.');
  const liveArtifact = exact(live_artifact_digest, SHA256, 'live_artifact_digest');
  const liveModel = live_model_digest ? exact(live_model_digest, SHA256, 'live_model_digest') : null;
  const reasons = [];
  if (liveArtifact !== candidate.artifact_digest) reasons.push('artifact-divergence');
  if (candidate.model_digest !== liveModel) reasons.push('model-divergence');
  const body = canonical({ candidate_digest: candidate.candidate_digest, head_sha: candidate.head_sha, environment: candidate.environment, deployment_url: clean(deployment_url, 2000), deployed_identity: clean(deployed_identity, 1000), intended_artifact_digest: candidate.artifact_digest, live_artifact_digest: liveArtifact, intended_model_digest: candidate.model_digest, live_model_digest: liveModel, rollback_target_sha: candidate.rollback_target_sha, verified: reasons.length === 0, reasons });
  return Object.freeze({ ...body, deployment_receipt_digest: digest(body) });
}

export function detectPostDeployDivergence(receipt, observed = {}) {
  const reasons = [];
  if (exact(observed.artifact_digest, SHA256, 'observed.artifact_digest') !== receipt.intended_artifact_digest) reasons.push('artifact-divergence');
  const model = observed.model_digest ? exact(observed.model_digest, SHA256, 'observed.model_digest') : null;
  if (model !== receipt.intended_model_digest) reasons.push('model-divergence');
  if (clean(observed.deployed_identity, 1000) !== receipt.deployed_identity) reasons.push('identity-divergence');
  return Object.freeze({ divergent: reasons.length > 0, reasons, rollback_target_sha: receipt.rollback_target_sha });
}

function hmac(secret, body) {
  return crypto.createHmac('sha256', secret).update(stableJSONStringify(body)).digest('hex');
}

export function signCoordinationMessage({ principal_id, sequence, nonce, generation, kind, payload = {}, previous_digest = null, secret } = {}) {
  const body = canonical({ schema: EXECUTIVE_COORDINATION_SCHEMA, principal_id: clean(principal_id, 200), sequence: Number(sequence), nonce: clean(nonce, 300), generation: Number(generation), kind: clean(kind, 100), payload, previous_digest: previous_digest || null });
  if (!body.principal_id || !Number.isInteger(body.sequence) || body.sequence < 1 || !body.nonce || !Number.isInteger(body.generation) || body.generation < 0 || !body.kind || !secret) throw new Error('Coordination message is incomplete.');
  const signature = hmac(secret, body);
  return Object.freeze({ ...body, signature, message_digest: digest({ ...body, signature }) });
}

export function createCoordinationState({ repository: repo, main_sha, root_principal } = {}) {
  const state = canonical({ repository: repository(repo), main_sha: exact(main_sha, SHA40, 'main_sha'), session_status: 'active', generation: 0, principals: { [clean(root_principal, 200)]: { active: true, role: 'root' } }, blockers: {}, claims: {}, used_nonces: [], messages: [] });
  if (!clean(root_principal, 200)) throw new Error('Coordination state requires root principal.');
  return Object.freeze({ ...state, state_digest: digest(state) });
}

export function applyCoordinationMessage({ state: input, message, secrets = {} } = {}) {
  const state = structuredClone(input);
  const principal = state.principals?.[message.principal_id];
  if (!principal?.active) throw new Error('Coordination principal is not active.');
  const body = canonical({ schema: message.schema, principal_id: message.principal_id, sequence: message.sequence, nonce: message.nonce, generation: message.generation, kind: message.kind, payload: message.payload, previous_digest: message.previous_digest || null });
  if (hmac(secrets[message.principal_id], body) !== message.signature) throw new Error('Coordination signature invalid.');
  if (message.sequence !== state.messages.length + 1) throw new Error('Coordination sequence mismatch.');
  if ((message.previous_digest || null) !== (state.messages.at(-1)?.message_digest || null)) throw new Error('Coordination predecessor mismatch.');
  if (state.used_nonces.includes(message.nonce)) throw new Error('Coordination replay detected.');
  if (message.generation !== state.generation) throw new Error('Coordination generation mismatch.');
  const payload = message.payload || {};
  const rootOnly = new Set(['grant', 'revoke', 'reset', 'terminalize']);
  if (rootOnly.has(message.kind) && principal.role !== 'root') throw new Error('Coordination action requires root principal.');
  if (message.kind === 'grant') state.principals[clean(payload.principal_id, 200)] = { active: true, role: clean(payload.role || 'member', 100) };
  else if (message.kind === 'revoke') { if (state.principals[payload.principal_id]) state.principals[payload.principal_id].active = false; }
  else if (message.kind === 'pause') state.session_status = 'paused';
  else if (message.kind === 'resume') state.session_status = 'active';
  else if (message.kind === 'stop') state.session_status = 'stopped';
  else if (message.kind === 'terminalize') state.session_status = 'terminal';
  else if (message.kind === 'reset') { state.generation += 1; state.claims = Object.fromEntries(Object.entries(state.claims).map(([id, claim]) => [id, { ...claim, valid: false, invalidation_reason: 'generation-reset' }])); }
  else if (message.kind === 'add_blocker') state.blockers[clean(payload.id, 200)] = { summary: clean(payload.summary, 2000), active: true };
  else if (message.kind === 'remove_blocker') { if (state.blockers[payload.id]) state.blockers[payload.id].active = false; }
  else if (message.kind === 'declare_head') { state.main_sha = exact(payload.main_sha, SHA40, 'payload.main_sha'); for (const claim of Object.values(state.claims)) if (claim.main_sha !== state.main_sha) { claim.valid = false; claim.invalidation_reason = 'repository-truth-contradiction'; } }
  else if (message.kind === 'claim') { const id = clean(payload.id, 200); state.claims[id] = { statement: clean(payload.statement, 4000), main_sha: exact(payload.main_sha, SHA40, 'payload.main_sha'), valid: exact(payload.main_sha, SHA40, 'payload.main_sha') === state.main_sha }; }
  else throw new Error(`Unsupported coordination message kind: ${message.kind}.`);
  state.used_nonces.push(message.nonce);
  state.messages.push(message);
  const normalized = canonical({ ...state, state_digest: undefined });
  return Object.freeze({ ...normalized, state_digest: digest(normalized) });
}

export function projectCoordinationState(state, { private_projection = false } = {}) {
  const base = { repository: state.repository, main_sha: state.main_sha, session_status: state.session_status, generation: state.generation, blockers: state.blockers, claims: state.claims, message_head: state.messages.at(-1)?.message_digest || null };
  if (private_projection) return Object.freeze(canonical({ ...base, principals: state.principals, used_nonces: state.used_nonces }));
  return Object.freeze(canonical(base));
}

export function computeExecutiveMetrics(events = []) {
  const verified = events.filter(value => value.type === 'verified_transition');
  const times = verified.map(value => Number(value.at_ms)).filter(Number.isFinite).sort((a, b) => a - b);
  const elapsed = times.length > 1 ? times.at(-1) - times[0] : 0;
  const count = type => events.filter(value => value.type === type).length;
  const verification = events.filter(value => value.type === 'verification' && Number.isFinite(Number(value.latency_ms)));
  const promotionReasons = events.filter(value => value.type === 'promotion_rejection').reduce((result, value) => ((result[value.reason] = (result[value.reason] || 0) + 1), result), {});
  const compute = events.filter(value => value.type === 'compute').reduce((sum, value) => sum + Number(value.compute_ms || 0), 0);
  const gains = events.filter(value => value.type === 'admitted_capability_gain').reduce((sum, value) => sum + Number(value.gain || 0), 0);
  const claims = events.filter(value => value.type === 'claim_calibration');
  const calibration = claims.length ? claims.reduce((sum, value) => sum + Math.abs(Number(value.claimed || 0) - Number(value.observed || 0)), 0) / claims.length : 0;
  return Object.freeze({
    verified_transitions: verified.length,
    throughput_per_hour: elapsed > 0 ? verified.length / (elapsed / 3600000) : 0,
    duplicate_work_ratio: events.length ? count('duplicate_work') / events.length : 0,
    stale_state_mutation_attempts: count('stale_mutation'),
    lease_contention_rate: events.length ? count('lease_contention') / events.length : 0,
    verification_latency_ms: verification.length ? verification.reduce((sum, value) => sum + Number(value.latency_ms), 0) / verification.length : 0,
    evidence_defect_rate: events.length ? count('evidence_defect') / events.length : 0,
    rollback_frequency: events.length ? count('rollback') / events.length : 0,
    promotion_rejection_reasons: promotionReasons,
    compute_ms_per_admitted_gain: gains > 0 ? compute / gains : null,
    mean_claim_calibration_error: calibration
  });
}

export function evaluateLaneTermination({ lane_id, mutation_receipt, evidence_complete, terminal_observed, termination_reason = null } = {}) {
  if (termination_reason) {
    const allowed = ['duplication', 'supersession', 'disproof', 'authority-loss', 'budget-exhaustion'];
    if (!allowed.includes(termination_reason)) throw new Error('Unsupported lane termination reason.');
    return Object.freeze({ lane_id: clean(lane_id, 200), status: 'terminated', reason: termination_reason });
  }
  const complete = Boolean(mutation_receipt?.receipt_digest) && evidence_complete === true && terminal_observed === true;
  return Object.freeze({ lane_id: clean(lane_id, 200), status: complete ? 'completed' : 'blocked', reason: complete ? null : 'mutation-evidence-terminal-disagreement' });
}

export function terminalizeGeneration({ generation_id, main_sha, snapshot_digest, leases = [], blockers = [], lanes = [] } = {}) {
  const active = leases.filter(value => MUTABLE_LEASE_STATES.has(value.status));
  if (active.length) throw new Error('Generation cannot terminalize while mutable scopes remain leased.');
  const unresolved = blockers.filter(value => value.active !== false).map(value => canonical(value));
  const restart = canonical({ main_sha: exact(main_sha, SHA40, 'main_sha'), snapshot_digest: exact(snapshot_digest, SHA256, 'snapshot_digest'), unresolved_blockers: unresolved, incomplete_lanes: lanes.filter(value => !['completed', 'terminated'].includes(value.status)).map(value => clean(value.id, 200)) });
  const body = canonical({ schema: EXECUTIVE_TERMINATION_SCHEMA, generation_id: clean(generation_id, 200), status: 'terminal', released_scopes: leases.length, unresolved_blockers: unresolved, restart_state: restart });
  return Object.freeze({ ...body, termination_digest: digest(body) });
}

export function filterExecutiveOutput(outputs = []) {
  const admitted = [];
  const rejected = [];
  for (const output of outputs) {
    const kind = clean(output.kind, 100);
    const completionEvidence = output.activity_summary === true || output.token_volume != null || output.speculative === true || output.ordinary_read === true || output.failed_hypothesis === true;
    if (OUTPUT_KINDS.has(kind) && !completionEvidence && output.verified === true) admitted.push(canonical(output));
    else rejected.push(canonical({ ...output, rejection_reason: completionEvidence ? 'narration-is-not-completion-evidence' : 'output-not-admitted' }));
  }
  return Object.freeze({ admitted, rejected });
}
