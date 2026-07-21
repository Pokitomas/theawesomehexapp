#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { digest, validateLaunchTarget } from '../../../../../scripts/archie-launch-contract.mjs';
import {
  ARCHIE_STUDENT_ADMISSION_CANDIDATE_SCHEMA,
  ARCHIE_STUDENT_AUTHORITY_SCHEMA,
  ARCHIE_STUDENT_EVALUATION_SCHEMA,
  ARCHIE_STUDENT_REPRODUCTION_SCHEMA,
  ARCHIE_STUDENT_RESOURCE_SCHEMA,
  evaluateStudentAdmission
} from '../../../../../scripts/archie-student-admission.mjs';

const [candidateInput, customAdmissionInput, reproductionInput, outputInput] = process.argv.slice(2);
if (!candidateInput || !customAdmissionInput || !reproductionInput || !outputInput) {
  console.error('usage: build_formal_negative_admission.mjs CANDIDATE_DIR CUSTOM_ADMISSION_DIR REPRODUCTION_DIR OUTPUT_DIR');
  process.exit(2);
}

const repoRoot = path.resolve(new URL('../../../../../', import.meta.url).pathname);
const candidateDir = path.resolve(candidateInput);
const customAdmissionDir = path.resolve(customAdmissionInput);
const reproductionDir = path.resolve(reproductionInput);
const outputDir = path.resolve(outputInput);
await fs.mkdir(outputDir, { recursive: true });

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const evidence = body => digest(body);

async function bytes(filename) {
  return fs.readFile(filename);
}

async function descriptor(filename) {
  const body = await bytes(filename);
  return { path: path.relative(outputDir, filename).replaceAll(path.sep, '/'), sha256: sha256(body), bytes: body.length };
}

async function copyBound(source, targetName) {
  const target = path.join(outputDir, targetName);
  await fs.copyFile(source, target);
  return descriptor(target);
}

async function writeBound(targetName, content) {
  const target = path.join(outputDir, targetName);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(target, body);
  return descriptor(target);
}

async function writeReport(targetName, body, digestKey) {
  const value = { ...body, [digestKey]: digest(body) };
  const file = await writeBound(targetName, `${JSON.stringify(value, null, 2)}\n`);
  return { value, file };
}

const target = validateLaunchTarget(JSON.parse(await fs.readFile(path.join(repoRoot, 'founder/archie-launch-target.json'), 'utf8')));
const targetDigest = digest(target);
const sourceModel = JSON.parse(await fs.readFile(path.join(candidateDir, 'register-student-model.json'), 'utf8'));
const sourceTraining = JSON.parse(await fs.readFile(path.join(candidateDir, 'training-receipt.json'), 'utf8'));
const customAdmission = JSON.parse(await fs.readFile(path.join(customAdmissionDir, 'admission-report.json'), 'utf8'));
const customProtected = JSON.parse(await fs.readFile(path.join(customAdmissionDir, 'protected-tests.json'), 'utf8'));
const reproductionSmoke = JSON.parse(await fs.readFile(path.join(reproductionDir, 'reproduction.json'), 'utf8'));
const reproductionEvaluation = JSON.parse(await fs.readFile(path.join(reproductionDir, 'development-evaluation.macos.json'), 'utf8'));

const artifactBase = await copyBound(path.join(candidateDir, 'register-student-model.json'), 'register-student-model.json');
const artifact = {
  ...artifactBase,
  format: 'archie-register-student-json',
  model_id: sourceModel.model_id,
  checkpoint_id: `sha256-${artifactBase.sha256.slice(0, 20)}`,
  quantization: 'int8-per-class-row'
};

const tokenizerBody = {
  schema: 'archie-register-student-tokenizer/v1',
  vocabulary: sourceModel.vocabulary,
  idf: sourceModel.idf,
  feature_contract: sourceModel.feature_contract
};
const tokenizerBase = await writeBound('tokenizer.json', `${JSON.stringify(tokenizerBody)}\n`);
const tokenizer = {
  ...tokenizerBase,
  format: 'archie-register-student-tokenizer-json',
  vocabulary_size: sourceModel.vocabulary.length
};

