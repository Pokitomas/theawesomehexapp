import assert from 'node:assert/strict';
import test from 'node:test';
import {
  foldWeaveMessages,
  normalizeWeaveEvent,
  weavePayload
} from '../weave-protocol.mjs';

const stamp = '2026-07-14T14:00:00.000Z';

function remoteMessage(event, overrides = {}) {
  const normalized = normalizeWeaveEvent(event, { issuer: event.issuer || 'agent-a', issued_at: event.issued_at || stamp });
  return {
    id: `remote-${normalized.id}`,
    session: 'Pokitomas/theawesomehexapp:main',
    generation: 1,
    issuer: normalized.issuer,
    issued_at: normalized.issued_at,
    payload: weavePayload(normalized),
    visibility: 'public',
    ...overrides
  };
}

test('normalizes typed beacons without imposing exclusive ownership', () => {
  const event = normalizeWeaveEvent({
    kind: 'beacon.emit',
    body: {
      beacon_id: 'b-1',
      kind: 'need_opposition',
      signal: 'Challenge the current navigation premise.',
      desired_agents: 3
    }
  }, { issuer: 'agent-a', issued_at: stamp });

  assert.equal(event.protocol, 'sideways-weave');
  assert.equal(event.body.beacon_id, 'b-1');
  assert.equal(event.body.desired_agents, 3);
});

test('folds multiple joins onto one beacon and permits deliberate overlap', () => {
  const messages = [
    remoteMessage({ id: '1', kind: 'beacon.emit', issuer: 'agent-a', issued_at: stamp, body: { beacon_id: 'b-1', kind: 'collision', signal: 'Two models disagree.' } }),
    remoteMessage({ id: '2', kind: 'beacon.join', issuer: 'agent-b', issued_at: '2026-07-14T14:01:00Z', body: { beacon_id: 'b-1' } }),
    remoteMessage({ id: '3', kind: 'beacon.join', issuer: 'agent-c', issued_at: '2026-07-14T14:02:00Z', body: { beacon_id: 'b-1' } })
  ];
  const state = foldWeaveMessages(messages, Date.parse('2026-07-14T14:03:00Z'));
  assert.deepEqual(state.beacons['b-1'].participants, ['agent-b', 'agent-c']);
  assert.equal(state.beacons['b-1'].state, 'active');
});

test('tracks recode lifecycle without changing terminal generation semantics', () => {
  const messages = [
    remoteMessage({ id: '1', kind: 'recode.declare', issuer: 'agent-a', body: {
      recode_id: 'r-1',
      target: ['manual-app'],
      reason: 'The current model is too synthetic.',
      current_reality: 'One universal card grammar.',
      proposed_reality: 'Locally authored interaction surfaces.',
      mode: 'parallel_replacement'
    } }),
    remoteMessage({ id: '2', kind: 'recode.join', issuer: 'agent-b', issued_at: '2026-07-14T14:01:00Z', body: { recode_id: 'r-1' } }),
    remoteMessage({ id: '3', kind: 'recode.event', issuer: 'agent-b', issued_at: '2026-07-14T14:02:00Z', body: { recode_id: 'r-1', action: 'show_variant', statement: 'Variant is executable.' } }),
    remoteMessage({ id: '4', kind: 'recode.terminate', issuer: 'agent-a', issued_at: '2026-07-14T14:03:00Z', body: { recode_id: 'r-1', state: 'preserved_variant', resulting_reality: 'Variant remains runnable.' } })
  ];
  const state = foldWeaveMessages(messages);
  assert.deepEqual(state.recodes['r-1'].participants, ['agent-a', 'agent-b']);
  assert.equal(state.recodes['r-1'].state, 'preserved_variant');
  assert.equal(state.recodes['r-1'].events.length, 1);
});

test('session handoff releases beacon participation while preserving residue', () => {
  const messages = [
    remoteMessage({ id: '1', kind: 'beacon.emit', issuer: 'agent-a', body: { beacon_id: 'b-1', kind: 'join_me', signal: 'Continue the patch.' } }),
    remoteMessage({ id: '2', kind: 'beacon.join', issuer: 'agent-a', issued_at: '2026-07-14T14:01:00Z', body: { beacon_id: 'b-1' } }),
    remoteMessage({ id: '3', kind: 'session.handoff', issuer: 'agent-a', issued_at: '2026-07-14T14:02:00Z', body: {
      agent_id: 'agent-a',
      session_id: 'session-a',
      reason: 'resource_limit',
      claimed_beacons: ['b-1'],
      beliefs_worth_preserving: ['The observer chain remains suspect.'],
      unresolved_concerns: ['Safari proof is missing.'],
      recommended_next_actions: ['Run the phone witness.'],
      handoff_to: 'any'
    } })
  ];
  const state = foldWeaveMessages(messages);
  assert.deepEqual(state.beacons['b-1'].participants, []);
  assert.equal(state.sessions['session-a'].state, 'handed_off');
  assert.deepEqual(state.sessions['session-a'].unresolved_concerns, ['Safari proof is missing.']);
});

test('expired presence leases generate recovery beacons unless recovery is recorded', () => {
  const presence = remoteMessage({ id: '1', kind: 'presence', issuer: 'agent-a', body: {
    agent_id: 'agent-a',
    session_id: 'session-a',
    state: 'coding',
    lease_expires_at: '2026-07-14T14:05:00Z'
  } });
  const lost = foldWeaveMessages([presence], Date.parse('2026-07-14T14:06:00Z'));
  assert.equal(lost.recovery_beacons[0].beacon_id, 'recovery:session-a');

  const recovered = foldWeaveMessages([
    presence,
    remoteMessage({ id: '2', kind: 'session.recover', issuer: 'agent-b', issued_at: '2026-07-14T14:06:30Z', body: {
      agent_id: 'agent-a',
      session_id: 'session-a',
      recovered_by: 'agent-b',
      outcome: 'continue',
      statement: 'Recovered the workspace and continued the patch.'
    } })
  ], Date.parse('2026-07-14T14:07:00Z'));
  assert.equal(recovered.recovery_beacons.length, 0);
  assert.equal(recovered.sessions['session-a'].state, 'recovered');
});

test('rejects malformed protocol events before they enter remote payloads', () => {
  assert.throws(() => normalizeWeaveEvent({ kind: 'beacon.emit', body: { beacon_id: 'b-1', kind: 'made_up', signal: 'x' } }, { issuer: 'agent-a', issued_at: stamp }), /Unknown beacon kind/);
  assert.throws(() => normalizeWeaveEvent({ kind: 'intent', body: { intended_reality_change: 'x', collision_policy: 'lock_everything' } }, { issuer: 'agent-a', issued_at: stamp }), /Unknown collision policy/);
});
