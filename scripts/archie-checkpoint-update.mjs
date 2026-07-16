import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createEncryptedArtifactPackage,
  inspectEncryptedTransport
} from './archie-artifact-envelope.mjs';
import {
  canonical,
  inspectModel,
  sha256,
  stableJSONStringify
} from './archie-runtime-core.mjs';

export const ARCHIE_CHECKPOINT_LINEAGE_SCHEMA = 'archie-checkpoint-lineage/v1';
export const ARCHIE_CHECKPOINT_TRANSITION_RECEIPT_SCHEMA = 'archie-checkpoint-transition-receipt/v1';

const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const clean = (value, limit = 20_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function assertDigest(value, field) {
  const digest = clean(value, 64).toLowerCase();
  if (!HEX_256.test(digest)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return digest;
}

function assertName(value, field) {
  const name = clean(value, 128);
  if (!SAFE_NAME.test(name)) throw new Error(`${field} must be a portable identifier.`);
  return name;
}

function assertSafeInteger(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} must be a safe integer >= ${minimum}.`);
  return value;
}

function assertNoPrivateMaterial(value, trail = 'input') {
  if (typeof value === 'string') {
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value)) throw new Error(`${trail} may not contain private key material.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateMaterial(entry, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:^|[_-])(api[_-]?key|private[_-]?key|password|secret|access[_-]?token)(?:$|[_-])/i.test(key)) {
      throw new Error(`${trail}.${key} is a secret-like field and is not allowed.`);
    }
    assertNoPrivateMaterial(entry, `${trail}.${key}`);
  }
}

function normalizedRegions(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const regions = value.map((entry, index) => {
    const region = clean(entry, 300);
    if (!region) throw new Error(`${field}[${index}] must be non-empty.`);
    return region;
  });
  if (new Set(regions).size !== regions.length) throw new Error(`${field} must not contain duplicates.`);
  return Object.freeze([...regions].sort());
}

function sameValue(left, right) {
  return stableJSONStringify(canonical(left)) === stableJSONStringify(canonical(right));
}

function manifestReference(manifest) {
  return `${assertName(manifest?.model?.id, 'parent model.id')}@${assertName(manifest?.model?.version, 'parent model.version')}`;
}

function normalizeLineage(input, parent, candidate) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('checkpoint lineage must be an object.');
  assertNoPrivateMaterial(input, 'lineage');
  if (input.schema !== ARCHIE_CHECKPOINT_LINEAGE_SCHEMA) {
    throw new Error(`lineage.schema must equal ${ARCHIE_CHECKPOINT_LINEAGE_SCHEMA}.`);
  }
  const parentExpectation = input.parent || {};
  const expectedParent = {
    model_ref: clean(parentExpectation.model_ref, 300),
    manifest_digest: assertDigest(parentExpectation.manifest_digest, 'lineage.parent.manifest_digest'),
    artifact_digest: assertDigest(parentExpectation.artifact_digest, 'lineage.parent.artifact_digest'),
    mutable_digest: assertDigest(parentExpectation.mutable_digest, 'lineage.parent.mutable_digest')
  };
  if (expectedParent.model_ref !== parent.model_ref) throw new Error('Checkpoint parent model reference mismatch.');
  if (expectedParent.manifest_digest !== parent.manifest_digest) throw new Error('Checkpoint parent manifest digest mismatch.');
  if (expectedParent.artifact_digest !== parent.artifact_digest) throw new Error('Checkpoint parent artifact digest mismatch.');
  if (expectedParent.mutable_digest !== parent.mutable_digest) throw new Error('Checkpoint parent mutable digest mismatch.');

  const evaluationReceiptDigest = assertDigest(input.evaluation_receipt_digest, 'lineage.evaluation_receipt_digest');
  if (evaluationReceiptDigest !== candidate.benchmark_report_digest) {
    throw new Error('Candidate benchmark report digest does not match lineage evaluation receipt.');
  }

  const rejected = Array.isArray(input.rejected_checkpoint_digests)
    ? input.rejected_checkpoint_digests.map((entry, index) => assertDigest(entry, `lineage.rejected_checkpoint_digests[${index}]`))
    : [];
  if (new Set(rejected).size !== rejected.length) throw new Error('lineage.rejected_checkpoint_digests must not contain duplicates.');

  const teacherIds = Array.isArray(input.teacher_ids)
    ? input.teacher_ids.map((entry, index) => {
        const id = clean(entry, 300);
        if (!id) throw new Error(`lineage.teacher_ids[${index}] must be non-empty.`);
        return id;
      })
    : [];

  return Object.freeze({
    schema: ARCHIE_CHECKPOINT_LINEAGE_SCHEMA,
    parent: expectedParent,
    candidate: {
      model_ref: candidate.model_ref,
      mutable_digest: candidate.mutable_digest,
      benchmark_report_digest: candidate.benchmark_report_digest
    },
    training_data_digest: assertDigest(input.training_data_digest, 'lineage.training_data_digest'),
    trajectory_digest: assertDigest(input.trajectory_digest, 'lineage.trajectory_digest'),
    training_config_digest: assertDigest(input.training_config_digest, 'lineage.training_config_digest'),
    optimizer_digest: assertDigest(input.optimizer_digest, 'lineage.optimizer_digest'),
    authority_receipt_digest: assertDigest(input.authority_receipt_digest, 'lineage.authority_receipt_digest'),
    evaluation_receipt_digest: evaluationReceiptDigest,
    seed: assertSafeInteger(input.seed, 'lineage.seed'),
    teacher_ids: Object.freeze([...new Set(teacherIds)].sort()),
    rejected_checkpoint_digests: Object.freeze([...rejected].sort())
  });
}

