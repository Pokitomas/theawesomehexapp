import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAdversarialFailureEvaluation,
  buildFrozenEvaluationContract,
  compareFrozenBase,
  compareQuantizationCandidates,
  decideModelPromotion,
  evaluateDeviceProfile,
  evaluateFrozenSuite,
  fuseReliableAdapterDeltas,
  materializeMergedCheckpoint,
  normalizeDatasetIdentity,
  normalizeTrajectoryProvenance,
  planBoundedFailureSetTraining,
  planRamCappedExecution,
  verifyAdapterShardReceipt,
  verifyGGUFCompatibility
} from '../maker-executive-model-evaluation.mjs';

const SHA = 'a'.repeat(40);
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64), E = 'e'.repeat(64), F = 'f'.repeat(64);

function shard(id, reliability = 0.8, overrides = {}) {
  return { id, shard_id: id, source_sha: SHA, base_checkpoint_digest: A, dataset_digest: B, trajectory_digest: C, adapter_digest: id === 'one' ? D : E, changed_tensor_digest: id === 'one' ? E : F, changed_tensor_count: 2, train_steps: 10, reliability, ...overrides };
}

test('dataset and trajectory identities bind bytes, schema, tokenizer, prompts, outcomes, and lineage', () => {
  const dataset = normalizeDatasetIdentity({ id: 'ds', digest: A, bytes: 10, records: 2, schema_digest: B, tokenizer_digest: C });
  const trajectory = normalizeTrajectoryProvenance({ id: 't1', dataset_digest: dataset.digest, source_sha: SHA, prompt_digest: D, chosen_digest: E, rejected_digest: F, causal_pair_id: 'pair:1', lineage: ['root'] });
  assert.match(dataset.identity_digest, /^[0-9a-f]{64}$/);
  assert.match(trajectory.provenance_digest, /^[0-9a-f]{64}$/);
});

test('adapter shard receipts require changed tensors and default to non-admitted', () => {
  const receipt = verifyAdapterShardReceipt(shard('one'));
  assert.equal(receipt.promotion_state, 'promotion:not-admitted');
  assert.throws(() => verifyAdapterShardReceipt(shard('bad', 0.5, { changed_tensor_count: 0 })), /invalid/);
});

test('reliability-weighted fusion rejects identity mismatch and emits normalized weights', () => {
  const fused = fuseReliableAdapterDeltas([shard('one', 0.75), shard('two', 0.25)]);
  assert.equal(fused.components[0].weight + fused.components[1].weight, 1);
  assert.equal(fused.promotion_state, 'promotion:not-admitted');
  assert.throws(() => fuseReliableAdapterDeltas([shard('one'), shard('two', 0.5, { dataset_digest: C })]), /identity-mismatched/);
});

test('frozen-base comparison captures case-level gains and regressions', () => {
  const result = compareFrozenBase({ baseline_cases: [{ id: '1', passed: true, capability: 'math' }, { id: '2', passed: false, capability: 'tool' }], candidate_cases: [{ id: '1', passed: false, capability: 'math', severity: 'high' }, { id: '2', passed: true, capability: 'tool' }] });
  assert.equal(result.non_regression, false);
  assert.deepEqual(result.regressions.map(value => value.id), ['1']);
  assert.deepEqual(result.gains.map(value => value.id), ['2']);
});

test('recursive failure training is bounded and uses only reproducible failures', () => {
  const plan = planBoundedFailureSetTraining({ source_sha: SHA, dataset_digest: B, failures: [{ id: 'a', reproducible: true, severity: 'high' }, { id: 'b', reproducible: false }], recursion_depth: 0, recursion_limit: 1, max_cases: 2, max_steps: 10 });
  assert.deepEqual(plan.selected_failure_ids, ['a']);
  assert.throws(() => planBoundedFailureSetTraining({ source_sha: SHA, dataset_digest: B, failures: [{ id: 'a', reproducible: true }], recursion_depth: 1, recursion_limit: 1 }), /limit reached/);
});

test('merged checkpoint materialization requires all fusion and non-regression gates', () => {
  const receipt = materializeMergedCheckpoint({ source_sha: SHA, base_checkpoint_digest: A, fused_adapter_digest: B, fusion_gates: { identity: true, tensors: true }, non_regression: { non_regression: true }, output_digest: C });
  assert.equal(receipt.promotion_state, 'promotion:not-admitted');
  assert.throws(() => materializeMergedCheckpoint({ source_sha: SHA, base_checkpoint_digest: A, fused_adapter_digest: B, fusion_gates: { identity: false }, non_regression: { non_regression: true }, output_digest: C }), /fusion gates/);
});

