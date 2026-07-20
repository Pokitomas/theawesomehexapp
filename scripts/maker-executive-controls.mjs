import crypto from 'node:crypto';

export const EXECUTIVE_AUTHORITY_SCHEMA = 'sideways-maker-executive-authority/v1';
export const EXECUTIVE_PATCH_PLAN_SCHEMA = 'sideways-maker-executive-patch-plan/v1';
export const EXECUTIVE_HYPOTHESIS_SCHEMA = 'sideways-maker-executive-hypotheses/v1';
export const EXECUTIVE_VERIFICATION_SCHEMA = 'sideways-maker-executive-verification/v1';
export const EXECUTIVE_MUTATION_RECEIPT_SCHEMA = 'sideways-maker-executive-mutation-receipt/v1';

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const ACTIONS = new Set(['read', 'plan', 'mutate', 'verify', 'build', 'train', 'evaluate', 'integrate', 'deploy', 'promote', 'coordinate']);
const TERMINAL_GENERATIONS = new Set(['completed', 'revoked', 'superseded', 'terminated']);
const BUDGET_KEYS = ['tokens', 'compute_ms', 'storage_bytes', 'workflow_reruns', 'recursive_training'];
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

function instant(value, label) {
  const timestamp = Date.parse(clean(value, 100));
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function repository(value) {
  const normalized = clean(value, 300);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error('repository must be owner/name.');
  return normalized;
}

function canonicalPath(value) {
  let raw = clean(value, 1000).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (['*', '**', '**/*'].includes(raw)) return '**';
  const directory = raw.endsWith('/**');
  if (directory) raw = raw.slice(0, -3).replace(/\/$/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || parts.some(part => ['.', '..'].includes(part)) || parts.join('/').includes('*')) throw new Error(`Invalid canonical path: ${raw}.`);
  return directory ? `${parts.join('/')}/**` : parts.join('/');
}

function normalizeScope(input = {}) {
  const kind = clean(input.kind || 'repository', 100);
  const id = ['repository', 'generated'].includes(kind) ? canonicalPath(input.id ?? input.path) : clean(input.id, 1000);
  if (!['repository', 'generated', 'artifact', 'dataset', 'checkpoint', 'deployment'].includes(kind) || !id) throw new Error('Invalid executive scope.');
  return canonical({ kind, id });
}

function scopeCovers(parentInput, childInput) {
  const parent = normalizeScope(parentInput);
  const child = normalizeScope(childInput);
  if (['repository', 'generated'].includes(parent.kind) && ['repository', 'generated'].includes(child.kind)) {
    if (parent.id === '**') return true;
    const pp = parent.id.endsWith('/**') ? parent.id.slice(0, -3) : parent.id;
    const cp = child.id.endsWith('/**') ? child.id.slice(0, -3) : child.id;
    return parent.id.endsWith('/**') ? cp === pp || cp.startsWith(`${pp}/`) : parent.id === child.id;
  }
  return parent.kind === child.kind && parent.id === child.id;
}

function normalizeBudget(input = {}, label = 'budget') {
  const result = {};
  for (const key of BUDGET_KEYS) {
    const value = Number(input[key] ?? 0);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label}.${key} must be non-negative and finite.`);
    result[key] = value;
  }
  return result;
}

function normalizeGrant(input = {}, index = 0) {
  const principal_id = clean(input.principal_id, 200);
  const actions = [...new Set((input.actions || []).map(value => clean(value, 100)))].sort();
  if (!principal_id || !actions.length || actions.some(value => !ACTIONS.has(value))) throw new Error(`Grant ${index} is incomplete.`);
  return canonical({ principal_id, actions, scopes: (input.scopes || []).map(normalizeScope), expires_at: input.expires_at ? instant(input.expires_at, `grant:${principal_id}.expires_at`) : null });
}

export function normalizeAuthorityManifest(input = {}) {
  const main_sha = exact(input.main_sha, SHA40, 'main_sha');
  const body = canonical({
    schema: EXECUTIVE_AUTHORITY_SCHEMA,
    repository: repository(input.repository),
    generation_id: clean(input.generation_id, 200),
    generation_status: clean(input.generation_status || 'active', 40),
    main_sha,
    snapshot_digest: exact(input.snapshot_digest, SHA256, 'snapshot_digest'),
    grants: (input.grants || []).map(normalizeGrant).sort((a, b) => a.principal_id.localeCompare(b.principal_id)),
    ceilings: normalizeBudget(input.ceilings, 'ceilings'),
    spent: normalizeBudget(input.spent, 'spent'),
    recursion_limit: Number(input.recursion_limit ?? 0),
    promotion_required_gates: [...new Set((input.promotion_required_gates || []).map(value => clean(value, 200)))].sort(),
    deployment_required_gates: [...new Set((input.deployment_required_gates || []).map(value => clean(value, 200)))].sort(),
    passed_gates: [...new Set((input.passed_gates || []).map(value => clean(value, 200)))].sort(),
    build_authority_separate: input.build_authority_separate !== false,
    deployment_authority_separate: input.deployment_authority_separate !== false
  });
  if (!body.generation_id || !Number.isInteger(body.recursion_limit) || body.recursion_limit < 0) throw new Error('Authority manifest is incomplete.');
  if (new Set(body.grants.map(value => value.principal_id)).size !== body.grants.length) throw new Error('Authority grants must be unique per principal.');
  for (const key of BUDGET_KEYS) if (body.spent[key] > body.ceilings[key]) throw new Error(`Authority budget already exceeded: ${key}.`);
  return Object.freeze({ ...body, manifest_digest: digest(body) });
}

export function authorizeExecutiveAction({ manifest, expected_manifest_digest, principal_id, action, source_sha, scopes = [], spend = {}, recursion_depth = 0, now = new Date().toISOString() } = {}) {
  const authority = normalizeAuthorityManifest(manifest);
  const reasons = [];
  if (authority.manifest_digest !== exact(expected_manifest_digest, SHA256, 'expected_manifest_digest')) reasons.push('authority-manifest-changed');
  if (authority.main_sha !== exact(source_sha, SHA40, 'source_sha')) reasons.push('stale-head');
  if (TERMINAL_GENERATIONS.has(authority.generation_status)) reasons.push(`generation-${authority.generation_status}`);
  const normalizedAction = clean(action, 100);
  if (!ACTIONS.has(normalizedAction)) reasons.push('unsupported-action');
  const grant = authority.grants.find(value => value.principal_id === clean(principal_id, 200));
  if (!grant) reasons.push('principal-not-granted');
  else {
    if (!grant.actions.includes(normalizedAction)) reasons.push(`action-not-granted:${normalizedAction}`);
    if (grant.expires_at && Date.parse(instant(now, 'now')) > Date.parse(grant.expires_at)) reasons.push('grant-expired');
    const normalizedScopes = scopes.map(normalizeScope);
    if (normalizedScopes.some(scope => !grant.scopes.some(owned => scopeCovers(owned, scope)))) reasons.push('scope-not-granted');
  }
  const requested = normalizeBudget(spend, 'spend');
  for (const key of BUDGET_KEYS) if (authority.spent[key] + requested[key] > authority.ceilings[key]) reasons.push(`budget-exceeded:${key}`);
  if (!Number.isInteger(recursion_depth) || recursion_depth < 0 || recursion_depth > authority.recursion_limit) reasons.push('recursion-limit-exceeded');
  if (normalizedAction === 'promote' && authority.promotion_required_gates.some(value => !authority.passed_gates.includes(value))) reasons.push('promotion-locked');
  if (normalizedAction === 'deploy' && authority.deployment_required_gates.some(value => !authority.passed_gates.includes(value))) reasons.push('deployment-locked');
  if (['build', 'deploy'].includes(normalizedAction) && (!authority.build_authority_separate || !authority.deployment_authority_separate)) reasons.push('authority-separation-invalid');
  return Object.freeze({ allowed: reasons.length === 0, action: normalizedAction, principal_id: clean(principal_id, 200), denial_reasons: reasons, manifest_digest: authority.manifest_digest, requested_spend: requested });
}

export function consumeExecutiveBudget({ manifest, expected_manifest_digest, authorization } = {}) {
  const authority = normalizeAuthorityManifest(manifest);
  if (authority.manifest_digest !== exact(expected_manifest_digest, SHA256, 'expected_manifest_digest')) throw new Error('Authority manifest compare-and-swap failed.');
  if (!authorization?.allowed) throw new Error(`Cannot consume budget for denied action: ${(authorization?.denial_reasons || []).join(', ')}.`);
  const spent = Object.fromEntries(BUDGET_KEYS.map(key => [key, authority.spent[key] + Number(authorization.requested_spend?.[key] || 0)]));
  return normalizeAuthorityManifest({ ...authority, spent, manifest_digest: undefined });
}

function normalizeMutationCandidate(input = {}, index = 0, sourceSha = '') {
  const id = clean(input.id || `candidate-${index + 1}`, 200);
  const changed_scopes = (input.changed_scopes || []).map(normalizeScope);
  const observable_tests = [...new Set((input.observable_tests || []).map(value => clean(value, 1000)))].sort();
  const claims = [...new Set((input.claims || []).map(value => clean(value, 1000)))].sort();
  if (!id || !changed_scopes.length) throw new Error(`Mutation candidate ${index} is incomplete.`);
  return canonical({
    id,
    source_sha: exact(input.source_sha || sourceSha, SHA40, `${id}.source_sha`),
    changed_scopes,
    changed_bytes: Number(input.changed_bytes ?? 0),
    commands: (input.commands || []).map(value => canonical(value)),
    observable_tests,
    claims,
    produced_artifacts: (input.produced_artifacts || []).map(value => canonical(value)),
    estimated_cost: Number(input.estimated_cost ?? 0),
    rollback: clean(input.rollback, 2000)
  });
}

export function buildBoundedPatchPlan({ source_sha, snapshot_digest, lease_id, candidates = [], max_changed_bytes = 1048576, max_changed_scopes = 50 } = {}) {
  const head = exact(source_sha, SHA40, 'source_sha');
  const snapshot = exact(snapshot_digest, SHA256, 'snapshot_digest');
  const normalized = candidates.map((value, index) => normalizeMutationCandidate(value, index, head));
  const evaluated = normalized.map(candidate => {
    const reasons = [];
    if (candidate.source_sha !== head) reasons.push('stale-head');
    if (!Number.isFinite(candidate.changed_bytes) || candidate.changed_bytes < 0 || candidate.changed_bytes > Number(max_changed_bytes)) reasons.push('changed-bytes-exceeded');
    if (candidate.changed_scopes.length > Number(max_changed_scopes)) reasons.push('changed-scopes-exceeded');
    if (!candidate.observable_tests.length) reasons.push('behavior-not-observable');
    if (candidate.claims.length && candidate.observable_tests.length < candidate.claims.length) reasons.push('claims-under-observed');
    if (!candidate.rollback) reasons.push('rollback-missing');
    return { candidate, reasons };
  });
  const valid = evaluated.filter(value => !value.reasons.length).map(value => value.candidate).sort((a, b) => a.changed_scopes.length - b.changed_scopes.length || a.changed_bytes - b.changed_bytes || a.estimated_cost - b.estimated_cost || a.id.localeCompare(b.id));
  if (!valid.length) throw new Error(`No valid bounded mutation candidate: ${evaluated.map(value => `${value.candidate.id}=[${value.reasons.join(',')}]`).join('; ')}.`);
  const selected = valid[0];
  const body = canonical({
    schema: EXECUTIVE_PATCH_PLAN_SCHEMA,
    source_sha: head,
    snapshot_digest: snapshot,
    lease_id: clean(lease_id, 200),
    selected,
    rejected: evaluated.filter(value => value.candidate.id !== selected.id).map(value => ({ id: value.candidate.id, reasons: value.reasons.length ? value.reasons : ['larger-valid-mutation'] }))
  });
  if (!body.lease_id) throw new Error('Patch plan requires lease_id.');
  return Object.freeze({ ...body, plan_digest: digest(body) });
}

function normalizeHypothesis(input = {}, index = 0, author = '') {
  const id = clean(input.id || `hypothesis-${index + 1}`, 200);
  const statement = clean(input.statement, 4000);
  const falsification = clean(input.falsification, 4000);
  const author_id = clean(input.author_id || author, 200);
  const evidence = (input.evidence || []).map((value, evidenceIndex) => {
    const direction = clean(value.direction, 40);
    const weight = Number(value.weight ?? 1);
    if (!['support', 'refute'].includes(direction) || !Number.isFinite(weight) || weight <= 0) throw new Error(`${id}.evidence[${evidenceIndex}] is invalid.`);
    return canonical({ id: clean(value.id || `${id}:e${evidenceIndex + 1}`, 200), direction, weight, provenance: clean(value.provenance, 1000) });
  });
  if (!id || !statement || !falsification || !author_id) throw new Error(`Hypothesis ${index} is incomplete.`);
  const score = evidence.reduce((sum, value) => sum + (value.direction === 'support' ? value.weight : -value.weight), 0);
  return canonical({ id, statement, falsification, author_id, adversarial: input.adversarial === true, evidence, score });
}

export function collapseExecutiveHypotheses({ implementation_author, high_impact = false, hypotheses = [] } = {}) {
  const author = clean(implementation_author, 200);
  const normalized = hypotheses.map((value, index) => normalizeHypothesis(value, index, author));
  if (!normalized.length) throw new Error('At least one hypothesis is required.');
  if (high_impact && normalized.length < 2) throw new Error('High-impact mutation requires competing hypotheses.');
  if (high_impact && !normalized.some(value => value.adversarial && value.author_id !== author)) throw new Error('High-impact mutation requires an adversarial hypothesis from another author.');
  const survivors = normalized.filter(value => value.score >= 0);
  if (!survivors.length) return Object.freeze({ schema: EXECUTIVE_HYPOTHESIS_SCHEMA, selected: null, rejected: normalized.map(value => ({ ...value, rejection_reason: 'disproved' })), terminated: normalized.map(value => ({ hypothesis_id: value.id, reason: 'assumption-disproved' })) });
  survivors.sort((a, b) => b.score - a.score || b.evidence.length - a.evidence.length || a.id.localeCompare(b.id));
  const selected = survivors[0];
  const rejected = normalized.filter(value => value.id !== selected.id).map(value => ({ ...value, rejection_reason: value.score < 0 ? 'disproved' : 'lower-evidence-weight' }));
  return Object.freeze({ schema: EXECUTIVE_HYPOTHESIS_SCHEMA, selected, rejected, terminated: rejected.filter(value => value.rejection_reason === 'disproved').map(value => ({ hypothesis_id: value.id, reason: 'assumption-disproved' })) });
}

export function deleteUnsupportedClaims(planInput, admitted_claims = []) {
  const admitted = new Set(admitted_claims.map(value => clean(value, 1000)));
  const plan = structuredClone(planInput);
  if (plan?.selected?.claims) plan.selected.claims = plan.selected.claims.filter(value => admitted.has(clean(value, 1000)));
  return Object.freeze(canonical(plan));
}

export function buildIndependentVerificationContract({ writer_id, verifier_id, source_sha, result_sha, exact_inputs = [], expected_tree_digest, required_evidence = [], negative_tests = [], deterministic_replay = false, changed_tensor_required = false } = {}) {
  const writer = clean(writer_id, 200);
  const verifier = clean(verifier_id, 200);
  if (!writer || !verifier || writer === verifier) throw new Error('Independent verification requires distinct writer and verifier principals.');
  const body = canonical({
    schema: EXECUTIVE_VERIFICATION_SCHEMA,
    writer_id: writer,
    verifier_id: verifier,
    source_sha: exact(source_sha, SHA40, 'source_sha'),
    result_sha: exact(result_sha, SHA40, 'result_sha'),
    exact_inputs: exact_inputs.map((value, index) => ({ id: clean(value.id || `input-${index + 1}`, 200), digest: exact(value.digest, SHA256, `exact_inputs[${index}].digest`) })),
    expected_tree_digest: exact(expected_tree_digest, SHA256, 'expected_tree_digest'),
    required_evidence: [...new Set(required_evidence.map(value => clean(value, 200)))].sort(),
    negative_tests: [...new Set(negative_tests.map(value => clean(value, 200)))].sort(),
    deterministic_replay: deterministic_replay === true,
    changed_tensor_required: changed_tensor_required === true
  });
  if (!body.required_evidence.length) throw new Error('Verification contract requires evidence types.');
  for (const required of ['authority-bypass', 'lease-overlap', 'stale-head', 'artifact-substitution']) if (!body.negative_tests.includes(required)) throw new Error(`Verification contract is missing negative test ${required}.`);
  return Object.freeze({ ...body, contract_digest: digest(body) });
}

export function evaluateIndependentVerification({ contract, observed_inputs = [], observed_tree_digest, evidence = [], cases = [], replay_digest = null, changed_tensor_proof = null } = {}) {
  if (contract?.schema !== EXECUTIVE_VERIFICATION_SCHEMA) throw new Error('Unsupported verification contract.');
  const failures = [];
  const observed = new Map(observed_inputs.map((value, index) => [clean(value.id || `input-${index + 1}`, 200), exact(value.digest, SHA256, `observed_inputs[${index}].digest`)]));
  for (const input of contract.exact_inputs) if (observed.get(input.id) !== input.digest) failures.push({ type: 'input-mismatch', unit: input.id });
  if (exact(observed_tree_digest, SHA256, 'observed_tree_digest') !== contract.expected_tree_digest) failures.push({ type: 'repository-tree-mismatch', unit: 'repository-tree' });
  const types = new Set(evidence.map(value => clean(value.type, 200)));
  for (const required of contract.required_evidence) if (!types.has(required)) failures.push({ type: 'missing-evidence', unit: required });
  for (const negative of contract.negative_tests) if (!evidence.some(value => value.type === 'negative-test' && value.name === negative && value.passed === true)) failures.push({ type: 'negative-test-failed', unit: negative });
  if (contract.deterministic_replay && !replay_digest) failures.push({ type: 'replay-missing', unit: 'deterministic-replay' });
  if (contract.changed_tensor_required && !changed_tensor_proof?.changed_tensor_digest) failures.push({ type: 'changed-tensor-proof-missing', unit: 'changed-tensors' });
  for (const value of cases) if (value.passed !== true) failures.push({ type: 'case-failure', unit: clean(value.id, 200), severity: clean(value.severity || 'unknown', 40) });
  failures.sort((a, b) => String(a.unit).localeCompare(String(b.unit)) || a.type.localeCompare(b.type));
  return Object.freeze({ ok: failures.length === 0, failures, smallest_failed_unit: failures[0]?.unit || null, case_results: cases.map(value => canonical(value)) });
}

export function selectSmallestFailedUnit(results = []) {
  const failed = results.flatMap(value => value.failures || []).sort((a, b) => String(a.unit).length - String(b.unit).length || String(a.unit).localeCompare(String(b.unit)) || a.type.localeCompare(b.type));
  return failed[0] || null;
}

export function verifyGeneratedReproducibility(first = [], second = []) {
  const normalize = values => values.map((value, index) => ({ id: clean(value.id || `output-${index + 1}`, 200), digest: exact(value.digest, SHA256, `output[${index}].digest`) })).sort((a, b) => a.id.localeCompare(b.id));
  const left = normalize(first);
  const right = normalize(second);
  if (stableJSONStringify(left) !== stableJSONStringify(right)) throw new Error('Generated outputs are not reproducible.');
  return Object.freeze({ reproducible: true, output_manifest_digest: digest(left) });
}

export function decideExecutiveRollback({ source_sha, current_head_sha, verification, transaction_status = 'mutated' } = {}) {
  const source = exact(source_sha, SHA40, 'source_sha');
  const current = exact(current_head_sha, SHA40, 'current_head_sha');
  const reasons = [];
  if (source !== current) reasons.push('expected-head-changed');
  if (verification?.ok !== true) reasons.push('verification-failed');
  if (['completed', 'rolled_back', 'cancelled'].includes(clean(transaction_status, 40))) reasons.push(`transaction-${transaction_status}`);
  return Object.freeze({ rollback_required: reasons.includes('expected-head-changed') || reasons.includes('verification-failed'), denial_reasons: reasons });
}

export function buildExecutiveMutationReceipt({ repository: repo, source_sha, result_sha, snapshot_digest, lease_id, plan_digest, authority_manifest_digest, changed_scopes = [], commands = [], produced_artifacts = [], verification, rollback_target_sha, promotion_state = 'promotion:not-admitted' } = {}) {
  if (verification?.ok !== true) throw new Error('Mutation receipt requires passing independent verification.');
  const body = canonical({
    schema: EXECUTIVE_MUTATION_RECEIPT_SCHEMA,
    repository: repository(repo),
    source_sha: exact(source_sha, SHA40, 'source_sha'),
    result_sha: exact(result_sha, SHA40, 'result_sha'),
    snapshot_digest: exact(snapshot_digest, SHA256, 'snapshot_digest'),
    lease_id: clean(lease_id, 200),
    plan_digest: exact(plan_digest, SHA256, 'plan_digest'),
    authority_manifest_digest: exact(authority_manifest_digest, SHA256, 'authority_manifest_digest'),
    changed_scopes: changed_scopes.map(normalizeScope),
    commands: commands.map(value => canonical(value)),
    produced_artifacts: produced_artifacts.map((value, index) => ({ ...canonical(value), digest: exact(value.digest, SHA256, `produced_artifacts[${index}].digest`) })),
    verification_digest: digest(verification),
    rollback_target_sha: exact(rollback_target_sha, SHA40, 'rollback_target_sha'),
    promotion_state: clean(promotion_state, 100)
  });
  if (!body.lease_id || !body.changed_scopes.length) throw new Error('Mutation receipt is incomplete.');
  if (!body.commands.length) throw new Error('Mutation receipt requires command evidence.');
  if (!body.promotion_state) body.promotion_state = 'promotion:not-admitted';
  return Object.freeze({ ...body, receipt_digest: digest(body) });
}
