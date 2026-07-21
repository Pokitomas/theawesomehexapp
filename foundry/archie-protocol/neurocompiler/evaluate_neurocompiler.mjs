#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MINIMUM_DURATION_MS = 60_000;
const MAX_MODEL_BYTES = 2_500_000;
const MAX_RUNTIME_BYTES = 80_000;

const REQUIRED_CATEGORIES = Object.freeze({
  v5_semantic_summary: 91,
  v5_semantic_checklist: 91,
  v5_semantic_message: 91,
  v5_semantic_decision: 91,
  v5_semantic_study: 91,
  v5_semantic_event: 91,
  v5_semantic_errands: 91,
  v5_semantic_objective: 91,
  v5_semantic_next_action: 91,
  v5_semantic_plan: 91,
  v5_ordered_compound_two: 240,
  v5_ordered_compound_three: 80,
  v5_before_order: 80,
  v5_negation: 120,
  v5_correction: 120,
  v5_abstention_ambiguous: 80,
  v5_underspecified: 60,
  v5_raw_source: 60,
  v5_authority_unsafe: 100,
  v5_authority_benign: 100,
  v5_attachment_missing: 50,
  v5_attachment_present: 50,
  v5_attachment_unusable: 50,
  v5_memory_missing: 50,
  v5_memory_present: 50,
  v5_memory_unusable: 50,
  v5_thread_missing: 50,
  v5_thread_present: 50,
  v5_thread_unusable: 50,
});

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const readJSON = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const fileDigest = filename => sha256(fs.readFileSync(filename));
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
const digest = value => sha256(Buffer.from(JSON.stringify(stable(value))));

function parse(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null) throw new Error(`invalid argument pair at ${index}`);
    flags.set(key, value);
  }
  const required = name => {
    const value = flags.get(name);
    if (!value) throw new Error(`${name} is required`);
    return path.resolve(value);
  };
  return {
    candidateDir: required('--candidate-dir'),
    pack: required('--pack'),
    manifest: required('--manifest'),
    development: required('--development'),
    typedBlind: required('--typed-blind'),
    output: required('--output'),
    pythonRuntime: required('--python-runtime'),
    candidateCommit: flags.get('--candidate-commit') || '',
    durationMs: Number(flags.get('--duration-ms') || MINIMUM_DURATION_MS),
  };
}

function expectedFor(row) {
  return row.expected || row.teacher?.final;
}

function exact(actual, expected) {
  return actual.route === expected.route
    && actual.authority === expected.authority
    && actual.context === expected.context
    && JSON.stringify(actual.outcomes) === JSON.stringify(expected.outcomes);
}

function evaluateRows(runtime, rows) {
  const categories = {};
  const errors = [];
  let correct = 0;
  for (const row of rows) {
    const actual = runtime.predict(row.request, {
      attachments: row.attachments || '',
      memory: row.memory || '',
      thread: row.thread || '',
    });
    const expected = expectedFor(row);
    const passed = exact(actual, expected);
    categories[row.category] ||= { examples: 0, correct: 0 };
    categories[row.category].examples += 1;
    categories[row.category].correct += Number(passed);
    correct += Number(passed);
    if (!passed && errors.length < 250) errors.push({ id: row.id, category: row.category, request: row.request, expected, actual });
  }
  for (const counts of Object.values(categories)) counts.accuracy = counts.correct / counts.examples;
  return { examples: rows.length, correct, accuracy: correct / rows.length, categories, errors };
}

function evaluateLegacy(runtime, suites) {
  const output = {};
  for (const [name, rows] of Object.entries(suites)) {
    const errors = [];
    for (const row of rows) {
      const actual = runtime.predict(row.request, {});
      if (actual.route !== row.expected) errors.push({ id: row.id, request: row.request, expected: row.expected, actual });
    }
    output[name] = { examples: rows.length, correct: rows.length - errors.length, accuracy: (rows.length - errors.length) / rows.length, errors };
  }
  return output;
}

function runParity({ runtime, modelPath, pythonRuntime, rows }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'archie-neurocompiler-parity-'));
  const inputPath = path.join(temporary, 'input.json');
  const outputPath = path.join(temporary, 'python-output.json');
  fs.writeFileSync(inputPath, JSON.stringify(rows));
  const execution = spawnSync('python3', [pythonRuntime, '--model', modelPath, '--input', inputPath, '--output', outputPath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (execution.status !== 0) throw new Error(`python parity runtime failed: ${execution.stderr || execution.stdout}`);
  const python = readJSON(outputPath);
  const errors = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const javascript = runtime.predict(row.request, { attachments: row.attachments || '', memory: row.memory || '', thread: row.thread || '' });
    if (!exact(javascript, python[index])) errors.push({ index, id: row.id, javascript, python: python[index] });
  }
  fs.rmSync(temporary, { recursive: true, force: true });
  return { examples: rows.length, correct: rows.length - errors.length, accuracy: (rows.length - errors.length) / rows.length, errors: errors.slice(0, 100) };
}

