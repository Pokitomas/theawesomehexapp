#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MODEL_SHA256 = '7a7f4619a9bb300ff5e690970663373d974fb0584a3b6b975cb1858f223a18b0';
const MODEL_MODULE_SHA256 = '828980422423c40a6a858e0f64217db03cc326a5530d24dac5fbff5b8aeeccd4';
const CONTROLLER_V3_SHA256 = '98c81fd2a83b70686155027d830372ca35852918d81b27b75e411ef423fd1e71';
const CONTROLLER_V4_SHA256 = '74ba2961c1baf7455837cc47925c3102f2500c5f90d8b0fe52e7a21d2a4e5b7e';
const TRAINING_RECEIPT_SHA256 = '98aab633c46765fc8e046090478a09bb347c0d58cec73c4ac95cec03919d948a';
const MINIMUM_DURATION_MS = 60_000;
const MAX_MODEL_BYTES = 2_500_000;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
const digest = value => sha256(Buffer.from(JSON.stringify(stable(value))));
const readJSON = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const fileDigest = filename => sha256(fs.readFileSync(filename));

function parse(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
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
    output: required('--output'),
    pythonParity: required('--python-parity'),
    candidateCommit: flags.get('--candidate-commit') || '',
    durationMs: Number(flags.get('--duration-ms') || MINIMUM_DURATION_MS),
  };
}

function exactRuntimeMatch(actual, expected) {
  return actual.route === expected.route
    && actual.authority === expected.authority
    && actual.context === expected.context
    && JSON.stringify(actual.outcomes) === JSON.stringify(expected.outcomes);
}

function evaluateRuntime(controller, rows) {
  const errors = [];
  const categories = {};
  for (const row of rows) {
    const actual = controller.predict(row.request, {
      attachments: row.attachments || '',
      memory: row.memory || '',
      thread: row.thread || '',
    });
    const correct = exactRuntimeMatch(actual, row.expected);
    categories[row.category] ||= { examples: 0, correct: 0 };
    categories[row.category].examples += 1;
    if (correct) categories[row.category].correct += 1;
    else errors.push({ id: row.id, category: row.category, request: row.request, expected: row.expected, actual });
  }
  for (const value of Object.values(categories)) value.accuracy = value.correct / value.examples;
  return { examples: rows.length, correct: rows.length - errors.length, accuracy: (rows.length - errors.length) / rows.length, categories, errors };
}

function evaluateLegacy(controller, legacy) {
  const suites = {};
  for (const [name, rows] of Object.entries(legacy)) {
    const errors = [];
    for (const row of rows) {
      const actual = controller.predict(row.request, {});
      if (actual.route !== row.expected) errors.push({ id: row.id, request: row.request, expected: row.expected, actual });
    }
    suites[name] = { examples: rows.length, correct: rows.length - errors.length, accuracy: (rows.length - errors.length) / rows.length, errors };
  }
  return suites;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p))];
}

function resourceBench(controller, rows, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < MINIMUM_DURATION_MS) throw new Error(`duration must be at least ${MINIMUM_DURATION_MS} ms`);
  const start = process.hrtime.bigint();
  const samples = [];
  const latencySamples = [];
  let totalLatencyMs = 0;
  let predictions = 0;
  let index = 0;
  let nextSample = 5_000;
  while (true) {
    const row = rows[index++ % rows.length];
    const before = process.hrtime.bigint();
    controller.predict(row.request, { attachments: row.attachments || '', memory: row.memory || '', thread: row.thread || '' });
    const after = process.hrtime.bigint();
    const latencyMs = Number(after - before) / 1e6;
    totalLatencyMs += latencyMs;
    predictions += 1;
    if (predictions % 100 === 0 && latencySamples.length < 50_000) latencySamples.push(latencyMs);
    const elapsed = Number(after - start) / 1e6;
    if (elapsed >= nextSample) {
      samples.push({ elapsed_ms: elapsed, rss_bytes: process.memoryUsage().rss, heap_used_bytes: process.memoryUsage().heapUsed });
      nextSample += 5_000;
    }
    if (elapsed >= durationMs) break;
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  if (!latencySamples.length) latencySamples.push(totalLatencyMs / Math.max(1, predictions));
  return {
    sustained_duration_ms: elapsedMs,
    sample_count: samples.length,
    predictions,
    predictions_per_second: predictions / (elapsedMs / 1000),
    mean_latency_ms: totalLatencyMs / predictions,
    p95_latency_ms: percentile(latencySamples, 0.95),
    peak_rss_bytes: Math.max(...samples.map(sample => sample.rss_bytes), process.memoryUsage().rss),
    samples,
  };
}

