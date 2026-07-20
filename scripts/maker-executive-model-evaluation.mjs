import crypto from 'node:crypto';

export const MODEL_EXECUTION_SCHEMA = 'sideways-maker-model-execution/v1';
export const FROZEN_EVALUATION_SCHEMA = 'sideways-maker-frozen-evaluation/v1';
export const MODEL_PROMOTION_SCHEMA = 'sideways-maker-model-promotion/v1';

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
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

function finite(value, label, { min = -Infinity, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || (integer && !Number.isInteger(number))) throw new Error(`${label} is invalid.`);
  return number;
}

export function normalizeDatasetIdentity(input = {}) {
  const body = canonical({
    id: clean(input.id, 300),
    digest: exact(input.digest, SHA256, 'dataset.digest'),
    bytes: finite(input.bytes, 'dataset.bytes', { min: 0, integer: true }),
    records: finite(input.records, 'dataset.records', { min: 0, integer: true }),
    schema_digest: exact(input.schema_digest, SHA256, 'dataset.schema_digest'),
    tokenizer_digest: input.tokenizer_digest ? exact(input.tokenizer_digest, SHA256, 'dataset.tokenizer_digest') : null
  });
  if (!body.id) throw new Error('Dataset identity requires id.');
  return Object.freeze({ ...body, identity_digest: digest(body) });
}

export function normalizeTrajectoryProvenance(input = {}) {
  const body = canonical({
    id: clean(input.id, 300),
    dataset_digest: exact(input.dataset_digest, SHA256, 'trajectory.dataset_digest'),
    source_sha: exact(input.source_sha, SHA40, 'trajectory.source_sha'),
    prompt_digest: exact(input.prompt_digest, SHA256, 'trajectory.prompt_digest'),
    chosen_digest: exact(input.chosen_digest, SHA256, 'trajectory.chosen_digest'),
    rejected_digest: input.rejected_digest ? exact(input.rejected_digest, SHA256, 'trajectory.rejected_digest') : null,
    causal_pair_id: input.causal_pair_id ? clean(input.causal_pair_id, 300) : null,
    lineage: [...new Set((input.lineage || []).map(value => clean(value, 300)))].sort()
  });
  if (!body.id) throw new Error('Trajectory provenance requires id.');
  return Object.freeze({ ...body, provenance_digest: digest(body) });
}

export function verifyAdapterShardReceipt(input = {}) {
  const body = canonical({
    schema: MODEL_EXECUTION_SCHEMA,
    id: clean(input.id, 300),
    shard_id: clean(input.shard_id, 300),
    source_sha: exact(input.source_sha, SHA40, 'shard.source_sha'),
    base_checkpoint_digest: exact(input.base_checkpoint_digest, SHA256, 'shard.base_checkpoint_digest'),
    dataset_digest: exact(input.dataset_digest, SHA256, 'shard.dataset_digest'),
    trajectory_digest: exact(input.trajectory_digest, SHA256, 'shard.trajectory_digest'),
    adapter_digest: exact(input.adapter_digest, SHA256, 'shard.adapter_digest'),
    changed_tensor_digest: exact(input.changed_tensor_digest, SHA256, 'shard.changed_tensor_digest'),
    changed_tensor_count: finite(input.changed_tensor_count, 'shard.changed_tensor_count', { min: 1, integer: true }),
    train_steps: finite(input.train_steps, 'shard.train_steps', { min: 1, integer: true }),
    reliability: finite(input.reliability, 'shard.reliability', { min: 0 }),
    promotion_state: 'promotion:not-admitted'
  });
  if (!body.id || !body.shard_id || body.reliability > 1) throw new Error('Adapter shard receipt is incomplete.');
  return Object.freeze({ ...body, receipt_digest: digest(body) });
}

export function fuseReliableAdapterDeltas(receipts = []) {
  const normalized = receipts.map(verifyAdapterShardReceipt);
  if (!normalized.length) throw new Error('Fusion requires adapter receipts.');
  const base = normalized[0].base_checkpoint_digest;
  const dataset = normalized[0].dataset_digest;
  const source = normalized[0].source_sha;
  if (normalized.some(value => value.base_checkpoint_digest !== base || value.dataset_digest !== dataset || value.source_sha !== source)) throw new Error('Fusion inputs are identity-mismatched.');
  const total = normalized.reduce((sum, value) => sum + value.reliability, 0);
  if (total <= 0) throw new Error('Fusion requires positive reliability evidence.');
  const components = normalized.sort((a, b) => a.id.localeCompare(b.id)).map(value => ({ id: value.id, adapter_digest: value.adapter_digest, changed_tensor_digest: value.changed_tensor_digest, weight: value.reliability / total }));
  const body = canonical({ schema: 'sideways-maker-adapter-fusion/v1', source_sha: source, base_checkpoint_digest: base, dataset_digest: dataset, components, promotion_state: 'promotion:not-admitted' });
  return Object.freeze({ ...body, fused_adapter_digest: digest(body) });
}

