import crypto from 'node:crypto';

export const ARCHIE_BRAIN_PACKAGE_SCHEMA = 'archie-brain-package/v1';
export const ARCHIE_BRAIN_SIGNATURE_SCHEMA = 'archie-brain-signature/v1';
export const ARCHIE_ACTIVATION_RECEIPT_SCHEMA = 'archie-brain-activation/v1';
export const ARCHIE_ROLLBACK_RECEIPT_SCHEMA = 'archie-brain-rollback/v1';

const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');

function without(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function requireDigest(value, name) {
  const result = clean(value, 200);
  if (!/^[a-f0-9]{64}$/i.test(result)) throw new Error(`${name} must be a SHA-256 digest.`);
  return result.toLowerCase();
}

export function createUnsignedArchieBrainPackage(value = {}) {
  const packageId = clean(value?.package_id, 300);
  const runtimeAbi = clean(value?.runtime_abi, 300);
  const workingStateSchema = clean(value?.working_state_schema, 300);
  if (!packageId || !runtimeAbi || !workingStateSchema) throw new Error('Archie package_id, runtime_abi, and working_state_schema are required.');
  const artifacts = (Array.isArray(value?.artifacts) ? value.artifacts : []).map(item => ({
    role: clean(item?.role, 200),
    digest: requireDigest(item?.digest, 'artifact digest'),
    bytes: Math.max(0, Number(item?.bytes || 0)),
    media_type: clean(item?.media_type || 'application/octet-stream', 200)
  })).sort((left, right) => left.role.localeCompare(right.role) || left.digest.localeCompare(right.digest));
  if (!artifacts.length || artifacts.some(item => !item.role)) throw new Error('At least one named Archie brain artifact is required.');
  const body = {
    schema: ARCHIE_BRAIN_PACKAGE_SCHEMA,
    package_id: packageId,
    runtime_abi: runtimeAbi,
    working_state_schema: workingStateSchema,
    tokenizer: value?.tokenizer ?? null,
    architecture: value?.architecture ?? null,
    artifacts,
    sidepus_manifest_digests: [...new Set((value?.sidepus_manifest_digests || []).map(item => requireDigest(item, 'Sidepus manifest digest')))].sort(),
    evaluation_receipts: Array.isArray(value?.evaluation_receipts) ? value.evaluation_receipts : [],
    authority_policy: value?.authority_policy ?? null,
    hardware_envelope: value?.hardware_envelope ?? null,
    parent_digest: value?.parent_digest ? requireDigest(value.parent_digest, 'parent digest') : null,
    metadata: value?.metadata ?? null
  };
  return Object.freeze({ ...body, package_digest: digest(body) });
}

export function verifyArchieBrainPackage(value, { public_keys = {}, supported_runtime_abis = null } = {}) {
  if (value?.schema !== ARCHIE_BRAIN_PACKAGE_SCHEMA) throw new Error('Invalid Archie brain-package schema.');
  const unsigned = without(value, 'signature');
  const expectedDigest = digest(without(unsigned, 'package_digest'));
  if (unsigned.package_digest !== expectedDigest) throw new Error('Archie brain-package integrity check failed.');
  if (supported_runtime_abis && !new Set(supported_runtime_abis).has(value.runtime_abi)) throw new Error(`Unsupported Archie runtime ABI: ${value.runtime_abi}.`);
  const signature = value?.signature;
  if (signature?.schema !== ARCHIE_BRAIN_SIGNATURE_SCHEMA || signature.algorithm !== 'Ed25519') throw new Error('Archie brain package is not Trainer-signed.');
  const publicKey = public_keys instanceof Map ? public_keys.get(signature.key_id) : public_keys?.[signature.key_id];
  if (!publicKey) throw new Error(`Unknown Archie Trainer key: ${signature.key_id}.`);
  const ok = crypto.verify(null, Buffer.from(value.package_digest, 'utf8'), publicKey, Buffer.from(signature.value, 'base64'));
  if (!ok) throw new Error('Archie Trainer signature verification failed.');
  return Object.freeze({ verified: true, package_digest: value.package_digest, key_id: signature.key_id });
}

function activationMode(current, candidate) {
  if (!current) return 'cold-start';
  return current.runtime_abi === candidate.runtime_abi && current.working_state_schema === candidate.working_state_schema
    ? 'hot-swap'
    : 'controlled-core-restart';
}

export class ArchieTrainerAuthority {
  #privateKey;

  constructor({ key_id, private_key, public_keys = {}, supported_runtime_abis = null, clock = Date.now } = {}) {
    if (!clean(key_id, 300) || !private_key) throw new Error('Archie Trainer key_id and private_key are required.');
    this.keyId = clean(key_id, 300);
    this.#privateKey = private_key;
    this.publicKeys = public_keys instanceof Map ? new Map(public_keys) : new Map(Object.entries(public_keys));
    this.supportedRuntimeAbis = supported_runtime_abis;
    this.clock = clock;
  }

  build(value) {
    return createUnsignedArchieBrainPackage(value);
  }

  sign(unsignedPackage) {
    const expected = createUnsignedArchieBrainPackage(unsignedPackage);
    if (expected.package_digest !== unsignedPackage.package_digest) throw new Error('Trainer refused a non-canonical Archie brain package.');
    const signature = crypto.sign(null, Buffer.from(unsignedPackage.package_digest, 'utf8'), this.#privateKey).toString('base64');
    return Object.freeze({
      ...unsignedPackage,
      signature: Object.freeze({
        schema: ARCHIE_BRAIN_SIGNATURE_SCHEMA,
        algorithm: 'Ed25519',
        key_id: this.keyId,
        value: signature
      })
    });
  }

  verify(packageValue) {
    return verifyArchieBrainPackage(packageValue, { public_keys: this.publicKeys, supported_runtime_abis: this.supportedRuntimeAbis });
  }

  promote(candidate, { current = null, shadow_evaluation, migration_adapter = null } = {}) {
    this.verify(candidate);
    if (current) this.verify(current);
    if (current && candidate.parent_digest !== current.package_digest) throw new Error('Archie candidate package is not based on the active rollback parent.');
    if (!shadow_evaluation?.passed) throw new Error('Archie Trainer promotion requires passing shadow evaluation evidence.');
    const mode = activationMode(current, candidate);
    if (mode === 'controlled-core-restart' && !migration_adapter) throw new Error('Controlled Core restart requires a versioned state migration adapter.');
    const body = {
      schema: ARCHIE_ACTIVATION_RECEIPT_SCHEMA,
      activated_at: new Date(this.clock()).toISOString(),
      prior_package_digest: current?.package_digest || null,
      candidate_package_digest: candidate.package_digest,
      mode,
      shadow_evaluation,
      migration_adapter,
      trainer_key_id: this.keyId,
      rollback_package_digest: current?.package_digest || null
    };
    const receiptDigest = digest(body);
    const signature = crypto.sign(null, Buffer.from(receiptDigest, 'utf8'), this.#privateKey).toString('base64');
    return Object.freeze({ ...body, receipt_digest: receiptDigest, signature: { schema: ARCHIE_BRAIN_SIGNATURE_SCHEMA, algorithm: 'Ed25519', key_id: this.keyId, value: signature } });
  }

  rollback(activationReceipt, { reason }) {
    if (!activationReceipt?.rollback_package_digest) throw new Error('Archie activation receipt has no rollback package.');
    const body = {
      schema: ARCHIE_ROLLBACK_RECEIPT_SCHEMA,
      rolled_back_at: new Date(this.clock()).toISOString(),
      activation_receipt_digest: clean(activationReceipt.receipt_digest, 200),
      from_package_digest: activationReceipt.candidate_package_digest,
      to_package_digest: activationReceipt.rollback_package_digest,
      reason: clean(reason || 'post-activation gate violation', 5000),
      trainer_key_id: this.keyId
    };
    const receiptDigest = digest(body);
    const signature = crypto.sign(null, Buffer.from(receiptDigest, 'utf8'), this.#privateKey).toString('base64');
    return Object.freeze({ ...body, receipt_digest: receiptDigest, signature: { schema: ARCHIE_BRAIN_SIGNATURE_SCHEMA, algorithm: 'Ed25519', key_id: this.keyId, value: signature } });
  }
}