function percentile(values, p) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p))] || 0;
}

function resourceBench(runtime, rows, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < MINIMUM_DURATION_MS) throw new Error(`duration must be at least ${MINIMUM_DURATION_MS}`);
  const started = process.hrtime.bigint();
  const latency = [];
  const samples = [];
  let predictions = 0;
  let totalLatencyMs = 0;
  let index = 0;
  let nextSample = 5_000;
  while (true) {
    const row = rows[index++ % rows.length];
    const before = process.hrtime.bigint();
    runtime.predict(row.request, { attachments: row.attachments || '', memory: row.memory || '', thread: row.thread || '' });
    const after = process.hrtime.bigint();
    const latencyMs = Number(after - before) / 1e6;
    totalLatencyMs += latencyMs;
    predictions += 1;
    if (predictions % 50 === 0 && latency.length < 50_000) latency.push(latencyMs);
    const elapsed = Number(after - started) / 1e6;
    if (elapsed >= nextSample) {
      samples.push({ elapsed_ms: elapsed, rss_bytes: process.memoryUsage().rss, heap_used_bytes: process.memoryUsage().heapUsed });
      nextSample += 5_000;
    }
    if (elapsed >= durationMs) break;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    sustained_duration_ms: elapsedMs,
    sample_count: samples.length,
    predictions,
    predictions_per_second: predictions / (elapsedMs / 1000),
    mean_latency_ms: totalLatencyMs / predictions,
    p95_latency_ms: percentile(latency, 0.95),
    peak_rss_bytes: Math.max(process.memoryUsage().rss, ...samples.map(sample => sample.rss_bytes)),
    samples,
  };
}