function caseIndex(values = []) {
  const result = new Map();
  for (const value of values) {
    const id = clean(value.id, 300);
    if (!id || result.has(id)) throw new Error('Evaluation cases require unique ids.');
    result.set(id, canonical({ ...value, id, passed: value.passed === true, capability: clean(value.capability || 'unknown', 200), severity: clean(value.severity || 'medium', 40) }));
  }
  return result;
}

export function compareFrozenBase({ baseline_cases = [], candidate_cases = [] } = {}) {
  const baseline = caseIndex(baseline_cases);
  const candidate = caseIndex(candidate_cases);
  if (baseline.size !== candidate.size || [...baseline.keys()].some(id => !candidate.has(id))) throw new Error('Frozen comparison case identities differ.');
  const regressions = [];
  const gains = [];
  for (const [id, before] of baseline) {
    const after = candidate.get(id);
    if (before.passed && !after.passed) regressions.push({ id, capability: after.capability, severity: after.severity, reproducible: after.reproducible !== false });
    if (!before.passed && after.passed) gains.push({ id, capability: after.capability });
  }
  regressions.sort((a, b) => a.capability.localeCompare(b.capability) || a.id.localeCompare(b.id));
  gains.sort((a, b) => a.capability.localeCompare(b.capability) || a.id.localeCompare(b.id));
  return Object.freeze({ regressions, gains, non_regression: regressions.length === 0, baseline_passed: [...baseline.values()].filter(value => value.passed).length, candidate_passed: [...candidate.values()].filter(value => value.passed).length });
}

export function planBoundedFailureSetTraining({ source_sha, dataset_digest, failures = [], recursion_depth = 0, recursion_limit = 0, max_cases = 100, max_steps = 1000 } = {}) {
  const depth = finite(recursion_depth, 'recursion_depth', { min: 0, integer: true });
  const limit = finite(recursion_limit, 'recursion_limit', { min: 0, integer: true });
  if (depth >= limit) throw new Error('Recursive failure-set training limit reached.');
  const selected = failures.filter(value => value.reproducible !== false).sort((a, b) => String(a.severity).localeCompare(String(b.severity)) || String(a.id).localeCompare(String(b.id))).slice(0, finite(max_cases, 'max_cases', { min: 1, integer: true }));
  if (!selected.length) throw new Error('No reproducible failures are available for recursive training.');
  const body = canonical({ source_sha: exact(source_sha, SHA40, 'source_sha'), dataset_digest: exact(dataset_digest, SHA256, 'dataset_digest'), recursion_depth: depth + 1, selected_failure_ids: selected.map(value => clean(value.id, 300)), failure_set_digest: digest(selected), max_steps: finite(max_steps, 'max_steps', { min: 1, integer: true }), promotion_state: 'promotion:not-admitted' });
  return Object.freeze({ ...body, plan_digest: digest(body) });
}

export function materializeMergedCheckpoint({ source_sha, base_checkpoint_digest, fused_adapter_digest, fusion_gates = {}, non_regression, output_digest } = {}) {
  const failed = Object.entries(fusion_gates).filter(([, passed]) => passed !== true).map(([name]) => name).sort();
  if (failed.length) throw new Error(`Merged checkpoint denied by fusion gates: ${failed.join(', ')}.`);
  if (non_regression?.non_regression !== true) throw new Error('Merged checkpoint requires fused-adapter non-regression evidence.');
  const body = canonical({ source_sha: exact(source_sha, SHA40, 'source_sha'), base_checkpoint_digest: exact(base_checkpoint_digest, SHA256, 'base_checkpoint_digest'), fused_adapter_digest: exact(fused_adapter_digest, SHA256, 'fused_adapter_digest'), output_digest: exact(output_digest, SHA256, 'output_digest'), promotion_state: 'promotion:not-admitted' });
  return Object.freeze({ ...body, materialization_receipt_digest: digest(body) });
}

