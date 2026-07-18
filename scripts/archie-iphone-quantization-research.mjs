#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ARCHIE_IPHONE_RESEARCH_TEMPLATE_SCHEMA = 'archie-iphone-quantization-template/v1';
export const ARCHIE_IPHONE_RESEARCH_PLAN_SCHEMA = 'archie-iphone-quantization-plan/v1';
export const ARCHIE_IPHONE_RESEARCH_RESULT_SCHEMA = 'archie-iphone-quantization-result/v1';
const gib = value => Math.round(value * 1024 ** 3);
export const DEFAULT_IPHONE_RESEARCH_TARGET = Object.freeze({
  id: 'iphone-a15-4gb-floor', os: 'ios', minimum_os_major: 18, device_floor: 'iphone14,6', silicon_floor: 'a15',
  physical_ram_bytes: gib(4), maximum_artifact_bytes: gib(2.2), maximum_peak_rss_bytes: gib(2.65), minimum_context_tokens: 4096,
  minimum_quality_retention: 0.94, maximum_first_token_ms: 1800, maximum_decode_ms_per_token: 125,
  minimum_sustained_tokens_per_second: 8, maximum_sustained_power_watts: 5.5, maximum_thermal_throttle_rate: 0.08,
  minimum_sustained_duration_ms: 120000, minimum_sample_count: 3, required_workloads: Object.freeze(['answer', 'planning', 'tool-routing'])
});
export const DEFAULT_IPHONE_QUANTIZATION_SEARCH = Object.freeze([
  ['mlx-q4-g32', 'mlx-safetensors', 'mlx-grouped-quantization', 4, 32],
  ['mlx-q4-g64', 'mlx-safetensors', 'mlx-grouped-quantization', 4, 64],
  ['mlx-q6-g32', 'mlx-safetensors', 'mlx-grouped-quantization', 6, 32],
  ['coreml-pal4-g16', 'coreml-mlpackage', 'coreml-palettization', 4, 16],
  ['coreml-pal4-g32', 'coreml-mlpackage', 'coreml-palettization', 4, 32],
  ['coreml-pal6-g16', 'coreml-mlpackage', 'coreml-palettization', 6, 16],
  ['coreml-linear4', 'coreml-mlpackage', 'coreml-linear-weight-quantization', 4, null],
  ['coreml-linear8', 'coreml-mlpackage', 'coreml-linear-weight-quantization', 8, null],
  ['gguf-q4-k-m', 'gguf', 'gguf-k-quantization', 4, null]
].map(([id, artifact_format, method, bits, group_size]) => Object.freeze({ id, artifact_format, method, bits, group_size })));