function runParity({ student, modelPath, pythonParity, requests }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'archie-register-v4-parity-'));
  const input = path.join(temp, 'requests.json');
  const output = path.join(temp, 'python.json');
  fs.writeFileSync(input, JSON.stringify(requests));
  const execution = spawnSync('python3', [pythonParity, '--model', modelPath, '--input', input, '--output', output], { encoding: 'utf8' });
  if (execution.status !== 0) throw new Error(`python parity failed: ${execution.stderr || execution.stdout}`);
  const python = readJSON(output);
  const javascript = requests.map(request => student.infer(request));
  const errors = [];
  let maximumConfidenceDelta = 0;
  for (let index = 0; index < requests.length; index += 1) {
    const js = javascript[index];
    const py = python[index];
    const delta = Math.abs(Number(js.confidence) - Number(py.confidence));
    maximumConfidenceDelta = Math.max(maximumConfidenceDelta, delta);
    if (js.route !== py.route || delta > 1e-6) errors.push({ index, request: requests[index], javascript: { route: js.route, confidence: js.confidence }, python: { route: py.route, confidence: py.confidence }, confidence_delta: delta });
  }
  fs.rmSync(temp, { recursive: true, force: true });
  return { examples: requests.length, correct: requests.length - errors.length, accuracy: (requests.length - errors.length) / requests.length, maximum_confidence_delta: maximumConfidenceDelta, errors };
}

const requiredCategoryMinimums = Object.freeze({
  semantic_summary: 60,
  semantic_checklist: 60,
  semantic_message: 60,
  semantic_decision: 60,
  semantic_study: 60,
  semantic_event: 60,
  semantic_errands: 60,
  semantic_objective: 60,
  semantic_next_action: 60,
  semantic_plan: 60,
  ordered_compound: 220,
  negation: 90,
  correction: 90,
  abstention_ambiguous: 80,
  authority_unsafe: 70,
  authority_benign: 70,
  raw_source_abstention: 40,
  attachment_missing: 36,
  attachment_present: 36,
  attachment_unusable: 36,
  memory_missing: 36,
  memory_present: 36,
  memory_unusable: 36,
  thread_missing: 36,
  thread_present: 36,
  thread_unusable: 36,
});

