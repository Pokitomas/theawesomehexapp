import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  createEncryptedSyncClient,
  decryptSyncObject,
  encryptSyncObject,
  inspectEncryptedEnvelope,
  mergeSyncValues,
  publicRelayRecord
} from '../maker-archie-sync.mjs';

const key = crypto.createHash('sha256').update('key-a').digest();
const wrong = crypto.createHash('sha256').update('key-b').digest();
const clock = () => Date.parse('2026-07-16T06:00:00.000Z');
const client = extra => createEncryptedSyncClient({
  device_id: 'phone-a',
  key_id: 'kid-1',
  key,
  namespace: 'kai',
  clock,
  chunk_bytes: 64,
  ...extra
});

function resign(envelope, changes = {}) {
  return encryptSyncObject({
    key,
    key_id: changes.key_id ?? envelope.key_id,
    device_id: changes.device_id ?? envelope.device_id,
    namespace: changes.namespace ?? envelope.namespace,
    object_id: changes.object_id ?? envelope.object_id,
    object_kind: changes.object_kind ?? envelope.object_kind,
    generation: changes.generation ?? envelope.generation,
    value: changes.value ?? decryptSyncObject({ key, envelope }).value,
    immutable: changes.immutable ?? envelope.immutable,
    tombstone: changes.tombstone ?? envelope.tombstone,
    nonce: changes.nonce
  });
}

test('relay receives ciphertext and minimized metadata but no plaintext, raw key id, or device identity', () => {
  const envelope = client().seal({ object_id: 'pack-1', generation: 1, value: { private_memory: 'owned locally' } });
  const relay = publicRelayRecord(envelope);
  assert.equal(relay.plaintext, null);
  assert.equal(relay.device_id, null);
  assert.equal(relay.key_id, null);
  assert.match(relay.key_id_digest, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(relay).includes('owned locally'));
  assert.ok(!JSON.stringify(envelope).includes(key.toString('hex')));
});

