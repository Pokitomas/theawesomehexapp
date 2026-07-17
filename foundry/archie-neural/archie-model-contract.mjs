import crypto from 'node:crypto';

export const ARCHIE_MODEL_MANIFEST_SCHEMA = 'archie-model-manifest/v1';
export const ARCHIE_RUNTIME_ABI = 'archie-runtime/v1';
export const ARCHIE_STATE_CONTRACT_SCHEMA = 'archie-state-contract/v1';
export const ARCHIE_CHECKPOINT_SCHEMA = 'archie-checkpoint/v1';
export const ARCHIE_CHECKPOINT_COMPATIBILITY_SCHEMA = 'archie-checkpoint-compatibility/v1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OID_PATTERN = /^[a-f0-9]{40,64}$/;
const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function stable(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function sha256(value, field, { required = true } = {}) {
  const normalized = clean(value, 128).toLowerCase();
  if (!normalized && !required) return null;
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${field} must be a SHA-256 hex digest.`);
  return normalized;
}

function gitOid(value, field, { required = true } = {}) {
  const normalized = clean(value, 128).toLowerCase();
  if (!normalized && !required) return null;
  if (!GIT_OID_PATTERN.test(normalized)) throw new Error(`${field} must be a 40- or 64-character Git object ID.`);
  return normalized;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return canonical(value);
}

function strings(value, field, { requireOne = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const normalized = [...new Set(value.map(item => clean(item, 1000)).filter(Boolean))].sort();
  if (requireOne && !normalized.length) throw new Error(`${field} requires at least one value.`);
  return normalized;
}

function digests(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return [...new Set(value.map((item, index) => sha256(item, `${field}[${index}]`)))].sort();
}

function normalizeMutableState(value) {
  const item = object(value, 'mutable_state');
  const fields = [
    'parameters_digest',
    'sparse_state_digest',
    'graph_state_digest',
    'routing_weights_digest',
    'action_transition_digest',
    'uncertainty_calibration_digest',
    'negative_lessons_digest',
    'episodic_memory_digest',
    'retrieval_index_digest'
  ];
  const normalized = Object.fromEntries(fields.map(field => [field, sha256(item[field], `mutable_state.${field}`, { required: false })]));
  if (!Object.values(normalized).some(Boolean)) throw new Error('mutable_state requires at least one learned-state digest.');
  return Object.freeze(normalized);
}

export function createArchieStateContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Archie state contract must be an object.');
  if (value.schema && value.schema !== ARCHIE_STATE_CONTRACT_SCHEMA) throw new Error(`State contract schema must be ${ARCHIE_STATE_CONTRACT_SCHEMA}.`);
  const runtimeAbi = clean(value.runtime_abi || ARCHIE_RUNTIME_ABI, 300);
  if (runtimeAbi !== ARCHIE_RUNTIME_ABI) throw new Error(`runtime ABI mismatch: expected ${ARCHIE_RUNTIME_ABI}.`);
  const architecture = clean(value.architecture, 1000);
  if (!architecture) throw new Error('architecture is required.');
  const immutable = Object.freeze({
    runtime_abi: runtimeAbi,
    architecture,
    architecture_config: value.architecture_config && typeof value.architecture_config === 'object' && !Array.isArray(value.architecture_config) ? canonical(value.architecture_config) : {},
    axioms: object(value.axioms, 'axioms'),
    authority: object(value.authority, 'authority'),
    state_schema: clean(value.state_schema, 500),
    allowed_learning_operations: strings(value.allowed_learning_operations || [], 'allowed_learning_operations', { requireOne: true })
  });
  if (!immutable.state_schema) throw new Error('state_schema is required.');
  const mutable = normalizeMutableState(value.mutable_state || value.mutable || {});
  const mutableRegions = Object.entries(mutable).filter(([, item]) => item).map(([field]) => field).sort();
  const body = {
    schema: ARCHIE_STATE_CONTRACT_SCHEMA,
    immutable,
    mutable,
    immutable_digest: digest(immutable),
    mutable_digest: digest(mutable),
    mutable_regions: mutableRegions
  };
  return Object.freeze({ ...body, state_contract_digest: digest(body) });
}

export function validateArchieStateContract(value) {
  const normalized = createArchieStateContract({
    schema: value?.schema,
    runtime_abi: value?.immutable?.runtime_abi ?? value?.runtime_abi,
    architecture: value?.immutable?.architecture ?? value?.architecture,
    architecture_config: value?.immutable?.architecture_config ?? value?.architecture_config,
    axioms: value?.immutable?.axioms ?? value?.axioms,
    authority: value?.immutable?.authority ?? value?.authority,
    state_schema: value?.immutable?.state_schema ?? value?.state_schema,
    allowed_learning_operations: value?.immutable?.allowed_learning_operations ?? value?.allowed_learning_operations,
    mutable_state: value?.mutable ?? value?.mutable_state
  });
  if (value?.immutable_digest && value.immutable_digest !== normalized.immutable_digest) throw new Error('Immutable-state digest mismatch.');
  if (value?.mutable_digest && value.mutable_digest !== normalized.mutable_digest) throw new Error('Mutable-state digest mismatch.');
  if (value?.state_contract_digest && value.state_contract_digest !== normalized.state_contract_digest) throw new Error('State-contract integrity check failed.');
  return normalized;
}

export function assertStateContractMatchesManifest(manifest, contractValue) {
  if (!manifest || manifest.schema !== ARCHIE_MODEL_MANIFEST_SCHEMA) throw new Error('Unsupported Archie model manifest schema.');
  const contract = validateArchieStateContract(contractValue);
  const reasons = [];
  if (clean(manifest.model?.runtime_abi, 300) !== contract.immutable.runtime_abi) reasons.push('runtime-abi-mismatch');
  if (clean(manifest.model?.architecture, 1000) !== contract.immutable.architecture) reasons.push('architecture-mismatch');
  if (clean(manifest.state?.immutable_digest, 128) !== contract.immutable_digest) reasons.push('immutable-state-mismatch');
  if (clean(manifest.state?.mutable_digest, 128) !== contract.mutable_digest) reasons.push('mutable-state-mismatch');
  const manifestRegions = strings(manifest.state?.mutable_regions || [], 'manifest.state.mutable_regions');
  if (stable(manifestRegions) !== stable(contract.mutable_regions)) reasons.push('mutable-regions-mismatch');
  if (reasons.length) throw new Error(`Archie state contract does not match manifest: ${reasons.join(', ')}.`);
  return Object.freeze({
    compatible: true,
    manifest_digest: sha256(manifest.manifest_digest, 'manifest.manifest_digest'),
    state_contract_digest: contract.state_contract_digest,
    immutable_digest: contract.immutable_digest,
    mutable_digest: contract.mutable_digest
  });
}

function normalizeTraining(value) {
  const item = object(value, 'training');
  return Object.freeze({
    code_commit: gitOid(item.code_commit, 'training.code_commit'),
    dataset_digests: digests(item.dataset_digests || [], 'training.dataset_digests'),
    trajectory_batch_digests: digests(item.trajectory_batch_digests || [], 'training.trajectory_batch_digests'),
    teacher_ids: strings(item.teacher_ids || [], 'training.teacher_ids'),
    teacher_model_ids: strings(item.teacher_model_ids || [], 'training.teacher_model_ids'),
    seed: Number.isSafeInteger(Number(item.seed)) ? Number(item.seed) : null,
    optimizer: item.optimizer && typeof item.optimizer === 'object' && !Array.isArray(item.optimizer) ? canonical(item.optimizer) : {},
    config: item.config && typeof item.config === 'object' && !Array.isArray(item.config) ? canonical(item.config) : {}
  });
}

export function createArchieCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Archie checkpoint must be an object.');
  if (value.schema && value.schema !== ARCHIE_CHECKPOINT_SCHEMA) throw new Error(`Checkpoint schema must be ${ARCHIE_CHECKPOINT_SCHEMA}.`);
  const mutable = normalizeMutableState(value.mutable_state || value.mutable || {});
  const modelId = clean(value.model_id, 500);
  const version = clean(value.version, 300);
  const runtimeAbi = clean(value.runtime_abi, 300);
  if (!modelId || !version || !runtimeAbi) throw new Error('model_id, version, and runtime_abi are required.');
  const body = {
    schema: ARCHIE_CHECKPOINT_SCHEMA,
    model_id: modelId,
    version,
    manifest_digest: sha256(value.manifest_digest, 'manifest_digest'),
    runtime_abi: runtimeAbi,
    immutable_digest: sha256(value.immutable_digest, 'immutable_digest'),
    mutable,
    mutable_digest: digest(mutable),
    parent_checkpoint_digest: sha256(value.parent_checkpoint_digest, 'parent_checkpoint_digest', { required: false }),
    training: normalizeTraining(value.training || {}),
    benchmark_receipt_digests: digests(value.benchmark_receipt_digests || [], 'benchmark_receipt_digests'),
    rejected: value.rejected === true,
    rejection_reasons: strings(value.rejection_reasons || [], 'rejection_reasons')
  };
  return Object.freeze({ ...body, checkpoint_digest: digest(body) });
}

export function validateArchieCheckpoint(value) {
  const normalized = createArchieCheckpoint(value || {});
  if (value?.mutable_digest && value.mutable_digest !== normalized.mutable_digest) throw new Error('Checkpoint mutable-state integrity check failed.');
  if (value?.checkpoint_digest && value.checkpoint_digest !== normalized.checkpoint_digest) throw new Error('Checkpoint integrity check failed.');
  return normalized;
}

export function assertCompatibleCheckpoint(manifest, manifestVerification, checkpointValue, {
  require_trusted_manifest = true,
  require_benchmark_receipt = true,
  allow_rejected = false
} = {}) {
  const checkpoint = validateArchieCheckpoint(checkpointValue);
  const reasons = [];
  if (!manifestVerification || manifestVerification.manifest_digest !== manifest?.manifest_digest) reasons.push('manifest-not-verified');
  if (require_trusted_manifest && manifestVerification?.trust !== 'trusted') reasons.push('manifest-not-trusted');
  if (checkpoint.manifest_digest !== manifest?.manifest_digest) reasons.push('manifest-digest-mismatch');
  if (checkpoint.model_id !== clean(manifest?.model?.id, 500)) reasons.push('model-id-mismatch');
  if (checkpoint.version !== clean(manifest?.model?.version, 300)) reasons.push('model-version-mismatch');
  if (checkpoint.runtime_abi !== clean(manifest?.model?.runtime_abi, 300)) reasons.push('runtime-abi-mismatch');
  if (checkpoint.immutable_digest !== clean(manifest?.state?.immutable_digest, 128)) reasons.push('immutable-state-mismatch');
  if (checkpoint.mutable_digest !== clean(manifest?.state?.mutable_digest, 128)) reasons.push('mutable-state-mismatch');
  if (require_benchmark_receipt && !checkpoint.benchmark_receipt_digests.length) reasons.push('missing-benchmark-receipt');
  if (checkpoint.rejected && !allow_rejected) reasons.push('checkpoint-rejected');
  if (reasons.length) throw new Error(`Archie checkpoint is incompatible: ${reasons.join(', ')}.`);
  const body = {
    schema: ARCHIE_CHECKPOINT_COMPATIBILITY_SCHEMA,
    manifest_digest: checkpoint.manifest_digest,
    checkpoint_digest: checkpoint.checkpoint_digest,
    immutable_digest: checkpoint.immutable_digest,
    mutable_digest: checkpoint.mutable_digest,
    trust: manifestVerification.trust,
    compatible: true
  };
  return Object.freeze({ ...body, compatibility_digest: digest(body) });
}
