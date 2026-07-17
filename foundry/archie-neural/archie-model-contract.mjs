import crypto from 'node:crypto';

export const ARCHIE_MODEL_MANIFEST_SCHEMA = 'archie-model-manifest/v1';
export const ARCHIE_CHECKPOINT_SCHEMA = 'archie-checkpoint/v1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
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

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return canonical(value);
}

function stringArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return [...new Set(value.map(item => clean(item, 1000)).filter(Boolean))].sort();
}

function digestArray(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const result = [...new Set(value.map((item, index) => sha256(item, `${field}[${index}]`)))].sort();
  if (!allowEmpty && !result.length) throw new Error(`${field} requires at least one digest.`);
  return result;
}

function normalizeImmutable(value) {
  const item = object(value, 'immutable');
  const runtimeAbi = clean(item.runtime_abi, 300);
  if (!runtimeAbi) throw new Error('immutable.runtime_abi is required.');
  const architecture = clean(item.architecture, 500);
  if (!architecture) throw new Error('immutable.architecture is required.');
  const axioms = object(item.axioms, 'immutable.axioms');
  const authority = object(item.authority, 'immutable.authority');
  const stateSchema = clean(item.state_schema, 500);
  if (!stateSchema) throw new Error('immutable.state_schema is required.');
  const allowedLearningOperations = stringArray(item.allowed_learning_operations || [], 'immutable.allowed_learning_operations');
  if (!allowedLearningOperations.length) throw new Error('immutable.allowed_learning_operations requires at least one operation.');
  return Object.freeze({
    runtime_abi: runtimeAbi,
    architecture,
    architecture_config: item.architecture_config && typeof item.architecture_config === 'object' && !Array.isArray(item.architecture_config) ? canonical(item.architecture_config) : {},
    axioms,
    authority,
    state_schema: stateSchema,
    allowed_learning_operations: allowedLearningOperations
  });
}

function normalizeMutable(value) {
  const item = object(value, 'mutable');
  const fields = [
    'parameters_digest',
    'sparse_state_digest',
    'graph_state_digest',
    'routing_weights_digest',
    'action_transition_digest',
    'uncertainty_calibration_digest',
    'negative_lessons_digest'
  ];
  const normalized = Object.fromEntries(fields.map(field => [field, sha256(item[field], `mutable.${field}`, { required: false })]));
  if (!Object.values(normalized).some(Boolean)) throw new Error('mutable state requires at least one learned-state digest.');
  return Object.freeze(normalized);
}

function normalizeArtifact(value, index) {
  const item = object(value, `artifacts[${index}]`);
  const size = Number(item.size_bytes);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`artifacts[${index}].size_bytes must be a non-negative safe integer.`);
  const chunks = Array.isArray(item.chunks) ? item.chunks.map((chunk, chunkIndex) => {
    const normalized = object(chunk, `artifacts[${index}].chunks[${chunkIndex}]`);
    const chunkSize = Number(normalized.size_bytes);
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 0) throw new Error(`artifacts[${index}].chunks[${chunkIndex}].size_bytes must be a non-negative safe integer.`);
    return Object.freeze({
      index: Number(normalized.index ?? chunkIndex),
      size_bytes: chunkSize,
      sha256: sha256(normalized.sha256 || normalized.digest, `artifacts[${index}].chunks[${chunkIndex}].sha256`),
      blake3: clean(normalized.blake3, 128) || null
    });
  }).sort((left, right) => left.index - right.index) : [];
  if (chunks.length && chunks.reduce((total, chunk) => total + chunk.size_bytes, 0) !== size) throw new Error(`artifacts[${index}] chunk sizes do not equal artifact size.`);
  return Object.freeze({
    name: clean(item.name, 500),
    media_type: clean(item.media_type, 300),
    format: clean(item.format, 300),
    quantization: clean(item.quantization, 300) || null,
    size_bytes: size,
    sha256: sha256(item.sha256 || item.digest, `artifacts[${index}].sha256`),
    chunks
  });
}

