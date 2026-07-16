#!/usr/bin/env node
import crypto from 'node:crypto';

export const ARCHIE_SYNC_ENVELOPE_SCHEMA = 'archie-encrypted-sync-envelope/v1';
export const ARCHIE_SYNC_RECEIPT_SCHEMA = 'archie-encrypted-sync-receipt/v1';
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 256 * 1024;

const clean = (value, limit = 4000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const b64u = value => Buffer.from(value).toString('base64url');
const fromB64u = value => Buffer.from(value, 'base64url');
const nowISO = clock => new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString();

function validateKey(key) {
  const bytes = Buffer.isBuffer(key) ? key : Buffer.from(key || '');
  if (bytes.length !== 32) throw new Error('Archie sync requires a 32-byte key.');
  return bytes;
}

function aadBody({ namespace, object_id, object_kind, generation, device_id, immutable, tombstone, key_id }) {
  return canonical({ namespace, object_id, object_kind, generation, device_id, immutable, tombstone, key_id });
}

function envelopeDigestBody(envelope) {
  const { envelope_digest, ...body } = envelope;
  return body;
}

export function encryptSyncObject({ key, key_id, device_id, namespace, object_id, object_kind = 'corpus_pack', generation, value, immutable = true, tombstone = false, nonce, clock = Date.now, max_bytes = DEFAULT_MAX_BYTES } = {}) {
  const keyBytes = validateKey(key);
  const meta = {
    namespace: clean(namespace, 200), object_id: clean(object_id, 300), object_kind: clean(object_kind, 100),
    generation: Number(generation), device_id: clean(device_id, 300), immutable: immutable === true,
    tombstone: tombstone === true, key_id: clean(key_id, 200)
  };
  if (!meta.namespace || !meta.object_id || !meta.device_id || !meta.key_id) throw new Error('Sync namespace, object, device and key identifiers are required.');
  if (!Number.isSafeInteger(meta.generation) || meta.generation < 1) throw new Error('Sync generation must be a positive integer.');
  const plaintext = Buffer.from(stable(tombstone ? null : value), 'utf8');
  if (plaintext.length > max_bytes) throw new Error('Sync payload exceeds max_bytes.');
  const iv = nonce ? Buffer.from(nonce) : crypto.randomBytes(12);
  if (iv.length !== 12) throw new Error('AES-GCM nonce must be 12 bytes.');
  const aad = Buffer.from(stable(aadBody(meta)), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = {
    schema: ARCHIE_SYNC_ENVELOPE_SCHEMA,
    created_at: nowISO(clock),
    algorithm: 'aes-256-gcm',
    key_id: meta.key_id,
    device_id: meta.device_id,
    namespace: meta.namespace,
    object_id: meta.object_id,
    object_kind: meta.object_kind,
    generation: meta.generation,
    immutable: meta.immutable,
    tombstone: meta.tombstone,
    nonce: b64u(iv),
    aad_digest: sha256(aad),
    ciphertext: b64u(ciphertext),
    ciphertext_bytes: ciphertext.length,
    ciphertext_digest: sha256(ciphertext),
    auth_tag: b64u(tag)
  };
  envelope.envelope_digest = sha256(Buffer.from(stable(envelopeDigestBody(envelope))));
  return Object.freeze(envelope);
}

export function inspectEncryptedEnvelope(envelope, { max_bytes = DEFAULT_MAX_BYTES } = {}) {
  if (!envelope || envelope.schema !== ARCHIE_SYNC_ENVELOPE_SCHEMA || envelope.algorithm !== 'aes-256-gcm') throw new Error('Unsupported Archie sync envelope.');
  if (sha256(Buffer.from(stable(envelopeDigestBody(envelope)))) !== envelope.envelope_digest) throw new Error('Sync envelope digest mismatch.');
  const ciphertext = fromB64u(envelope.ciphertext);
  if (ciphertext.length !== envelope.ciphertext_bytes || ciphertext.length > max_bytes) throw new Error('Sync ciphertext size mismatch or limit exceeded.');
  if (sha256(ciphertext) !== envelope.ciphertext_digest) throw new Error('Sync ciphertext digest mismatch.');
  const aad = Buffer.from(stable(aadBody(envelope)), 'utf8');
  if (sha256(aad) !== envelope.aad_digest) throw new Error('Sync AAD binding mismatch.');
  if (fromB64u(envelope.nonce).length !== 12 || fromB64u(envelope.auth_tag).length !== 16) throw new Error('Sync nonce or authentication tag is invalid.');
  return Object.freeze({ ciphertext, aad });
}

export function decryptSyncObject({ key, envelope, max_bytes = DEFAULT_MAX_BYTES } = {}) {
  const keyBytes = validateKey(key);
  const inspected = inspectEncryptedEnvelope(envelope, { max_bytes });
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, fromB64u(envelope.nonce));
  decipher.setAAD(inspected.aad);
  decipher.setAuthTag(fromB64u(envelope.auth_tag));
  let plaintext;
  try { plaintext = Buffer.concat([decipher.update(inspected.ciphertext), decipher.final()]); }
  catch { throw new Error('Sync authentication failed: wrong key or tampered ciphertext.'); }
  return Object.freeze({
    metadata: canonical({ namespace: envelope.namespace, object_id: envelope.object_id, object_kind: envelope.object_kind, generation: envelope.generation, device_id: envelope.device_id, immutable: envelope.immutable, tombstone: envelope.tombstone, key_id: envelope.key_id }),
    value: envelope.tombstone ? null : JSON.parse(plaintext.toString('utf8')),
    plaintext_digest: sha256(plaintext)
  });
}

export function mergeSyncValues(left, right, { immutable = true } = {}) {
  if (stable(left) === stable(right)) return Object.freeze({ state: 'identical', value: canonical(left), conflicts: [] });
  if (immutable) return Object.freeze({ state: 'conflict', value: null, conflicts: [canonical(left), canonical(right)] });
  if (Array.isArray(left) && Array.isArray(right)) {
    const values = [...new Map([...left, ...right].map(value => [stable(value), canonical(value)])).values()].sort((a, b) => stable(a).localeCompare(stable(b)));
    return Object.freeze({ state: 'merged', value: values, conflicts: [] });
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const conflicts = [];
    const value = {};
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!(key in left)) value[key] = canonical(right[key]);
      else if (!(key in right) || stable(left[key]) === stable(right[key])) value[key] = canonical(left[key]);
      else conflicts.push({ key, left: canonical(left[key]), right: canonical(right[key]) });
    }
    return Object.freeze({ state: conflicts.length ? 'conflict' : 'merged', value: conflicts.length ? null : value, conflicts });
  }
  return Object.freeze({ state: 'conflict', value: null, conflicts: [canonical(left), canonical(right)] });
}

