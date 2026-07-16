import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createEncryptedSyncClient, decryptSyncObject, encryptSyncObject, inspectEncryptedEnvelope, mergeSyncValues, publicRelayRecord } from '../maker-archie-sync.mjs';

const key = crypto.createHash('sha256').update('key-a').digest();
const wrong = crypto.createHash('sha256').update('key-b').digest();
const clock = () => Date.parse('2026-07-16T06:00:00.000Z');
const client = extra => createEncryptedSyncClient({ device_id: 'phone-a', key_id: 'kid-1', key, namespace: 'kai', clock, chunk_bytes: 64, ...extra });

test('relay receives ciphertext and minimized metadata but no plaintext or raw device identity', () => {
  const envelope = client().seal({ object_id: 'pack-1', generation: 1, value: { private_memory: 'owned locally' } });
  const relay = publicRelayRecord(envelope);
  assert.equal(relay.plaintext, null);
  assert.equal(relay.device_id, null);
  assert.ok(!JSON.stringify(relay).includes('owned locally'));
  assert.ok(!envelope.key);
});

test('wrong keys, ciphertext tampering and AAD tampering are rejected', () => {
  const envelope = client().seal({ object_id: 'pack-1', generation: 1, value: { x: 1 } });
  assert.throws(() => decryptSyncObject({ key: wrong, envelope }), /authentication failed/);
  const tampered = { ...envelope, ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}` };
  assert.throws(() => inspectEncryptedEnvelope(tampered), /digest/);
  const aad = { ...envelope, object_id: 'other' };
  assert.throws(() => inspectEncryptedEnvelope(aad), /digest|AAD/);
});

test('nonce reuse is rejected per key identifier', () => {
  const sync = client();
  const nonce = Buffer.alloc(12, 7);
  sync.seal({ object_id: 'a', generation: 1, value: 1, nonce });
  assert.throws(() => sync.seal({ object_id: 'b', generation: 1, value: 2, nonce }), /nonce reuse/);
});

test('replay, rollback and stale generation are rejected', () => {
  const sender = client();
  const receiver = client({ device_id: 'phone-b' });
  const one = sender.seal({ object_id: 'pack', generation: 1, value: { v: 1 } });
  const two = sender.seal({ object_id: 'pack', generation: 2, value: { v: 2 } });
  assert.equal(receiver.accept(one).state, 'accepted');
  assert.equal(receiver.accept(two).generation, 2);
  assert.throws(() => receiver.accept(one), /replay|rollback/);
  assert.throws(() => receiver.accept(two), /replay/);
});

test('resumable transfer rejects partial and tampered chunks then restores the envelope', () => {
  const sync = client();
  const envelope = sync.seal({ object_id: 'large', generation: 1, value: { text: 'x'.repeat(500) } });
  const transfer = sync.chunkEnvelope(envelope);
  assert.throws(() => sync.resumeTransfer(transfer.chunks.slice(1)), /partial/);
  const bad = transfer.chunks.map(x => ({ ...x })); bad[0].bytes = `${bad[0].bytes[0] === 'A' ? 'B' : 'A'}${bad[0].bytes.slice(1)}`;
  assert.throws(() => sync.resumeTransfer(bad), /digest/);
  assert.deepEqual(sync.resumeTransfer(transfer.chunks), envelope);
});

test('concurrent immutable divergence is preserved as a conflict', () => {
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
});

test('safe array merge is deterministic while object field divergence is refused', () => {
  const merged = mergeSyncValues([{ id: 2 }, { id: 1 }], [{ id: 3 }, { id: 1 }], { immutable: false });
  assert.equal(merged.state, 'merged');
  assert.deepEqual(merged.value, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(mergeSyncValues({ a: 1 }, { a: 2 }, { immutable: false }).state, 'conflict');
});

test('tombstones synchronize deletion without exposing prior plaintext', () => {
  const sender = client(); const receiver = client({ device_id: 'receiver' });
  const deleted = sender.seal({ object_id: 'pack', generation: 3, value: null, tombstone: true });
  const accepted = receiver.accept(deleted);
  assert.equal(accepted.state, 'deleted');
  assert.equal(accepted.value, null);
  assert.equal(decryptSyncObject({ key, envelope: deleted }).value, null);
});

test('bounded payloads and secret absence are enforced by representation', () => {
  assert.throws(() => encryptSyncObject({ key, key_id: 'kid', device_id: 'd', namespace: 'n', object_id: 'o', generation: 1, value: 'too large', max_bytes: 2 }), /max_bytes/);
  const envelope = client().seal({ object_id: 'o', generation: 1, value: { token: 'plaintext-inside-ciphertext-only' } });
  assert.ok(!JSON.stringify(relay).includes('plaintext-inside-ciphertext-only'));
  assert.equal(client().metadata.offline_capable, true);
  assert.equal(client().metadata.relay_plaintext_authority, false);
});