export function compareQuantizationCandidates(candidates = [], { minimum_retention = 0.99, ram_cap_bytes = Infinity } = {}) {
  const minRetention = finite(minimum_retention, 'minimum_retention', { min: 0 });
  const cap = finite(ram_cap_bytes, 'ram_cap_bytes', { min: 1 });
  const normalized = candidates.map((value, index) => {
    const id = clean(value.id || `quant-${index + 1}`, 300);
    const case_total = finite(value.case_total, `${id}.case_total`, { min: 1, integer: true });
    const case_retained = finite(value.case_retained, `${id}.case_retained`, { min: 0, integer: true });
    if (case_retained > case_total) throw new Error(`${id} retained more cases than evaluated.`);
    return canonical({ id, digest: exact(value.digest, SHA256, `${id}.digest`), format: clean(value.format, 100), bytes: finite(value.bytes, `${id}.bytes`, { min: 1, integer: true }), peak_ram_bytes: finite(value.peak_ram_bytes, `${id}.peak_ram_bytes`, { min: 1, integer: true }), case_total, case_retained, retention: case_retained / case_total, failures: (value.failures || []).map(item => clean(item, 300)) });
  });
  const eligible = normalized.filter(value => value.retention >= minRetention && value.peak_ram_bytes <= cap).sort((a, b) => a.bytes - b.bytes || b.retention - a.retention || a.id.localeCompare(b.id));
  if (!eligible.length) throw new Error('No quantization candidate meets retention and RAM gates.');
  return Object.freeze({ selected: eligible[0], rejected: normalized.filter(value => value.id !== eligible[0].id), promotion_state: 'promotion:not-admitted' });
}

export function verifyGGUFCompatibility(input = {}) {
  const architecture = clean(input.architecture, 200);
  const expected = clean(input.expected_architecture, 200);
  const tensor_count = finite(input.tensor_count, 'tensor_count', { min: 1, integer: true });
  const metadata_digest = exact(input.metadata_digest, SHA256, 'metadata_digest');
  const file_digest = exact(input.file_digest, SHA256, 'file_digest');
  const reasons = [];
  if (!architecture || architecture !== expected) reasons.push('architecture-mismatch');
  if (!clean(input.model_type, 200)) reasons.push('model-type-missing');
  if (!Array.isArray(input.required_metadata) || input.required_metadata.some(key => !Object.hasOwn(input.metadata || {}, key))) reasons.push('metadata-missing');
  return Object.freeze({ compatible: reasons.length === 0, reasons, architecture, tensor_count, metadata_digest, file_digest });
}

export function planRamCappedExecution({ model_bytes, runtime_overhead_bytes, context_bytes, kv_cache_bytes, ram_cap_bytes } = {}) {
  const parts = {
    model_bytes: finite(model_bytes, 'model_bytes', { min: 1, integer: true }),
    runtime_overhead_bytes: finite(runtime_overhead_bytes, 'runtime_overhead_bytes', { min: 0, integer: true }),
    context_bytes: finite(context_bytes, 'context_bytes', { min: 0, integer: true }),
    kv_cache_bytes: finite(kv_cache_bytes, 'kv_cache_bytes', { min: 0, integer: true })
  };
  const cap = finite(ram_cap_bytes, 'ram_cap_bytes', { min: 1, integer: true });
  const required = Object.values(parts).reduce((sum, value) => sum + value, 0);
  return Object.freeze({ admitted: required <= cap, required_ram_bytes: required, ram_cap_bytes: cap, headroom_bytes: cap - required, components: parts });
}

export function buildFrozenEvaluationContract(input = {}) {
  const body = canonical({
    schema: FROZEN_EVALUATION_SCHEMA,
    suite_digest: exact(input.suite_digest, SHA256, 'suite_digest'),
    prompt_digest: exact(input.prompt_digest, SHA256, 'prompt_digest'),
    dataset_digest: exact(input.dataset_digest, SHA256, 'dataset_digest'),
    baseline_digest: exact(input.baseline_digest, SHA256, 'baseline_digest'),
    candidate_digest: exact(input.candidate_digest, SHA256, 'candidate_digest'),
    evaluator_id: clean(input.evaluator_id, 300),
    trainer_id: clean(input.trainer_id, 300),
    declared_artifact_digests: [...new Set((input.declared_artifact_digests || []).map((value, index) => exact(value, SHA256, `declared_artifact_digests[${index}]`)))].sort(),
    minimum_cases: finite(input.minimum_cases, 'minimum_cases', { min: 1, integer: true }),
    minimum_lower_confidence: finite(input.minimum_lower_confidence, 'minimum_lower_confidence', { min: 0 })
  });
  if (!body.evaluator_id || body.evaluator_id === body.trainer_id || body.minimum_lower_confidence > 1) throw new Error('Frozen evaluation requires isolated evaluator and valid threshold.');
  return Object.freeze({ ...body, contract_digest: digest(body) });
}

function wilson(successes, total, z = 1.96) {
  if (!total) return { lower: 0, upper: 1 };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return { lower: Math.max(0, (centre - margin) / denominator), upper: Math.min(1, (centre + margin) / denominator) };
}

