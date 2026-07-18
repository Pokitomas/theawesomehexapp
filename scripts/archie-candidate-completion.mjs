#!/usr/bin/env node
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { digest } from './archie-launch-contract.mjs';

export const ARCHIE_CANDIDATE_COMPLETION_MANIFEST_SCHEMA = 'archie-candidate-completion-manifest/v1';
export const ARCHIE_CANDIDATE_COMPLETION_DECISION_SCHEMA = 'archie-candidate-completion-decision/v1';
export const ARCHIE_REPRODUCTION_RECEIPT_SCHEMA = 'archie-reproduction-receipt/v1';
export const ARCHIE_METRICS_RECEIPT_SCHEMA = 'archie-metrics-receipt/v1';
export const ARCHIE_INTELLIGENCE_RESULT_SCHEMA = 'archie-intelligence-result/v1';
export const ARCHIE_IPHONE_RESULT_SCHEMA = 'archie-iphone-result/v1';
export const ARCHIE_ARCHITECTURE_REPORT_SCHEMA = 'archie-quant-architecture-report/v2';
export const ARCHIE_IPHONE_AUTHORITY_SCHEMA = 'archie-iphone-measurement-authorities/v1';
export const ARCHIE_IPHONE_ATTESTATION_SCHEMA = 'archie-iphone-measurement-attestation/v1';

const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const REQUIRED_REPRODUCTION_CHECKS = Object.freeze(['install', 'offline_run', 'benchmark', 'upgrade', 'rollback', 'removal']);
const MANIFEST_KEYS = Object.freeze(['architecture_report', 'reproduction_receipt', 'metrics_receipt', 'intelligence_result', 'iphone_result', 'authority_manifest']);

const object = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value;
};
const text = (value, field, limit = 10_000) => {
  const out = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!out || out.length > limit) throw new Error(`${field} is required and must be <= ${limit} characters.`);
  return out;
};
const id = (value, field) => {
  const out = text(value, field, 200);
  if (!ID.test(out)) throw new Error(`${field} must be a portable identifier.`);
  return out;
};
const hash = (value, field) => {
  const out = text(value, field, 64).toLowerCase();
  if (!HEX.test(out)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return out;
};
const integer = (value, field, minimum = 0) => {
  const out = Number(value);
  if (!Number.isSafeInteger(out) || out < minimum) throw new Error(`${field} must be an integer >= ${minimum}.`);
  return out;
};
const finite = (value, field, minimum = Number.NEGATIVE_INFINITY) => {
  const out = Number(value);
  if (!Number.isFinite(out) || out < minimum) throw new Error(`${field} must be finite and >= ${minimum}.`);
  return out;
};
const rejectUnknown = (value, allowed, field) => {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${field} contains unsupported fields: ${unknown.join(', ')}.`);
};
const safeRelative = (value, field) => {
  const relative = text(value, field, 1000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (relative.startsWith('/') || /^[A-Za-z]:\//.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${field} must be a safe relative path.`);
  return relative;
};
const descriptor = (input, field) => {
  const value = object(input, field);
  rejectUnknown(value, new Set(['path', 'sha256', 'bytes']), field);
  return Object.freeze({ path: safeRelative(value.path, `${field}.path`), sha256: hash(value.sha256, `${field}.sha256`), bytes: integer(value.bytes, `${field}.bytes`, 1) });
};

async function hashFile(filename) {
  const state = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on('data', chunk => state.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return state.digest('hex');
}

function resolveWithin(root, relative, field) {
  const rootPath = path.resolve(root);
  const filename = path.resolve(rootPath, relative);
  const difference = path.relative(rootPath, filename);
  if (difference.startsWith('..') || path.isAbsolute(difference)) throw new Error(`${field}.path escapes the manifest root.`);
  return filename;
}

async function readJsonDescriptor(root, input, field) {
  const item = descriptor(input, field);
  const filename = resolveWithin(root, item.path, field);
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size !== item.bytes) throw new Error(`${field} byte count mismatch.`);
  const observed = await hashFile(filename);
  if (observed !== item.sha256) throw new Error(`${field} digest mismatch.`);
  let value;
  try {
    value = JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    throw new Error(`${field} must contain parseable JSON: ${error.message}`);
  }
  return Object.freeze({ descriptor: item, filename, value });
}