test('wrong keys, ciphertext tampering, authentication-tag tampering, and AAD tampering are rejected', () => {
  const envelope = client().seal({ object_id: 'pack-1', generation: 1, value: { x: 1 } });
  assert.throws(() => decryptSyncObject({ key: wrong, envelope }), /authentication failed/);
  const ciphertext = { ...envelope, ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}` };
  assert.throws(() => inspectEncryptedEnvelope(ciphertext), /digest/);
  const tag = { ...envelope, auth_tag: `${envelope.auth_tag[0] === 'A' ? 'B' : 'A'}${envelope.auth_tag.slice(1)}` };
  assert.throws(() => inspectEncryptedEnvelope(tag), /digest/);
  const aad = { ...envelope, object_id: 'other' };
  assert.throws(() => inspectEncryptedEnvelope(aad), /digest|AAD/);
});

test('local nonce reuse and received nonce reuse are rejected per key identifier', () => {
  const sync = client();
  const nonce = Buffer.alloc(12, 7);
  sync.seal({ object_id: 'a', generation: 1, value: 1, nonce });
  assert.throws(() => sync.seal({ object_id: 'b', generation: 1, value: 2, nonce }), /nonce reuse/);

  const receiver = client({ device_id: 'receiver' });
  const first = encryptSyncObject({ key, key_id: 'kid-1', device_id: 'sender-a', namespace: 'kai', object_id: 'one', generation: 1, value: 1, nonce });
  const second = encryptSyncObject({ key, key_id: 'kid-1', device_id: 'sender-b', namespace: 'kai', object_id: 'two', generation: 1, value: 2, nonce });
  receiver.accept(first);
  assert.throws(() => receiver.accept(second), /nonce reuse/);
});

test('replay, duplicate delivery, rollback, and stale generation are rejected', () => {
  const sender = client();
  const receiver = client({ device_id: 'phone-b' });
  const one = sender.seal({ object_id: 'pack', generation: 1, value: { v: 1 } });
  const two = sender.seal({ object_id: 'pack', generation: 2, value: { v: 2 } });
  assert.equal(receiver.accept(one).state, 'accepted');
  assert.equal(receiver.accept(two).generation, 2);
  assert.throws(() => receiver.accept(one), /replay|rollback/);
  assert.throws(() => receiver.accept(two), /replay/);
  const stale = sender.seal({ object_id: 'pack', generation: 1, value: { v: 3 } });
  assert.throws(() => receiver.accept(stale), /rollback/);
});

test('namespace and key-identifier isolation fail closed before state mutation', () => {
  const receiver = client({ device_id: 'receiver' });
  const otherNamespace = createEncryptedSyncClient({ device_id: 'sender', key_id: 'kid-1', key, namespace: 'other' })
    .seal({ object_id: 'pack', generation: 1, value: 1 });
  const otherKeyId = createEncryptedSyncClient({ device_id: 'sender', key_id: 'kid-2', key, namespace: 'kai' })
    .seal({ object_id: 'pack', generation: 1, value: 1 });
  assert.throws(() => receiver.accept(otherNamespace), /namespace mismatch/);
  assert.throws(() => receiver.accept(otherKeyId), /key identifier mismatch/);
  assert.deepEqual(receiver.exportState().generations, {});
});

test('resumable transfer rejects partial, mixed, oversized, and tampered chunks then restores the envelope', () => {
  const sync = client();
  const envelope = sync.seal({ object_id: 'large', generation: 1, value: { text: 'x'.repeat(500) } });
  const transfer = sync.chunkEnvelope(envelope);
  assert.throws(() => sync.resumeTransfer(transfer.chunks.slice(1)), /partial|inconsistent/);

  const bad = transfer.chunks.map(value => ({ ...value }));
  bad[0].bytes = `${bad[0].bytes[0] === 'A' ? 'B' : 'A'}${bad[0].bytes.slice(1)}`;
  assert.throws(() => sync.resumeTransfer(bad), /digest|bound/);

  const mixed = transfer.chunks.map(value => ({ ...value }));
  mixed.at(-1).transfer_id = 'sync_wrong';
  assert.throws(() => sync.resumeTransfer(mixed), /partial|inconsistent/);

  const oversized = transfer.chunks.map(value => ({ ...value }));
  oversized[0].bytes = Buffer.alloc(65).toString('base64url');
  oversized[0].digest = crypto.createHash('sha256').update(Buffer.alloc(65)).digest('hex');
  assert.throws(() => sync.resumeTransfer(oversized), /bound/);
  assert.deepEqual(sync.resumeTransfer(transfer.chunks), envelope);
});

test('concurrent immutable divergence is preserved without overwriting either object', () => {
  const a = client({ device_id: 'a' });
  const b = client({ device_id: 'b' });
  const receiver = client({ device_id: 'c' });
  const left = a.seal({ object_id: 'model', generation: 1, value: { digest: 'left' }, immutable: true });
  const right = b.seal({ object_id: 'model', generation: 1, value: { digest: 'right' }, immutable: true });
  receiver.accept(left);
  const conflict = receiver.accept(right);
  assert.equal(conflict.state, 'conflict_preserved');
  assert.equal(conflict.local.envelope_digest, left.envelope_digest);
  assert.equal(conflict.remote.envelope_digest, right.envelope_digest);
  assert.equal(receiver.exportState().objects['kai:model'].envelope_digest, left.envelope_digest);
});

test('concurrent mutable arrays and non-conflicting objects merge deterministically into a new generation', () => {
  const receiverA = client({ device_id: 'receiver-a' });
  const receiverB = client({ device_id: 'receiver-b' });
  const senderA = client({ device_id: 'sender-a' });
  const senderB = client({ device_id: 'sender-b' });

  const arrayLeft = senderA.seal({ object_id: 'lessons', generation: 1, value: [{ id: 2 }, { id: 1 }], immutable: false });
  const arrayRight = senderB.seal({ object_id: 'lessons', generation: 1, value: [{ id: 3 }, { id: 1 }], immutable: false });
  receiverA.accept(arrayLeft);
  const arrayMerged = receiverA.accept(arrayRight);
  assert.equal(arrayMerged.state, 'merged');
  assert.equal(arrayMerged.generation, 2);
  assert.deepEqual(arrayMerged.value, [{ id: 1 }, { id: 2 }, { id: 3 }]);

  const objectLeft = senderA.seal({ object_id: 'prefs', generation: 1, value: { a: 1 }, immutable: false });
  const objectRight = senderB.seal({ object_id: 'prefs', generation: 1, value: { b: 2 }, immutable: false });
  receiverB.accept(objectRight);
  const objectMerged = receiverB.accept(objectLeft);
  assert.equal(objectMerged.state, 'merged');
  assert.deepEqual(objectMerged.value, { a: 1, b: 2 });
  assert.deepEqual(mergeSyncValues({ a: 1 }, { b: 2 }, { immutable: false }).value, { a: 1, b: 2 });
  assert.equal(mergeSyncValues({ a: 1 }, { a: 2 }, { immutable: false }).state, 'conflict');
});

test('tombstones synchronize deletion and concurrent tombstone/value divergence is preserved', () => {
  const sender = client();
  const receiver = client({ device_id: 'receiver' });
  const deleted = sender.seal({ object_id: 'pack', generation: 3, value: null, tombstone: true });
  const accepted = receiver.accept(deleted);
  assert.equal(accepted.state, 'deleted');
  assert.equal(accepted.value, null);
  assert.equal(decryptSyncObject({ key, envelope: deleted }).value, null);

  const tombstone = sender.seal({ object_id: 'race', generation: 1, value: null, immutable: false, tombstone: true });
  const value = client({ device_id: 'other' }).seal({ object_id: 'race', generation: 1, value: { live: true }, immutable: false });
  const race = client({ device_id: 'race-receiver' });
  race.accept(value);
  assert.equal(race.accept(tombstone).state, 'conflict_preserved');
});

test('bounded payloads, bounded transfer settings, and required identifiers are enforced', () => {
  assert.throws(() => encryptSyncObject({ key, key_id: 'kid', device_id: 'd', namespace: 'n', object_id: 'o', generation: 1, value: 'too large', max_bytes: 2 }), /max_bytes/);
  assert.throws(() => createEncryptedSyncClient({ device_id: 'd', key_id: 'kid', key, namespace: 'n', max_bytes: 8, chunk_bytes: 9 }), /chunk_bytes/);
  assert.throws(() => encryptSyncObject({ key, key_id: '', device_id: 'd', namespace: 'n', object_id: 'o', generation: 1, value: 1 }), /identifiers/);
  assert.throws(() => encryptSyncObject({ key, key_id: 'kid', device_id: 'd', namespace: 'n', object_id: 'o', generation: 0, value: 1 }), /generation/);
});

test('offline state export and restore preserve anti-replay, anti-rollback, and nonce history without exporting key material', () => {
  const original = client();
  const envelope = original.seal({ object_id: 'pack', generation: 1, value: { token: 'plaintext-inside-ciphertext-only' } });
  original.accept(envelope);
  const state = original.exportState();
  assert.ok(!JSON.stringify(state).includes(key.toString('hex')));
  assert.ok(!JSON.stringify(publicRelayRecord(envelope)).includes('plaintext-inside-ciphertext-only'));

  const restored = client({ state });
  assert.equal(restored.metadata.offline_capable, true);
  assert.equal(restored.metadata.relay_plaintext_authority, false);
  assert.throws(() => restored.accept(envelope), /replay/);
  assert.throws(() => restored.seal({ object_id: 'other', generation: 1, value: 2, nonce: Buffer.from(envelope.nonce, 'base64url') }), /nonce reuse/);
});
