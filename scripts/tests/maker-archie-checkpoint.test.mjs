import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ARCHIE_CHECKPOINT_LINEAGE_SCHEMA,
  ARCHIE_CHECKPOINT_TRANSITION_RECEIPT_SCHEMA,
  createCheckpointUpdatePackage,
  validateCheckpointTransition
} from '../archie-checkpoint-update.mjs';
import {
  createEncryptedArtifactPackage,
  generateArtifactKeyPair,
  pullEncryptedModel
} from '../archie-artifact-envelope.mjs';
import { inspectModel, runModel } from '../archie-runtime-core.mjs';

const digest = character => character.repeat(64);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-checkpoint-test-'));
  const runner = path.join(root, 'runner.mjs');
  await fs.writeFile(runner, [
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "const value = name => args[args.indexOf(name) + 1] || '';",
    "process.stdout.write(`CHECKPOINT:${value('--prompt')}:${path.basename(value('--model'))}\\n`);"
  ].join('\n'));

  const signer = generateArtifactKeyPair('signing');
  const device = generateArtifactKeyPair('recipient');
  const parentArtifact = path.join(root, 'archie-parent.gguf');
  const candidateArtifact = path.join(root, 'archie-candidate.gguf');
  await fs.writeFile(parentArtifact, Buffer.concat([Buffer.from('PARENT\n'), Buffer.alloc(2048, 0x11)]));
  await fs.writeFile(candidateArtifact, Buffer.concat([Buffer.from('CANDIDATE\n'), Buffer.alloc(2048, 0x22)]));

  const parentMetadata = {
    model: {
      id: 'archie-checkpoint-fixture',
      version: '1.0.0',
      architecture: 'fixture-architecture',
      runtime_abi: 'archie-runtime/v1',
      format: 'gguf',
      quantization: 'fixture-q4',
      context_limit: 2048
    },
    hardware: {
      required_ram_bytes: 1,
      recommended_ram_bytes: 4096,
      disk_bytes: 4096,
      backends: ['cpu']
    },
    provenance: {
      license: 'test-only',
      source: 'generated parent fixture',
      training: 'fixture parent state',
      code_commit: 'a'.repeat(40)
    },
    state: {
      immutable_digest: digest('1'),
      mutable_digest: digest('2'),
      mutable_regions: ['routing.weights', 'student.adapter']
    },
    benchmarks: {
      suite_digest: digest('3'),
      report_digest: digest('4'),
      claim_boundary: 'Checkpoint plumbing fixture only.'
    },
    runtime: {
      adapter: 'process-template/v1',
      arguments: [runner, '--model', '{artifact}', '--prompt', '{prompt}', '--max-tokens', '{max_tokens}', '--context', '{context}', '--seed', '{seed}']
    }
  };

  const parentPackage = await createEncryptedArtifactPackage({
    artifact_path: parentArtifact,
    output_directory: path.join(root, 'parent-package'),
    metadata: parentMetadata,
    recipient_public_keys: [device.public_key_pem],
    signing_private_key_pem: signer.private_key_pem,
    signing_public_key_pem: signer.public_key_pem,
    chunk_bytes: 700
  });
  const home = path.join(root, 'home');
  await pullEncryptedModel(parentPackage.manifest_path, {
    home,
    trusted_public_keys: [signer.public_key_pem],
    recipient_private_keys: [device.private_key_pem]
  });

  const candidateMetadata = structuredClone(parentMetadata);
  candidateMetadata.model.version = '1.1.0';
  candidateMetadata.provenance.source = 'generated candidate fixture';
  candidateMetadata.provenance.training = 'adapter update from accepted trajectories';
  candidateMetadata.state.mutable_digest = digest('5');
  candidateMetadata.benchmarks.report_digest = digest('6');

  const lineage = {
    schema: ARCHIE_CHECKPOINT_LINEAGE_SCHEMA,
    parent: {
      model_ref: 'archie-checkpoint-fixture@1.0.0',
      manifest_digest: parentPackage.manifest.manifest_digest,
      artifact_digest: parentPackage.manifest.artifact.sha256,
      mutable_digest: parentMetadata.state.mutable_digest
    },
    training_data_digest: digest('7'),
    trajectory_digest: digest('8'),
    training_config_digest: digest('9'),
    optimizer_digest: digest('a'),
    authority_receipt_digest: digest('b'),
    evaluation_receipt_digest: candidateMetadata.benchmarks.report_digest,
    seed: 17,
    teacher_ids: ['teacher-fixture'],
    rejected_checkpoint_digests: [digest('c')]
  };

  return {
    root,
    runner,
    signer,
    device,
    parentArtifact,
    candidateArtifact,
    parentMetadata,
    parentPackage,
    candidateMetadata,
    lineage,
    home
  };
}

async function cleanup(value) {
  await fs.rm(value.root, { recursive: true, force: true });
}

