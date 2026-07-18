import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIPhoneResearch, validateIPhoneResearchPlan } from '../archie-iphone-quantization-research.mjs';

const gib = value => Math.round(value * 1024 * 1024 * 1024);
const digest = character => character.repeat(64);
const target = {
  id: 'iphone-a15-4gb-floor', os: 'ios', minimum_os_major: 18, device_floor: 'iphone14,6', silicon_floor: 'a15',
  physical_ram_bytes: gib(4), maximum_artifact_bytes: gib(2.2), maximum_peak_rss_bytes: gib(2.65), minimum_context_tokens: 4096,
  minimum_quality_retention: 0.94, maximum_first_token_ms: 1800, maximum_decode_ms_per_token: 125,
  minimum_sustained_tokens_per_second: 8, maximum_sustained_power_watts: 5.5, maximum_thermal_throttle_rate: 0.08,
  minimum_sustained_duration_ms: 120000, minimum_sample_count: 3,
  required_workloads: ['answer', 'planning', 'tool-routing']
};
function candidate(overrides = {}) {
  const id = overrides.id || 'q4';
  return {
    id, model_id: 'archie-student-3b', revision: '0123456789abcdef0123456789abcdef01234567', artifact_format: 'mlx-safetensors',
    method: 'mlx-grouped-quantization', bits: 4, group_size: 64, artifact_bytes: gib(1.8),
    metrics: { peak_rss_bytes: gib(2.4), context_tokens: 4096, quality_retention: 0.97, first_token_ms_p95: 1300,
      decode_ms_per_token_p95: 90, sustained_tokens_per_second_p50: 11.1, sustained_power_watts_p95: 4.8,
      thermal_throttle_rate: 0.03, sustained_duration_ms: 180000, sample_count: 5,
      workloads: ['answer', 'planning', 'tool-routing'] },
    evidence: { measured_on_physical_device: true, evaluation_digest: digest('a'), measurement_digest: digest('b'),
      device: { os: 'ios', os_version: '18.5', model_identifier: 'iphone14,6', silicon: 'a15', physical_ram_bytes: gib(4), fingerprint_digest: digest('c') } },
    ...overrides,
    metrics: { peak_rss_bytes: gib(2.4), context_tokens: 4096, quality_retention: 0.97, first_token_ms_p95: 1300,
      decode_ms_per_token_p95: 90, sustained_tokens_per_second_p50: 11.1, sustained_power_watts_p95: 4.8,
      thermal_throttle_rate: 0.03, sustained_duration_ms: 180000, sample_count: 5,
      workloads: ['answer', 'planning', 'tool-routing'], ...(overrides.metrics || {}) },
    evidence: { measured_on_physical_device: true, evaluation_digest: digest('a'), measurement_digest: digest('b'),
      device: { os: 'ios', os_version: '18.5', model_identifier: 'iphone14,6', silicon: 'a15', physical_ram_bytes: gib(4), fingerprint_digest: digest('c') }, ...(overrides.evidence || {}) }
  };
}
function matrix(candidates) {
  return { schema: 'archie-iphone-quantization-plan/v1', id: 'iphone-research-1', target, candidates,
    claim_boundary: 'Synthetic test fixture only.' };
}

test('selects strongest fully admitted iPhone candidate', () => {
  const result = evaluateIPhoneResearch(matrix([
    candidate(),
    candidate({ id: 'q6', bits: 6, group_size: 32, artifact_bytes: gib(2.1), metrics: { quality_retention: 0.965, sustained_tokens_per_second_p50: 9.2, peak_rss_bytes: gib(2.58), sustained_power_watts_p95: 5.1 } }),
    candidate({ id: 'q3', bits: 3, artifact_bytes: gib(1.4), metrics: { quality_retention: 0.91, sustained_tokens_per_second_p50: 13.2 } })
  ]));
  assert.equal(result.decision, 'selected-strongest-admitted-iphone-candidate');
  assert.equal(result.selected_candidate.id, 'q4');
  assert.deepEqual(result.admitted_candidate_ids, ['q4', 'q6']);
  assert.deepEqual(result.pareto_frontier_candidate_ids, ['q4']);
});

test('rejects desktop-only or simulated evidence', () => {
  const result = evaluateIPhoneResearch(matrix([candidate({ evidence: { measured_on_physical_device: false } })]));
  assert.equal(result.decision, 'no-iphone-candidate-admitted');
  assert.ok(result.evaluations[0].blockers.includes('physical-iphone-evidence'));
});

test('rejects measurements not collected on the exact iPhone floor', () => {
  const bad = candidate({ evidence: { device: { os: 'ios', os_version: '18.5', model_identifier: 'iphone17,1', silicon: 'a18pro', physical_ram_bytes: gib(8), fingerprint_digest: digest('d') } } });
  assert.throws(() => validateIPhoneResearchPlan(matrix([bad])), /exact target iPhone floor/);
});
