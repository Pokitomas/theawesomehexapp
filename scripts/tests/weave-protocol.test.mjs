import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultWeaveVisibility,
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

function presence(id, sessionId, issuedAt, leaseExpiresAt, agentId = 'agent-a') {
  return remoteMessage({
    id,
    kind: 'presence',
    issuer: agentId,
    issued_at: issuedAt,
    body: {
      agent_id: agentId,
      session_id: sessionId,
      state: 'coding',
      lease_expires_at: leaseExpiresAt
    }
  });
}

function sessionEvent(id, kind, sessionId, issuedAt, agentId = 'agent-a') {
  const common = { agent_id: agentId, session_id: sessionId };
  if (kind === 'session.handoff') {
    return remoteMessage({
      id,
      kind,
      issuer: agentId,
      issued_at: issuedAt,
      body: {
        ...common,
        reason: 'completed',
        claimed_beacons: [],
        beliefs_worth_preserving: [],
        unresolved_concerns: [],
        recommended_next_actions: [],
        handoff_to: 'any'
      }
    });
  }
  if (kind === 'session.lost') {
    return remoteMessage({ id, kind, issuer: 'observer', issued_at: issuedAt, body: common });
  }
  return remoteMessage({
    id,
    kind: 'session.recover',
    issuer: 'agent-b',
    issued_at: issuedAt,
    body: {
      ...common,
      recovered_by: 'agent-b',
      outcome: 'continue',
      statement: 'Recovered the workspace.'
    }
  });
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
  const presenceMessage = remoteMessage({ id: '1', kind: 'presence', issuer: 'agent-a', body: {
    agent_id: 'agent-a',
    session_id: 'session-a',
    state: 'coding',
    lease_expires_at: '2026-07-14T14:05:00Z'
  } });
  const lost = foldWeaveMessages([presenceMessage], Date.parse('2026-07-14T14:06:00Z'));
  assert.equal(lost.recovery_beacons[0].beacon_id, 'recovery:session-a');

  const recovered = foldWeaveMessages([
    presenceMessage,
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

test('recovery obligations follow session identity and issued-time ordering', () => {
  const now = Date.parse('2026-07-14T14:10:00Z');

  const renewedBeforeExpiry = foldWeaveMessages([
    presence('p1', 'renew-before', '2026-07-14T14:00:00Z', '2026-07-14T14:05:00Z'),
    presence('p2', 'renew-before', '2026-07-14T14:04:00Z', '2026-07-14T14:20:00Z')
  ], now);
  assert.equal(renewedBeforeExpiry.recovery_beacons.length, 0);

  const renewedAfterExpiry = foldWeaveMessages([
    presence('p1', 'renew-after', '2026-07-14T14:00:00Z', '2026-07-14T14:05:00Z'),
    presence('p2', 'renew-after', '2026-07-14T14:06:00Z', '2026-07-14T14:20:00Z')
  ], now);
  assert.equal(renewedAfterExpiry.recovery_beacons.length, 0);

  for (const kind of ['session.handoff', 'session.lost', 'session.recover']) {
    const explained = foldWeaveMessages([
      presence(`p-${kind}`, kind, '2026-07-14T14:00:00Z', '2026-07-14T14:05:00Z'),
      sessionEvent(`e-${kind}`, kind, kind, '2026-07-14T14:06:00Z')
    ], now);
    assert.equal(explained.recovery_beacons.length, 0, kind);
  }

  const reordered = foldWeaveMessages([
    sessionEvent('handoff-late', 'session.handoff', 'reordered', '2026-07-14T14:06:00Z'),
    presence('presence-first', 'reordered', '2026-07-14T14:00:00Z', '2026-07-14T14:05:00Z')
  ], now);
  assert.equal(reordered.recovery_beacons.length, 0);

  const staleExplanation = foldWeaveMessages([
    presence('presence-new', 'stale-explanation', '2026-07-14T14:02:00Z', '2026-07-14T14:05:00Z'),
    sessionEvent('handoff-old', 'session.handoff', 'stale-explanation', '2026-07-14T14:01:00Z')
  ], now);
  assert.deepEqual(staleExplanation.recovery_beacons.map(item => item.beacon_id), ['recovery:stale-explanation']);

  const simultaneous = foldWeaveMessages([
    presence('old-session', 'session-old', '2026-07-14T14:00:00Z', '2026-07-14T14:05:00Z'),
    presence('live-session', 'session-live', '2026-07-14T14:01:00Z', '2026-07-14T14:20:00Z')
  ], now);
  assert.equal(simultaneous.presence['agent-a'].session_id, 'session-live');
  assert.deepEqual(simultaneous.recovery_beacons.map(item => item.beacon_id), ['recovery:session-old']);
});

test('defaults coordination signals public and sensitive residue private', () => {
  assert.equal(defaultWeaveVisibility('beacon.emit'), 'public');
  assert.equal(defaultWeaveVisibility('presence'), 'public');
  assert.equal(defaultWeaveVisibility('recode.declare'), 'private');
  assert.equal(defaultWeaveVisibility('session.handoff'), 'private');
  assert.equal(defaultWeaveVisibility('session.handoff', 'public'), 'public');
  assert.throws(() => defaultWeaveVisibility('message', 'friends-only'), /Unknown weave visibility/);
});

test('rejects malformed protocol events before they enter remote payloads', () => {
  assert.throws(() => normalizeWeaveEvent({ kind: 'beacon.emit', body: { beacon_id: 'b-1', kind: 'made_up', signal: 'x' } }, { issuer: 'agent-a', issued_at: stamp }), /Unknown beacon kind/);
  assert.throws(() => normalizeWeaveEvent({ kind: 'intent', body: { intended_reality_change: 'x', collision_policy: 'lock_everything' } }, { issuer: 'agent-a', issued_at: stamp }), /Unknown collision policy/);
});