function verifyInternalDigest(value, field, digestField) {
  const claimed = hash(value[digestField], `${field}.${digestField}`);
  const body = { ...value };
  delete body[digestField];
  const observed = digest(body);
  if (observed !== claimed) throw new Error(`${field}.${digestField} mismatch.`);
  return claimed;
}

function normalizeArchitectureReport(input) {
  const value = object(input, 'architecture_report');
  if (value.schema !== ARCHIE_ARCHITECTURE_REPORT_SCHEMA) throw new Error(`architecture_report.schema must equal ${ARCHIE_ARCHITECTURE_REPORT_SCHEMA}.`);
  const reportDigest = verifyInternalDigest(value, 'architecture_report', 'report_digest');
  if (!Array.isArray(value.completed_diagnostics)) throw new Error('architecture_report.completed_diagnostics must be an array.');
  const rows = value.completed_diagnostics.map((raw, index) => {
    const row = object(raw, `architecture_report.completed_diagnostics[${index}]`);
    return Object.freeze({
      candidate_id: id(row.candidate_id, `architecture_report.completed_diagnostics[${index}].candidate_id`),
      architecture_id: id(row.architecture_id, `architecture_report.completed_diagnostics[${index}].architecture_id`),
      model_artifact_sha256: hash(row.checkpoint_sha256, `architecture_report.completed_diagnostics[${index}].checkpoint_sha256`),
      runtime_sha256: hash(row.runtime_sha256, `architecture_report.completed_diagnostics[${index}].runtime_sha256`)
    });
  });
  if (new Set(rows.map(row => row.candidate_id)).size !== rows.length) throw new Error('architecture_report contains duplicate completed candidate IDs.');
  return Object.freeze({ value, report_digest: reportDigest, rows });
}

function commonBinding(value, field, schema, digestField) {
  const input = object(value, field);
  if (input.schema !== schema) throw new Error(`${field}.schema must equal ${schema}.`);
  const internalDigest = verifyInternalDigest(input, field, digestField);
  return Object.freeze({
    value: input,
    internal_digest: internalDigest,
    candidate_id: id(input.candidate_id, `${field}.candidate_id`),
    architecture_report_digest: hash(input.architecture_report_digest, `${field}.architecture_report_digest`),
    model_artifact_sha256: hash(input.model_artifact_sha256, `${field}.model_artifact_sha256`),
    runtime_sha256: hash(input.runtime_sha256, `${field}.runtime_sha256`)
  });
}

function normalizeReproductionReceipt(input) {
  const normalized = commonBinding(input, 'reproduction_receipt', ARCHIE_REPRODUCTION_RECEIPT_SCHEMA, 'receipt_digest');
  const checks = object(normalized.value.checks, 'reproduction_receipt.checks');
  rejectUnknown(checks, new Set(REQUIRED_REPRODUCTION_CHECKS), 'reproduction_receipt.checks');
  for (const name of REQUIRED_REPRODUCTION_CHECKS) if (typeof checks[name] !== 'boolean') throw new Error(`reproduction_receipt.checks.${name} must be boolean.`);
  return Object.freeze({
    ...normalized,
    environment_fingerprint: hash(normalized.value.environment_fingerprint, 'reproduction_receipt.environment_fingerprint'),
    reproduced: normalized.value.reproduced === true,
    checks: Object.freeze(Object.fromEntries(REQUIRED_REPRODUCTION_CHECKS.map(name => [name, checks[name]])))
  });
}