function normalizeProvenance(value) {
  const item = object(value, 'provenance');
  return Object.freeze({
    code_commit: sha256(item.code_commit, 'provenance.code_commit'),
    dataset_digests: digestArray(item.dataset_digests || [], 'provenance.dataset_digests'),
    trajectory_batch_digests: digestArray(item.trajectory_batch_digests || [], 'provenance.trajectory_batch_digests'),
    teacher_ids: stringArray(item.teacher_ids || [], 'provenance.teacher_ids'),
    teacher_model_ids: stringArray(item.teacher_model_ids || [], 'provenance.teacher_model_ids'),
    seed: Number.isSafeInteger(Number(item.seed)) ? Number(item.seed) : null,
    optimizer: item.optimizer && typeof item.optimizer === 'object' && !Array.isArray(item.optimizer) ? canonical(item.optimizer) : {},
    training_config: item.training_config && typeof item.training_config === 'object' && !Array.isArray(item.training_config) ? canonical(item.training_config) : {},
    benchmark_receipt_digests: digestArray(item.benchmark_receipt_digests || [], 'provenance.benchmark_receipt_digests'),
    rejected_checkpoint_digests: digestArray(item.rejected_checkpoint_digests || [], 'provenance.rejected_checkpoint_digests')
  });
}

function normalizeHardware(value) {
  const item = object(value, 'hardware');
  const numeric = field => {
    const number = Number(item[field] ?? 0);
    if (!Number.isFinite(number) || number < 0) throw new Error(`hardware.${field} must be non-negative.`);
    return number;
  };
  return Object.freeze({
    required_ram_bytes: numeric('required_ram_bytes'),
    recommended_ram_bytes: numeric('recommended_ram_bytes'),
    required_disk_bytes: numeric('required_disk_bytes'),
    context_limit: numeric('context_limit'),
    cpu_backends: stringArray(item.cpu_backends || [], 'hardware.cpu_backends'),
    gpu_backends: stringArray(item.gpu_backends || [], 'hardware.gpu_backends')
  });
}

export function createArchieModelManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Archie model manifest must be an object.');
  if (value.schema && value.schema !== ARCHIE_MODEL_MANIFEST_SCHEMA) throw new Error(`Model manifest schema must be ${ARCHIE_MODEL_MANIFEST_SCHEMA}.`);
  const modelId = clean(value.model_id, 500);
  const version = clean(value.version, 300);
  if (!modelId || !version) throw new Error('model_id and version are required.');
  const immutable = normalizeImmutable(value.immutable || {});
  const mutable = normalizeMutable(value.mutable || {});
  const artifacts = (Array.isArray(value.artifacts) ? value.artifacts : []).map(normalizeArtifact).sort((left, right) => left.name.localeCompare(right.name));
  if (!artifacts.length) throw new Error('Model manifest requires at least one artifact.');
  const immutableDigest = digest(immutable);
  const mutableCheckpointDigest = digest(mutable);
  const body = {
    schema: ARCHIE_MODEL_MANIFEST_SCHEMA,
    model_id: modelId,
    version,
    display_name: clean(value.display_name, 1000) || modelId,
    license: clean(value.license, 1000),
    claim_boundary: clean(value.claim_boundary, 10000),
    immutable,
    mutable,
    immutable_state_digest: immutableDigest,
    mutable_checkpoint_digest: mutableCheckpointDigest,
    artifacts,
    compressed_download_bytes: Number(value.compressed_download_bytes ?? artifacts.reduce((total, item) => total + item.size_bytes, 0)),
    installed_bytes: Number(value.installed_bytes ?? artifacts.reduce((total, item) => total + item.size_bytes, 0)),
    hardware: normalizeHardware(value.hardware || {}),
    provenance: normalizeProvenance(value.provenance || {})
  };
  if (!Number.isSafeInteger(body.compressed_download_bytes) || body.compressed_download_bytes < 0) throw new Error('compressed_download_bytes must be a non-negative safe integer.');
  if (!Number.isSafeInteger(body.installed_bytes) || body.installed_bytes < 0) throw new Error('installed_bytes must be a non-negative safe integer.');
  return Object.freeze({ ...body, manifest_digest: digest(body) });
}

