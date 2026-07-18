import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA,
  buildArchitectureQuantizationTemplate,
  digest,
  evaluateArchitectureQuantizationCampaign,
  validateArchitectureSourceCatalog
} from '../archie-quant-architecture-campaign.mjs';

const catalogPath = path.resolve('product/archie-architecture-source-catalog.json');
const loadCatalog = async () => JSON.parse(await fs.readFile(catalogPath, 'utf8'));
const hash = character => character.repeat(64);

function completed(candidateId, overrides = {}) {
  return {
    candidate_id: candidateId,
    status: 'completed',
    checkpoint_sha256: hash('a'),
    runtime_sha256: hash('b'),
    training_budget_digest: hash('c'),
    hidden_split_sha256: hash('d'),
    grader_sha256: hash('e'),
    workload_set_sha256: hash('f'),
    evidence: { independent: true, reproduced: true, physical_a15: true },
    metrics: {
      task_success_rate: 0.82,
      quality_retention: 0.95,
      sustained_tokens_per_second_p50: 9,
      peak_rss_bytes: 2_000_000_000,
      sustained_power_watts_p95: 5,
      artifact_bytes: 1_500_000_000
    },
    ...overrides
  };
}

test('binds the uploaded source identities and keeps faculties outside the neural core', async () => {
  const catalog = validateArchitectureSourceCatalog(await loadCatalog());
  assert.equal(catalog.neural_core_sources.length, 3);
  assert.deepEqual(catalog.neural_core_sources.map(row => row.id), ['unsloth-upload-0a35ae61', 'mamba-upload-5da2347d', 'rwkv8-note-14ded853']);
  assert.equal(catalog.faculty_sources.length, 3);
  assert.equal(catalog.excluded_from_neural_core.length, 4);
  assert.equal(catalog.catalog_digest, digest({ ...catalog, catalog_digest: undefined }));
});

test('creates transformer controls and blocked Mamba/RWKV experiment cells without inventing runtimes', async () => {
  const template = buildArchitectureQuantizationTemplate(await loadCatalog());
  assert.equal(template.candidates.length, 12);
  const qwen = template.candidates.filter(row => row.family === 'transformer');
  const mamba = template.candidates.filter(row => row.family === 'state-space');
  const rwkv = template.candidates.filter(row => row.family === 'recurrent');
  assert.deepEqual(qwen.map(row => row.quantization.id), ['gguf-q4-k-m', 'gguf-q5-k-m', 'gguf-q6-k', 'gguf-q8-0']);
  assert.ok(qwen.every(row => row.materialization.command === 'npm run archie:student:quantize'));
  assert.ok([...mamba, ...rwkv].every(row => row.materialization.state === 'blocked-research-proposal' && row.materialization.command === null));
  assert.ok(rwkv.some(row => row.quantization.state_or_activation_bits === 6));
});

test('continues through expected blockers and identifies unexpected failures', async () => {
  const template = buildArchitectureQuantizationTemplate(await loadCatalog());
  const results = {
    schema: ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA,
    template_digest: template.template_digest,
    results: [
      { candidate_id: 'mamba2-ssm-w4a16', status: 'failed', failure_code: 'missing-iphone-runtime', log_sha256: hash('1') },
      { candidate_id: 'rwkv8-quantized-state-w8-s6', status: 'failed', failure_code: 'kernel-produced-nan', log_sha256: hash('2') }
    ]
  };
  const report = evaluateArchitectureQuantizationCampaign(template, results);
  assert.equal(report.expected_failures.length, 1);
  assert.equal(report.unexpected_failures.length, 1);
  assert.ok(report.selection.blockers.includes('unexpected-failures'));
  assert.equal(report.selection.eligible, false);
});

test('forms a Pareto frontier only from equivalently bound independent physical-device completions', async () => {
  const template = buildArchitectureQuantizationTemplate(await loadCatalog());
  const results = {
    schema: ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA,
    template_digest: template.template_digest,
    results: [
      completed('qwen3-transformer-gguf-q4-k-m'),
      completed('qwen3-transformer-gguf-q5-k-m', { metrics: { task_success_rate: 0.84, quality_retention: 0.97, sustained_tokens_per_second_p50: 8.5, peak_rss_bytes: 2_100_000_000, sustained_power_watts_p95: 5.1, artifact_bytes: 1_700_000_000 } })
    ]
  };
  const report = evaluateArchitectureQuantizationCampaign(template, results);
  assert.equal(report.selection.eligible, true);
  assert.deepEqual(report.comparison.comparable_candidate_ids, ['qwen3-transformer-gguf-q4-k-m', 'qwen3-transformer-gguf-q5-k-m']);
  assert.deepEqual(report.comparison.pareto_frontier_candidate_ids, ['qwen3-transformer-gguf-q4-k-m', 'qwen3-transformer-gguf-q5-k-m']);
  assert.equal(report.selection.selected_candidate_id, null);

  const mismatched = structuredClone(results);
  mismatched.results[1].hidden_split_sha256 = hash('9');
  const blocked = evaluateArchitectureQuantizationCampaign(template, mismatched);
  assert.ok(blocked.selection.blockers.includes('comparison-binding-mismatch'));
  assert.deepEqual(blocked.comparison.comparable_candidate_ids, []);
});
