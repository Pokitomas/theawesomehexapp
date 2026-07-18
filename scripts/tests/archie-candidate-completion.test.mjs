import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest } from '../archie-launch-contract.mjs';
import {
  ARCHIE_CANDIDATE_COMPLETION_MANIFEST_SCHEMA,
  ARCHIE_INTELLIGENCE_RESULT_SCHEMA,
  ARCHIE_IPHONE_RESULT_SCHEMA,
  ARCHIE_METRICS_RECEIPT_SCHEMA,
  ARCHIE_REPRODUCTION_RECEIPT_SCHEMA,
  verifyCandidateCompletionManifest
} from '../archie-candidate-completion.mjs';

const candidateId = 'qwen3-transformer-gguf-q4-k-m';
const architectureId = 'qwen3-dense-transformer';
const modelDigest = 'a'.repeat(64);
const runtimeDigest = 'b'.repeat(64);
const packageDigest = 'c'.repeat(64);
const deviceFingerprint = 'd'.repeat(64);
const bindingDigest = 'e'.repeat(64);

async function writeJson(root, name, value) {
  const filename = path.join(root, name);
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await fs.writeFile(filename, data);
  return { path: name, sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length };
}

function internallyDigest(body, field) {
  return { ...body, [field]: digest(body) };
}