async function main() {
  const args = parse(process.argv.slice(2));
  const modelPath = path.join(args.candidateDir, 'register-student-model.json');
  const modelModulePath = path.join(args.candidateDir, 'register-student-model.mjs');
  const controllerV3Path = path.join(args.candidateDir, 'register-student-core.mjs');
  const controllerV4Path = path.join(args.candidateDir, 'register-student-core-v4.mjs');
  const trainingPath = path.join(args.candidateDir, 'training-receipt.json');
  const developmentPath = path.join(args.candidateDir, 'development-input.json');
  const candidateManifestPath = path.join(args.candidateDir, 'candidate-v3-manifest.json');

  const identities = {
    model_sha256: fileDigest(modelPath),
    model_module_sha256: fileDigest(modelModulePath),
    controller_v3_sha256: fileDigest(controllerV3Path),
    controller_v4_sha256: fileDigest(controllerV4Path),
    training_receipt_sha256: fileDigest(trainingPath),
  };
  const model = readJSON(modelPath);
  const training = readJSON(trainingPath);
  const development = readJSON(developmentPath);
  const candidateManifest = readJSON(candidateManifestPath);
  const pack = readJSON(args.pack);
  const manifest = readJSON(args.manifest);
  const packBytes = fs.readFileSync(args.pack);

  const imported = await import(`${pathToFileURL(controllerV4Path).href}?sha=${identities.controller_v4_sha256}`);
  const controller = imported.createRegisterStudentController(model);
  const student = imported.createRegisterStudent(model);

  process.stderr.write('phase runtime start\n');
  const runtime = evaluateRuntime(controller, pack);
  process.stderr.write('phase runtime done\n');
  process.stderr.write('phase legacy start\n');
  const legacy = evaluateLegacy(controller, development.legacy);
  process.stderr.write('phase legacy done\n');
  const probes = [
    ['As an operator handoff, render acceptance for college financial aid document backlog as binary controls.', { route: 'checklist', outcomes: ['checklist'] }],
    ['As an operator handoff, state the durable success condition of college financial aid document backlog Once that is complete, keep unsupported assumptions out and render acceptance for county foster care records transfer as binary controls.', { route: 'compound', outcomes: ['objective', 'checklist'] }],
    ['make a plan', { route: 'clarify', outcomes: [] }],
    ['Create a three-line recap and a sendable client update from it.', { route: 'compound', outcomes: ['summary', 'message'] }],
  ].map(([request, expected]) => {
    const actual = controller.predict(request, {});
    return { request, expected, actual, passed: actual.route === expected.route && JSON.stringify(actual.outcomes) === JSON.stringify(expected.outcomes) };
  });

  const parityRequests = [...pack.map(row => row.request), ...Object.values(development.legacy).flat().map(row => row.request)];
  process.stderr.write('phase parity start\n');
  const parity = runParity({ student, modelPath, pythonParity: args.pythonParity, requests: parityRequests });
  process.stderr.write('phase parity done\n');
  process.stderr.write('phase resources start\n');
  const resources = resourceBench(controller, pack, args.durationMs);
  process.stderr.write('phase resources done\n');

  const checks = [];
  const add = (id, passed, detail = null) => checks.push({ id, passed: Boolean(passed), detail });
  add('model-digest', identities.model_sha256 === MODEL_SHA256, identities.model_sha256);
  add('model-module-digest', identities.model_module_sha256 === MODEL_MODULE_SHA256, identities.model_module_sha256);
  add('v3-controller-digest', identities.controller_v3_sha256 === CONTROLLER_V3_SHA256, identities.controller_v3_sha256);
  add('v4-controller-digest', identities.controller_v4_sha256 === CONTROLLER_V4_SHA256, identities.controller_v4_sha256);
  add('training-receipt-digest', identities.training_receipt_sha256 === TRAINING_RECEIPT_SHA256, identities.training_receipt_sha256);
  add('trained-artifact-bound', training.artifact?.sha256 === MODEL_SHA256 && candidateManifest.learned_weight_source?.model_json_sha256 === MODEL_SHA256);
  add('weights-unchanged', candidateManifest.controller?.weights_changed === false);
  add('sealed-manifest-schema', manifest.schema === 'archie-register-sealed-admission-pack/v4');
  add('sealed-pack-digest', manifest.sha256 === sha256(packBytes), { claimed: manifest.sha256, actual: sha256(packBytes) });
  add('sealed-pack-row-count', manifest.rows === pack.length && pack.length === 1800, { claimed: manifest.rows, actual: pack.length });
  add('candidate-commit-bound', Boolean(args.candidateCommit) && manifest.candidate_commit === args.candidateCommit, { claimed: manifest.candidate_commit, actual: args.candidateCommit });
  add('candidate-controller-bound', manifest.controller_sha256 === CONTROLLER_V4_SHA256);
  add('candidate-model-bound', manifest.model_sha256 === MODEL_SHA256);
  add('generated-after-candidate-fixed', manifest.generated_after_candidate_fixed === true);
  add('judge-only-seal-contract', manifest.access_contract === 'seal job only; candidate commit fixed before generation; judge job opens artifact after upload');
  add('hidden-runtime-perfect', runtime.accuracy === 1, { correct: runtime.correct, examples: runtime.examples });
  for (const [category, minimum] of Object.entries(requiredCategoryMinimums)) {
    const observed = runtime.categories[category];
    add(`category:${category}:coverage`, Number(observed?.examples || 0) >= minimum, { minimum, observed: observed?.examples || 0 });
    add(`category:${category}:perfect`, observed?.accuracy === 1, { observed: observed?.accuracy ?? null });
  }
  for (const [name, suite] of Object.entries(legacy)) add(`legacy:${name}:exact`, suite.accuracy === 1, { correct: suite.correct, examples: suite.examples });
  add('repair-probes', probes.every(probe => probe.passed), probes.filter(probe => !probe.passed));
  add('python-javascript-parity', parity.accuracy === 1 && parity.examples === 2406 && parity.maximum_confidence_delta <= 1e-6, { correct: parity.correct, examples: parity.examples, maximum_confidence_delta: parity.maximumConfidenceDelta });
  add('model-size', fs.statSync(modelPath).size <= MAX_MODEL_BYTES, { bytes: fs.statSync(modelPath).size, maximum: MAX_MODEL_BYTES });
  add('resource-duration', resources.sustained_duration_ms >= MINIMUM_DURATION_MS, { observed: resources.sustained_duration_ms, minimum: MINIMUM_DURATION_MS });
  add('resource-samples', resources.sample_count >= 12, { observed: resources.sample_count, minimum: 12 });
  add('resource-finite', ['predictions_per_second', 'mean_latency_ms', 'p95_latency_ms', 'peak_rss_bytes'].every(key => Number.isFinite(resources[key]) && resources[key] >= 0));

  const blockers = checks.filter(check => !check.passed).map(check => check.id);
  const admitted = blockers.length === 0;
  const body = {
    schema: 'archie-register-router-admission/v2',
    candidate_id: 'archie-register-student-v4-compositional-20260721',
    decision: admitted ? 'admitted-register-router' : 'rejected-register-router',
    admitted_for: admitted ? 'local register routing only' : null,
    candidate_commit: args.candidateCommit,
    identities,
    immutable_learned_weights: true,
    hidden_evaluation: runtime,
    legacy_retention: legacy,
    repair_probes: probes,
    python_javascript_raw_parity: parity,
    resources,
    packaged_model_bytes: fs.statSync(modelPath).size,
    checks,
    blockers,
    claim_boundary: 'This admission covers the exact local register route model, V4 controller, context sufficiency, authority denial, abstention, negation, correction, and ordered composition behavior only. It is not provider-neutral maximal Archie student admission, embodiment admission, execution authorization, or launch admission.',
  };
  const report = { ...body, report_digest: digest(body) };
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ admitted, decision: report.decision, blockers, hidden: `${runtime.correct}/${runtime.examples}`, legacy: Object.fromEntries(Object.entries(legacy).map(([name, value]) => [name, `${value.correct}/${value.examples}`])), parity: `${parity.correct}/${parity.examples}`, resources: { mean_latency_ms: resources.mean_latency_ms, p95_latency_ms: resources.p95_latency_ms, peak_rss_bytes: resources.peak_rss_bytes }, report_digest: report.report_digest }, null, 2)}\n`);
  if (!admitted) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
