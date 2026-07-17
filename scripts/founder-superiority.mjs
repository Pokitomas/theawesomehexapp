#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const HEX_256 = /^[a-f0-9]{64}$/;
const SCORE_FIELDS = [
  'objective_test_pass_rate',
  'independent_quality_score',
  'security_score',
  'accessibility_score',
  'recovery_score',
  'reproducibility_score'
];
const LOWER_IS_BETTER_FIELDS = ['human_minutes', 'interventions', 'developer_surface_exposures'];

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finiteNumber(value, name) {
  assert(Number.isFinite(value), `${name} must be finite`);
  return value;
}

function boundedScore(value, name) {
  finiteNumber(value, name);
  assert(value >= 0 && value <= 1, `${name} must be between 0 and 1`);
  return value;
}

function nonNegative(value, name) {
  finiteNumber(value, name);
  assert(value >= 0, `${name} must be non-negative`);
  return value;
}

export function validateProtocol(protocol) {
  assert(protocol?.schema === 'founder-superiority-protocol/v1', 'Unsupported superiority protocol');
  assert(protocol.systems?.candidate && protocol.systems?.baseline, 'Protocol systems are required');
  assert(protocol.systems.candidate !== protocol.systems.baseline, 'Candidate and baseline must differ');
  assert(Array.isArray(protocol.required_task_families) && protocol.required_task_families.length >= 3, 'At least three task families are required');
  assert(new Set(protocol.required_task_families).size === protocol.required_task_families.length, 'Task families must be unique');
  const weights = Object.values(protocol.primary_composite || {});
  assert(weights.length === SCORE_FIELDS.length, 'Primary composite must weight every score field');
  assert(Math.abs(weights.reduce((sum, value) => sum + finiteNumber(value, 'composite weight'), 0) - 1) < 1e-9, 'Primary composite weights must total 1');
  for (const field of SCORE_FIELDS) assert(Number.isFinite(protocol.primary_composite[field]), `Missing composite weight for ${field}`);
  assert(protocol.study.minimum_participants >= 2, 'minimum_participants must be at least 2');
  assert(protocol.study.minimum_tasks >= protocol.required_task_families.length, 'minimum_tasks must cover required task families');
  assert(protocol.study.minimum_matched_pairs >= protocol.study.minimum_participants * protocol.study.minimum_tasks, 'minimum_matched_pairs is too small');
  assert(protocol.study.required_independent_evaluator_organizations >= 2, 'At least two independent evaluator organizations are required');
  return true;
}

function validateRun(run, protocol, index) {
  const prefix = `runs[${index}]`;
  assert(typeof run.participant_id === 'string' && run.participant_id.trim(), `${prefix}.participant_id is required`);
  assert(typeof run.task_id === 'string' && run.task_id.trim(), `${prefix}.task_id is required`);
  assert(protocol.required_task_families.includes(run.task_family), `${prefix}.task_family is not registered`);
  assert([protocol.systems.candidate, protocol.systems.baseline].includes(run.system), `${prefix}.system is invalid`);
  assert(typeof run.completed === 'boolean', `${prefix}.completed must be boolean`);
  assert(typeof run.published_url_verified === 'boolean', `${prefix}.published_url_verified must be boolean`);
  assert(run.metrics && typeof run.metrics === 'object', `${prefix}.metrics are required`);
  for (const field of SCORE_FIELDS) boundedScore(run.metrics[field], `${prefix}.metrics.${field}`);
  for (const field of LOWER_IS_BETTER_FIELDS) nonNegative(run.metrics[field], `${prefix}.metrics.${field}`);
  for (const field of ['artifact_digest', 'evaluator_digest', 'trace_digest']) {
    assert(HEX_256.test(run[field] || ''), `${prefix}.${field} must be a lowercase SHA-256 digest`);
  }
  return run;
}