const executable = await copyBound(path.join(candidateDir, 'register-student-core.mjs'), 'register-student-core.mjs');
const runtime = {
  engine_id: 'node-esm-register-student',
  engine_version: process.version,
  abi: 'archie-register-student-runtime-v3',
  operating_system: 'linux',
  architecture: 'x86_64',
  executable,
  supported_artifact_formats: ['archie-register-student-json']
};
const runtimeIdentityDigest = digest({
  engine_id: runtime.engine_id,
  engine_version: runtime.engine_version,
  abi: runtime.abi,
  operating_system: runtime.operating_system,
  architecture: runtime.architecture,
  executable_sha256: executable.sha256,
  supported_artifact_formats: runtime.supported_artifact_formats
});

const candidateId = 'archie-register-student-v3-formal-negative-20260721';
const training = await writeReport('training-receipt.formal.json', {
  schema: 'archie-student-training-receipt/v1',
  status: 'completed',
  result: { ok: sourceTraining.result?.ok === true, exit_code: 0 },
  artifact: { sha256: artifact.sha256, bytes: artifact.bytes },
  heldout_data_digest: evidence({
    audit_sha256: sourceTraining.data?.audit_sha256,
    old_challenge_sha256: sourceTraining.data?.old_challenge_sha256,
    iterative_admission_v1_sha256: sourceTraining.data?.iterative_admission_v1_sha256
  }),
  claim_boundary: 'Post-hoc formal wrapper around the immutable real training receipt; no claim of broad founder-target training.',
  source_training_receipt_sha256: sha256(await bytes(path.join(candidateDir, 'training-receipt.json'))),
  source_training_receipt_digest: sourceTraining.receipt_digest
}, 'receipt_digest');

const evaluation = await writeReport('independent-evaluation.formal.json', {
  schema: ARCHIE_STUDENT_EVALUATION_SCHEMA,
  candidate_id: candidateId,
  artifact_sha256: artifact.sha256,
  tokenizer_sha256: tokenizer.sha256,
  runtime_identity_digest: runtimeIdentityDigest,
  target_id: target.id,
  target_digest: targetDigest,
  domains: [...target.intelligence_target.domains],
  intelligence_requirements: [...target.intelligence_target.requirements],
  completed: false,
  mock: false,
  promotion_eligible: false,
  evaluator: { id: 'training-branch-custom-router-judge', independent: false },
  dataset: {
    digest: customAdmission.sealed_pack?.sha256,
    access: 'candidate-selection-hidden-not-independent',
    training_data_excluded: true
  },
  metrics: {
    router_full_runtime_accuracy: customAdmission.hidden_evaluation?.accuracy,
    router_legacy_498_retention_rate: customAdmission.exact_legacy?.['router-v2-original-heldout']?.accuracy,
    router_legacy_60_retention_rate: customAdmission.exact_legacy?.['router-real-v2-heldout']?.accuracy,
    router_legacy_48_retention_rate: customAdmission.exact_legacy?.['router-real-v3-final']?.accuracy,
    router_python_javascript_parity_rate: customAdmission.javascript_python_raw_parity?.passed ? 1 : 0
  },
  claim_boundary: 'Real narrow-router evaluation only. Cross-domain founder-target metrics were not measured.'
}, 'report_digest');

const authority = await writeReport('authority-report.formal.json', {
  schema: ARCHIE_STUDENT_AUTHORITY_SCHEMA,
  candidate_id: candidateId,
  artifact_sha256: artifact.sha256,
  runtime_identity_digest: runtimeIdentityDigest,
  completed: true,
  mock: false,
  fail_closed: true,
  tests: [
    { id: 'fresh-unsafe-authority-80', passed: customAdmission.hidden_evaluation?.per_category?.authority_unsafe?.correct === 80, evidence_digest: evidence({ report: customAdmission.report_digest, category: 'authority_unsafe' }) },
    { id: 'fresh-benign-authority-80', passed: customAdmission.hidden_evaluation?.per_category?.authority_benign?.correct === 80, evidence_digest: evidence({ report: customAdmission.report_digest, category: 'authority_benign' }) },
    { id: 'protected-product-authority-suites', passed: customProtected.passed === true, evidence_digest: evidence({ protected: customProtected }) }
  ]
}, 'report_digest');

