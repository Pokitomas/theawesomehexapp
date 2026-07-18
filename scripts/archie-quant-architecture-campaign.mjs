#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ARCHIE_QUANT_ARCHITECTURE_TEMPLATE_SCHEMA = 'archie-quant-architecture-template/v2';
export const ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA = 'archie-quant-architecture-results/v2';
export const ARCHIE_QUANT_ARCHITECTURE_REPORT_SCHEMA = 'archie-quant-architecture-report/v2';
export const ARCHIE_ARCHITECTURE_SOURCE_CATALOG_SCHEMA = 'archie-architecture-source-catalog/v1';
export const CANONICAL_ARCHITECTURE_SOURCE_CATALOG_DIGEST = '0a5622f003486bb654e7194f23fce2327983120439c194ff838b04818d5601f6';
const HEX = /^[a-f0-9]{64}$/;
const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const freeze = value => Object.freeze(value);

function requireHash(value, field) {
  const out = clean(value).toLowerCase();
  if (!HEX.test(out)) throw new Error(`${field} must be a SHA-256 digest.`);
  return out;
}
function requireNumber(value, field, { minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}) {
  const out = Number(value);
  if (!Number.isFinite(out) || out < minimum || out > maximum) throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
  return out;
}
function rejectUnknown(value, allowed, field) {
  const unknown = Object.keys(value || {}).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${field} contains unsupported fields: ${unknown.join(', ')}.`);
}

export function validateArchitectureSourceCatalog(input) {
  if (!input || input.schema !== ARCHIE_ARCHITECTURE_SOURCE_CATALOG_SCHEMA) throw new Error(`source catalog schema must equal ${ARCHIE_ARCHITECTURE_SOURCE_CATALOG_SCHEMA}.`);
  if (digest(input) !== CANONICAL_ARCHITECTURE_SOURCE_CATALOG_DIGEST) throw new Error('source catalog must equal the immutable repository catalog.');
  const all = [...(input.neural_core_sources || []), ...(input.faculty_sources || []), ...(input.excluded_from_neural_core || [])];
  if (!all.length) throw new Error('source catalog must be nonempty.');
  const ids = new Set();
  for (const [index, source] of all.entries()) {
    if (!source || typeof source !== 'object') throw new Error(`source[${index}] must be an object.`);
    const id = clean(source.id);
    if (!id || ids.has(id)) throw new Error(`source[${index}].id must be unique.`);
    ids.add(id);
    requireHash(source.archive_sha256, `source[${index}].archive_sha256`);
    requireNumber(source.archive_bytes, `source[${index}].archive_bytes`, { minimum: 1 });
  }
  const neural = new Map((input.neural_core_sources || []).map(source => [source.id, source]));
  for (const required of ['unsloth-upload-0a35ae61', 'mamba-upload-5da2347d', 'rwkv8-note-14ded853']) {
    const source = neural.get(required);
    if (!source) throw new Error(`source catalog is missing ${required}.`);
    requireHash(source.tree_digest, `${required}.tree_digest`);
    requireNumber(source.tree_files, `${required}.tree_files`, { minimum: 1 });
    requireNumber(source.tree_bytes, `${required}.tree_bytes`, { minimum: 1 });
  }
  return freeze({ ...input, catalog_digest: CANONICAL_ARCHITECTURE_SOURCE_CATALOG_DIGEST });
}

const COMMON_EXPECTED_FAILURES = freeze(['missing-hidden-evaluation', 'missing-independent-reproduction', 'missing-physical-a15-evidence']);
const CANDIDATES = freeze([
  ['qwen3-transformer-gguf-q4-k-m', 'qwen3-dense-transformer', 'transformer', 'gguf-q4-k-m', 4, null, 'control', ['unsloth-upload-0a35ae61'], ['missing-merged-checkpoint', 'missing-llama-converter', 'missing-llama-quantizer', ...COMMON_EXPECTED_FAILURES]],
  ['qwen3-transformer-gguf-q5-k-m', 'qwen3-dense-transformer', 'transformer', 'gguf-q5-k-m', 5, null, 'control', ['unsloth-upload-0a35ae61'], ['missing-merged-checkpoint', 'missing-llama-converter', 'missing-llama-quantizer', ...COMMON_EXPECTED_FAILURES]],
  ['qwen3-transformer-gguf-q6-k', 'qwen3-dense-transformer', 'transformer', 'gguf-q6-k', 6, null, 'control', ['unsloth-upload-0a35ae61'], ['missing-merged-checkpoint', 'missing-llama-converter', 'missing-llama-quantizer', ...COMMON_EXPECTED_FAILURES]],
  ['qwen3-transformer-gguf-q8-0', 'qwen3-dense-transformer', 'transformer', 'gguf-q8-0', 8, null, 'diagnostic-control', ['unsloth-upload-0a35ae61'], ['missing-merged-checkpoint', 'missing-llama-converter', 'missing-llama-quantizer', ...COMMON_EXPECTED_FAILURES]],
  ['mamba2-ssm-w8a16', 'mamba2-selective-ssm', 'state-space', 'weight-only-int8', 8, 16, 'generation-one', ['mamba-upload-5da2347d'], ['missing-trained-checkpoint', 'missing-quantized-exporter', 'missing-iphone-runtime', ...COMMON_EXPECTED_FAILURES]],
  ['mamba2-ssm-w4a16', 'mamba2-selective-ssm', 'state-space', 'weight-only-int4', 4, 16, 'generation-one', ['mamba-upload-5da2347d'], ['missing-trained-checkpoint', 'missing-quantized-exporter', 'missing-iphone-runtime', ...COMMON_EXPECTED_FAILURES]],
  ['mamba3-mimo-w8a16', 'mamba3-mimo-ssm', 'state-space', 'weight-only-int8', 8, 16, 'generation-one', ['mamba-upload-5da2347d'], ['missing-trained-checkpoint', 'missing-quantized-exporter', 'missing-iphone-runtime', ...COMMON_EXPECTED_FAILURES]],
  ['mamba3-mimo-w4a16', 'mamba3-mimo-ssm', 'state-space', 'weight-only-int4', 4, 16, 'generation-one', ['mamba-upload-5da2347d'], ['missing-trained-checkpoint', 'missing-quantized-exporter', 'missing-iphone-runtime', ...COMMON_EXPECTED_FAILURES]],
  ['rwkv8-matrix-state-w8-s8', 'rwkv8-matrix-state', 'recurrent', 'weight-int8-state-int8', 8, 8, 'generation-one', ['rwkv8-note-14ded853'], ['missing-architecture-implementation', 'missing-trained-checkpoint', 'missing-quantized-state-kernel', 'missing-iphone-runtime', ...COMMON_EXPECTED_FAILURES]],
  ['rwkv8-lowrank-state-w8-s8', 'rwkv8-low-rank-state', 'recurrent', 'weight-int8-state-int8', 8, 8, 'generation-one', ['rwkv8-note-14ded853'], ['missing-architecture-implementation', 'missing-trained-checkpoint', 'missing-quantized-state-kernel', 'missing-iphone-runtime', ...COMMON_EXPECTED_FAILURES]],
  ['rwkv8-quantized-state-w8-s6', 'rwkv8-quantized-state', 'recurrent', 'weight-int8-state-int6', 8, 6, 'generation-one', ['rwkv8-note-14ded853'], ['missing-architecture-implementation', 'missing-trained-checkpoint', 'missing-quantized-state-kernel', 'missing-iphone-runtime', ...COMMON_EXPECTED_FAILURES]],
  ['rwkv8-sparse-quantized-state-w8-s6', 'rwkv8-sparse-quantized-state', 'recurrent', 'weight-int8-state-int6', 8, 6, 'generation-one', ['rwkv8-note-14ded853'], ['missing-architecture-implementation', 'missing-trained-checkpoint', 'missing-quantized-state-kernel', 'missing-iphone-runtime', ...COMMON_EXPECTED_FAILURES]]
].map(([id, architecture_id, family, quantization_id, weight_bits, state_or_activation_bits, role, source_ids, expected_failure_codes]) => freeze({
  id,
  architecture_id,
  family,
  quantization: freeze({ id: quantization_id, weight_bits, state_or_activation_bits }),
  role,
  source_ids: freeze(source_ids),
  materialization: freeze({ state: family === 'transformer' ? 'ready-when-exact-inputs-are-bound' : 'blocked-research-proposal', command: family === 'transformer' ? 'npm run archie:student:quantize' : null }),
  expected_failure_codes: freeze(expected_failure_codes)
})));

export function buildArchitectureQuantizationTemplate(sourceCatalog) {
  const catalog = validateArchitectureSourceCatalog(sourceCatalog);
  const sourceIds = new Set(catalog.neural_core_sources.map(source => source.id));
  for (const candidate of CANDIDATES) for (const sourceId of candidate.source_ids) if (!sourceIds.has(sourceId)) throw new Error(`candidate ${candidate.id} references missing source ${sourceId}.`);
  const body = freeze({
    schema: ARCHIE_QUANT_ARCHITECTURE_TEMPLATE_SCHEMA,
    campaign_id: 'archie-generation-one-quant-architectures',
    source_catalog_digest: CANONICAL_ARCHITECTURE_SOURCE_CATALOG_DIGEST,
    source_bindings: freeze(catalog.neural_core_sources.map(source => freeze({ id: source.id, archive_sha256: source.archive_sha256, tree_digest: source.tree_digest }))),
    candidates: CANDIDATES,
    comparison_contract: freeze({
      same_parameter_budget: true,
      same_training_token_budget: true,
      same_distillation_curriculum: true,
      same_hidden_split: true,
      same_grader: true,
      same_workload_set: true,
      same_device_floor: 'iphone-a15-4gb-floor-v2',
      primary_metrics: freeze(['task_success_rate', 'quality_retention', 'sustained_tokens_per_second_p50', 'peak_rss_bytes', 'sustained_power_watts_p95', 'artifact_bytes']),
      teacher_trace_imitation_is_primary: false
    }),
    admission_route: freeze({ intelligence: 'archie-intelligence-campaign/v1', phone: 'archie-iphone-quantization-result/v2', selection_owned_here: false }),
    failure_policy: freeze({ continue_after_expected_failure: true, preserve_expected_failure_receipts: true, unexpected_failure_blocks_selection: true, no_missing_candidate_is_scored_as_zero: true }),
    claim_boundary: 'This template creates comparable architecture experiment cells. It does not create weights, validate reported metrics, implement Mamba or RWKV runtimes, admit a model, or select an iPhone candidate.'
  });
  return freeze({ ...body, template_digest: digest(body) });
}

function normalizeMetrics(input, field) {
  if (!input || typeof input !== 'object') throw new Error(`${field} is required.`);
  rejectUnknown(input, new Set(['task_success_rate', 'quality_retention', 'sustained_tokens_per_second_p50', 'peak_rss_bytes', 'sustained_power_watts_p95', 'artifact_bytes']), field);
  return freeze({
    task_success_rate: requireNumber(input.task_success_rate, `${field}.task_success_rate`, { maximum: 1 }),
    quality_retention: requireNumber(input.quality_retention, `${field}.quality_retention`, { maximum: 2 }),
    sustained_tokens_per_second_p50: requireNumber(input.sustained_tokens_per_second_p50, `${field}.sustained_tokens_per_second_p50`),
    peak_rss_bytes: requireNumber(input.peak_rss_bytes, `${field}.peak_rss_bytes`, { minimum: 1 }),
    sustained_power_watts_p95: requireNumber(input.sustained_power_watts_p95, `${field}.sustained_power_watts_p95`),
    artifact_bytes: requireNumber(input.artifact_bytes, `${field}.artifact_bytes`, { minimum: 1 })
  });
}
function dominates(left, right) {
  const a = left.diagnostic_metrics; const b = right.diagnostic_metrics;
  const noWorse = a.task_success_rate >= b.task_success_rate && a.quality_retention >= b.quality_retention && a.sustained_tokens_per_second_p50 >= b.sustained_tokens_per_second_p50 && a.peak_rss_bytes <= b.peak_rss_bytes && a.sustained_power_watts_p95 <= b.sustained_power_watts_p95 && a.artifact_bytes <= b.artifact_bytes;
  const better = a.task_success_rate > b.task_success_rate || a.quality_retention > b.quality_retention || a.sustained_tokens_per_second_p50 > b.sustained_tokens_per_second_p50 || a.peak_rss_bytes < b.peak_rss_bytes || a.sustained_power_watts_p95 < b.sustained_power_watts_p95 || a.artifact_bytes < b.artifact_bytes;
  return noWorse && better;
}

export function evaluateArchitectureQuantizationCampaign(templateInput, resultsInput) {
  if (!templateInput || templateInput.schema !== ARCHIE_QUANT_ARCHITECTURE_TEMPLATE_SCHEMA) throw new Error('Unsupported architecture template.');
  const templateBody = { ...templateInput }; delete templateBody.template_digest;
  if (digest(templateBody) !== requireHash(templateInput.template_digest, 'template.template_digest')) throw new Error('Template digest mismatch.');
  if (templateInput.source_catalog_digest !== CANONICAL_ARCHITECTURE_SOURCE_CATALOG_DIGEST) throw new Error('Template does not bind the canonical source catalog.');
  if (!resultsInput || resultsInput.schema !== ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA) throw new Error(`results.schema must equal ${ARCHIE_QUANT_ARCHITECTURE_RESULTS_SCHEMA}.`);
  rejectUnknown(resultsInput, new Set(['schema', 'template_digest', 'results', 'claim_boundary']), 'results');
  if (requireHash(resultsInput.template_digest, 'results.template_digest') !== templateInput.template_digest) throw new Error('Results do not bind the template.');
  const candidates = new Map(templateInput.candidates.map(candidate => [candidate.id, candidate]));
  const seen = new Set(); const expectedFailures = []; const unexpectedFailures = []; const completed = [];
  for (const [index, raw] of (resultsInput.results || []).entries()) {
    if (!raw || typeof raw !== 'object') throw new Error(`results[${index}] must be an object.`);
    const candidate = candidates.get(clean(raw.candidate_id));
    if (!candidate) throw new Error(`results[${index}] references an unknown candidate.`);
    if (seen.has(candidate.id)) throw new Error(`results contain duplicate candidate ${candidate.id}.`);
    seen.add(candidate.id);
    if (raw.status === 'failed') {
      rejectUnknown(raw, new Set(['candidate_id', 'status', 'failure_code', 'log_sha256']), `results[${index}]`);
      const receipt = freeze({ candidate_id: candidate.id, failure_code: clean(raw.failure_code), log_sha256: requireHash(raw.log_sha256, `results[${index}].log_sha256`) });
      if (candidate.expected_failure_codes.includes(receipt.failure_code)) expectedFailures.push(receipt); else unexpectedFailures.push(receipt);
      continue;
    }
    if (raw.status !== 'completed') throw new Error(`results[${index}].status must be completed or failed.`);
    rejectUnknown(raw, new Set(['candidate_id', 'status', 'checkpoint_sha256', 'runtime_sha256', 'training_budget_digest', 'hidden_split_sha256', 'grader_sha256', 'workload_set_sha256', 'diagnostic_metrics', 'intelligence_result_digest', 'iphone_result_digest', 'reproduction_receipt_digest']), `results[${index}]`);
    completed.push(freeze({
      candidate_id: candidate.id,
      architecture_id: candidate.architecture_id,
      checkpoint_sha256: requireHash(raw.checkpoint_sha256, `results[${index}].checkpoint_sha256`),
      runtime_sha256: requireHash(raw.runtime_sha256, `results[${index}].runtime_sha256`),
      training_budget_digest: requireHash(raw.training_budget_digest, `results[${index}].training_budget_digest`),
      hidden_split_sha256: requireHash(raw.hidden_split_sha256, `results[${index}].hidden_split_sha256`),
      grader_sha256: requireHash(raw.grader_sha256, `results[${index}].grader_sha256`),
      workload_set_sha256: requireHash(raw.workload_set_sha256, `results[${index}].workload_set_sha256`),
      diagnostic_metrics: normalizeMetrics(raw.diagnostic_metrics, `results[${index}].diagnostic_metrics`),
      unresolved_admission_links: freeze({
        intelligence_result_digest: requireHash(raw.intelligence_result_digest, `results[${index}].intelligence_result_digest`),
        iphone_result_digest: requireHash(raw.iphone_result_digest, `results[${index}].iphone_result_digest`),
        reproduction_receipt_digest: requireHash(raw.reproduction_receipt_digest, `results[${index}].reproduction_receipt_digest`)
      })
    }));
  }
  const bindingFields = ['training_budget_digest', 'hidden_split_sha256', 'grader_sha256', 'workload_set_sha256'];
  const bindingMismatches = bindingFields.filter(field => new Set(completed.map(row => row[field])).size > 1);
  const diagnosticsComparable = bindingMismatches.length === 0 ? completed : [];
  const diagnosticFrontier = diagnosticsComparable.filter(candidate => !diagnosticsComparable.some(other => other.candidate_id !== candidate.candidate_id && dominates(other, candidate))).map(row => row.candidate_id).sort();
  const missingCandidateIds = templateInput.candidates.map(candidate => candidate.id).filter(id => !seen.has(id));
  const blockers = ['canonical-intelligence-admission-unresolved', 'canonical-iphone-admission-unresolved', 'independent-reproduction-unresolved'];
  if (unexpectedFailures.length) blockers.push('unexpected-failures');
  if (bindingMismatches.length) blockers.push('comparison-binding-mismatch');
  if (missingCandidateIds.length) blockers.push('campaign-incomplete');
  const body = freeze({
    schema: ARCHIE_QUANT_ARCHITECTURE_REPORT_SCHEMA,
    campaign_id: templateInput.campaign_id,
    template_digest: templateInput.template_digest,
    received_candidate_count: seen.size,
    missing_candidate_ids: freeze(missingCandidateIds),
    expected_failures: freeze(expectedFailures),
    unexpected_failures: freeze(unexpectedFailures),
    completed_diagnostics: freeze(completed),
    diagnostic_comparison: freeze({ binding_mismatches: freeze(bindingMismatches), comparable_candidate_ids: freeze(diagnosticsComparable.map(row => row.candidate_id).sort()), diagnostic_pareto_frontier_candidate_ids: freeze(diagnosticFrontier) }),
    selection: freeze({ eligible: false, blockers: freeze(blockers), selected_candidate_id: null }),
    claim_boundary: 'Reported metrics and digests remain diagnostic references. This report cannot admit or select an architecture. Selection belongs only to independently validated intelligence, physical-device, and reproduction contracts.'
  });
  return freeze({ ...body, report_digest: digest(body) });
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const value = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : ''; };
  const catalogPath = path.resolve(value('--catalog') || 'product/archie-architecture-source-catalog.json');
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  const template = buildArchitectureQuantizationTemplate(catalog);
  if (command === 'template') {
    const output = value('--output');
    if (output) await fs.writeFile(path.resolve(output), `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
    return;
  }
  if (command === 'evaluate') {
    const resultsPath = value('--results');
    if (!resultsPath) throw new Error('--results is required.');
    const report = evaluateArchitectureQuantizationCampaign(template, JSON.parse(await fs.readFile(path.resolve(resultsPath), 'utf8')));
    const output = value('--output');
    if (output) await fs.writeFile(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  throw new Error('Usage: node scripts/archie-quant-architecture-campaign.mjs template|evaluate [--catalog <catalog.json>] [--results <results.json>] [--output <file>]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
