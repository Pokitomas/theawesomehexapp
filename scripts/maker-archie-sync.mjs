#!/usr/bin/env node
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SYNC_SCHEMA = 'archie-private-sync/v1';
const MANIFEST_SCHEMA = 'archie-private-sync-manifest-entry/v1';
const RECEIPT_SCHEMA = 'archie-private-sync-public-receipt/v1';
const ENVELOPE_SCHEMA = 'archie-private-sync-envelope/v1';
const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential|seed|mnemonic|passphrase)/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;
const clean = (value, limit = 100000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function stableJSONStringify(value) { return JSON.stringify(canonical(value)); }
function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex'); }
function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(stableJSONStringify(value), 'utf8');
}
function fromBytes(buffer) {
  const text = Buffer.from(buffer).toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}
function redact(value, depth = 0) {
  if (depth > 16) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 2000).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 4000).map(([key, child]) => [clean(key, 300), SECRET_KEY.test(key) ? '[redacted]' : redact(child, depth + 1)]));
  }
  if (typeof value === 'string') return clean(value.replace(SECRET_TEXT, '[redacted]'));
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return clean(value, 2000);
}
function nowISO(clock) { return new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString(); }
function normalizeStatus(name, adapter, methods) {
  if (!adapter) return { name, configured: false, available: false, reason: 'not_configured', provider: 'none' };
  const missing = methods.filter(method => typeof adapter[method] !== 'function');
  const reported = typeof adapter.status === 'function' ? adapter.status() : {};
  const configured = missing.length === 0 && reported?.configured !== false;
  const available = configured && reported?.available !== false;
  return { name, configured, available, reason: missing.length ? `missing:${missing.join(',')}` : clean(reported?.reason || (available ? 'available' : 'unavailable'), 300), provider: clean(reported?.provider || adapter.provider || 'injected', 200) };
}
function assertAvailable(status, name) {
  if (!status.configured) throw new Error(`${name} adapter is not configured.`);
  if (!status.available) throw new Error(`${name} adapter is unavailable: ${status.reason}`);
}
function publicDevice(device = {}) {
  const deviceId = clean(device.device_id || device.id || '', 200);
  if (!deviceId) throw new Error('A device identity with device_id is required.');
  return Object.freeze({ device_id: deviceId, device_label_hash: device.label ? digest(`device-label:${clean(device.label, 500)}`).slice(0, 32) : null, public_key_id: clean(device.public_key_id || device.key_id || '', 300) || null });
}
function manifestDigest(entry) { return digest({ ...entry, manifest_digest: undefined }); }
function makeReceipt(action, body) {
  const receipt = { schema: RECEIPT_SCHEMA, action: clean(action, 100), ...redact(body) };
  return Object.freeze({ ...receipt, receipt_digest: digest(receipt) });
}
function entrySort(left, right) {
  return String(left.observed_at || '').localeCompare(String(right.observed_at || '')) || String(left.device_id || '').localeCompare(String(right.device_id || '')) || Number(left.device_sequence || 0) - Number(right.device_sequence || 0) || String(left.manifest_digest || '').localeCompare(String(right.manifest_digest || ''));
}
function activeView(entries) {
  const revokedDevices = new Set();
  const tombstoned = new Set();
  const byLogical = new Map();
  const conflicts = [];
  const ignored = [];
  for (const entry of [...entries].sort(entrySort)) {
    if (entry.entry_type === 'revoke') { if (entry.revoked_device_id) revokedDevices.add(entry.revoked_device_id); continue; }
    if (revokedDevices.has(entry.device_id)) { ignored.push({ reason: 'revoked_device', manifest_digest: entry.manifest_digest, device_id: entry.device_id }); continue; }
    if (entry.entry_type === 'tombstone') { tombstoned.add(entry.logical_id_hash); byLogical.delete(entry.logical_id_hash); continue; }
    if (entry.entry_type !== 'chunk' && entry.entry_type !== 'receipt') continue;
    if (tombstoned.has(entry.logical_id_hash)) continue;
    const prior = byLogical.get(entry.logical_id_hash);
    if (prior && prior.object_id !== entry.object_id) {
      const pair = [prior, entry].sort(entrySort);
      conflicts.push({ logical_id_hash: entry.logical_id_hash, entries: pair.map(item => ({ manifest_digest: item.manifest_digest, object_id: item.object_id, device_id: item.device_id, observed_at: item.observed_at })) });
      byLogical.set(entry.logical_id_hash, pair[1]);
      continue;
    }
    byLogical.set(entry.logical_id_hash, entry);
  }
  return { revokedDevices, tombstoned, byLogical, conflicts, ignored };
}
async function maybeAwait(value) { return value && typeof value.then === 'function' ? await value : value; }