const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._,:@+-]{0,199}$/;
const FORMATS = new Set(['mlx-safetensors', 'coreml-mlpackage', 'gguf']);
const METHODS = new Set(['mlx-grouped-quantization', 'coreml-linear-weight-quantization', 'coreml-palettization', 'gguf-k-quantization']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const object = (value, field) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`); return value; };
const text = (value, field, limit = 10000) => { const out = String(value ?? '').replace(/\u0000/g, '').trim(); if (!out || out.length > limit) throw new Error(`${field} is required and must be <= ${limit} characters.`); return out; };
const id = (value, field) => { const out = text(value, field, 200); if (!ID.test(out)) throw new Error(`${field} must be a portable identifier.`); return out; };
const number = (value, field, minimum = 0) => { const out = Number(value); if (!Number.isFinite(out) || out < minimum) throw new Error(`${field} must be finite and >= ${minimum}.`); return out; };
const integer = (value, field, minimum = 0) => { const out = number(value, field, minimum); if (!Number.isSafeInteger(out)) throw new Error(`${field} must be a safe integer.`); return out; };
const rate = (value, field) => { const out = number(value, field); if (out > 1) throw new Error(`${field} must be between 0 and 1.`); return out; };
const hash = (value, field) => { const out = text(value, field, 64).toLowerCase(); if (!HEX.test(out)) throw new Error(`${field} must be a SHA-256 digest.`); return out; };
const strings = (values, field) => { if (!Array.isArray(values) || !values.length) throw new Error(`${field} must not be empty.`); const out = values.map((value, index) => id(value, `${field}[${index}]`)); if (new Set(out).size !== out.length) throw new Error(`${field} contains duplicates.`); return Object.freeze(out); };

function target(input) {
  const value = object(input, 'target');
  if (String(value.os).toLowerCase() !== 'ios') throw new Error('target.os must equal ios.');
  return Object.freeze({
    id: id(value.id, 'target.id'), os: 'ios', minimum_os_major: integer(value.minimum_os_major, 'target.minimum_os_major', 16),
    device_floor: id(value.device_floor, 'target.device_floor'), silicon_floor: id(value.silicon_floor, 'target.silicon_floor'),
    physical_ram_bytes: integer(value.physical_ram_bytes, 'target.physical_ram_bytes', 1), maximum_artifact_bytes: integer(value.maximum_artifact_bytes, 'target.maximum_artifact_bytes', 1),
    maximum_peak_rss_bytes: integer(value.maximum_peak_rss_bytes, 'target.maximum_peak_rss_bytes', 1), minimum_context_tokens: integer(value.minimum_context_tokens, 'target.minimum_context_tokens', 1),
    minimum_quality_retention: rate(value.minimum_quality_retention, 'target.minimum_quality_retention'), maximum_first_token_ms: number(value.maximum_first_token_ms, 'target.maximum_first_token_ms', 0.001),
    maximum_decode_ms_per_token: number(value.maximum_decode_ms_per_token, 'target.maximum_decode_ms_per_token', 0.001), minimum_sustained_tokens_per_second: number(value.minimum_sustained_tokens_per_second, 'target.minimum_sustained_tokens_per_second', 0.001),
    maximum_sustained_power_watts: number(value.maximum_sustained_power_watts, 'target.maximum_sustained_power_watts', 0.001), maximum_thermal_throttle_rate: rate(value.maximum_thermal_throttle_rate, 'target.maximum_thermal_throttle_rate'),
    minimum_sustained_duration_ms: integer(value.minimum_sustained_duration_ms ?? 120000, 'target.minimum_sustained_duration_ms', 60000), minimum_sample_count: integer(value.minimum_sample_count ?? 3, 'target.minimum_sample_count', 3),
    required_workloads: strings(value.required_workloads, 'target.required_workloads')
  });
}

function candidate(input, index, floor) {
  const field = `candidates[${index}]`; const value = object(input, field); const evidence = object(value.evidence, `${field}.evidence`); const device = object(evidence.device, `${field}.evidence.device`); const metrics = object(value.metrics, `${field}.metrics`);
  const format = id(value.artifact_format, `${field}.artifact_format`); const method = id(value.method, `${field}.method`);
  if (!FORMATS.has(format) || !METHODS.has(method)) throw new Error(`${field} uses an unsupported format or method.`);
  const compatible = (method === 'mlx-grouped-quantization' && format === 'mlx-safetensors') || (method.startsWith('coreml-') && format === 'coreml-mlpackage') || (method === 'gguf-k-quantization' && format === 'gguf');
  if (!compatible) throw new Error(`${field} artifact format is incompatible with its quantization method.`);
  const observed = Object.freeze({ os: text(device.os, `${field}.evidence.device.os`, 100).toLowerCase(), os_version: text(device.os_version, `${field}.evidence.device.os_version`, 100), model_identifier: id(device.model_identifier, `${field}.evidence.device.model_identifier`), silicon: id(device.silicon, `${field}.evidence.device.silicon`), physical_ram_bytes: integer(device.physical_ram_bytes, `${field}.evidence.device.physical_ram_bytes`, 1), fingerprint_digest: hash(device.fingerprint_digest, `${field}.evidence.device.fingerprint_digest`) });
  if (observed.os !== 'ios' || Number.parseInt(observed.os_version, 10) < floor.minimum_os_major || observed.model_identifier !== floor.device_floor || observed.silicon !== floor.silicon_floor || observed.physical_ram_bytes !== floor.physical_ram_bytes) throw new Error(`${field} was not measured on the exact target iPhone floor.`);
  return Object.freeze({
    id: id(value.id, `${field}.id`), model_id: id(value.model_id, `${field}.model_id`), revision: text(value.revision, `${field}.revision`, 200), artifact_format: format, method,
    bits: number(value.bits, `${field}.bits`, 1), group_size: value.group_size == null ? null : integer(value.group_size, `${field}.group_size`, 1), artifact_bytes: integer(value.artifact_bytes, `${field}.artifact_bytes`, 1),
    peak_rss_bytes: integer(metrics.peak_rss_bytes, `${field}.metrics.peak_rss_bytes`, 1), context_tokens: integer(metrics.context_tokens, `${field}.metrics.context_tokens`, 1), quality_retention: rate(metrics.quality_retention, `${field}.metrics.quality_retention`),
    first_token_ms_p95: number(metrics.first_token_ms_p95, `${field}.metrics.first_token_ms_p95`, 0.001), decode_ms_per_token_p95: number(metrics.decode_ms_per_token_p95, `${field}.metrics.decode_ms_per_token_p95`, 0.001), sustained_tokens_per_second_p50: number(metrics.sustained_tokens_per_second_p50, `${field}.metrics.sustained_tokens_per_second_p50`, 0.001),
    sustained_power_watts_p95: number(metrics.sustained_power_watts_p95, `${field}.metrics.sustained_power_watts_p95`, 0.001), thermal_throttle_rate: rate(metrics.thermal_throttle_rate, `${field}.metrics.thermal_throttle_rate`), sustained_duration_ms: integer(metrics.sustained_duration_ms, `${field}.metrics.sustained_duration_ms`, 1), sample_count: integer(metrics.sample_count, `${field}.metrics.sample_count`, 1), workloads: strings(metrics.workloads, `${field}.metrics.workloads`),
    evaluation_digest: hash(evidence.evaluation_digest, `${field}.evidence.evaluation_digest`), measurement_digest: hash(evidence.measurement_digest, `${field}.evidence.measurement_digest`), measured_on_physical_device: evidence.measured_on_physical_device === true, device: observed
  });
}

export function createIPhoneResearchTemplate() {
  const body = { schema: ARCHIE_IPHONE_RESEARCH_TEMPLATE_SCHEMA, target: DEFAULT_IPHONE_RESEARCH_TARGET, quantization_search: DEFAULT_IPHONE_QUANTIZATION_SEARCH, allocation: { iphone_model_quality_and_quantization: 1, desktop_specific_research: 0 }, authority: { physical_iphone_evidence_required: true, training_spend: 'human', model_promotion: 'human', merge: 'human', deploy: 'human' }, next_artifact: 'Populate an archie-iphone-quantization-plan/v1 matrix with exact model revision and physical-device metrics.' };
  return Object.freeze({ ...body, template_digest: digest(body) });
}

export function validateIPhoneResearchPlan(input) {
  const value = object(input, 'plan'); if (value.schema !== ARCHIE_IPHONE_RESEARCH_PLAN_SCHEMA) throw new Error(`plan.schema must equal ${ARCHIE_IPHONE_RESEARCH_PLAN_SCHEMA}.`); const floor = target(value.target); const candidates = (value.candidates || []).map((item, index) => candidate(item, index, floor));
  if (!candidates.length || new Set(candidates.map(item => item.id)).size !== candidates.length) throw new Error('plan.candidates must be nonempty and unique.');
  const body = { schema: ARCHIE_IPHONE_RESEARCH_PLAN_SCHEMA, id: id(value.id, 'plan.id'), target: floor, candidates, selection_policy: 'strongest-admitted-candidate-on-iphone-floor', claim_boundary: text(value.claim_boundary || 'Only exact physical-iPhone evidence can select a candidate.', 'plan.claim_boundary', 2000) };
  return Object.freeze({ ...body, plan_digest: digest(body) });
}

const check = (id, passed, detail = null) => Object.freeze({ id, passed: Boolean(passed), detail });
function evaluate(item, floor) {
  const observed = new Set(item.workloads); const required = floor.required_workloads;
  const checks = [
    check('physical-iphone-evidence', item.measured_on_physical_device), check('artifact-fits', item.artifact_bytes <= floor.maximum_artifact_bytes), check('peak-rss-fits', item.peak_rss_bytes <= floor.maximum_peak_rss_bytes),
    check('context-sufficient', item.context_tokens >= floor.minimum_context_tokens), check('quality-retained', item.quality_retention >= floor.minimum_quality_retention), check('first-token-latency', item.first_token_ms_p95 <= floor.maximum_first_token_ms),
    check('decode-latency', item.decode_ms_per_token_p95 <= floor.maximum_decode_ms_per_token), check('sustained-speed', item.sustained_tokens_per_second_p50 >= floor.minimum_sustained_tokens_per_second), check('sustained-power', item.sustained_power_watts_p95 <= floor.maximum_sustained_power_watts),
    check('thermal-throttle', item.thermal_throttle_rate <= floor.maximum_thermal_throttle_rate), check('sustained-duration', item.sustained_duration_ms >= floor.minimum_sustained_duration_ms), check('sample-count', item.sample_count >= floor.minimum_sample_count), check('workload-coverage', required.every(name => observed.has(name)), { required, observed: item.workloads })
  ];
  const blockers = checks.filter(value => !value.passed).map(value => value.id); return Object.freeze({ candidate: item, admitted: blockers.length === 0, checks, blockers });
}
const dominates = (a, b) => a.quality_retention >= b.quality_retention && a.sustained_tokens_per_second_p50 >= b.sustained_tokens_per_second_p50 && a.peak_rss_bytes <= b.peak_rss_bytes && a.sustained_power_watts_p95 <= b.sustained_power_watts_p95 && a.first_token_ms_p95 <= b.first_token_ms_p95 && (a.quality_retention > b.quality_retention || a.sustained_tokens_per_second_p50 > b.sustained_tokens_per_second_p50 || a.peak_rss_bytes < b.peak_rss_bytes || a.sustained_power_watts_p95 < b.sustained_power_watts_p95 || a.first_token_ms_p95 < b.first_token_ms_p95);
const order = (a, b) => b.quality_retention - a.quality_retention || b.sustained_tokens_per_second_p50 - a.sustained_tokens_per_second_p50 || a.peak_rss_bytes - b.peak_rss_bytes || a.sustained_power_watts_p95 - b.sustained_power_watts_p95 || a.first_token_ms_p95 - b.first_token_ms_p95 || a.id.localeCompare(b.id);

export function evaluateIPhoneResearch(input) {
  const plan = validateIPhoneResearchPlan(input); const evaluations = plan.candidates.map(item => evaluate(item, plan.target)); const admitted = evaluations.filter(item => item.admitted).map(item => item.candidate); const frontier = admitted.filter(item => !admitted.some(other => other.id !== item.id && dominates(other, item))).sort(order); const selected = frontier[0] || null; const findings = [];
  if (!admitted.length) findings.push('No candidate satisfies the complete physical-iPhone quality, memory, latency, power, thermal, duration, and workload envelope.');
  if (admitted.length > 1 && frontier.length > 1) findings.push('The admitted set has a real quality-versus-efficiency frontier; one scalar benchmark would hide deployment tradeoffs.');
  if (selected?.bits > 4) findings.push('The strongest admitted candidate uses more than four bits; lower precision lost after quality and sustained-device gates.');
  if (selected?.bits < 4) findings.push('A sub-four-bit candidate survived the complete measured envelope; this is candidate-specific, not a general claim.');
  if (selected?.method === 'coreml-palettization') findings.push('Core ML palettization won this exact measured matrix.');
  if (selected?.method === 'mlx-grouped-quantization') findings.push('MLX grouped quantization won this exact measured matrix.');
  const body = { schema: ARCHIE_IPHONE_RESEARCH_RESULT_SCHEMA, plan_id: plan.id, plan_digest: plan.plan_digest, target: plan.target, evaluations: evaluations.map(({ candidate, admitted: ok, checks, blockers }) => ({ candidate_id: candidate.id, admitted: ok, checks, blockers })), admitted_candidate_ids: admitted.map(item => item.id).sort(), pareto_frontier_candidate_ids: frontier.map(item => item.id), selected_candidate: selected ? { id: selected.id, model_id: selected.model_id, revision: selected.revision, artifact_format: selected.artifact_format, method: selected.method, bits: selected.bits, group_size: selected.group_size, evidence: { evaluation_digest: selected.evaluation_digest, measurement_digest: selected.measurement_digest, device_fingerprint_digest: selected.device.fingerprint_digest } } : null, decision: selected ? 'selected-strongest-admitted-iphone-candidate' : 'no-iphone-candidate-admitted', novel_findings: findings, claim_boundary: selected ? 'Selection applies only to this exact revision, compression, iPhone floor, workloads, evaluation, and measurement.' : 'No model may be represented as iPhone-ready from this matrix.' };
  return Object.freeze({ ...body, result_digest: digest(body) });
}

function parse(argv) { const command = argv[0] || 'template'; const flags = new Map(); for (let i = 1; i < argv.length; i += 1) { const token = argv[i]; if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}.`); const [name, inline] = token.split('=', 2); if (inline !== undefined) flags.set(name, inline); else { const next = argv[++i]; if (!next || next.startsWith('--')) throw new Error(`${name} requires a value.`); flags.set(name, next); } } return { command, flags }; }
export async function main(argv = process.argv.slice(2)) { const { command, flags } = parse(argv); let result; if (command === 'template') result = createIPhoneResearchTemplate(); else if (command === 'evaluate') { const matrix = flags.get('--matrix'); if (!matrix) throw new Error('--matrix is required.'); result = evaluateIPhoneResearch(JSON.parse(await fs.readFile(path.resolve(matrix), 'utf8'))); } else throw new Error('Usage: template [--output file] | evaluate --matrix file [--output file]'); const output = `${JSON.stringify(result, null, 2)}\n`; if (flags.get('--output')) { const filename = path.resolve(flags.get('--output')); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, output); process.stdout.write(`${filename}\n`); } else process.stdout.write(output); if (command === 'evaluate' && !result.selected_candidate) process.exitCode = 1; }
const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) main().catch(error => { process.stderr.write(`archie-iphone-quantization-research: ${error?.stack || error}\n`); process.exitCode = 1; });
