import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  assertCompatibleCheckpoint,
  createArchieCheckpoint,
  createArchieModelManifest,
  validateArchieCheckpoint,
  validateArchieModelManifest
} from '../archie-model-contract.mjs';

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function manifest(overrides = {}) {
  return createArchieModelManifest({
    model_id: 'archie-generation-one-fixture',
    version: '0.1.0',
    display_name: 'Archie Generation One Fixture',
    license: 'Apache-2.0',
    claim_boundary: 'Contract fixture only; no capability claim.',
    immutable: {
      runtime_abi: 'archie-runtime/v1',
      architecture: 'dense-transformer-plus-symbolic-control',
      architecture_config: { layers: 2, hidden_size: 64 },
      axioms: { maker_is_only_effect_executor: true, evidence_bound_promotion: true },
      authority: { external_writes_require_grant: true },
      state_schema: 'archie-learned-state/v1',
      allowed_learning_operations: ['adapter-update', 'calibration-update', 'negative-memory-append']
    },
    mutable: {
      parameters_digest: sha('parameters'),
      sparse_state_digest: sha('sparse'),
      graph_state_digest: sha('graph'),
      routing_weights_digest: sha('routing'),
      action_transition_digest: sha('actions'),
      uncertainty_calibration_digest: sha('calibration'),
      negative_lessons_digest: sha('negative')
    },
    artifacts: [{
      name: 'student.gguf',
      media_type: 'application/octet-stream',
      format: 'gguf',
      quantization: 'Q4_K_M',
      size_bytes: 12,
      sha256: sha('artifact'),
      chunks: [
        { index: 0, size_bytes: 5, sha256: sha('chunk-0') },
        { index: 1, size_bytes: 7, sha256: sha('chunk-1') }
      ]
    }],
    compressed_download_bytes: 12,
    installed_bytes: 12,
    hardware: {
      required_ram_bytes: 1024,
      recommended_ram_bytes: 2048,
      required_disk_bytes: 12,
      context_limit: 8192,
      cpu_backends: ['llama.cpp'],
      gpu_backends: []
    },
    provenance: {
      code_commit: sha('code'),
      dataset_digests: [sha('sidepus-manifest')],
      trajectory_batch_digests: [sha('trajectory-batch')],
      teacher_ids: ['teacher-a'],
      teacher_model_ids: ['teacher-model-a'],
      seed: 42,
      optimizer: { name: 'adamw' },
      training_config: { epochs: 1 },
      benchmark_receipt_digests: [sha('benchmark')],
      rejected_checkpoint_digests: []
    },
    ...overrides
  });
}

function checkpoint(model, overrides = {}) {
  return createArchieCheckpoint({
    model_id: model.model_id,
    version: model.version,
    runtime_abi: model.immutable.runtime_abi,
    immutable_state_digest: model.immutable_state_digest,
    mutable: model.mutable,
    training_run_digest: sha('training-run'),
    benchmark_receipt_digests: [sha('benchmark')],
    ...overrides
  });
}

test('manifest separates immutable architecture from mutable learned state', () => {
  const model = manifest();
  assert.notEqual(model.immutable_state_digest, model.mutable_checkpoint_digest);
  assert.equal(model.immutable.authority.external_writes_require_grant, true);
  assert.equal(validateArchieModelManifest(model).manifest_digest, model.manifest_digest);
});

test('manifest validation rejects immutable tampering', () => {
  const model = manifest();
  const tampered = {
    ...model,
    immutable: { ...model.immutable, authority: { external_writes_require_grant: false } }
  };
  assert.throws(() => validateArchieModelManifest(tampered), /Immutable-state digest mismatch/);
});

test('checkpoint validation rejects mutable-state tampering', () => {
  const model = manifest();
  const candidate = checkpoint(model);
  const tampered = {
    ...candidate,
    mutable: { ...candidate.mutable, routing_weights_digest: sha('tampered-routing') }
  };
  assert.throws(() => validateArchieCheckpoint(tampered), /mutable-state integrity/);
});

test('compatible checkpoint is bound to exact runtime ABI and immutable digest', () => {
  const model = manifest();
  const candidate = checkpoint(model);
  const result = assertCompatibleCheckpoint(model, candidate);
  assert.equal(result.compatible, true);
  assert.equal(result.immutable_state_digest, model.immutable_state_digest);
});

test('runtime ABI mismatch fails closed', () => {
  const model = manifest();
  const candidate = checkpoint(model, { runtime_abi: 'archie-runtime/v2' });
  assert.throws(() => assertCompatibleCheckpoint(model, candidate), /runtime-abi-mismatch/);
});

test('checkpoint without held-out benchmark receipt cannot load by default', () => {
  const model = manifest();
  const candidate = checkpoint(model, { benchmark_receipt_digests: [] });
  assert.throws(() => assertCompatibleCheckpoint(model, candidate), /missing-benchmark-receipt/);
});

test('rejected checkpoint remains recorded but cannot load', () => {
  const model = manifest();
  const candidate = checkpoint(model, { rejected: true, rejection_reasons: ['held-out-regression'] });
  assert.throws(() => assertCompatibleCheckpoint(model, candidate), /checkpoint-rejected/);
});

test('artifact chunk sizes must exactly equal declared artifact size', () => {
  assert.throws(() => manifest({
    artifacts: [{
      name: 'bad.gguf',
      media_type: 'application/octet-stream',
      format: 'gguf',
      size_bytes: 12,
      sha256: sha('bad-artifact'),
      chunks: [{ index: 0, size_bytes: 11, sha256: sha('bad-chunk') }]
    }]
  }), /chunk sizes/);
});
