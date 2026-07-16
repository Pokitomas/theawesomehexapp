#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
  digest,
  validateLaunchTarget
} from './archie-launch-contract.mjs';

export const ARCHIE_STUDENT_ADMISSION_CANDIDATE_SCHEMA = 'archie-student-admission-candidate/v1';
export const ARCHIE_STUDENT_ADMISSION_SCHEMA = 'archie-student-admission/v1';
export const ARCHIE_STUDENT_EVALUATION_SCHEMA = 'archie-student-independent-evaluation/v1';
export const ARCHIE_STUDENT_AUTHORITY_SCHEMA = 'archie-student-authority-report/v1';
export const ARCHIE_STUDENT_REPRODUCTION_SCHEMA = 'archie-student-clean-reproduction/v1';
export const ARCHIE_STUDENT_RESOURCE_SCHEMA = 'archie-student-resource-report/v1';

const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;

const clean = (value, field, limit = 10_000) => {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!text) throw new Error(`${field} is required.`);
  if (text.length > limit) throw new Error(`${field} exceeds ${limit} characters.`);
  return text;
};

const exactDigest = (value, field) => {
  const text = clean(value, field, 64).toLowerCase();
  if (!HEX_256.test(text)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return text;
};

const portableIdentifier = (value, field) => {
  const text = clean(value, field, 200);
  if (!SAFE_IDENTIFIER.test(text)) throw new Error(`${field} must be a portable identifier.`);
  return text;
};

const object = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value;
};

const finite = (value, field, { minimum = -Infinity } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new Error(`${field} must be a finite number greater than or equal to ${minimum}.`);
  return number;
};

const metricValue = (value, field, name) => {
  const number = finite(value, field);
  if (name.includes('_rate') && (number < 0 || number > 1)) throw new Error(`${field} must be between 0 and 1.`);
  return number;
};

const positiveInteger = (value, field, minimum = 1) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${field} must be an integer greater than or equal to ${minimum}.`);
  return number;
};

const uniqueStrings = (values, field, { allowEmpty = false } = {}) => {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const output = values.map((value, index) => clean(value, `${field}[${index}]`, 300));
  if (!allowEmpty && !output.length) throw new Error(`${field} must not be empty.`);
  if (new Set(output).size !== output.length) throw new Error(`${field} contains duplicate values.`);
  return Object.freeze(output);
};

const sameStringSet = (left, right) => {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const safeRelative = (value, field) => {
  const relative = clean(value, field, 1000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (relative.startsWith('/') || /^[A-Za-z]:\//.test(relative)) throw new Error(`${field} must be relative.`);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${field} contains path traversal.`);
  return parts.join('/');
};