function normalizeMetricsReceipt(input) {
  const normalized = commonBinding(input, 'metrics_receipt', ARCHIE_METRICS_RECEIPT_SCHEMA, 'receipt_digest');
  const metrics = object(normalized.value.metrics, 'metrics_receipt.metrics');
  if (!Object.keys(metrics).length) throw new Error('metrics_receipt.metrics must be nonempty.');
  const normalizedMetrics = Object.freeze(Object.fromEntries(Object.entries(metrics).map(([name, value]) => [id(name, `metrics_receipt.metrics key ${name}`), finite(value, `metrics_receipt.metrics.${name}`)])));
  return Object.freeze({
    ...normalized,
    evidence_package_digest: hash(normalized.value.evidence_package_digest, 'metrics_receipt.evidence_package_digest'),
    device_fingerprint: hash(normalized.value.device_fingerprint, 'metrics_receipt.device_fingerprint'),
    sample_count: integer(normalized.value.sample_count, 'metrics_receipt.sample_count', 1),
    independently_recomputed: normalized.value.independently_recomputed === true,
    metrics: normalizedMetrics
  });
}

function normalizeIntelligenceResult(input) {
  const normalized = commonBinding(input, 'intelligence_result', ARCHIE_INTELLIGENCE_RESULT_SCHEMA, 'result_digest');
  const baselines = object(normalized.value.baseline_gains, 'intelligence_result.baseline_gains');
  const normalizedBaselines = Object.freeze(Object.fromEntries(Object.entries(baselines).map(([name, value]) => [id(name, `intelligence_result.baseline_gains key ${name}`), finite(value, `intelligence_result.baseline_gains.${name}`)])));
  return Object.freeze({
    ...normalized,
    hidden_split_sha256: hash(normalized.value.hidden_split_sha256, 'intelligence_result.hidden_split_sha256'),
    grader_sha256: hash(normalized.value.grader_sha256, 'intelligence_result.grader_sha256'),
    protocol_digest: hash(normalized.value.protocol_digest, 'intelligence_result.protocol_digest'),
    passed: normalized.value.passed === true,
    decision: text(normalized.value.decision, 'intelligence_result.decision', 200),
    baseline_gains: normalizedBaselines
  });
}

function normalizeAuthorityManifest(input) {
  const value = object(input, 'authority_manifest');
  if (value.schema !== ARCHIE_IPHONE_AUTHORITY_SCHEMA) throw new Error(`authority_manifest.schema must equal ${ARCHIE_IPHONE_AUTHORITY_SCHEMA}.`);
  if (!Array.isArray(value.authorities)) throw new Error('authority_manifest.authorities must be an array.');
  const authorities = value.authorities.map((raw, index) => {
    const authority = object(raw, `authority_manifest.authorities[${index}]`);
    return Object.freeze({
      id: id(authority.id, `authority_manifest.authorities[${index}].id`),
      status: text(authority.status, `authority_manifest.authorities[${index}].status`, 100),
      public_key_pem: text(authority.public_key_pem, `authority_manifest.authorities[${index}].public_key_pem`, 20_000)
    });
  });
  if (new Set(authorities.map(authority => authority.id)).size !== authorities.length) throw new Error('authority_manifest contains duplicate authority IDs.');
  return Object.freeze({ value, authorities });
}

function normalizeIPhoneResult(input) {
  const normalized = commonBinding(input, 'iphone_result', ARCHIE_IPHONE_RESULT_SCHEMA, 'result_digest');
  const attestation = normalized.value.attestation == null ? null : object(normalized.value.attestation, 'iphone_result.attestation');
  if (attestation && attestation.schema !== ARCHIE_IPHONE_ATTESTATION_SCHEMA) throw new Error(`iphone_result.attestation.schema must equal ${ARCHIE_IPHONE_ATTESTATION_SCHEMA}.`);
  return Object.freeze({
    ...normalized,
    evidence_package_digest: hash(normalized.value.evidence_package_digest, 'iphone_result.evidence_package_digest'),
    metrics_receipt_digest: hash(normalized.value.metrics_receipt_digest, 'iphone_result.metrics_receipt_digest'),
    device_fingerprint: hash(normalized.value.device_fingerprint, 'iphone_result.device_fingerprint'),
    nonce: text(normalized.value.nonce, 'iphone_result.nonce', 500),
    authority_id: id(normalized.value.authority_id, 'iphone_result.authority_id'),
    binding_digest: hash(normalized.value.binding_digest, 'iphone_result.binding_digest'),
    decision: text(normalized.value.decision, 'iphone_result.decision', 200),
    attestation
  });
}

