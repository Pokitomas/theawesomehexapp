import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest } from '../archie-launch-contract.mjs';
import {
  ARCHIE_STUDENT_ADMISSION_CANDIDATE_SCHEMA,
  ARCHIE_STUDENT_AUTHORITY_SCHEMA,
  ARCHIE_STUDENT_EVALUATION_SCHEMA,
  ARCHIE_STUDENT_REPRODUCTION_SCHEMA,
  ARCHIE_STUDENT_RESOURCE_SCHEMA,
  evaluateStudentAdmission,
  validateStudentAdmissionCandidate
} from '../archie-student-admission.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const evidence = label => digest({ evidence: label });

async function writeFile(root, name, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(path.join(root, name), bytes);
  return { path: name, sha256: sha256(bytes), bytes: bytes.length };
}

async function writeJSON(root, name, body, digestKey) {
  const value = { ...body, [digestKey]: digest(body) };
  const descriptor = await writeFile(root, name, `${JSON.stringify(value, null, 2)}\n`);
  return { value, descriptor };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-student-admission-'));
  const artifact = {
    ...(await writeFile(root, 'student.gguf', Buffer.from('exact-student-checkpoint'))),
    format: 'gguf',
    model_id: 'archie-student',
    checkpoint_id: 'checkpoint-0001',
    quantization: 'Q4_K_M'
  };
  const tokenizer = {
    ...(await writeFile(root, 'tokenizer.json', '{"tokens":["a","b"]}\n')),
    format: 'tokenizer-json',
    vocabulary_size: 2
  };
  const executable = await writeFile(root, 'runtime.bin', Buffer.from('exact-runtime-executable'));
  const licenseText = await writeFile(root, 'LICENSE.model', 'Apache License 2.0 fixture\n');
  const runtime = {
    engine_id: 'provider-neutral-runtime',
    engine_version: '1.0.0',
    abi: 'archie-model-runtime-v1',
    operating_system: 'linux',
    architecture: 'x86_64',
    executable,
    supported_artifact_formats: ['gguf']
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
  const candidateId = 'archie-student-checkpoint-0001';

  const training = await writeJSON(root, 'training-receipt.json', {
    schema: 'archie-student-training-receipt/v1',
    status: 'completed',
    result: { ok: true, exit_code: 0 },
    artifact: { sha256: artifact.sha256, bytes: artifact.bytes },
    heldout_data_digest: evidence('training-heldout'),
    claim_boundary: 'Training execution only.'
  }, 'receipt_digest');

  const evaluation = await writeJSON(root, 'independent-evaluation.json', {
    schema: ARCHIE_STUDENT_EVALUATION_SCHEMA,
    candidate_id: candidateId,
    artifact_sha256: artifact.sha256,
    tokenizer_sha256: tokenizer.sha256,
    runtime_identity_digest: runtimeIdentityDigest,
    completed: true,
    mock: false,
    promotion_eligible: true,
    evaluator: { id: 'independent-judge-01', independent: true },
    dataset: {
      digest: evidence('hidden-evaluation-dataset'),
      access: 'judge-only-hidden',
      training_data_excluded: true
    },
    metrics: {
      cross_domain_completion_rate: 0.91,
      unsafe_action_rate_max: 0.01,
      clean_reproduction_rate: 1
    }
  }, 'report_digest');

  const authority = await writeJSON(root, 'authority-report.json', {
    schema: ARCHIE_STUDENT_AUTHORITY_SCHEMA,
    candidate_id: candidateId,
    artifact_sha256: artifact.sha256,
    runtime_identity_digest: runtimeIdentityDigest,
    completed: true,
    mock: false,
    fail_closed: true,
    tests: [
      { id: 'deny-ungranted-write', passed: true, evidence_digest: evidence('deny-ungranted-write') },
      { id: 'preserve-user-revocation', passed: true, evidence_digest: evidence('preserve-user-revocation') }
    ]
  }, 'report_digest');

  const reproduction = await writeJSON(root, 'reproduction-receipt.json', {
    schema: ARCHIE_STUDENT_REPRODUCTION_SCHEMA,
    candidate_id: candidateId,
    artifact_sha256: artifact.sha256,
    tokenizer_sha256: tokenizer.sha256,
    runtime_identity_digest: runtimeIdentityDigest,
    completed: true,
    mock: false,
    clean_environment: true,
    second_environment: true,
    environment_fingerprint_digest: evidence('clean-environment-02'),
    invocation_digest: evidence('exact-invocation'),
    output_digest: evidence('reproduced-output')
  }, 'receipt_digest');

  const resources = await writeJSON(root, 'resource-report.json', {
    schema: ARCHIE_STUDENT_RESOURCE_SCHEMA,
    candidate_id: candidateId,
    artifact_sha256: artifact.sha256,
    runtime_identity_digest: runtimeIdentityDigest,
    completed: true,
    mock: false,
    machine_fingerprint_digest: evidence('machine-fingerprint'),
    sustained_duration_ms: 120_000,
    sample_count: 120,
    measurements: {
      peak_ram_bytes: 8_000_000_000,
      peak_vram_bytes: 0,
      p95_first_token_latency_ms: 840,
      average_tokens_per_second: 18.4
    }
  }, 'report_digest');

  const candidate = {
    schema: ARCHIE_STUDENT_ADMISSION_CANDIDATE_SCHEMA,
    id: candidateId,
    artifact,
    tokenizer,
    runtime,
    provenance: {
      source_digest: evidence('source-checkpoint'),
      license_spdx: 'Apache-2.0',
      redistribution_permitted: true,
      license_text: licenseText,
      training_receipt: training.descriptor
    },
    reports: {
      independent_evaluation: evaluation.descriptor,
      authority: authority.descriptor,
      reproduction: reproduction.descriptor,
      resources: resources.descriptor
    },
    intelligence: {
      domains: ['software', 'research', 'product-creation'],
      requirements: ['complete-unfamiliar-product-builds', 'reproduce-delivery-on-clean-environment'],
      minimum_metrics: {
        cross_domain_completion_rate: 0.85,
        unsafe_action_rate_max: 0.02,
        clean_reproduction_rate: 1
      }
    },
    resource_policy: {
      minimum_sustained_duration_ms: 60_000,
      minimum_sample_count: 60
    }
  };

  return { root, candidate, reports: { evaluation, authority, reproduction, resources } };
}

async function replaceReport(root, candidate, key, filename, value, digestKey) {
  const body = { ...value };
  delete body[digestKey];
  const replacement = await writeJSON(root, filename, body, digestKey);
  candidate.reports[key] = replacement.descriptor;
  return replacement.value;
}

test('admits one exact provider-neutral student only when every evidence family is bound', async t => {
  const { root, candidate } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const admission = await evaluateStudentAdmission(candidate, { root });
  assert.equal(admission.decision, 'admitted-provider-neutral-student');
  assert.deepEqual(admission.blockers, []);
  assert.equal(admission.runtime.abi, 'archie-model-runtime-v1');
  assert.equal(admission.launch_candidate_intelligence_binding.artifact_digest, candidate.artifact.sha256);
  assert.equal(admission.launch_candidate_intelligence_binding.faculties && Object.keys(admission.launch_candidate_intelligence_binding.faculties).length, 0);
  assert.match(admission.admission_digest, /^[a-f0-9]{64}$/);
  assert.match(admission.claim_boundary, /Embodiment and machine launch admission remain separate/);
});

test('explicit mock or non-independent evaluation cannot promote a student', async t => {
  const { root, candidate, reports } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const changed = structuredClone(reports.evaluation.value);
  changed.mock = true;
  changed.evaluator.independent = false;
  await replaceReport(root, candidate, 'independent_evaluation', 'independent-evaluation.json', changed, 'report_digest');
  const admission = await evaluateStudentAdmission(candidate, { root });
  assert.equal(admission.decision, 'rejected-incomplete-student-evidence');
  assert.ok(admission.blockers.includes('evaluation-not-mock'));
  assert.ok(admission.blockers.includes('evaluation-independent'));
});

test('second clean-environment reproduction and sustained resource evidence are mandatory', async t => {
  const { root, candidate, reports } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reproduction = structuredClone(reports.reproduction.value);
  reproduction.second_environment = false;
  await replaceReport(root, candidate, 'reproduction', 'reproduction-receipt.json', reproduction, 'receipt_digest');
  const resources = structuredClone(reports.resources.value);
  resources.sustained_duration_ms = 1_000;
  resources.sample_count = 1;
  await replaceReport(root, candidate, 'resources', 'resource-report.json', resources, 'report_digest');
  const admission = await evaluateStudentAdmission(candidate, { root });
  assert.equal(admission.decision, 'rejected-incomplete-student-evidence');
  assert.ok(admission.blockers.includes('reproduction-second-environment'));
  assert.ok(admission.blockers.includes('resources-sustained-duration'));
  assert.ok(admission.blockers.includes('resources-sample-count'));
});

test('artifact mutation and unsupported runtime formats fail closed before admission', async t => {
  const { root, candidate } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.appendFile(path.join(root, candidate.artifact.path), 'tamper');
  await assert.rejects(() => evaluateStudentAdmission(candidate, { root }), /artifact byte count mismatch/);
  const unsupported = structuredClone(candidate);
  unsupported.runtime.supported_artifact_formats = ['safetensors'];
  assert.throws(() => validateStudentAdmissionCandidate(unsupported), /does not declare support/);
});
