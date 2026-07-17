import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  assertCompatibleCheckpoint,
  assertStateContractMatchesManifest,
  createArchieCheckpoint,
  createArchieStateContract,
  validateArchieCheckpoint,
  validateArchieStateContract
} from '../archie-model-contract.mjs';

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const git = value => sha(value).slice(0, 40);

function stateContract(overrides = {}) {
  return createArchieStateContract({
    runtime_abi: 'archie-runtime/v1',
    architecture: 'dense-transformer-plus-symbolic-control',
    architecture_config: { layers: 2, hidden_size: 64 },
    axioms: { maker_is_only_effect_executor: true, evidence_bound_promotion: true },
    authority: { external_writes_require_grant: true },
    state_schema: 'archie-learned-state/v1',
    allowed_learning_operations: ['adapter-update', 'calibration-update', 'negative-memory-append'],
    mutable_state: {
      parameters_digest: sha('parameters'),
      sparse_state_digest: sha('sparse'),
      graph_state_digest: sha('graph'),
      routing_weights_digest: sha('routing'),
      action_transition_digest: sha('actions'),
      uncertainty_calibration_digest: sha('calibration'),
      negative_lessons_digest: sha('negative')
    },
    ...overrides
  });
}

function manifest(contract, overrides = {}) {
  return {
    schema: 'archie-model-manifest/v1',
    model: {
      id: 'archie-generation-one-fixture',
      version: '0.1.0',
      architecture: contract.immutable.architecture,
      runtime_abi: contract.immutable.runtime_abi,
      format: 'gguf',
      quantization: 'Q4_K_M',
      context_limit: 8192
    },
    state: {
      immutable_digest: contract.immutable_digest,
      mutable_digest: contract.mutable_digest,
      mutable_regions: contract.mutable_regions
    },
    manifest_digest: sha('signed-manifest'),
    ...overrides
  };
}

function checkpoint(model, contract, overrides = {}) {
  return createArchieCheckpoint({
    model_id: model.model.id,
    version: model.model.version,
    manifest_digest: model.manifest_digest,
    runtime_abi: model.model.runtime_abi,
    immutable_digest: contract.immutable_digest,
    mutable_state: contract.mutable,
    training: {
      code_commit: git('code'),
      dataset_digests: [sha('sidepus-manifest')],
      trajectory_batch_digests: [sha('trajectory-batch')],
      teacher_ids: ['teacher-a'],
      teacher_model_ids: ['teacher-model-a'],
      seed: 42,
      optimizer: { name: 'adamw' },
      config: { epochs: 1 }
    },
    benchmark_receipt_digests: [sha('held-out-benchmark')],
    ...overrides
  });
}

test('state contract separates immutable architecture from mutable learned state', () => {
  const contract = stateContract();
  assert.notEqual(contract.immutable_digest, contract.mutable_digest);
  assert.equal(contract.immutable.authority.external_writes_require_grant, true);
  assert.ok(contract.mutable_regions.includes('routing_weights_digest'));
  assert.equal(validateArchieStateContract(contract).state_contract_digest, contract.state_contract_digest);
});

test('state contract validation rejects immutable tampering', () => {
  const contract = stateContract();
  const tampered = {
    ...contract,
    immutable: { ...contract.immutable, authority: { external_writes_require_grant: false } }
  };
  assert.throws(() => validateArchieStateContract(tampered), /Immutable-state digest mismatch/);
});

test('state contract binds to the existing signed manifest state fields', () => {
  const contract = stateContract();
  const model = manifest(contract);
  const result = assertStateContractMatchesManifest(model, contract);
  assert.equal(result.compatible, true);
  assert.equal(result.manifest_digest, model.manifest_digest);
});

test('manifest state mismatch fails closed', () => {
  const contract = stateContract();
  const model = manifest(contract, { state: { ...manifest(contract).state, immutable_digest: sha('wrong') } });
  assert.throws(() => assertStateContractMatchesManifest(model, contract), /immutable-state-mismatch/);
});

test('checkpoint validation rejects mutable-state tampering', () => {
  const contract = stateContract();
  const model = manifest(contract);
  const candidate = checkpoint(model, contract);
  const tampered = {
    ...candidate,
    mutable: { ...candidate.mutable, routing_weights_digest: sha('tampered-routing') }
  };
  assert.throws(() => validateArchieCheckpoint(tampered), /mutable-state integrity/);
});

test('compatible checkpoint requires the trusted manifest verification receipt', () => {
  const contract = stateContract();
  const model = manifest(contract);
  const candidate = checkpoint(model, contract);
  const verification = { manifest_digest: model.manifest_digest, trust: 'trusted' };
  const result = assertCompatibleCheckpoint(model, verification, candidate);
  assert.equal(result.compatible, true);
  assert.equal(result.immutable_digest, contract.immutable_digest);
});

test('untrusted or absent manifest verification fails closed', () => {
  const contract = stateContract();
  const model = manifest(contract);
  const candidate = checkpoint(model, contract);
  assert.throws(() => assertCompatibleCheckpoint(model, null, candidate), /manifest-not-verified/);
  assert.throws(() => assertCompatibleCheckpoint(model, { manifest_digest: model.manifest_digest, trust: 'self-signed-untrusted' }, candidate), /manifest-not-trusted/);
});

test('runtime ABI and immutable state mismatches fail closed', () => {
  const contract = stateContract();
  const model = manifest(contract);
  const verification = { manifest_digest: model.manifest_digest, trust: 'trusted' };
  assert.throws(() => assertCompatibleCheckpoint(model, verification, checkpoint(model, contract, { runtime_abi: 'archie-runtime/v2' })), /runtime-abi-mismatch/);
  assert.throws(() => assertCompatibleCheckpoint(model, verification, checkpoint(model, contract, { immutable_digest: sha('wrong') })), /immutable-state-mismatch/);
});

test('checkpoint without held-out benchmark receipt cannot load by default', () => {
  const contract = stateContract();
  const model = manifest(contract);
  const verification = { manifest_digest: model.manifest_digest, trust: 'trusted' };
  const candidate = checkpoint(model, contract, { benchmark_receipt_digests: [] });
  assert.throws(() => assertCompatibleCheckpoint(model, verification, candidate), /missing-benchmark-receipt/);
});

test('rejected checkpoint remains recorded but cannot load', () => {
  const contract = stateContract();
  const model = manifest(contract);
  const verification = { manifest_digest: model.manifest_digest, trust: 'trusted' };
  const candidate = checkpoint(model, contract, { rejected: true, rejection_reasons: ['held-out-regression'] });
  assert.throws(() => assertCompatibleCheckpoint(model, verification, candidate), /checkpoint-rejected/);
});