async function fixture({ attested = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-completion-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const authorityId = 'physical-lab-one';

  const architectureBody = {
    schema: 'archie-quant-architecture-report/v2',
    campaign_id: 'archie-generation-one-quant-architectures',
    template_digest: '1'.repeat(64),
    received_candidate_count: 1,
    missing_candidate_ids: [],
    expected_failures: [],
    unexpected_failures: [],
    completed_diagnostics: [{
      candidate_id: candidateId,
      architecture_id: architectureId,
      checkpoint_sha256: modelDigest,
      runtime_sha256: runtimeDigest,
      training_budget_digest: '2'.repeat(64),
      hidden_split_sha256: '3'.repeat(64),
      grader_sha256: '4'.repeat(64),
      workload_set_sha256: '5'.repeat(64),
      diagnostic_metrics: { task_success_rate: 0.9 }
    }],
    diagnostic_comparison: { binding_mismatches: [], comparable_candidate_ids: [candidateId], diagnostic_pareto_frontier_candidate_ids: [candidateId] },
    selection: { eligible: false, blockers: ['canonical-intelligence-admission-unresolved'], selected_candidate_id: null },
    claim_boundary: 'Diagnostic only.'
  };
  const architecture = internallyDigest(architectureBody, 'report_digest');
  const architectureDescriptor = await writeJson(root, 'architecture.json', architecture);

  const reproductionBody = {
    schema: ARCHIE_REPRODUCTION_RECEIPT_SCHEMA,
    candidate_id: candidateId,
    architecture_report_digest: architecture.report_digest,
    model_artifact_sha256: modelDigest,
    runtime_sha256: runtimeDigest,
    environment_fingerprint: '6'.repeat(64),
    reproduced: true,
    checks: { install: true, offline_run: true, benchmark: true, upgrade: true, rollback: true, removal: true }
  };
  const reproduction = internallyDigest(reproductionBody, 'receipt_digest');
  const reproductionDescriptor = await writeJson(root, 'reproduction.json', reproduction);

  const metricsBody = {
    schema: ARCHIE_METRICS_RECEIPT_SCHEMA,
    candidate_id: candidateId,
    architecture_report_digest: architecture.report_digest,
    model_artifact_sha256: modelDigest,
    runtime_sha256: runtimeDigest,
    evidence_package_digest: packageDigest,
    device_fingerprint: deviceFingerprint,
    sample_count: 50,
    independently_recomputed: true,
    metrics: { task_success_rate: 0.9, sustained_tokens_per_second_p50: 11, peak_rss_bytes: 2400000000 }
  };
  const metrics = internallyDigest(metricsBody, 'receipt_digest');
  const metricsDescriptor = await writeJson(root, 'metrics.json', metrics);

  const intelligenceBody = {
    schema: ARCHIE_INTELLIGENCE_RESULT_SCHEMA,
    candidate_id: candidateId,
    architecture_report_digest: architecture.report_digest,
    model_artifact_sha256: modelDigest,
    runtime_sha256: runtimeDigest,
    hidden_split_sha256: '3'.repeat(64),
    grader_sha256: '4'.repeat(64),
    protocol_digest: '7'.repeat(64),
    passed: true,
    decision: 'passed-independent-intelligence-gate',
    baseline_gains: { 'raw-student': 0.12, 'retrieval-only-archie': 0.08, 'current-archie': 0.03 }
  };
  const intelligence = internallyDigest(intelligenceBody, 'result_digest');
  const intelligenceDescriptor = await writeJson(root, 'intelligence.json', intelligence);

  const attestationBody = {
    schema: 'archie-iphone-measurement-attestation/v1',
    authority_id: authorityId,
    candidate_id: candidateId,
    package_digest: packageDigest,
    binding_digest: bindingDigest,
    issued_at: '2026-07-18T04:00:00.000Z'
  };
  const attestation = attested ? { ...attestationBody, signature: crypto.sign(null, Buffer.from(digest(attestationBody), 'hex'), privateKey).toString('base64') } : null;
  const iphoneBody = {
    schema: ARCHIE_IPHONE_RESULT_SCHEMA,
    candidate_id: candidateId,
    architecture_report_digest: architecture.report_digest,
    model_artifact_sha256: modelDigest,
    runtime_sha256: runtimeDigest,
    evidence_package_digest: packageDigest,
    metrics_receipt_digest: metrics.receipt_digest,
    device_fingerprint: deviceFingerprint,
    nonce: 'fresh-physical-run-nonce',
    authority_id: authorityId,
    binding_digest: bindingDigest,
    attestation,
    decision: attested ? 'admitted-canonical-physical-iphone-result' : 'rejected-canonical-physical-iphone-result'
  };
  const iphone = internallyDigest(iphoneBody, 'result_digest');
  const iphoneDescriptor = await writeJson(root, 'iphone.json', iphone);

  const authorities = {
    schema: 'archie-iphone-measurement-authorities/v1',
    authorities: [{ id: authorityId, status: 'active', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
    claim_boundary: 'Test authority.'
  };
  const authorityDescriptor = await writeJson(root, 'authorities.json', authorities);

  const manifestBody = {
    schema: ARCHIE_CANDIDATE_COMPLETION_MANIFEST_SCHEMA,
    candidate_id: candidateId,
    architecture_report: architectureDescriptor,
    reproduction_receipt: reproductionDescriptor,
    metrics_receipt: metricsDescriptor,
    intelligence_result: intelligenceDescriptor,
    iphone_result: iphoneDescriptor,
    authority_manifest: authorityDescriptor,
    claim_boundary: 'No completion without all canonical evidence.'
  };
  const manifest = internallyDigest(manifestBody, 'manifest_digest');
  return { root, manifest, files: { architecture, reproduction, metrics, intelligence, iphone, authorities } };
}

test('completes only the exact architecture candidate after every receipt and iPhone attestation verify', async t => {
  const state = await fixture(); t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const decision = await verifyCandidateCompletionManifest(state.manifest, { root: state.root });
  assert.equal(decision.complete, true);
  assert.equal(decision.candidate_id, candidateId);
  assert.equal(decision.selected_candidate_id, candidateId);
  assert.equal(decision.architecture_id, architectureId);
  assert.equal(decision.authority.attestation_verified, true);
  assert.match(decision.decision_digest, /^[a-f0-9]{64}$/);
});

test('canonical iPhone result is mandatory even when every non-phone gate passes', async t => {
  const state = await fixture({ attested: false }); t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const decision = await verifyCandidateCompletionManifest(state.manifest, { root: state.root });
  assert.equal(decision.complete, false);
  assert.equal(decision.selected_candidate_id, null);
  assert.ok(decision.blockers.includes('canonical-physical-iphone-result-not-admitted'));
  assert.ok(decision.blockers.includes('canonical-iphone-attestation-missing'));
});

test('candidate identity cannot drift between architecture, reproduction, intelligence, metrics, and phone receipts', async t => {
  const state = await fixture(); t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const altered = { ...state.files.reproduction, candidate_id: 'other-candidate' };
  const body = { ...altered }; delete body.receipt_digest;
  altered.receipt_digest = digest(body);
  const descriptor = await writeJson(state.root, 'reproduction.json', altered);
  const manifestBody = { ...state.manifest, reproduction_receipt: descriptor }; delete manifestBody.manifest_digest;
  const manifest = { ...manifestBody, manifest_digest: digest(manifestBody) };
  await assert.rejects(() => verifyCandidateCompletionManifest(manifest, { root: state.root }), /reproduction\.candidate_id mismatch/);
});

test('every referenced file is externally hashed and parsed as JSON', async t => {
  const state = await fixture(); t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await fs.appendFile(path.join(state.root, 'metrics.json'), 'tamper');
  await assert.rejects(() => verifyCandidateCompletionManifest(state.manifest, { root: state.root }), /metrics_receipt (byte count|digest) mismatch/);

  const fresh = await fixture(); t.after(() => fs.rm(fresh.root, { recursive: true, force: true }));
  const opaque = Buffer.from('not-json');
  await fs.writeFile(path.join(fresh.root, 'intelligence.json'), opaque);
  const descriptor = { path: 'intelligence.json', sha256: crypto.createHash('sha256').update(opaque).digest('hex'), bytes: opaque.length };
  const manifestBody = { ...fresh.manifest, intelligence_result: descriptor }; delete manifestBody.manifest_digest;
  const manifest = { ...manifestBody, manifest_digest: digest(manifestBody) };
  await assert.rejects(() => verifyCandidateCompletionManifest(manifest, { root: fresh.root }), /must contain parseable JSON/);
});

test('forged iPhone attestation signatures fail integrity verification', async t => {
  const state = await fixture(); t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const forged = structuredClone(state.files.iphone);
  forged.attestation.signature = Buffer.alloc(64).toString('base64');
  const body = { ...forged }; delete body.result_digest;
  forged.result_digest = digest(body);
  const descriptor = await writeJson(state.root, 'iphone.json', forged);
  const manifestBody = { ...state.manifest, iphone_result: descriptor }; delete manifestBody.manifest_digest;
  const manifest = { ...manifestBody, manifest_digest: digest(manifestBody) };
  await assert.rejects(() => verifyCandidateCompletionManifest(manifest, { root: state.root }), /signature verification failed/);
});