function verifyIPhoneAttestation(iphone, authorityManifest) {
  if (!iphone.attestation) return Object.freeze({ verified: false, blocker: 'canonical-iphone-attestation-missing' });
  const attestation = iphone.attestation;
  const authority = authorityManifest.authorities.find(candidate => candidate.id === iphone.authority_id && candidate.status === 'active');
  if (!authority) return Object.freeze({ verified: false, blocker: 'active-measurement-authority-missing' });
  if (attestation.authority_id !== iphone.authority_id || attestation.candidate_id !== iphone.candidate_id || attestation.package_digest !== iphone.evidence_package_digest || attestation.binding_digest !== iphone.binding_digest) throw new Error('iphone_result.attestation does not bind the canonical iPhone result.');
  const signature = text(attestation.signature, 'iphone_result.attestation.signature', 20_000);
  const body = { ...attestation };
  delete body.signature;
  const verified = crypto.verify(null, Buffer.from(digest(body), 'hex'), authority.public_key_pem, Buffer.from(signature, 'base64'));
  if (!verified) throw new Error('iphone_result.attestation signature verification failed.');
  return Object.freeze({ verified: true, blocker: null });
}

function assertEqual(actual, expected, field) {
  if (actual !== expected) throw new Error(`${field} mismatch.`);
}