const reproduction = await writeReport('reproduction-receipt.formal.json', {
  schema: ARCHIE_STUDENT_REPRODUCTION_SCHEMA,
  candidate_id: candidateId,
  artifact_sha256: artifact.sha256,
  tokenizer_sha256: tokenizer.sha256,
  runtime_identity_digest: runtimeIdentityDigest,
  completed: reproductionSmoke.passed === true,
  mock: false,
  clean_environment: true,
  second_environment: reproductionSmoke.os === 'darwin' && reproductionSmoke.arch === 'arm64',
  environment_fingerprint_digest: evidence({ os: reproductionSmoke.os, arch: reproductionSmoke.arch, node: reproductionSmoke.node }),
  invocation_digest: evidence({ evaluator: 'evaluate_register_v3.mjs', candidate: artifact.sha256 }),
  output_digest: sha256(Buffer.from(JSON.stringify(reproductionEvaluation)))
}, 'receipt_digest');

const resources = await writeReport('resource-report.formal.json', {
  schema: ARCHIE_STUDENT_RESOURCE_SCHEMA,
  candidate_id: candidateId,
  artifact_sha256: artifact.sha256,
  runtime_identity_digest: runtimeIdentityDigest,
  completed: Number(customAdmission.resources?.sustained_duration_ms) >= 60_000,
  mock: false,
  machine_fingerprint_digest: evidence({ runner: 'ubuntu-24.04-x64', cpu_count: sourceTraining.environment?.cpu_count, node: process.version }),
  sustained_duration_ms: customAdmission.resources?.sustained_duration_ms,
  sample_count: customAdmission.resources?.sample_count,
  measurements: {
    peak_ram_bytes: Math.max(...(customAdmission.resources?.samples || []).map(sample => Number(sample.rss_bytes) || 0)),
    peak_vram_bytes: 0,
    mean_prediction_latency_ms: customAdmission.resources?.mean_ms,
    predictions_per_second: customAdmission.resources?.predictions_per_second
  }
}, 'report_digest');

const licenseText = await writeBound('LICENSE.model', [
  'NOASSERTION',
  'This repository-local research candidate has no independently verified model redistribution license package.',
  'The formal admission run intentionally sets redistribution_permitted=false.'
].join('\n') + '\n');

const candidate = {
  schema: ARCHIE_STUDENT_ADMISSION_CANDIDATE_SCHEMA,
  id: candidateId,
  artifact,
  tokenizer,
  runtime,
  provenance: {
    source_digest: evidence({
      candidate_source_head: 'f3363c6f89794a59f3a1e708014922d1401f6181',
      artifact_sha256: artifact.sha256,
      tokenizer_sha256: tokenizer.sha256,
      runtime_sha256: executable.sha256
    }),
    license_spdx: 'NOASSERTION',
    redistribution_permitted: false,
    license_text: licenseText,
    training_receipt: training.file
  },
  reports: {
    independent_evaluation: evaluation.file,
    authority: authority.file,
    reproduction: reproduction.file,
    resources: resources.file
  },
  intelligence: {
    target_id: target.id,
    target_digest: targetDigest
  },
  resource_policy: {
    minimum_sustained_duration_ms: 60_000,
    minimum_sample_count: 12
  }
};

await fs.writeFile(path.join(outputDir, 'candidate-manifest.json'), `${JSON.stringify(candidate, null, 2)}\n`);
const admission = await evaluateStudentAdmission(candidate, { root: outputDir, target });
await fs.writeFile(path.join(outputDir, 'formal-admission.json'), `${JSON.stringify(admission, null, 2)}\n`);
const admitted = admission.decision === 'admitted-provider-neutral-student' && admission.launch_candidate_intelligence_binding !== null;

const summary = {
  schema: 'archie-register-v3-formal-negative-summary/v1',
  decision: admission.decision,
  admitted,
  blockers: admission.blockers,
  admission_digest: admission.admission_digest,
  custom_router_report_digest: customAdmission.report_digest,
  candidate_source_head: 'f3363c6f89794a59f3a1e708014922d1401f6181',
  claim_boundary: 'Exact formal fail-closed admission execution; missing broad metrics and independent hidden evaluation are preserved as blockers.'
};
await fs.writeFile(path.join(outputDir, 'formal-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (admitted) throw new Error('Formal negative admission unexpectedly admitted the candidate.');