export class MemoryArchieSyncStorageAdapter {
  constructor({ provider = 'memory', available = true, fail_puts = 0 } = {}) {
    this.provider = provider;
    this.available = available;
    this.failPuts = fail_puts;
    this.manifests = new Map();
    this.envelopes = new Map();
    this.deleted = [];
  }
  status() { return { configured: true, available: this.available, provider: this.provider, reason: this.available ? 'available' : 'storage_offline' }; }
  manifestKey(packId) { return `manifest:${packId}`; }
  async readManifest(packId) { if (!this.available) throw new Error('storage unavailable'); return [...(this.manifests.get(this.manifestKey(packId)) || [])]; }
  async appendManifest(packId, entry) { if (!this.available) throw new Error('storage unavailable'); const key = this.manifestKey(packId); const existing = this.manifests.get(key) || []; this.manifests.set(key, [...existing, entry]); return { entries: existing.length + 1, tip: entry.manifest_digest }; }
  async putEnvelope(objectId, envelope) {
    if (!this.available) throw new Error('storage unavailable');
    if (this.failPuts > 0) { this.failPuts -= 1; throw new Error('simulated resumable storage interruption'); }
    if (!this.envelopes.has(objectId)) this.envelopes.set(objectId, envelope);
    return { object_id: objectId, deduplicated: this.envelopes.get(objectId) !== envelope };
  }
  async getEnvelope(objectId) { if (!this.available) throw new Error('storage unavailable'); const envelope = this.envelopes.get(objectId); if (!envelope) throw new Error(`Envelope not found: ${objectId}`); return envelope; }
  async deleteEnvelope(objectId) { if (!this.available) throw new Error('storage unavailable'); this.deleted.push(objectId); return this.envelopes.delete(objectId); }
  snapshotPublic() { return { manifests: Object.fromEntries([...this.manifests.entries()].map(([key, value]) => [key, value])), envelopes: Object.fromEntries([...this.envelopes.entries()].map(([key, value]) => [key, value])), deleted: this.deleted }; }
}
export function createMemoryArchieSyncStorageAdapter(options) { return new MemoryArchieSyncStorageAdapter(options); }

