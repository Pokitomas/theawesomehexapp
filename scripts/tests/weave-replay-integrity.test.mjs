import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalWeaveMessages,
  createWeaveEvent,
  foldWeaveMessages,
  normalizePersistedWeaveEvent,
  normalizePersistedWeaveMessage,
  strictWeavePayload
} from '../weave-replay-integrity.mjs';

const at = index => new Date(Date.UTC(2026, 6, 15, 3, 30, index)).toISOString();

function beacon(id, signal = 'Need review', issued_at = at(1), visibility = 'public') {
  return createWeaveEvent({
    id,
    kind: 'beacon.emit',
    issuer: 'agent:alpha',
    issued_at,
    visibility,
    body: {
      beacon_id: 'beacon:one',
      kind: 'join_me',
      signal,
      useful_contribution: ['review'],
      urgency: 80,
      desired_agents: 1
    }
  });
}

function remoteMessage(event, overrides = {}) {
  return {
    id: overrides.id || `remote:${event.id}`,
    session: overrides.session === undefined ? 'repo:main' : overrides.session,
    generation: overrides.generation === undefined ? 1 : overrides.generation,
    issuer: overrides.issuer || event.issuer,
    parent: null,
    issued_at: overrides.issued_at || event.issued_at,
    visibility: overrides.visibility || event.visibility,
    payload: strictWeavePayload(event)
  };
}

test('persisted validation never invents identity or time', () => {
  assert.throws(() => normalizePersistedWeaveEvent({
    protocol: 'sideways-weave', version: 1,
    kind: 'presence',
    issuer: 'agent:a',
    issued_at: at(1),
    body: { agent_id: 'a', session_id: 's', state: 'testing', lease_expires_at: at(20) }
  }), /event id is invalid/i);
  assert.throws(() => normalizePersistedWeaveEvent({
    protocol: 'sideways-weave', version: 1,
    id: 'presence:1',
    kind: 'presence',
    issuer: 'agent:a',
    body: { agent_id: 'a', session_id: 's', state: 'testing', lease_expires_at: at(20) }
  }), /issued_at/i);
});

test('creation helper derives the same identity from the same canonical envelope', () => {
  const left = createWeaveEvent({
    kind: 'presence', issuer: 'agent:a', issued_at: at(1),
    body: { agent_id: 'a', session_id: 's', state: 'testing', lease_expires_at: at(20) }
  });
  const right = createWeaveEvent({
    body: { lease_expires_at: at(20), state: 'testing', session_id: 's', agent_id: 'a' },
    issued_at: at(1), issuer: 'agent:a', kind: 'presence'
  });
  assert.equal(left.id, right.id);
  assert.equal(left.visibility, 'public');
});

test('strict payload preserves explicit private override on a public-default kind', () => {
  const event = beacon('beacon:event:private', 'Private coordination', at(1), 'private');
  const payload = strictWeavePayload(event);
  assert.equal(payload.weave.visibility, 'private');
  assert.equal(normalizePersistedWeaveMessage(remoteMessage(event)).payload.weave.visibility, 'private');
});

test('public Remote envelope cannot carry a private weave event', () => {
  const event = beacon('beacon:event:private', 'Private coordination', at(1), 'private');
  assert.throws(
    () => normalizePersistedWeaveMessage(remoteMessage(event, { visibility: 'public' })),
    error => error?.code === 'WEAVE_VISIBILITY_MISMATCH'
  );
});

test('legacy event without visibility may narrow to private but cannot widen a private-default kind to public', () => {
  const oldBeacon = beacon('beacon:event:legacy');
  delete oldBeacon.visibility;
  const narrowed = normalizePersistedWeaveMessage(remoteMessage(oldBeacon, { visibility: 'private' }));
  assert.equal(narrowed.payload.weave.visibility, 'private');

  const oldMessage = createWeaveEvent({
    id: 'message:legacy', kind: 'message', issuer: 'agent:alpha', issued_at: at(2), visibility: 'private',
    body: { message_type: 'note', statement: 'private note' }
  });
  delete oldMessage.visibility;
  assert.throws(
    () => normalizePersistedWeaveMessage(remoteMessage(oldMessage, { visibility: 'public' })),
    error => error?.code === 'WEAVE_VISIBILITY_MISMATCH'
  );
});

test('persisted weave messages require complete transport identity', () => {
  const event = beacon('beacon:event:1');
  assert.throws(() => normalizePersistedWeaveMessage(remoteMessage(event, { session: '' })), /Remote session is required/);
  assert.throws(() => normalizePersistedWeaveMessage(remoteMessage(event, { generation: 0 })), /positive safe integer/);
});

test('exact duplicate delivery is idempotent', () => {
  const event = beacon('beacon:event:1');
  const first = remoteMessage(event, { id: 'remote:1' });
  const duplicate = remoteMessage(event, { id: 'remote:2' });
  const canonical = canonicalWeaveMessages([first, duplicate]);
  assert.equal(canonical.length, 1);
  const state = foldWeaveMessages([first, duplicate], Date.parse(at(10)));
  assert.equal(Object.keys(state.beacons).length, 1);
});

test('same event id with changed content fails terminally', () => {
  const first = beacon('beacon:event:1', 'Need review');
  const conflicting = beacon('beacon:event:1', 'Different signal');
  assert.throws(() => foldWeaveMessages([
    remoteMessage(first, { id: 'remote:1' }),
    remoteMessage(conflicting, { id: 'remote:2' })
  ]), error => error?.code === 'WEAVE_ID_CONFLICT');
});

test('same event cannot move between transport identities', () => {
  const event = beacon('beacon:event:1');
  assert.throws(() => canonicalWeaveMessages([
    remoteMessage(event, { session: 'repo:main', id: 'remote:1' }),
    remoteMessage(event, { session: 'repo:other', id: 'remote:2' })
  ]), error => error?.code === 'WEAVE_TRANSPORT_CONFLICT');
});

test('Remote issuer and event issuer must match', () => {
  const event = beacon('beacon:event:1');
  assert.throws(() => canonicalWeaveMessages([
    remoteMessage(event, { issuer: 'agent:forged' })
  ]), error => error?.code === 'WEAVE_TRANSPORT_MISMATCH');
});

test('fold output is invariant to delivery order', () => {
  const emitted = beacon('beacon:event:1', 'Need review', at(1));
  const joined = createWeaveEvent({
    id: 'beacon:event:2',
    kind: 'beacon.join',
    issuer: 'agent:beta',
    issued_at: at(2),
    body: { beacon_id: 'beacon:one', mode: 'join', statement: 'I can review.' }
  });
  const messages = [remoteMessage(emitted), remoteMessage(joined)];
  assert.deepEqual(
    foldWeaveMessages(messages, Date.parse(at(10))),
    foldWeaveMessages([...messages].reverse(), Date.parse(at(10)))
  );
});