export function validateArchieModelManifest(value) {
  const normalized = createArchieModelManifest(value);
  if (value.immutable_state_digest && value.immutable_state_digest !== normalized.immutable_state_digest) throw new Error('Immutable-state digest mismatch.');
  if (value.mutable_checkpoint_digest && value.mutable_checkpoint_digest !== normalized.mutable_checkpoint_digest) throw new Error('Mutable-checkpoint digest mismatch.');
  if (value.manifest_digest && value.manifest_digest !== normalized.manifest_digest) throw new Error('Model manifest integrity check failed.');
  return normalized;
}

export function createArchieCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Archie checkpoint must be an object.');
  if (value.schema && value.schema !== ARCHIE_CHECKPOINT_SCHEMA) throw new Error(`Checkpoint schema must be ${ARCHIE_CHECKPOINT_SCHEMA}.`);
  const mutable = normalizeMutable(value.mutable || {});
  const body = {
    schema: ARCHIE_CHECKPOINT_SCHEMA,
    model_id: clean(value.model_id, 500),
    version: clean(value.version, 300),
    runtime_abi: clean(value.runtime_abi, 300),
    immutable_state_digest: sha256(value.immutable_state_digest, 'immutable_state_digest'),
    mutable,
    mutable_checkpoint_digest: digest(mutable),
    parent_checkpoint_digest: sha256(value.parent_checkpoint_digest, 'parent_checkpoint_digest', { required: false }),
    training_run_digest: sha256(value.training_run_digest, 'training_run_digest'),
    benchmark_receipt_digests: digestArray(value.benchmark_receipt_digests || [], 'benchmark_receipt_digests'),
    rejected: value.rejected === true,
    rejection_reasons: stringArray(value.rejection_reasons || [], 'rejection_reasons')
  };
  if (!body.model_id || !body.version || !body.runtime_abi) throw new Error('Checkpoint model_id, version, and runtime_abi are required.');
  return Object.freeze({ ...body, checkpoint_digest: digest(body) });
}

export function validateArchieCheckpoint(value) {
  const normalized = createArchieCheckpoint(value);
  if (value.mutable_checkpoint_digest && value.mutable_checkpoint_digest !== normalized.mutable_checkpoint_digest) throw new Error('Checkpoint mutable-state integrity check failed.');
  if (value.checkpoint_digest && value.checkpoint_digest !== normalized.checkpoint_digest) throw new Error('Checkpoint integrity check failed.');
  return normalized;
}

export function assertCompatibleCheckpoint(manifestValue, checkpointValue, {
  require_benchmark_receipt = true,
  allow_rejected = false
} = {}) {
  const manifest = validateArchieModelManifest(manifestValue);
  const checkpoint = validateArchieCheckpoint(checkpointValue);
  const reasons = [];
  if (manifest.model_id !== checkpoint.model_id) reasons.push('model-id-mismatch');
  if (manifest.immutable.runtime_abi !== checkpoint.runtime_abi) reasons.push('runtime-abi-mismatch');
  if (manifest.immutable_state_digest !== checkpoint.immutable_state_digest) reasons.push('immutable-state-mismatch');
  if (require_benchmark_receipt && !checkpoint.benchmark_receipt_digests.length) reasons.push('missing-benchmark-receipt');
  if (checkpoint.rejected && !allow_rejected) reasons.push('checkpoint-rejected');
  if (reasons.length) throw new Error(`Archie checkpoint is incompatible: ${reasons.join(', ')}.`);
  return Object.freeze({
    compatible: true,
    manifest_digest: manifest.manifest_digest,
    checkpoint_digest: checkpoint.checkpoint_digest,
    immutable_state_digest: checkpoint.immutable_state_digest,
    mutable_checkpoint_digest: checkpoint.mutable_checkpoint_digest
  });
}