export async function verifyCandidateCompletionManifest(input, { root = '.' } = {}) {
  const manifest = object(input, 'manifest');
  rejectUnknown(manifest, new Set(['schema', 'candidate_id', ...MANIFEST_KEYS, 'claim_boundary', 'manifest_digest']), 'manifest');
  if (manifest.schema !== ARCHIE_CANDIDATE_COMPLETION_MANIFEST_SCHEMA) throw new Error(`manifest.schema must equal ${ARCHIE_CANDIDATE_COMPLETION_MANIFEST_SCHEMA}.`);
  const candidateId = id(manifest.candidate_id, 'manifest.candidate_id');
  const manifestDigest = verifyInternalDigest(manifest, 'manifest', 'manifest_digest');
  const descriptors = Object.fromEntries(MANIFEST_KEYS.map(key => [key, descriptor(manifest[key], `manifest.${key}`)]));
  if (new Set(MANIFEST_KEYS.map(key => descriptors[key].path)).size !== MANIFEST_KEYS.length) throw new Error('manifest file descriptors must reference unique files.');

  const loaded = {};
  for (const key of MANIFEST_KEYS) loaded[key] = await readJsonDescriptor(root, descriptors[key], `manifest.${key}`);

  const architecture = normalizeArchitectureReport(loaded.architecture_report.value);
  const reproduction = normalizeReproductionReceipt(loaded.reproduction_receipt.value);
  const metrics = normalizeMetricsReceipt(loaded.metrics_receipt.value);
  const intelligence = normalizeIntelligenceResult(loaded.intelligence_result.value);
  const iphone = normalizeIPhoneResult(loaded.iphone_result.value);
  const authorities = normalizeAuthorityManifest(loaded.authority_manifest.value);

  const architectureRows = architecture.rows.filter(row => row.candidate_id === candidateId);
  if (architectureRows.length !== 1) throw new Error('manifest.candidate_id must identify exactly one completed architecture candidate.');
  const architectureCandidate = architectureRows[0];

  for (const [name, receipt] of Object.entries({ reproduction, metrics, intelligence, iphone })) {
    assertEqual(receipt.candidate_id, candidateId, `${name}.candidate_id`);
    assertEqual(receipt.architecture_report_digest, architecture.report_digest, `${name}.architecture_report_digest`);
    assertEqual(receipt.model_artifact_sha256, architectureCandidate.model_artifact_sha256, `${name}.model_artifact_sha256`);
    assertEqual(receipt.runtime_sha256, architectureCandidate.runtime_sha256, `${name}.runtime_sha256`);
  }
  assertEqual(iphone.metrics_receipt_digest, metrics.internal_digest, 'iphone_result.metrics_receipt_digest');
  assertEqual(iphone.evidence_package_digest, metrics.evidence_package_digest, 'iphone_result.evidence_package_digest');
  assertEqual(iphone.device_fingerprint, metrics.device_fingerprint, 'iphone_result.device_fingerprint');

  const attestation = verifyIPhoneAttestation(iphone, authorities);
  const blockers = [];
  if (!reproduction.reproduced) blockers.push('clean-reproduction-not-passed');
  for (const name of REQUIRED_REPRODUCTION_CHECKS) if (!reproduction.checks[name]) blockers.push(`reproduction-check-failed:${name}`);
  if (!metrics.independently_recomputed) blockers.push('metrics-not-independently-recomputed');
  if (!intelligence.passed || intelligence.decision !== 'passed-independent-intelligence-gate') blockers.push('intelligence-gate-not-passed');
  if (iphone.decision !== 'admitted-canonical-physical-iphone-result') blockers.push('canonical-physical-iphone-result-not-admitted');
  if (!attestation.verified) blockers.push(attestation.blocker);

  const complete = blockers.length === 0;
  const body = {
    schema: ARCHIE_CANDIDATE_COMPLETION_DECISION_SCHEMA,
    candidate_id: candidateId,
    architecture_id: architectureCandidate.architecture_id,
    complete,
    selected_candidate_id: complete ? candidateId : null,
    blockers: Object.freeze(blockers),
    verified_files: Object.freeze(Object.fromEntries(MANIFEST_KEYS.map(key => [key, Object.freeze({ path: descriptors[key].path, sha256: descriptors[key].sha256, bytes: descriptors[key].bytes })]))),
    verified_internal_digests: Object.freeze({
      manifest_digest: manifestDigest,
      architecture_report_digest: architecture.report_digest,
      reproduction_receipt_digest: reproduction.internal_digest,
      metrics_receipt_digest: metrics.internal_digest,
      intelligence_result_digest: intelligence.internal_digest,
      iphone_result_digest: iphone.internal_digest
    }),
    authority: Object.freeze({ authority_id: iphone.authority_id, attestation_verified: attestation.verified }),
    claim_boundary: complete
      ? 'Completion applies only to this exact architecture candidate, model artifact, runtime, intelligence result, clean reproduction, canonical physical-iPhone result, and enrolled measurement authority.'
      : 'No candidate may be selected, promoted, bundled, or represented as iPhone-ready while any blocker remains.'
  };
  return Object.freeze({ ...body, decision_digest: digest(body) });
}

function parse(argv) {
  const command = argv[0] || 'verify';
  const flags = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}.`);
    const [name, inline] = token.split('=', 2);
    if (inline !== undefined) flags.set(name, inline);
    else {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${name} requires a value.`);
      flags.set(name, next);
      index += 1;
    }
  }
  return { command, flags };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parse(argv);
  if (command !== 'verify') throw new Error('Usage: verify --manifest file [--output file]');
  const manifestPath = flags.get('--manifest');
  if (!manifestPath) throw new Error('--manifest is required.');
  const resolved = path.resolve(manifestPath);
  const result = await verifyCandidateCompletionManifest(JSON.parse(await fs.readFile(resolved, 'utf8')), { root: path.dirname(resolved) });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (flags.get('--output')) {
    const filename = path.resolve(flags.get('--output'));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, output, { flag: 'wx' });
    process.stdout.write(`${filename}\n`);
  } else process.stdout.write(output);
  if (!result.complete) process.exitCode = 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) main().catch(error => { process.stderr.write(`archie-candidate-completion: ${error?.stack || error}\n`); process.exitCode = 1; });