export class ArchiePrivateSync {
  constructor({ pack_id = 'default', device, key_adapter, seal_adapter, storage_adapter, clock = Date.now, chunk_bytes = 64 * 1024, retention = {} } = {}) {
    this.schema = SYNC_SCHEMA;
    this.packId = clean(pack_id, 300) || 'default';
    this.device = publicDevice(device);
    this.keyAdapter = key_adapter;
    this.sealAdapter = seal_adapter;
    this.storageAdapter = storage_adapter;
    this.clock = clock;
    this.chunkBytes = Math.max(1024, Math.min(16 * 1024 * 1024, Number(chunk_bytes) || 64 * 1024));
    this.retention = retention || {};
    this.sequence = 0;
    this.pending = [];
    this.lastTip = null;
    this.lastLength = 0;
  }
  status() {
    const key = normalizeStatus('key', this.keyAdapter, ['currentKeyRef', 'dedupeId']);
    const seal = normalizeStatus('seal', this.sealAdapter, ['seal', 'open']);
    const storage = normalizeStatus('storage', this.storageAdapter, ['readManifest', 'appendManifest', 'putEnvelope', 'getEnvelope']);
    return Object.freeze({ schema: SYNC_SCHEMA, pack_id_hash: digest(`pack:${this.packId}`).slice(0, 32), device: this.device, adapters: { key, seal, storage }, ready: key.available && seal.available && storage.available, offline_queue_depth: this.pending.length, retention: redact(this.retention) });
  }
  assertCryptoAvailable() { const status = this.status(); assertAvailable(status.adapters.key, 'key'); assertAvailable(status.adapters.seal, 'seal'); return status; }
  async makeEnvelope({ purpose, logical_id, payload }) {
    const status = this.assertCryptoAvailable();
    const keyRef = await maybeAwait(this.keyAdapter.currentKeyRef({ purpose, pack_id: this.packId, device: this.device }));
    if (!keyRef) throw new Error('Key adapter did not return a key reference.');
    const plaintext = toBytes({ schema: ENVELOPE_SCHEMA, purpose, payload });
    const logicalHash = digest(`logical:${this.packId}:${purpose}:${clean(logical_id, 2000)}`).slice(0, 48);
    const dedupeId = await maybeAwait(this.keyAdapter.dedupeId(plaintext, { purpose, pack_id: this.packId, logical_id_hash: logicalHash, key_ref: keyRef }));
    if (!dedupeId) throw new Error('Key adapter did not return a dedupe id.');
    const objectId = `${purpose}_${clean(dedupeId, 200).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96)}`;
    const aad = { schema: ENVELOPE_SCHEMA, purpose, pack_id_hash: digest(`pack:${this.packId}`).slice(0, 32), logical_id_hash: logicalHash, object_id: objectId, device_id: this.device.device_id, key_ref: clean(typeof keyRef === 'string' ? keyRef : keyRef.id || keyRef.key_id || stableJSONStringify(keyRef), 300) };
    const sealed = await this.sealAdapter.seal(plaintext, aad, keyRef);
    const envelope = Object.freeze({ schema: ENVELOPE_SCHEMA, aad, sealed: redact(sealed), sealed_digest: digest(redact(sealed)), bytes: plaintext.byteLength });
    return { status, keyRef, plaintext, logicalHash, objectId, envelope };
  }
  nextSequence() { this.sequence += 1; return this.sequence; }
  buildEntry({ entry_type, logical_id_hash = null, object_id = null, envelope = null, extra = {} }) {
    const body = { schema: MANIFEST_SCHEMA, pack_id_hash: digest(`pack:${this.packId}`).slice(0, 32), entry_type, device_id: this.device.device_id, device_public_key_id: this.device.public_key_id, device_sequence: this.nextSequence(), logical_id_hash, object_id, sealed_digest: envelope?.sealed_digest || null, envelope_bytes: envelope?.bytes || 0, observed_at: nowISO(this.clock), ...extra };
    return Object.freeze({ ...body, manifest_digest: manifestDigest(body) });
  }
  async appendSealed({ entry, envelope }) {
    const storageStatus = this.status().adapters.storage;
    if (!storageStatus.configured) throw new Error('storage adapter is not configured.');
    const item = Object.freeze({ entry, envelope });
    try {
      assertAvailable(storageStatus, 'storage');
      await this.storageAdapter.putEnvelope(entry.object_id, envelope);
      await this.storageAdapter.appendManifest(this.packId, entry);
      return { queued: false, deduplicated: false };
    } catch (error) {
      this.pending.push(item);
      return { queued: true, reason: clean(error.message, 300), deduplicated: false };
    }
  }
  async publishChunk(logical_id, content, { metadata = null } = {}) {
    const { logicalHash, objectId, envelope } = await this.makeEnvelope({ purpose: 'chunk', logical_id, payload: { content: Buffer.from(toBytes(content)).toString('base64'), metadata: redact(metadata) } });
    const entry = this.buildEntry({ entry_type: 'chunk', logical_id_hash: logicalHash, object_id: objectId, envelope });
    const result = await this.appendSealed({ entry, envelope });
    return makeReceipt('chunk.publish', { status: result.queued ? 'queued' : 'published', queued: result.queued, reason: result.reason || null, object_id: objectId, logical_id_hash: logicalHash, manifest_digest: entry.manifest_digest, device_id: this.device.device_id, sealed_digest: envelope.sealed_digest, adapter_status: this.status().adapters });
  }
  async publishReceipt(logical_id, receipt) {
    const { logicalHash, objectId, envelope } = await this.makeEnvelope({ purpose: 'receipt', logical_id, payload: { receipt: redact(receipt) } });
    const entry = this.buildEntry({ entry_type: 'receipt', logical_id_hash: logicalHash, object_id: objectId, envelope });
    const result = await this.appendSealed({ entry, envelope });
    return makeReceipt('receipt.publish', { status: result.queued ? 'queued' : 'published', queued: result.queued, reason: result.reason || null, object_id: objectId, logical_id_hash: logicalHash, manifest_digest: entry.manifest_digest, device_id: this.device.device_id, sealed_digest: envelope.sealed_digest, adapter_status: this.status().adapters });
  }
  async tombstone(logical_id, { reason = 'operator tombstone' } = {}) {
    const logicalHash = digest(`logical:${this.packId}:chunk:${clean(logical_id, 2000)}`).slice(0, 48);
    const entry = this.buildEntry({ entry_type: 'tombstone', logical_id_hash: logicalHash, extra: { reason_hash: digest(clean(reason, 1000)).slice(0, 32) } });
    await this.storageAdapter.appendManifest(this.packId, entry);
    return makeReceipt('chunk.tombstone', { status: 'tombstoned', logical_id_hash: logicalHash, manifest_digest: entry.manifest_digest, device_id: this.device.device_id });
  }
  async revokeDevice(device_id, { reason = 'operator revoke' } = {}) {
    const revoked = clean(device_id, 200);
    if (!revoked) throw new Error('device_id is required for revoke.');
    const entry = this.buildEntry({ entry_type: 'revoke', extra: { revoked_device_id: revoked, reason_hash: digest(clean(reason, 1000)).slice(0, 32) } });
    await this.storageAdapter.appendManifest(this.packId, entry);
    return makeReceipt('device.revoke', { status: 'revoked', revoked_device_id: revoked, manifest_digest: entry.manifest_digest, device_id: this.device.device_id });
  }
  async flushPending() {
    const storageStatus = this.status().adapters.storage;
    assertAvailable(storageStatus, 'storage');
    const remaining = [];
    const flushed = [];
    for (const item of this.pending) {
      try { await this.storageAdapter.putEnvelope(item.entry.object_id, item.envelope); await this.storageAdapter.appendManifest(this.packId, item.entry); flushed.push(item.entry.manifest_digest); }
      catch { remaining.push(item); }
    }
    this.pending = remaining;
    return makeReceipt('offline.flush', { status: remaining.length ? 'partial' : 'flushed', flushed, remaining: remaining.length, device_id: this.device.device_id });
  }
  async readEntries() {
    const sorted = [...await this.storageAdapter.readManifest(this.packId)].sort(entrySort);
    for (const entry of sorted) {
      if (entry.schema !== MANIFEST_SCHEMA) throw new Error('Unknown Archie sync manifest entry schema.');
      if (entry.manifest_digest !== manifestDigest({ ...entry, manifest_digest: undefined })) throw new Error('Manifest integrity check failed.');
    }
    const tip = sorted.at(-1)?.manifest_digest || null;
    if (this.lastTip && !sorted.some(entry => entry.manifest_digest === this.lastTip)) throw new Error('Manifest rollback detected: previously observed tip is missing.');
    if (sorted.length < this.lastLength) throw new Error('Manifest rollback detected: log length decreased.');
    this.lastTip = tip;
    this.lastLength = sorted.length;
    return sorted;
  }
  async restore({ include_conflicts = true } = {}) {
    const status = this.assertCryptoAvailable();
    const view = activeView(await this.readEntries());
    const restored = [];
    const failures = [];
    for (const entry of view.byLogical.values()) {
      try {
        const envelope = await this.storageAdapter.getEnvelope(entry.object_id);
        if (envelope.sealed_digest !== entry.sealed_digest || digest(envelope.sealed) !== entry.sealed_digest) throw new Error('Envelope integrity check failed.');
        const keyRef = await maybeAwait(this.keyAdapter.currentKeyRef({ purpose: entry.entry_type, pack_id: this.packId, device: this.device, key_ref: envelope.aad?.key_ref }));
        const body = fromBytes(await this.sealAdapter.open(envelope.sealed, envelope.aad, keyRef));
        if (body?.schema !== ENVELOPE_SCHEMA) throw new Error('Opened envelope has an invalid schema.');
        restored.push({ entry_type: entry.entry_type, object_id: entry.object_id, logical_id_hash: entry.logical_id_hash, payload: body.payload, device_id: entry.device_id, observed_at: entry.observed_at });
      } catch (error) { failures.push({ object_id: entry.object_id, logical_id_hash: entry.logical_id_hash, reason: clean(error.message, 300) }); }
    }
    return makeReceipt('pack.restore', { status: failures.length ? 'partial' : 'restored', restored_count: restored.length, failures, conflicts: include_conflicts ? view.conflicts : [], ignored: view.ignored, revoked_devices: [...view.revokedDevices].sort(), tombstones: [...view.tombstoned].sort(), restored, adapter_status: status.adapters });
  }
  async inspectConflicts() {
    const view = activeView(await this.readEntries());
    return makeReceipt('conflicts.inspect', { status: view.conflicts.length ? 'conflicted' : 'clean', conflicts: view.conflicts, ignored: view.ignored });
  }
  async enforceRetention({ tombstoned_older_than_ms = Number(this.retention.tombstoned_older_than_ms || 0) } = {}) {
    const entries = await this.readEntries();
    const view = activeView(entries);
    const cutoff = Date.parse(nowISO(this.clock)) - Math.max(0, Number(tombstoned_older_than_ms) || 0);
    const removed = [];
    for (const entry of entries) {
      if (!view.tombstoned.has(entry.logical_id_hash)) continue;
      if (Date.parse(entry.observed_at) > cutoff) continue;
      if (entry.object_id && typeof this.storageAdapter.deleteEnvelope === 'function') { await this.storageAdapter.deleteEnvelope(entry.object_id); removed.push(entry.object_id); }
    }
    return makeReceipt('retention.enforce', { status: 'enforced', removed, tombstones: [...view.tombstoned].sort() });
  }
}
export function createArchiePrivateSync(options) { return new ArchiePrivateSync(options); }

function argument(name, fallback = '') { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; }
async function main() {
  if (process.argv[2] === 'status') {
    const sync = createArchiePrivateSync({ pack_id: argument('--pack', 'default'), device: { device_id: argument('--device', 'unknown') }, key_adapter: null, seal_adapter: null, storage_adapter: null });
    console.log(JSON.stringify(sync.status(), null, 2));
    return;
  }
  throw new Error('Usage: maker-archie-sync.mjs status --device <device-id> [--pack <pack-id>]. Runtime sync requires injected key, seal, and storage adapters.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
}