export function validateCheckpointTransition(parentManifest, candidateMetadata, lineageInput) {
  if (!parentManifest || typeof parentManifest !== 'object' || Array.isArray(parentManifest)) throw new Error('parent manifest must be an object.');
  if (!candidateMetadata || typeof candidateMetadata !== 'object' || Array.isArray(candidateMetadata)) throw new Error('candidate metadata must be an object.');
  assertNoPrivateMaterial(candidateMetadata, 'metadata');

  const parentModel = parentManifest.model || {};
  const candidateModel = candidateMetadata.model || {};
  const parentRef = manifestReference(parentManifest);
  const candidateId = assertName(candidateModel.id, 'candidate model.id');
  const candidateVersion = assertName(candidateModel.version, 'candidate model.version');
  const candidateRef = `${candidateId}@${candidateVersion}`;

  if (candidateId !== parentModel.id) throw new Error('Checkpoint updates may not change model.id.');
  if (candidateVersion === parentModel.version) throw new Error('Checkpoint updates require a new model.version.');

  for (const field of ['architecture', 'runtime_abi', 'format', 'quantization', 'context_limit']) {
    if (!sameValue(candidateModel[field], parentModel[field])) throw new Error(`Checkpoint updates may not change model.${field}.`);
  }
  if (!sameValue(candidateMetadata.runtime, parentManifest.runtime)) {
    throw new Error('Checkpoint updates may not change the runtime adapter or argument template.');
  }

  const parentState = parentManifest.state || {};
  const candidateState = candidateMetadata.state || {};
  const parentImmutable = assertDigest(parentState.immutable_digest, 'parent state.immutable_digest');
  const candidateImmutable = assertDigest(candidateState.immutable_digest, 'candidate state.immutable_digest');
  if (candidateImmutable !== parentImmutable) throw new Error('Checkpoint updates may not change the immutable-state digest.');

  const parentMutable = assertDigest(parentState.mutable_digest, 'parent state.mutable_digest');
  const candidateMutable = assertDigest(candidateState.mutable_digest, 'candidate state.mutable_digest');
  if (candidateMutable === parentMutable) throw new Error('Checkpoint update must declare a changed mutable-state digest.');

  const parentRegions = normalizedRegions(parentState.mutable_regions, 'parent state.mutable_regions');
  const candidateRegions = normalizedRegions(candidateState.mutable_regions, 'candidate state.mutable_regions');
  if (!sameValue(parentRegions, candidateRegions)) throw new Error('Checkpoint updates may not change the declared mutable regions.');

  const parentManifestDigest = assertDigest(parentManifest.manifest_digest, 'parent manifest_digest');
  const parentArtifactDigest = assertDigest(parentManifest.artifact?.sha256, 'parent artifact.sha256');
  const benchmarkReportDigest = assertDigest(candidateMetadata.benchmarks?.report_digest, 'candidate benchmarks.report_digest');
  if (benchmarkReportDigest === clean(parentManifest.benchmarks?.report_digest, 64).toLowerCase()) {
    throw new Error('Checkpoint update requires a fresh benchmark report digest.');
  }

  const parent = Object.freeze({
    model_ref: parentRef,
    manifest_digest: parentManifestDigest,
    artifact_digest: parentArtifactDigest,
    immutable_digest: parentImmutable,
    mutable_digest: parentMutable,
    mutable_regions: parentRegions
  });
  const candidate = Object.freeze({
    model_ref: candidateRef,
    immutable_digest: candidateImmutable,
    mutable_digest: candidateMutable,
    mutable_regions: candidateRegions,
    benchmark_report_digest: benchmarkReportDigest
  });
  const lineage = normalizeLineage(lineageInput, parent, candidate);

  const metadata = canonical({
    ...candidateMetadata,
    provenance: {
      ...candidateMetadata.provenance,
      checkpoint_lineage: lineage
    }
  });

  return Object.freeze({ parent, candidate, lineage, metadata });
}

