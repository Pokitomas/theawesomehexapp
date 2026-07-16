import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createArchiePrivateSync, createMemoryArchieSyncStorageAdapter } from '../maker-archie-sync.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function stableJSONStringify(value) { return JSON.stringify(canonical(value)); }
function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex'); }

function testAdapters({ key = 'alpha', keyAvailable = true, sealAvailable = true } = {}) {
  const keyAdapter = {
    status: () => ({ configured: true, available: keyAvailable, provider: 'test-keyring', reason: keyAvailable ? 'available' : 'locked' }),
    currentKeyRef: () => ({ id: `key-${key}`, material: key }),
    dedupeId: (plaintext, context) => `d_${digest(`${key}:${context.purpose}:${Buffer.from(plaintext).toString('base64')}`).slice(0, 32)}`
  };
  const sealAdapter = {
    status: () => ({ configured: true, available: sealAvailable, provider: 'test-sealer', reason: sealAvailable ? 'available' : 'missing' }),
    seal: (plaintext, aad, keyRef) => {
      const encoded = Buffer.from(plaintext).toString('base64');
      const mac = digest({ encoded, aad, key: keyRef.material });
      return { alg: 'test-adapter-envelope', kid: keyRef.id, encoded, mac };
    },
    open: (sealed, aad, keyRef) => {
      const expected = digest({ encoded: sealed.encoded, aad, key: keyRef.material });
      if (expected !== sealed.mac) throw new Error('wrong key or tampered envelope');
      return Buffer.from(sealed.encoded, 'base64');
    }
  };
  return { key_adapter: keyAdapter, seal_adapter: sealAdapter };
}

function sync(storage, device_id, options = {}) {
  return createArchiePrivateSync({
    pack_id: 'pack-one',
    device: { device_id, public_key_id: `${device_id}-pub`, label: `${device_id} secret label` },
    storage_adapter: storage,
    clock: () => options.time || '2026-07-16T04:00:00.000Z',
    ...testAdapters(options)
  });
}

test('syncs Archie pack chunks and model receipts across two devices without exposing plaintext metadata', async () => {
  const storage = createMemoryArchieSyncStorageAdapter();
  const phone = sync(storage, 'phone');
  const laptop = sync(storage, 'laptop');

  const chunk = await phone.publishChunk('private/pack/chunk-a', 'Bearer ghp_secretsecretsecretsecretsecret model weights chunk', { authorization: 'Bearer should-never-persist' });
  const receipt = await phone.publishReceipt('receipt/run-a', { model: 'tiny-local-planner', token: 'github_pat_123456789012345678901234567890', result: { ok: true } });
  assert.equal(chunk.status, 'published');
  assert.equal(receipt.status, 'published');

  const restored = await laptop.restore();
  assert.equal(restored.status, 'restored');
  assert.equal(restored.restored_count, 2);
  assert.equal(restored.restored.some(item => item.entry_type === 'chunk'), true);
  assert.equal(restored.restored.some(item => item.entry_type === 'receipt'), true);

  const publicBytes = JSON.stringify(storage.snapshotPublic());
  assert.equal(publicBytes.includes('private/pack/chunk-a'), false);
  assert.equal(publicBytes.includes('Bearer ghp_'), false);
  assert.equal(publicBytes.includes('github_pat_'), false);
  assert.equal(publicBytes.includes('should-never-persist'), false);
});

test('deduplicates chunks, queues sealed offline work, and replays it with resumable transfer', async () => {
  const storage = createMemoryArchieSyncStorageAdapter({ available: false });
  const phone = sync(storage, 'phone');
  const queued = await phone.publishChunk('same-logical', 'offline chunk secret token sk-abcabcabcabcabcabc');
  assert.equal(queued.status, 'queued');
  assert.equal(phone.status().offline_queue_depth, 1);
  assert.equal(JSON.stringify(phone.pending).includes('offline chunk secret'), false);

  storage.available = true;
  storage.failPuts = 1;
  const partial = await phone.flushPending();
  assert.equal(partial.status, 'partial');
  assert.equal(phone.status().offline_queue_depth, 1);
  const flushed = await phone.flushPending();
  assert.equal(flushed.status, 'flushed');
  assert.equal(phone.status().offline_queue_depth, 0);

  const firstEnvelopeCount = storage.envelopes.size;
  await phone.publishChunk('same-logical', 'offline chunk secret token sk-abcabcabcabcabcabc');
  assert.equal(storage.envelopes.size, firstEnvelopeCount);
});