export function validateStudy(study, protocol) {
  validateProtocol(protocol);
  assert(study?.schema === 'founder-superiority-study/v1', 'Unsupported superiority study');
  assert(study.protocol_digest === digest(protocol), 'Study protocol digest does not match the exact protocol');
  assert(typeof study.study_id === 'string' && study.study_id.trim(), 'study_id is required');
  assert(!Number.isNaN(Date.parse(study.performed_at)), 'performed_at must be an ISO date');
  assert(HEX_256.test(study.raw_evidence_archive_digest || ''), 'raw_evidence_archive_digest must be a lowercase SHA-256 digest');
  assert(HEX_256.test(study.preregistration_receipt_digest || ''), 'preregistration_receipt_digest must be a lowercase SHA-256 digest');
  const organizations = study.independent_evaluator_organizations;
  assert(Array.isArray(organizations), 'independent_evaluator_organizations must be an array');
  assert(new Set(organizations.map(value => String(value).trim()).filter(Boolean)).size >= protocol.study.required_independent_evaluator_organizations, 'Not enough independent evaluator organizations');
  assert(Array.isArray(study.runs) && study.runs.length > 0, 'Study runs are required');
  study.runs.forEach((run, index) => validateRun(run, protocol, index));
  return true;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function lowerConfidenceBound95(values) {
  if (values.length < 2) return Number.NEGATIVE_INFINITY;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
  return average - (1.96 * Math.sqrt(variance / values.length));
}

function composite(metrics, weights) {
  return SCORE_FIELDS.reduce((sum, field) => sum + metrics[field] * weights[field], 0);
}

function summarize(runs, protocol) {
  const metrics = Object.fromEntries([...SCORE_FIELDS, ...LOWER_IS_BETTER_FIELDS].map(field => [field, mean(runs.map(run => run.metrics[field]))]));
  return {
    runs: runs.length,
    completion_rate: mean(runs.map(run => Number(run.completed && run.published_url_verified))),
    primary_composite: mean(runs.map(run => composite(run.metrics, protocol.primary_composite))),
    ...metrics
  };
}

export function evaluateStudy(protocol, study) {
  validateStudy(study, protocol);
  const pairs = new Map();
  const participants = new Set();
  const tasks = new Set();
  const taskFamilies = new Set();
  for (const run of study.runs) {
    participants.add(run.participant_id);
    tasks.add(run.task_id);
    taskFamilies.add(run.task_family);
    const key = `${run.participant_id}\u0000${run.task_id}`;
    const pair = pairs.get(key) || {};
    assert(!pair[run.system], `Duplicate ${run.system} run for ${run.participant_id}/${run.task_id}`);
    pair[run.system] = run;
    pairs.set(key, pair);
  }

  const matched = [];
  for (const [key, pair] of pairs) {
    assert(pair[protocol.systems.candidate] && pair[protocol.systems.baseline], `Unmatched comparison pair: ${key.replace('\u0000', '/')}`);
    assert(pair[protocol.systems.candidate].task_family === pair[protocol.systems.baseline].task_family, `Task family mismatch in pair ${key.replace('\u0000', '/')}`);
    matched.push({ candidate: pair[protocol.systems.candidate], baseline: pair[protocol.systems.baseline] });
  }

  const structuralGates = {
    minimum_participants: participants.size >= protocol.study.minimum_participants,
    minimum_tasks: tasks.size >= protocol.study.minimum_tasks,
    minimum_matched_pairs: matched.length >= protocol.study.minimum_matched_pairs,
    task_family_coverage: protocol.required_task_families.every(family => taskFamilies.has(family))
  };

  const candidateRuns = matched.map(pair => pair.candidate);
  const baselineRuns = matched.map(pair => pair.baseline);
  const candidate = summarize(candidateRuns, protocol);
  const baseline = summarize(baselineRuns, protocol);
  const primaryDeltas = matched.map(pair => composite(pair.candidate.metrics, protocol.primary_composite) - composite(pair.baseline.metrics, protocol.primary_composite));
  const humanMinutesRatio = baseline.human_minutes === 0
    ? (candidate.human_minutes === 0 ? 1 : Number.POSITIVE_INFINITY)
    : candidate.human_minutes / baseline.human_minutes;

  const deltas = {
    completion_rate: candidate.completion_rate - baseline.completion_rate,
    primary_composite: candidate.primary_composite - baseline.primary_composite,
    primary_delta_lower_confidence_bound_95: lowerConfidenceBound95(primaryDeltas),
    human_minutes_ratio: humanMinutesRatio,
    recovery_score: candidate.recovery_score - baseline.recovery_score,
    security_score: candidate.security_score - baseline.security_score,
    accessibility_score: candidate.accessibility_score - baseline.accessibility_score,
    reproducibility_score: candidate.reproducibility_score - baseline.reproducibility_score
  };

  const gates = {
    ...structuralGates,
    candidate_completion_rate: candidate.completion_rate >= protocol.gates.minimum_candidate_completion_rate,
    completion_delta: deltas.completion_rate >= protocol.gates.minimum_completion_delta,
    primary_composite_delta: deltas.primary_composite >= protocol.gates.minimum_primary_composite_delta,
    primary_delta_lower_confidence_bound: deltas.primary_delta_lower_confidence_bound_95 >= protocol.gates.minimum_primary_delta_lower_confidence_bound,
    human_minutes_ratio: deltas.human_minutes_ratio <= protocol.gates.maximum_human_minutes_ratio,
    zero_developer_surface_exposure: candidate.developer_surface_exposures <= protocol.gates.maximum_candidate_developer_surface_exposures_per_run,
    recovery_delta: deltas.recovery_score >= protocol.gates.minimum_recovery_delta,
    security_non_regression: deltas.security_score >= -protocol.gates.maximum_security_regression,
    accessibility_non_regression: deltas.accessibility_score >= -protocol.gates.maximum_accessibility_regression,
    reproducibility_non_regression: deltas.reproducibility_score >= -protocol.gates.maximum_reproducibility_regression
  };

  const thresholdsMet = Object.values(gates).every(Boolean);
  const result = {
    schema: 'founder-superiority-evaluation/v1',
    claim: protocol.claim,
    protocol_digest: digest(protocol),
    study_id: study.study_id,
    evidence_archive_digest: study.raw_evidence_archive_digest,
    matched_pairs: matched.length,
    participant_count: participants.size,
    task_count: tasks.size,
    candidate,
    baseline,
    deltas,
    gates,
    thresholds_met: thresholdsMet,
    status: thresholdsMet ? 'superiority-thresholds-met-awaiting-independent-admission' : 'superiority-not-proven'
  };
  return { ...result, evaluation_digest: digest(result) };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function parseArgs(argv) {
  const args = { command: argv[2] || 'status' };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    assert(token.startsWith('--'), `Unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    assert(value && !value.startsWith('--'), `Missing value for ${token}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const protocolPath = args.protocol || 'benchmarks/founder-vibe-superiority.v1.json';
  const protocol = readJson(protocolPath);
  validateProtocol(protocol);
  if (args.command === 'status') {
    process.stdout.write(`${JSON.stringify({ schema: protocol.schema, claim: protocol.claim, status: protocol.status, protocol_digest: digest(protocol) }, null, 2)}\n`);
    return;
  }
  assert(args.command === 'evaluate', `Unknown command: ${args.command}`);
  assert(args.study, 'evaluate requires --study <path>');
  const result = evaluateStudy(protocol, readJson(args.study));
  if (args.out) fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.thresholds_met) process.exitCode = 2;
}

const invokedAsMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