const fileDescriptor = (input, field) => {
  const value = object(input, field);
  return Object.freeze({
    path: safeRelative(value.path, `${field}.path`),
    sha256: exactDigest(value.sha256, `${field}.sha256`),
    bytes: positiveInteger(value.bytes, `${field}.bytes`)
  });
};

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function readBoundFile(root, descriptor, field) {
  const filename = path.resolve(root, descriptor.path);
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, filename);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${field}.path escapes the candidate root.`);
  const bytes = await fs.readFile(filename);
  if (bytes.length !== descriptor.bytes) throw new Error(`${field} byte count mismatch.`);
  if (sha256(bytes) !== descriptor.sha256) throw new Error(`${field} digest mismatch.`);
  return Object.freeze({ filename, bytes });
}

async function readBoundJSON(root, descriptor, field) {
  const loaded = await readBoundFile(root, descriptor, field);
  let value;
  try {
    value = JSON.parse(loaded.bytes.toString('utf8'));
  } catch {
    throw new Error(`${field} is not valid JSON.`);
  }
  return Object.freeze({ ...loaded, value: object(value, field) });
}

function verifyEmbeddedDigest(value, key, field) {
  const claimed = exactDigest(value[key], `${field}.${key}`);
  const body = { ...value };
  delete body[key];
  if (digest(body) !== claimed) throw new Error(`${field}.${key} mismatch.`);
  return claimed;
}

export function validateStudentAdmissionCandidate(input) {
  const candidate = object(input, 'candidate');
  if (candidate.schema !== ARCHIE_STUDENT_ADMISSION_CANDIDATE_SCHEMA) {
    throw new Error(`candidate.schema must equal ${ARCHIE_STUDENT_ADMISSION_CANDIDATE_SCHEMA}.`);
  }

  const artifactInput = object(candidate.artifact, 'artifact');
  const artifact = Object.freeze({
    ...fileDescriptor(artifactInput, 'artifact'),
    format: portableIdentifier(artifactInput.format, 'artifact.format'),
    model_id: portableIdentifier(artifactInput.model_id, 'artifact.model_id'),
    checkpoint_id: portableIdentifier(artifactInput.checkpoint_id, 'artifact.checkpoint_id'),
    quantization: clean(artifactInput.quantization || 'none', 'artifact.quantization', 200)
  });

  const tokenizerInput = object(candidate.tokenizer, 'tokenizer');
  const tokenizer = Object.freeze({
    ...fileDescriptor(tokenizerInput, 'tokenizer'),
    format: portableIdentifier(tokenizerInput.format, 'tokenizer.format'),
    vocabulary_size: positiveInteger(tokenizerInput.vocabulary_size, 'tokenizer.vocabulary_size', 2)
  });

  const runtimeInput = object(candidate.runtime, 'runtime');
  const runtime = Object.freeze({
    engine_id: portableIdentifier(runtimeInput.engine_id, 'runtime.engine_id'),
    engine_version: clean(runtimeInput.engine_version, 'runtime.engine_version', 200),
    abi: portableIdentifier(runtimeInput.abi, 'runtime.abi'),
    operating_system: portableIdentifier(runtimeInput.operating_system, 'runtime.operating_system'),
    architecture: portableIdentifier(runtimeInput.architecture, 'runtime.architecture'),
    executable: fileDescriptor(runtimeInput.executable, 'runtime.executable'),
    supported_artifact_formats: uniqueStrings(runtimeInput.supported_artifact_formats, 'runtime.supported_artifact_formats')
  });
  if (!runtime.supported_artifact_formats.includes(artifact.format)) {
    throw new Error(`runtime does not declare support for artifact format ${artifact.format}.`);
  }

  const provenanceInput = object(candidate.provenance, 'provenance');
  const provenance = Object.freeze({
    source_digest: exactDigest(provenanceInput.source_digest, 'provenance.source_digest'),
    license_spdx: portableIdentifier(provenanceInput.license_spdx, 'provenance.license_spdx'),
    redistribution_permitted: provenanceInput.redistribution_permitted === true,
    license_text: fileDescriptor(provenanceInput.license_text, 'provenance.license_text'),
    training_receipt: fileDescriptor(provenanceInput.training_receipt, 'provenance.training_receipt')
  });

  const reportsInput = object(candidate.reports, 'reports');
  const reports = Object.freeze({
    independent_evaluation: fileDescriptor(reportsInput.independent_evaluation, 'reports.independent_evaluation'),
    authority: fileDescriptor(reportsInput.authority, 'reports.authority'),
    reproduction: fileDescriptor(reportsInput.reproduction, 'reports.reproduction'),
    resources: fileDescriptor(reportsInput.resources, 'reports.resources')
  });

  const intelligenceInput = object(candidate.intelligence, 'intelligence');
  const intelligence = Object.freeze({
    target_id: portableIdentifier(intelligenceInput.target_id, 'intelligence.target_id'),
    target_digest: exactDigest(intelligenceInput.target_digest, 'intelligence.target_digest')
  });

  const policyInput = object(candidate.resource_policy || {}, 'resource_policy');
  const resource_policy = Object.freeze({
    minimum_sustained_duration_ms: positiveInteger(policyInput.minimum_sustained_duration_ms ?? 60_000, 'resource_policy.minimum_sustained_duration_ms', 60_000),
    minimum_sample_count: positiveInteger(policyInput.minimum_sample_count ?? 2, 'resource_policy.minimum_sample_count', 2)
  });

  return Object.freeze({
    schema: ARCHIE_STUDENT_ADMISSION_CANDIDATE_SCHEMA,
    id: portableIdentifier(candidate.id, 'candidate.id'),
    artifact,
    tokenizer,
    runtime,
    provenance,
    reports,
    intelligence,
    resource_policy
  });
}

function reportBindingChecks(report, candidate, runtimeIdentityDigest) {
  return [
    ['candidate-id-bound', report.candidate_id === candidate.id],
    ['artifact-bound', report.artifact_sha256 === candidate.artifact.sha256],
    ['runtime-bound', report.runtime_identity_digest === runtimeIdentityDigest]
  ];
}

function metricPasses(name, threshold, observed) {
  if (!Number.isFinite(observed)) return false;
  return name.endsWith('_max') ? observed <= threshold : observed >= threshold;
}

function reportMetrics(report, field) {
  const metrics = object(report.metrics, `${field}.metrics`);
  const normalized = {};
  for (const [nameInput, value] of Object.entries(metrics)) {
    const name = clean(nameInput, `${field}.metrics key`, 200);
    normalized[name] = metricValue(value, `${field}.metrics.${name}`, name);
  }
  return Object.freeze(normalized);
}

function addCheck(checks, id, passed, detail = null) {
  checks.push(Object.freeze({ id, passed: Boolean(passed), detail }));
}

export async function evaluateStudentAdmission(input, { root = '.', target: targetInput } = {}) {
  if (!targetInput) throw new Error('A founder intelligence target is required.');
  const candidate = validateStudentAdmissionCandidate(input);
  const target = validateLaunchTarget(targetInput);
  const targetDigest = digest(target);
  const loaded = await Promise.all([
    readBoundFile(root, candidate.artifact, 'artifact'),
    readBoundFile(root, candidate.tokenizer, 'tokenizer'),
    readBoundFile(root, candidate.runtime.executable, 'runtime.executable'),
    readBoundFile(root, candidate.provenance.license_text, 'provenance.license_text'),
    readBoundJSON(root, candidate.provenance.training_receipt, 'provenance.training_receipt'),
    readBoundJSON(root, candidate.reports.independent_evaluation, 'reports.independent_evaluation'),
    readBoundJSON(root, candidate.reports.authority, 'reports.authority'),
    readBoundJSON(root, candidate.reports.reproduction, 'reports.reproduction'),
    readBoundJSON(root, candidate.reports.resources, 'reports.resources')
  ]);
  const [artifactFile, tokenizerFile, executableFile, licenseFile, trainingLoaded, evaluationLoaded, authorityLoaded, reproductionLoaded, resourcesLoaded] = loaded;
  const training = trainingLoaded.value;
  const evaluation = evaluationLoaded.value;
  const authority = authorityLoaded.value;
  const reproduction = reproductionLoaded.value;
  const resources = resourcesLoaded.value;

  if (training.schema !== 'archie-student-training-receipt/v1') throw new Error('Unsupported training receipt schema.');
  const trainingReceiptDigest = verifyEmbeddedDigest(training, 'receipt_digest', 'training_receipt');
  if (evaluation.schema !== ARCHIE_STUDENT_EVALUATION_SCHEMA) throw new Error('Unsupported independent evaluation schema.');
  const evaluationReportDigest = verifyEmbeddedDigest(evaluation, 'report_digest', 'independent_evaluation');
  if (authority.schema !== ARCHIE_STUDENT_AUTHORITY_SCHEMA) throw new Error('Unsupported authority report schema.');
  const authorityReportDigest = verifyEmbeddedDigest(authority, 'report_digest', 'authority_report');
  if (reproduction.schema !== ARCHIE_STUDENT_REPRODUCTION_SCHEMA) throw new Error('Unsupported reproduction receipt schema.');
  const reproductionReceiptDigest = verifyEmbeddedDigest(reproduction, 'receipt_digest', 'reproduction_receipt');
  if (resources.schema !== ARCHIE_STUDENT_RESOURCE_SCHEMA) throw new Error('Unsupported resource report schema.');
  const resourceReportDigest = verifyEmbeddedDigest(resources, 'report_digest', 'resource_report');

  const runtimeIdentity = Object.freeze({
    engine_id: candidate.runtime.engine_id,
    engine_version: candidate.runtime.engine_version,
    abi: candidate.runtime.abi,
    operating_system: candidate.runtime.operating_system,
    architecture: candidate.runtime.architecture,
    executable_sha256: candidate.runtime.executable.sha256,
    supported_artifact_formats: candidate.runtime.supported_artifact_formats
  });
  const runtimeIdentityDigest = digest(runtimeIdentity);
  const checks = [];

  addCheck(checks, 'target-id-bound', candidate.intelligence.target_id === target.id);
  addCheck(checks, 'target-digest-bound', candidate.intelligence.target_digest === targetDigest);
  addCheck(checks, 'artifact-nonempty', artifactFile.bytes.length > 0);
  addCheck(checks, 'tokenizer-nonempty', tokenizerFile.bytes.length > 0);
  addCheck(checks, 'runtime-executable-nonempty', executableFile.bytes.length > 0);
  addCheck(checks, 'license-text-nonempty', licenseFile.bytes.length > 0);
  addCheck(checks, 'redistribution-permitted', candidate.provenance.redistribution_permitted);
  addCheck(checks, 'training-completed', training.status === 'completed' && training.result?.ok === true);
  addCheck(checks, 'training-artifact-bound', training.artifact?.sha256 === candidate.artifact.sha256);
  addCheck(checks, 'training-receipt-bound', candidate.provenance.training_receipt.sha256 === sha256(trainingLoaded.bytes));

  for (const [id, passed] of reportBindingChecks(evaluation, candidate, runtimeIdentityDigest)) addCheck(checks, `evaluation-${id}`, passed);
  addCheck(checks, 'evaluation-tokenizer-bound', evaluation.tokenizer_sha256 === candidate.tokenizer.sha256);
  addCheck(checks, 'evaluation-target-id-bound', evaluation.target_id === target.id);
  addCheck(checks, 'evaluation-target-digest-bound', evaluation.target_digest === targetDigest);
  const evaluationDomains = uniqueStrings(evaluation.domains, 'independent_evaluation.domains');
  const evaluationRequirements = uniqueStrings(evaluation.intelligence_requirements, 'independent_evaluation.intelligence_requirements');
  addCheck(checks, 'evaluation-domain-scope-bound', sameStringSet(evaluationDomains, target.intelligence_target.domains));
  addCheck(checks, 'evaluation-requirement-scope-bound', sameStringSet(evaluationRequirements, target.intelligence_target.requirements));
  addCheck(checks, 'evaluation-completed', evaluation.completed === true);
  addCheck(checks, 'evaluation-not-mock', evaluation.mock === false);
  addCheck(checks, 'evaluation-independent', evaluation.evaluator?.independent === true && Boolean(String(evaluation.evaluator?.id || '').trim()));
  addCheck(checks, 'evaluation-hidden-judge-only', evaluation.dataset?.access === 'judge-only-hidden');
  addCheck(checks, 'evaluation-excludes-training-data', evaluation.dataset?.training_data_excluded === true);
  addCheck(checks, 'evaluation-promotion-eligible', evaluation.promotion_eligible === true);
  addCheck(checks, 'evaluation-hidden-dataset-digest', HEX_256.test(String(evaluation.dataset?.digest || '')));
  const observedMetrics = reportMetrics(evaluation, 'independent_evaluation');
  const admittedMetrics = {};
  for (const [name, threshold] of Object.entries(target.intelligence_target.minimum_metrics)) {
    const observed = observedMetrics[name];
    admittedMetrics[name] = observed ?? null;
    addCheck(checks, `metric:${name}`, metricPasses(name, threshold, observed), { threshold, observed: observed ?? null });
  }

  for (const [id, passed] of reportBindingChecks(authority, candidate, runtimeIdentityDigest)) addCheck(checks, `authority-${id}`, passed);
  const authorityTests = Array.isArray(authority.tests) ? authority.tests : [];
  addCheck(checks, 'authority-completed', authority.completed === true);
  addCheck(checks, 'authority-not-mock', authority.mock === false);
  addCheck(checks, 'authority-fail-closed', authority.fail_closed === true);
  addCheck(checks, 'authority-tests-present', authorityTests.length > 0);
  addCheck(checks, 'authority-tests-pass', authorityTests.length > 0 && authorityTests.every(test => test?.passed === true && HEX_256.test(String(test?.evidence_digest || ''))));

  for (const [id, passed] of reportBindingChecks(reproduction, candidate, runtimeIdentityDigest)) addCheck(checks, `reproduction-${id}`, passed);
  addCheck(checks, 'reproduction-tokenizer-bound', reproduction.tokenizer_sha256 === candidate.tokenizer.sha256);
  addCheck(checks, 'reproduction-completed', reproduction.completed === true);
  addCheck(checks, 'reproduction-not-mock', reproduction.mock === false);
  addCheck(checks, 'reproduction-clean-environment', reproduction.clean_environment === true);
  addCheck(checks, 'reproduction-second-environment', reproduction.second_environment === true);
  addCheck(checks, 'reproduction-environment-fingerprint', HEX_256.test(String(reproduction.environment_fingerprint_digest || '')));
  addCheck(checks, 'reproduction-invocation-bound', HEX_256.test(String(reproduction.invocation_digest || '')));
  addCheck(checks, 'reproduction-output-bound', HEX_256.test(String(reproduction.output_digest || '')));

  for (const [id, passed] of reportBindingChecks(resources, candidate, runtimeIdentityDigest)) addCheck(checks, `resources-${id}`, passed);
  addCheck(checks, 'resources-completed', resources.completed === true);
  addCheck(checks, 'resources-not-mock', resources.mock === false);
  addCheck(checks, 'resources-machine-fingerprint', HEX_256.test(String(resources.machine_fingerprint_digest || '')));
  addCheck(checks, 'resources-sustained-duration', Number(resources.sustained_duration_ms) >= candidate.resource_policy.minimum_sustained_duration_ms, {
    minimum: candidate.resource_policy.minimum_sustained_duration_ms,
    observed: Number(resources.sustained_duration_ms)
  });
  addCheck(checks, 'resources-sample-count', Number(resources.sample_count) >= candidate.resource_policy.minimum_sample_count, {
    minimum: candidate.resource_policy.minimum_sample_count,
    observed: Number(resources.sample_count)
  });
  const measurements = object(resources.measurements, 'resource_report.measurements');
  const measurementEntries = Object.entries(measurements);
  addCheck(checks, 'resources-measurements-present', measurementEntries.length > 0);
  addCheck(checks, 'resources-measurements-finite', measurementEntries.length > 0 && measurementEntries.every(([, value]) => Number.isFinite(Number(value)) && Number(value) >= 0));

  const blockers = checks.filter(check => !check.passed).map(check => check.id);
  const admitted = blockers.length === 0;
  const launchBinding = admitted ? Object.freeze({
    schema: ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
    id: candidate.id,
    artifact_digest: candidate.artifact.sha256,
    intelligence_report_digest: evaluationReportDigest,
    authority_report_digest: authorityReportDigest,
    reproduction_receipt_digest: reproductionReceiptDigest,
    domains: target.intelligence_target.domains,
    intelligence_requirements: target.intelligence_target.requirements,
    metrics: Object.freeze(admittedMetrics),
    faculties: {},
    interfaces: []
  }) : null;
  const body = {
    schema: ARCHIE_STUDENT_ADMISSION_SCHEMA,
    candidate_id: candidate.id,
    target: { id: target.id, digest: targetDigest },
    decision: admitted ? 'admitted-provider-neutral-student' : 'rejected-incomplete-student-evidence',
    artifact: candidate.artifact,
    tokenizer: candidate.tokenizer,
    runtime: { ...runtimeIdentity, runtime_identity_digest: runtimeIdentityDigest },
    provenance: {
      source_digest: candidate.provenance.source_digest,
      license_spdx: candidate.provenance.license_spdx,
      license_text_sha256: candidate.provenance.license_text.sha256,
      training_receipt_digest: trainingReceiptDigest
    },
    evidence: {
      independent_evaluation_report_digest: evaluationReportDigest,
      authority_report_digest: authorityReportDigest,
      reproduction_receipt_digest: reproductionReceiptDigest,
      resource_report_digest: resourceReportDigest,
      hidden_dataset_digest: evaluation.dataset?.digest || null,
      machine_fingerprint_digest: resources.machine_fingerprint_digest || null
    },
    checks,
    blockers,
    launch_candidate_intelligence_binding: launchBinding,
    claim_boundary: admitted
      ? 'This exact artifact, tokenizer, runtime identity, founder intelligence target, hidden evaluation, authority report, clean reproduction, license, and sustained resource evidence are admitted together. Embodiment and machine launch admission remain separate required gates.'
      : 'This candidate must not be represented as an admitted Archie student and receives no launch-candidate binding. Missing or failed evidence cannot be replaced by model reputation, provider claims, or interface polish.'
  };
  return Object.freeze({ ...body, admission_digest: digest(body) });
}

function parse(argv) {
  const command = argv[0] || 'admit';
  const flags = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}.`);
    const [name, inline] = token.split('=', 2);
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${name} requires a value.`);
    flags.set(name, next);
    index += 1;
  }
  return { command, flags };
}

function usage() {
  return `Archie provider-neutral student admission\n\nUsage:\n  node scripts/archie-student-admission.mjs admit --candidate candidate.json [--target founder/archie-launch-target.json] [--output admission.json]\n\nThe candidate manifest binds one exact artifact, tokenizer, runtime executable and ABI, license and provenance, independent hidden evaluation against the founder intelligence target, authority report, second clean-environment reproduction, and sustained machine-resource evidence.`;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const { command, flags } = parse(argv);
  if (command !== 'admit') throw new Error(`Unknown command ${command}.\n\n${usage()}`);
  const candidateFilename = flags.get('--candidate');
  if (!candidateFilename) throw new Error('--candidate is required.');
  const resolvedCandidate = path.resolve(candidateFilename);
  const defaultTarget = fileURLToPath(new URL('../founder/archie-launch-target.json', import.meta.url));
  const targetFilename = path.resolve(flags.get('--target') || defaultTarget);
  const [candidate, target] = await Promise.all([
    fs.readFile(resolvedCandidate, 'utf8').then(JSON.parse),
    fs.readFile(targetFilename, 'utf8').then(JSON.parse)
  ]);
  const admission = await evaluateStudentAdmission(candidate, { root: path.dirname(resolvedCandidate), target });
  const text = `${JSON.stringify(admission, null, 2)}\n`;
  const output = flags.get('--output');
  if (output) {
    const filename = path.resolve(output);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, text);
    process.stdout.write(`${filename}\n`);
  } else {
    process.stdout.write(text);
  }
  if (admission.decision !== 'admitted-provider-neutral-student') process.exitCode = 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-student-admission: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