export function createEncryptedSyncClient({ device_id, key_id, key, namespace = 'personal', clock = Date.now, max_bytes = DEFAULT_MAX_BYTES, chunk_bytes = DEFAULT_CHUNK_BYTES, state = {} } = {}) {
  validateKey(key);
  const device = clean(device_id, 300);
  const keyId = clean(key_id, 200);
  if (!device || !keyId) throw new Error('Device and key identifiers are required.');
  const generations = new Map(Object.entries(state.generations || {}).map(([k, v]) => [k, Number(v)]));
  const seenEnvelopes = new Set(state.seen_envelopes || []);
  const usedNonces = new Set(state.used_nonces || []);
  const objects = new Map(Object.entries(state.objects || {}));

  function objectKey(object_id) { return `${namespace}:${clean(object_id, 300)}`; }
  function assertFresh(envelope) {
    const key = objectKey(envelope.object_id);
    const known = generations.get(key) || 0;
    if (seenEnvelopes.has(envelope.envelope_digest)) throw new Error('Sync replay rejected.');
    if (envelope.generation < known) throw new Error('Sync rollback rejected.');
  }

  function seal({ object_id, object_kind, generation, value, immutable = true, tombstone = false, nonce } = {}) {
    const nonceBytes = nonce ? Buffer.from(nonce) : crypto.randomBytes(12);
    const nonceKey = `${keyId}:${b64u(nonceBytes)}`;
    if (usedNonces.has(nonceKey)) throw new Error('Sync nonce reuse rejected.');
    const envelope = encryptSyncObject({ key, key_id: keyId, device_id: device, namespace, object_id, object_kind, generation, value, immutable, tombstone, nonce: nonceBytes, clock, max_bytes });
    usedNonces.add(nonceKey);
    return envelope;
  }

  function accept(envelope) {
    assertFresh(envelope);
    const decrypted = decryptSyncObject({ key, envelope, max_bytes });
    const keyName = objectKey(envelope.object_id);
    const current = objects.get(keyName);
    if (current && envelope.generation === current.generation && envelope.envelope_digest !== current.envelope_digest) {
      const left = decryptSyncObject({ key, envelope: current, max_bytes });
      const merged = mergeSyncValues(left.value, decrypted.value, { immutable: envelope.immutable || current.immutable });
      if (merged.state === 'conflict') return Object.freeze({ state: 'conflict_preserved', conflicts: merged.conflicts, local: current, remote: envelope });
    }
    generations.set(keyName, envelope.generation);
    seenEnvelopes.add(envelope.envelope_digest);
    objects.set(keyName, envelope);
    return Object.freeze({ state: envelope.tombstone ? 'deleted' : 'accepted', envelope_digest: envelope.envelope_digest, generation: envelope.generation, value: decrypted.value });
  }

  function chunkEnvelope(envelope) {
    const encoded = Buffer.from(stable(envelope), 'utf8');
    if (encoded.length > max_bytes * 2) throw new Error('Encoded sync envelope exceeds bound.');
    const transfer_id = `sync_${sha256(encoded).slice(0, 24)}`;
    const chunks = [];
    for (let offset = 0, index = 0; offset < encoded.length; offset += chunk_bytes, index += 1) {
      const bytes = encoded.subarray(offset, Math.min(encoded.length, offset + chunk_bytes));
      chunks.push(Object.freeze({ transfer_id, index, total: Math.ceil(encoded.length / chunk_bytes), bytes: b64u(bytes), digest: sha256(bytes) }));
    }
    return Object.freeze({ transfer_id, envelope_digest: envelope.envelope_digest, chunks });
  }

  function resumeTransfer(chunks) {
    const ordered = [...chunks].sort((a, b) => a.index - b.index);
    if (!ordered.length) throw new Error('No sync chunks supplied.');
    const total = ordered[0].total;
    if (ordered.length !== total || ordered.some((chunk, index) => chunk.index !== index || chunk.total !== total)) throw new Error('Sync transfer is partial.');
    const bytes = ordered.map(chunk => {
      const value = fromB64u(chunk.bytes);
      if (sha256(value) !== chunk.digest) throw new Error('Sync chunk digest mismatch.');
      return value;
    });
    return JSON.parse(Buffer.concat(bytes).toString('utf8'));
  }

  function exportState() {
    return Object.freeze({ generations: Object.fromEntries(generations), seen_envelopes: [...seenEnvelopes].sort(), used_nonces: [...usedNonces].sort(), objects: Object.fromEntries(objects) });
  }

  return Object.freeze({ seal, accept, chunkEnvelope, resumeTransfer, exportState, metadata: Object.freeze({ device_id: device, key_id: keyId, namespace, relay_plaintext_authority: false, offline_capable: true }) });
}

export function publicRelayRecord(envelope) {
  inspectEncryptedEnvelope(envelope);
  return Object.freeze({
    schema: 'archie-sync-relay-record/v1', namespace_digest: sha256(Buffer.from(envelope.namespace)), object_id_digest: sha256(Buffer.from(envelope.object_id)),
    generation: envelope.generation, ciphertext_bytes: envelope.ciphertext_bytes, ciphertext_digest: envelope.ciphertext_digest,
    envelope_digest: envelope.envelope_digest, key_id: envelope.key_id, plaintext: null, device_id: null
  });
}