test('detects concurrent conflicts and rolls back when an observed manifest tip disappears', async () => {
  const storage = createMemoryArchieSyncStorageAdapter();
  const phone = sync(storage, 'phone', { time: '2026-07-16T04:01:00.000Z' });
  const laptop = sync(storage, 'laptop', { time: '2026-07-16T04:01:01.000Z' });
  const observer = sync(storage, 'observer', { time: '2026-07-16T04:01:02.000Z' });

  await phone.publishChunk('shared-note', 'phone version');
  await laptop.publishChunk('shared-note', 'laptop version');
  const conflicts = await observer.inspectConflicts();
  assert.equal(conflicts.status, 'conflicted');
  assert.equal(conflicts.conflicts.length, 1);
  assert.equal(conflicts.conflicts[0].entries.length, 2);

  await observer.restore();
  const key = storage.manifestKey('pack-one');
  storage.manifests.set(key, storage.manifests.get(key).slice(0, 1));
  await assert.rejects(observer.restore(), /rollback detected/i);
});

test('supports tombstones, retention cleanup, device revoke, and ignores revoked future writes', async () => {
  const storage = createMemoryArchieSyncStorageAdapter();
  const phone = sync(storage, 'phone', { time: '2026-07-16T04:02:00.000Z' });
  const laptop = sync(storage, 'laptop', { time: '2026-07-16T04:02:01.000Z' });
  const observer = sync(storage, 'observer', { time: '2026-07-16T04:02:02.000Z' });

  const live = await phone.publishChunk('live', 'keep me');
  await phone.publishChunk('gone', 'delete me');
  await phone.tombstone('gone');
  const restored = await observer.restore();
  assert.equal(restored.restored_count, 1);
  assert.equal(restored.restored[0].object_id, live.object_id);

  const retention = await observer.enforceRetention({ tombstoned_older_than_ms: 0 });
  assert.equal(retention.status, 'enforced');
  assert.equal(storage.deleted.length >= 1, true);

  await phone.revokeDevice('laptop');
  await laptop.publishChunk('after-revoke', 'must not restore');
  const afterRevoke = await observer.restore();
  assert.equal(afterRevoke.revoked_devices.includes('laptop'), true);
  assert.equal(afterRevoke.ignored.some(item => item.reason === 'revoked_device'), true);
  assert.equal(afterRevoke.restored.some(item => item.payload?.content === Buffer.from('must not restore').toString('base64')), false);
});

test('fails restore on wrong key or tampered chunk and reports adapter unavailable states truthfully', async () => {
  const storage = createMemoryArchieSyncStorageAdapter();
  const phone = sync(storage, 'phone', { key: 'alpha' });
  await phone.publishChunk('secret', 'sealed content');

  const wrong = sync(storage, 'wrong', { key: 'beta' });
  const wrongRestore = await wrong.restore();
  assert.equal(wrongRestore.status, 'partial');
  assert.match(wrongRestore.failures[0].reason, /wrong key|tampered/i);

  const [objectId, envelope] = [...storage.envelopes.entries()][0];
  storage.envelopes.set(objectId, { ...envelope, sealed: { ...envelope.sealed, encoded: Buffer.from('tampered').toString('base64') } });
  const tampered = await phone.restore();
  assert.equal(tampered.status, 'partial');
  assert.match(tampered.failures[0].reason, /integrity/i);

  const unavailable = createArchiePrivateSync({ pack_id: 'pack-one', device: { device_id: 'phone' }, storage_adapter: storage, ...testAdapters({ keyAvailable: false }) });
  assert.equal(unavailable.status().adapters.key.configured, true);
  assert.equal(unavailable.status().adapters.key.available, false);
  await assert.rejects(unavailable.publishChunk('x', 'would be raw if queued'), /key adapter is unavailable/i);
});

test('emits deterministic public receipts and never stores raw secrets in the public receipt', async () => {
  const storageA = createMemoryArchieSyncStorageAdapter();
  const storageB = createMemoryArchieSyncStorageAdapter();
  const one = sync(storageA, 'phone', { time: '2026-07-16T04:03:00.000Z' });
  const two = sync(storageB, 'phone', { time: '2026-07-16T04:03:00.000Z' });
  const left = await one.publishChunk('stable', 'secret payload with password swordfish');
  const right = await two.publishChunk('stable', 'secret payload with password swordfish');

  assert.equal(left.receipt_digest, right.receipt_digest);
  assert.equal(JSON.stringify(left).includes('swordfish'), false);
  assert.equal(left.adapter_status.key.provider, 'test-keyring');
  assert.equal(left.adapter_status.seal.provider, 'test-sealer');
  assert.equal(left.adapter_status.storage.provider, 'memory');
});