export function evaluateFrozenSuite({ contract, observed = {}, cases = [], accessible_artifact_digests = [] } = {}) {
  if (contract?.schema !== FROZEN_EVALUATION_SCHEMA) throw new Error('Unsupported frozen evaluation contract.');
  const rejection_reasons = [];
  for (const key of ['suite_digest', 'prompt_digest', 'dataset_digest', 'baseline_digest', 'candidate_digest']) {
    if (exact(observed[key], SHA256, `observed.${key}`) !== contract[key]) rejection_reasons.push(`${key}-mismatch`);
  }
  const accessible = [...new Set(accessible_artifact_digests.map((value, index) => exact(value, SHA256, `accessible_artifact_digests[${index}]`)))].sort();
  if (accessible.some(value => !contract.declared_artifact_digests.includes(value))) rejection_reasons.push('evaluator-isolation-violation');
  const total = cases.length;
  const successes = cases.filter(value => value.passed === true).length;
  const confidence = wilson(successes, total);
  if (total < contract.minimum_cases) rejection_reasons.push('minimum-evidence-not-met');
  if (confidence.lower < contract.minimum_lower_confidence) rejection_reasons.push('confidence-threshold-not-met');
  const grouped = cases.reduce((groups, value) => ((groups[clean(value.capability || 'unknown', 200)] ||= []).push(value), groups), {});
  const byCapability = Object.values(grouped).map(values => ({ capability: clean(values[0]?.capability || 'unknown', 200), total: values.length, passed: values.filter(value => value.passed === true).length }));
  return Object.freeze({ admitted_metrics: rejection_reasons.length === 0, rejection_reasons, total, successes, confidence, case_results: cases.map(value => canonical(value)), by_capability: byCapability.sort((a, b) => a.capability.localeCompare(b.capability)) });
}

export function buildAdversarialFailureEvaluation(failures = [], { max_cases = 100 } = {}) {
  const groups = new Map();
  for (const failure of failures) {
    const key = `${clean(failure.capability || 'unknown', 200)}:${clean(failure.cluster || 'unclustered', 200)}`;
    const values = groups.get(key) || [];
    values.push(failure);
    groups.set(key, values);
  }
  const perCluster = Math.max(1, Math.floor(finite(max_cases, 'max_cases', { min: 1, integer: true }) / Math.max(1, groups.size)));
  const selected = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, values]) => values
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .slice(0, perCluster)
      .map(value => ({ source_failure_id: clean(value.id, 300), cluster: key, adversarial_prompt_digest: exact(value.adversarial_prompt_digest, SHA256, `${value.id}.adversarial_prompt_digest`) })));
  return Object.freeze({ cases: selected.slice(0, max_cases), evaluation_digest: digest(selected.slice(0, max_cases)) });
}

export function evaluateDeviceProfile(input = {}) {
  const metrics = canonical({
    runtime_ms: finite(input.runtime_ms, 'runtime_ms', { min: 0 }),
    peak_memory_bytes: finite(input.peak_memory_bytes, 'peak_memory_bytes', { min: 0 }),
    latency_p95_ms: finite(input.latency_p95_ms, 'latency_p95_ms', { min: 0 }),
    peak_temperature_c: finite(input.peak_temperature_c, 'peak_temperature_c', { min: 0 })
  });
  const limits = canonical({
    runtime_ms: finite(input.limits?.runtime_ms, 'limits.runtime_ms', { min: 0 }),
    peak_memory_bytes: finite(input.limits?.peak_memory_bytes, 'limits.peak_memory_bytes', { min: 0 }),
    latency_p95_ms: finite(input.limits?.latency_p95_ms, 'limits.latency_p95_ms', { min: 0 }),
    peak_temperature_c: finite(input.limits?.peak_temperature_c, 'limits.peak_temperature_c', { min: 0 })
  });
  const failed = Object.keys(metrics).filter(key => metrics[key] > limits[key]);
  return Object.freeze({ passed: failed.length === 0, failed_constraints: failed, metrics, limits, device_id: clean(input.device_id, 300) });
}

export function decideModelPromotion({ evaluation, non_regression, device_profiles = [], required_gates = {}, identities = {} } = {}) {
  const reasons = [];
  if (evaluation?.admitted_metrics !== true) reasons.push('evaluation-not-admitted');
  if (non_regression?.non_regression !== true) reasons.push('regression-detected');
  if (device_profiles.some(value => value.passed !== true)) reasons.push('device-constraint-failed');
  for (const [name, passed] of Object.entries(required_gates)) if (passed !== true) reasons.push(`gate-failed:${name}`);
  for (const key of ['baseline_digest', 'candidate_digest', 'suite_digest', 'dataset_digest']) if (!SHA256.test(clean(identities[key], 1000))) reasons.push(`identity-missing:${key}`);
  const body = canonical({ schema: MODEL_PROMOTION_SCHEMA, state: reasons.length ? 'promotion:not-admitted' : 'promotion:admitted', reasons: [...new Set(reasons)].sort(), identities });
  return Object.freeze({ ...body, decision_digest: digest(body) });
}