test('quantization selection preserves case retention and RAM constraints', () => {
  const result = compareQuantizationCandidates([{ id: 'q4', digest: A, format: 'gguf', bytes: 100, peak_ram_bytes: 200, case_total: 100, case_retained: 99 }, { id: 'q8', digest: B, format: 'gguf', bytes: 200, peak_ram_bytes: 300, case_total: 100, case_retained: 100 }], { minimum_retention: 0.99, ram_cap_bytes: 250 });
  assert.equal(result.selected.id, 'q4');
  assert.throws(() => compareQuantizationCandidates([{ id: 'bad', digest: A, format: 'gguf', bytes: 10, peak_ram_bytes: 500, case_total: 10, case_retained: 5 }], { minimum_retention: 0.9, ram_cap_bytes: 100 }), /No quantization/);
});

test('GGUF metadata and RAM planning fail closed on architecture and capacity', () => {
  const gguf = verifyGGUFCompatibility({ architecture: 'qwen3', expected_architecture: 'qwen3', model_type: 'decoder', tensor_count: 10, metadata_digest: A, file_digest: B, metadata: { tokenizer: 'x' }, required_metadata: ['tokenizer'] });
  assert.equal(gguf.compatible, true);
  assert.equal(planRamCappedExecution({ model_bytes: 100, runtime_overhead_bytes: 10, context_bytes: 20, kv_cache_bytes: 30, ram_cap_bytes: 200 }).admitted, true);
  assert.equal(planRamCappedExecution({ model_bytes: 100, runtime_overhead_bytes: 10, context_bytes: 20, kv_cache_bytes: 80, ram_cap_bytes: 200 }).admitted, false);
});

test('frozen evaluation isolates evaluator and rejects mismatched bytes or weak confidence', () => {
  const contract = buildFrozenEvaluationContract({ suite_digest: A, prompt_digest: B, dataset_digest: C, baseline_digest: D, candidate_digest: E, evaluator_id: 'verifier', trainer_id: 'writer', declared_artifact_digests: [F], minimum_cases: 2, minimum_lower_confidence: 0.2 });
  const passed = evaluateFrozenSuite({ contract, observed: { suite_digest: A, prompt_digest: B, dataset_digest: C, baseline_digest: D, candidate_digest: E }, cases: [{ id: '1', passed: true, capability: 'math' }, { id: '2', passed: true, capability: 'tool' }], accessible_artifact_digests: [F] });
  assert.equal(passed.admitted_metrics, true);
  const rejected = evaluateFrozenSuite({ contract, observed: { suite_digest: F, prompt_digest: B, dataset_digest: C, baseline_digest: D, candidate_digest: E }, cases: [{ id: '1', passed: true }], accessible_artifact_digests: [A] });
  assert.ok(rejected.rejection_reasons.includes('suite_digest-mismatch'));
  assert.ok(rejected.rejection_reasons.includes('evaluator-isolation-violation'));
  assert.ok(rejected.rejection_reasons.includes('minimum-evidence-not-met'));
});

test('adversarial clusters and device profiles feed fail-closed promotion', () => {
  const adversarial = buildAdversarialFailureEvaluation([{ id: 'a', capability: 'math', cluster: 'carry', adversarial_prompt_digest: A }, { id: 'b', capability: 'tool', cluster: 'authority', adversarial_prompt_digest: B }], { max_cases: 2 });
  assert.equal(adversarial.cases.length, 2);
  const device = evaluateDeviceProfile({ device_id: 'phone', runtime_ms: 10, peak_memory_bytes: 100, latency_p95_ms: 5, peak_temperature_c: 40, limits: { runtime_ms: 20, peak_memory_bytes: 200, latency_p95_ms: 10, peak_temperature_c: 45 } });
  const decision = decideModelPromotion({ evaluation: { admitted_metrics: true }, non_regression: { non_regression: true }, device_profiles: [device], required_gates: { fusion: true }, identities: { baseline_digest: A, candidate_digest: B, suite_digest: C, dataset_digest: D } });
  assert.equal(decision.state, 'promotion:admitted');
  const rejected = decideModelPromotion({ evaluation: { admitted_metrics: false }, non_regression: { non_regression: false }, device_profiles: [{ passed: false }], required_gates: { fusion: false }, identities: {} });
  assert.equal(rejected.state, 'promotion:not-admitted');
  assert.ok(rejected.reasons.length >= 4);
});