async function main() {
  const args = parse(process.argv.slice(2));
  const modelPath = path.join(args.candidateDir, 'neurocompiler-model.json');
  const jsRuntimePath = path.join(args.candidateDir, 'neurocompiler_runtime.mjs');
  const pyRuntimePath = path.join(args.candidateDir, 'neurocompiler_runtime.py');
  const trainingPath = path.join(args.candidateDir, 'training-receipt.json');
  const identities = {
    model_sha256: fileDigest(modelPath),
    javascript_runtime_sha256: fileDigest(jsRuntimePath),
    python_runtime_sha256: fileDigest(pyRuntimePath),
    training_receipt_sha256: fileDigest(trainingPath),
  };
  const model = readJSON(modelPath);
  const training = readJSON(trainingPath);
  const pack = readJSON(args.pack);
  const manifest = readJSON(args.manifest);
  const development = readJSON(args.development);
  const typedBlind = readJSON(args.typedBlind);
  const module = await import(`${pathToFileURL(jsRuntimePath).href}?sha=${identities.javascript_runtime_sha256}`);
  const runtime = module.createNeurocompiler(model);

  process.stderr.write('phase sealed evaluation start\n');
  const sealed = evaluateRows(runtime, pack);
  process.stderr.write('phase opened replay start\n');
  const openedRows = [...development.pack, ...typedBlind];
  const opened = evaluateRows(runtime, openedRows);
  const legacy = evaluateLegacy(runtime, development.legacy);
  process.stderr.write('phase parity start\n');
  const legacyParityRows = Object.values(development.legacy).flat().map((row, index) => ({ ...row, id: row.id || `legacy-${index}`, category: 'legacy', expected: { route: row.expected, authority: 'allow', context: 'ready', outcomes: [row.expected] } }));
  const parityRows = [...pack.slice(0, 400), ...openedRows.slice(0, 400), ...legacyParityRows];
  const parity = runParity({ runtime, modelPath, pythonRuntime: pyRuntimePath, rows: parityRows });
  process.stderr.write('phase resources start\n');
  const resources = resourceBench(runtime, pack, args.durationMs);
  process.stderr.write('phase resources done\n');

  const checks = [];
  const add = (id, passed, detail = null) => checks.push({ id, passed: Boolean(passed), detail });
  add('candidate-commit-present', Boolean(args.candidateCommit));
  add('model-schema', model.schema === 'archie-segment-neurocompiler-int8/v1', model.schema);
  add('model-digest-bound', training.artifact?.sha256 === identities.model_sha256, { claimed: training.artifact?.sha256, actual: identities.model_sha256 });
  add('candidate-commit-bound-training', training.candidate_commit === args.candidateCommit, { claimed: training.candidate_commit, actual: args.candidateCommit });
  add('five-fold-cross-validation', training.cross_validation?.length === 5, training.cross_validation?.map(fold => ({ fold: fold.fold, accuracy: fold.accuracy })));
  for (const fold of training.cross_validation || []) add(`cross-validation-fold-${fold.fold}`, fold.accuracy >= 0.995, { correct: fold.correct, examples: fold.examples, accuracy: fold.accuracy });
  add('training-opened-replay-perfect', training.opened_training_evaluation?.accuracy === 1, training.opened_training_evaluation && { correct: training.opened_training_evaluation.correct, examples: training.opened_training_evaluation.examples });
  add('manifest-schema', manifest.schema === 'archie-neurocompiler-sealed-pack/v5', manifest.schema);
  add('sealed-pack-digest', manifest.sha256 === fileDigest(args.pack), { claimed: manifest.sha256, actual: fileDigest(args.pack) });
  add('sealed-row-count', manifest.rows === 2400 && pack.length === 2400, { claimed: manifest.rows, actual: pack.length });
  add('manifest-candidate-commit', manifest.candidate_commit === args.candidateCommit, { claimed: manifest.candidate_commit, actual: args.candidateCommit });
  add('manifest-model-bound', manifest.model_sha256 === identities.model_sha256, { claimed: manifest.model_sha256, actual: identities.model_sha256 });
  add('manifest-runtime-bound', manifest.runtime_sha256 === identities.javascript_runtime_sha256, { claimed: manifest.runtime_sha256, actual: identities.javascript_runtime_sha256 });
  add('post-candidate-seal', manifest.generated_after_candidate_fixed === true);
  add('seal-access-contract', manifest.access_contract === 'trainer fixes and uploads candidate before seal generation; trainer never receives sealed pack; independent judge opens both artifacts');
  add('sealed-perfect', sealed.accuracy === 1, { correct: sealed.correct, examples: sealed.examples });
  for (const [name, minimum] of Object.entries(REQUIRED_CATEGORIES)) {
    const category = sealed.categories[name];
    add(`category:${name}:coverage`, Number(category?.examples || 0) >= minimum, { minimum, observed: category?.examples || 0 });
    add(`category:${name}:perfect`, category?.accuracy === 1, { observed: category?.accuracy ?? null });
  }
  add('opened-hard-negative-replay-perfect', opened.accuracy === 1, { correct: opened.correct, examples: opened.examples });
  for (const [name, suite] of Object.entries(legacy)) add(`legacy:${name}:exact`, suite.accuracy === 1, { correct: suite.correct, examples: suite.examples });
  add('python-javascript-parity', parity.accuracy === 1, { correct: parity.correct, examples: parity.examples });
  add('model-size', fs.statSync(modelPath).size <= MAX_MODEL_BYTES, { bytes: fs.statSync(modelPath).size, maximum: MAX_MODEL_BYTES });
  add('javascript-runtime-size', fs.statSync(jsRuntimePath).size <= MAX_RUNTIME_BYTES, { bytes: fs.statSync(jsRuntimePath).size, maximum: MAX_RUNTIME_BYTES });
  add('resource-duration', resources.sustained_duration_ms >= MINIMUM_DURATION_MS, resources.sustained_duration_ms);
  add('resource-samples', resources.sample_count >= 12, resources.sample_count);
  add('resource-finite', ['predictions_per_second', 'mean_latency_ms', 'p95_latency_ms', 'peak_rss_bytes'].every(key => Number.isFinite(resources[key]) && resources[key] >= 0));

  const blockers = checks.filter(check => !check.passed).map(check => check.id);
  const admitted = blockers.length === 0;
  const body = {
    schema: 'archie-generalized-neurocompiler-admission/v1',
    candidate_id: 'archie-segment-neurocompiler-v1-20260721',
    decision: admitted ? 'admitted-generalized-register-neurocompiler' : 'rejected-generalized-register-neurocompiler',
    admitted_for: admitted ? 'local generalized typed register routing and context binding' : null,
    candidate_commit: args.candidateCommit,
    identities,
    architecture: model.architecture,
    quantization: 'per-output-row symmetric int8',
    sealed_evaluation: sealed,
    opened_hard_negative_replay: opened,
    legacy_retention: legacy,
    python_javascript_parity: parity,
    resources,
    packaged_model_bytes: fs.statSync(modelPath).size,
    javascript_runtime_bytes: fs.statSync(jsRuntimePath).size,
    checks,
    blockers,
    claim_boundary: 'Admission covers the exact local segment-isolated typed register neurocompiler, including route semantics, ordered composition, negation, correction, authority denial, abstention, and attachment/memory/thread context sufficiency. It is not AGI, free-form generation, execution authorization, provider-neutral maximal Archie admission, embodiment admission, or launch approval.',
  };
  const report = { ...body, report_digest: digest(body) };
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ admitted, decision: report.decision, blockers, sealed: `${sealed.correct}/${sealed.examples}`, opened: `${opened.correct}/${opened.examples}`, legacy: Object.fromEntries(Object.entries(legacy).map(([name, suite]) => [name, `${suite.correct}/${suite.examples}`])), parity: `${parity.correct}/${parity.examples}`, model_bytes: report.packaged_model_bytes, resources: { mean_latency_ms: resources.mean_latency_ms, p95_latency_ms: resources.p95_latency_ms, predictions_per_second: resources.predictions_per_second, peak_rss_bytes: resources.peak_rss_bytes }, report_digest: report.report_digest }, null, 2)}\n`);
  if (!admitted) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