test('checkpoint update emits a new encrypted package and parent-bound transition receipt', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  const result = await createCheckpointUpdatePackage({
    parent_reference: 'archie-checkpoint-fixture@1.0.0',
    candidate_artifact_path: value.candidateArtifact,
    metadata: value.candidateMetadata,
    lineage: value.lineage,
    output_directory: path.join(value.root, 'candidate-package'),
    recipient_public_keys: [value.device.public_key_pem],
    signing_private_key_pem: value.signer.private_key_pem,
    signing_public_key_pem: value.signer.public_key_pem,
    home: value.home,
    chunk_bytes: 650,
    clock: () => Date.parse('2026-07-16T17:30:00.000Z')
  });

  assert.equal(result.transition_receipt.schema, ARCHIE_CHECKPOINT_TRANSITION_RECEIPT_SCHEMA);
  assert.equal(result.transition_receipt.payload.parent.model_ref, 'archie-checkpoint-fixture@1.0.0');
  assert.equal(result.transition_receipt.payload.candidate.model_ref, 'archie-checkpoint-fixture@1.1.0');
  assert.equal(result.transition_receipt.payload.candidate.mutable_digest, digest('5'));
  assert.equal(result.transition_receipt.payload.constraints.same_immutable_digest, true);
  assert.equal(result.manifest.provenance.checkpoint_lineage.parent.manifest_digest, value.parentPackage.manifest.manifest_digest);
  assert.equal(result.manifest.provenance.checkpoint_lineage.authority_receipt_digest, digest('b'));
  assert.match(result.transition_receipt.receipt_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(value.signer.private_key_pem.trim()), false);
  assert.equal(JSON.stringify(result).includes(value.device.private_key_pem.trim()), false);

  const candidateHome = path.join(value.root, 'candidate-home');
  await pullEncryptedModel(result.manifest_path, {
    home: candidateHome,
    trusted_public_keys: [value.signer.public_key_pem],
    recipient_private_keys: [value.device.private_key_pem]
  });
  const installed = await inspectModel('archie-checkpoint-fixture@1.1.0', { home: candidateHome });
  assert.equal(installed.manifest.state.immutable_digest, value.parentMetadata.state.immutable_digest);
  assert.equal(installed.manifest.state.mutable_digest, value.candidateMetadata.state.mutable_digest);
  const run = await runModel('archie-checkpoint-fixture@1.1.0', {
    home: candidateHome,
    prompt: 'updated state',
    runner_path: process.execPath,
    context: 512,
    max_tokens: 16,
    env: { ...process.env, OPENAI_API_KEY: '', SIDEWAYS_MODEL_API_KEY: '' }
  });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /^CHECKPOINT:updated state:archie-candidate\.gguf/m);
});

test('transition validation rejects immutable, ABI, runtime, region, version, and stale-evaluation drift', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  const parent = value.parentPackage.manifest;

  const mutate = fn => {
    const metadata = structuredClone(value.candidateMetadata);
    const lineage = structuredClone(value.lineage);
    fn(metadata, lineage);
    return () => validateCheckpointTransition(parent, metadata, lineage);
  };

  assert.throws(mutate(metadata => { metadata.model.id = 'other-model'; }), /model\.id/);
  assert.throws(mutate(metadata => { metadata.model.version = '1.0.0'; }), /new model\.version/);
  assert.throws(mutate(metadata => { metadata.model.runtime_abi = 'archie-runtime/v2'; }), /runtime_abi/);
  assert.throws(mutate(metadata => { metadata.state.immutable_digest = digest('d'); }), /immutable-state/);
  assert.throws(mutate(metadata => { metadata.state.mutable_digest = value.parentMetadata.state.mutable_digest; }), /changed mutable-state/);
  assert.throws(mutate(metadata => { metadata.state.mutable_regions.push('new.region'); }), /mutable regions/);
  assert.throws(mutate(metadata => { metadata.runtime.arguments = [...metadata.runtime.arguments, '--unsafe']; }), /runtime adapter/);
  assert.throws(mutate((metadata, lineage) => {
    metadata.benchmarks.report_digest = value.parentMetadata.benchmarks.report_digest;
    lineage.evaluation_receipt_digest = metadata.benchmarks.report_digest;
  }), /fresh benchmark/);
});

test('transition validation rejects stale parent expectations, malformed provenance, and private material', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  const parent = value.parentPackage.manifest;

  const staleParent = structuredClone(value.lineage);
  staleParent.parent.manifest_digest = digest('f');
  assert.throws(() => validateCheckpointTransition(parent, value.candidateMetadata, staleParent), /parent manifest digest mismatch/);

  const wrongEvaluation = structuredClone(value.lineage);
  wrongEvaluation.evaluation_receipt_digest = digest('e');
  assert.throws(() => validateCheckpointTransition(parent, value.candidateMetadata, wrongEvaluation), /benchmark report digest/);

  const secretMetadata = structuredClone(value.candidateMetadata);
  secretMetadata.provenance.private_key = '-----BEGIN PRIVATE KEY-----\nforbidden';
  assert.throws(() => validateCheckpointTransition(parent, secretMetadata, value.lineage), /secret-like|private key material/i);

  const duplicateRejected = structuredClone(value.lineage);
  duplicateRejected.rejected_checkpoint_digests.push(duplicateRejected.rejected_checkpoint_digests[0]);
  assert.throws(() => validateCheckpointTransition(parent, value.candidateMetadata, duplicateRejected), /must not contain duplicates/);
});
