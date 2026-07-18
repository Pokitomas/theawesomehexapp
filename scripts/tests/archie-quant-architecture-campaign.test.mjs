import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA,
  CANONICAL_ARCHITECTURE_SOURCE_CATALOG_DIGEST,
  buildArchitectureQuantizationTemplate,
  evaluateArchitectureQuantizationCampaign,
  validateArchitectureSourceCatalog
} from '../archie-quant-architecture-campaign.mjs';

const hex = value => Number(value).toString(16).padStart(2, '0').repeat(32);
const catalog = async () => JSON.parse(await fs.readFile('product/archie-architecture-source-catalog.json', 'utf8'));
function completed(candidate, index) {
  return {
    candidate_id: candidate.id,
    status: 'completed',
    checkpoint_sha256: hex(20 + index),
    runtime_sha256: hex(50 + index),
    training_budget_digest: hex(1),
    hidden_split_sha256: hex(2),
    grader_sha256: hex(3),
    workload_set_sha256: hex(4),
    diagnostic_metrics: {
      task_success_rate: 0.70 + index / 100,
      quality_retention: 0.90 + index / 200,
      sustained_tokens_per_second_p50: 8 + index,
      peak_rss_bytes: 2_400_000_000 - index * 1_000_000,
      sustained_power_watts_p95: 5 - index / 100,
      artifact_bytes: 1_900_000_000 - index * 1_000_000
    },
    intelligence_result_digest: hex(5),
    iphone_result_digest: hex(6),
    reproduction_receipt_digest: hex(7)
  };
}

test('binds the immutable inspected source catalog and keeps the broader architecture search', async () => {
  const input = await catalog();
  const validated = validateArchitectureSourceCatalog(input);
  assert.equal(validated.catalog_digest, CANONICAL_ARCHITECTURE_SOURCE_CATALOG_DIGEST);
  const template = buildArchitectureQuantizationTemplate(input);
  assert.ok(template.candidates.some(candidate => candidate.family === 'transformer'));
  assert.ok(template.candidates.some(candidate => candidate.family === 'state-space'));
  assert.ok(template.candidates.some(candidate => candidate.family === 'recurrent'));
  assert.equal(template.admission_route.selection_owned_here, false);
  const mutated = structuredClone(input);
  mutated.neural_core_sources[0].archive_bytes += 1;
  assert.throws(() => validateArchitectureSourceCatalog(mutated), /immutable repository catalog/);
});

test('rejects self-attested evidence booleans and never selects from reported metrics or opaque digests', async () => {
  const template = buildArchitectureQuantizationTemplate(await catalog());
  const entries = template.candidates.map(completed);
  const unsafe = structuredClone(entries[0]);
  unsafe.evidence = { independent: true, reproduced: true, physical_a15: true };
  assert.throws(() => evaluateArchitectureQuantizationCampaign(template, {
    schema: ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA,
    template_digest: template.template_digest,
    results: [unsafe]
  }), /unsupported fields: evidence/);

  const report = evaluateArchitectureQuantizationCampaign(template, {
    schema: ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA,
    template_digest: template.template_digest,
    results: entries,
    claim_boundary: 'Synthetic diagnostics only.'
  });
  assert.equal(report.selection.eligible, false);
  assert.equal(report.selection.selected_candidate_id, null);
  assert.ok(report.selection.blockers.includes('canonical-intelligence-admission-unresolved'));
  assert.ok(report.selection.blockers.includes('canonical-iphone-admission-unresolved'));
  assert.ok(report.selection.blockers.includes('independent-reproduction-unresolved'));
  assert.equal(report.missing_candidate_ids.length, 0);
  assert.ok(report.diagnostic_comparison.diagnostic_pareto_frontier_candidate_ids.length > 0);
  assert.match(report.claim_boundary, /cannot admit or select/);
});

test('preserves expected failures without scoring missing candidates as zero', async () => {
  const template = buildArchitectureQuantizationTemplate(await catalog());
  const candidate = template.candidates[0];
  const report = evaluateArchitectureQuantizationCampaign(template, {
    schema: ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA,
    template_digest: template.template_digest,
    results: [{ candidate_id: candidate.id, status: 'failed', failure_code: candidate.expected_failure_codes[0], log_sha256: hex(9) }]
  });
  assert.equal(report.expected_failures.length, 1);
  assert.equal(report.unexpected_failures.length, 0);
  assert.equal(report.completed_diagnostics.length, 0);
  assert.equal(report.missing_candidate_ids.length, template.candidates.length - 1);
  assert.ok(report.selection.blockers.includes('campaign-incomplete'));
});

test('rejects template tampering and comparison-binding drift', async () => {
  const template = buildArchitectureQuantizationTemplate(await catalog());
  const tampered = structuredClone(template);
  tampered.comparison_contract.same_hidden_split = false;
  assert.throws(() => evaluateArchitectureQuantizationCampaign(tampered, {
    schema: ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA,
    template_digest: template.template_digest,
    results: []
  }), /Template digest mismatch/);

  const entries = template.candidates.slice(0, 2).map(completed);
  entries[1].hidden_split_sha256 = hex(11);
  const report = evaluateArchitectureQuantizationCampaign(template, {
    schema: ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA,
    template_digest: template.template_digest,
    results: entries
  });
  assert.ok(report.diagnostic_comparison.binding_mismatches.includes('hidden_split_sha256'));
  assert.equal(report.diagnostic_comparison.comparable_candidate_ids.length, 0);
  assert.ok(report.selection.blockers.includes('comparison-binding-mismatch'));
});