function transitionReceipt(payload, clock = Date.now) {
  const observedAt = new Date(typeof clock === 'function' ? clock() : clock).toISOString();
  const body = {
    schema: ARCHIE_CHECKPOINT_TRANSITION_RECEIPT_SCHEMA,
    observed_at: observedAt,
    payload: canonical(payload)
  };
  return Object.freeze({ ...body, receipt_digest: sha256(body) });
}

export async function createCheckpointUpdatePackage({
  parent_reference,
  candidate_artifact_path,
  metadata,
  lineage,
  output_directory,
  recipient_public_keys,
  signing_private_key_pem,
  signing_public_key_pem,
  home,
  chunk_bytes,
  chunk_base_url,
  clock = Date.now
}) {
  const installed = await inspectModel(parent_reference, { home });
  const encryptedTransport = await inspectEncryptedTransport(installed.artifact_path);
  const parentManifest = encryptedTransport?.outer_manifest || installed.manifest;
  const transition = validateCheckpointTransition(parentManifest, metadata, lineage);

  const packaged = await createEncryptedArtifactPackage({
    artifact_path: candidate_artifact_path,
    output_directory,
    metadata: transition.metadata,
    recipient_public_keys,
    signing_private_key_pem,
    signing_public_key_pem,
    chunk_bytes,
    chunk_base_url
  });

  const receipt = transitionReceipt({
    parent: transition.parent,
    candidate: {
      ...transition.candidate,
      manifest_digest: packaged.manifest.manifest_digest,
      artifact_digest: packaged.manifest.artifact.sha256,
      exact_download_bytes: packaged.manifest.sizes.download_bytes,
      exact_installed_bytes: packaged.manifest.sizes.installed_bytes
    },
    lineage: transition.lineage,
    constraints: {
      same_model_id: true,
      new_version: true,
      same_architecture: true,
      same_runtime_abi: true,
      same_format: true,
      same_quantization: true,
      same_context_limit: true,
      same_runtime_adapter: true,
      same_immutable_digest: true,
      same_mutable_regions: true,
      changed_mutable_digest: true,
      fresh_benchmark_receipt: true
    }
  }, clock);

  const receiptPath = path.join(path.resolve(output_directory), 'checkpoint-transition-receipt.json');
  await fs.writeFile(receiptPath, `${JSON.stringify(canonical(receipt), null, 2)}\n`, { mode: 0o600 });

  return Object.freeze({
    manifest: packaged.manifest,
    manifest_path: packaged.manifest_path,
    transition_receipt: receipt,
    transition_receipt_path: receiptPath,
    output_directory: packaged.output_directory
  });
}
