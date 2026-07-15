import assert from 'node:assert/strict';
import test from 'node:test';
import { projectTerminalDrain } from '../weave-terminal-drain.mjs';

function event(id, kind, issuer, issued_at, body = {}) {
  return { id, kind, issuer, issued_at, body };
}

const generation = 'remote-generation-9';
const outer = 'remote-terminal-receipt-9';
const basePrepare = body => event('prepare', 'terminal.drain.prepare', 'coordinator', '2026-07-15T04:00:00Z', {
  drain_id: 'drain-9',
  generation_id: generation,
  outer_receipt_id: outer,
  ...body
});
const commit = id => event(id, 'terminal.drain.commit', 'coordinator', '2026-07-15T04:05:00Z', {
  drain_id: 'drain-9',
  generation_id: generation,
  outer_receipt_id: outer
});

test('terminal weave with zero participants drains immediately and binds to the outer receipt', () => {
  const state = projectTerminalDrain([
    basePrepare({ participant_sessions: [], pending_assignments: [], in_flight_dispatches: [] }),
    commit('commit')
  ], { head: 'abc123' });

  assert.equal(state.status, 'terminal_release_committed');
  assert.equal(state.head, 'abc123');
  assert.equal(state.generation_id, generation);
  assert.equal(state.outer_receipt_id, outer);
  assert.equal(state.commit.participant_count, 0);
});

test('live participant release is counted exactly once and duplicate release is idempotent', () => {
  const release = event('release-1', 'terminal.drain.release', 'agent-a', '2026-07-15T04:01:00Z', {
    session_id: 'session-a',
    generation_id: generation,
    outer_receipt_id: outer,
    reason: 'finished'
  });
  const duplicate = { ...release, id: 'release-1-duplicate' };
  const state = projectTerminalDrain([
    event('presence-a', 'presence', 'agent-a', '2026-07-15T03:55:00Z', {
      agent_id: 'agent-a',
      session_id: 'session-a',
      state: 'terminating',
      lease_expires_at: '2026-07-15T04:30:00Z'
    }),
    basePrepare(),
    release,
    duplicate,
    commit('commit')
  ]);

  assert.deepEqual(state.snapshot.participant_sessions, ['session-a']);
  assert.deepEqual(state.releases.map(item => item.session_id), ['session-a']);
  assert.equal(state.commit.participant_count, 1);
});

test('same participant and lease with different release content is rejected', () => {
  assert.throws(() => projectTerminalDrain([
    event('presence-a', 'presence', 'agent-a', '2026-07-15T03:55:00Z', {
      agent_id: 'agent-a',
      session_id: 'session-a',
      state: 'terminating',
      lease_expires_at: '2026-07-15T04:30:00Z'
    }),
    basePrepare(),
    event('release-1', 'terminal.drain.release', 'agent-a', '2026-07-15T04:01:00Z', {
      session_id: 'session-a',
      generation_id: generation,
      outer_receipt_id: outer,
      reason: 'finished'
    }),
    event('release-2', 'terminal.drain.release', 'agent-a', '2026-07-15T04:02:00Z', {
      session_id: 'session-a',
      generation_id: generation,
      outer_receipt_id: outer,
      reason: 'different'
    })
  ]), /different content/);
});

test('participant cannot append ordinary work after release under the retiring generation', () => {
  assert.throws(() => projectTerminalDrain([
    event('presence-a', 'presence', 'agent-a', '2026-07-15T03:55:00Z', {
      agent_id: 'agent-a',
      session_id: 'session-a',
      state: 'terminating',
      lease_expires_at: '2026-07-15T04:30:00Z'
    }),
    basePrepare(),
    event('release-1', 'terminal.drain.release', 'agent-a', '2026-07-15T04:01:00Z', {
      session_id: 'session-a',
      generation_id: generation,
      outer_receipt_id: outer,
      reason: 'finished'
    }),
    event('late-work', 'intent', 'agent-a', '2026-07-15T04:02:00Z', {
      assignment_id: 'late',
      intended_reality_change: 'Keep working after release.',
      collision_policy: 'avoid'
    })
  ]), /ordinary work after release/);
});

test('pending unstarted dispatch is canceled and cannot block terminal release', () => {
  const state = projectTerminalDrain([
    event('presence-a', 'presence', 'agent-a', '2026-07-15T03:55:00Z', {
      agent_id: 'agent-a',
      session_id: 'session-a',
      state: 'terminating',
      lease_expires_at: '2026-07-15T04:30:00Z'
    }),
    event('intent-a', 'intent', 'agent-a', '2026-07-15T03:56:00Z', {
      assignment_id: 'assignment-a',
      intended_reality_change: 'Unstarted work.',
      collision_policy: 'avoid'
    }),
    basePrepare(),
    event('release-a', 'terminal.drain.release', 'agent-a', '2026-07-15T04:01:00Z', {
      session_id: 'session-a',
      generation_id: generation,
      outer_receipt_id: outer,
      reason: 'released'
    }),
    event('cancel-a', 'terminal.drain.cancel', 'coordinator', '2026-07-15T04:01:30Z', {
      assignment_id: 'assignment-a',
      generation_id: generation,
      outer_receipt_id: outer,
      reason: 'terminal drain canceled unstarted work'
    }),
    commit('commit')
  ]);

  assert.deepEqual(state.snapshot.pending_assignments, ['assignment-a']);
  assert.deepEqual(state.canceled.map(item => item.assignment_id), ['assignment-a']);
  assert.equal(state.status, 'terminal_release_committed');
});

test('in-flight dispatch must finish, be canceled, or be quarantined before terminal release', () => {
  assert.throws(() => projectTerminalDrain([
    basePrepare({ in_flight_dispatches: ['dispatch-a'] }),
    commit('commit')
  ]), /unaccounted participants or dispatch/);

  const quarantined = projectTerminalDrain([
    basePrepare({ in_flight_dispatches: ['dispatch-a'] }),
    event('quarantine-a', 'terminal.drain.quarantine', 'coordinator', '2026-07-15T04:02:00Z', {
      dispatch_id: 'dispatch-a',
      generation_id: generation,
      outer_receipt_id: outer,
      reason: 'in-flight work cannot safely finish before terminal release'
    }),
    commit('commit')
  ]);
  assert.deepEqual(quarantined.quarantined.map(item => item.assignment_id), ['dispatch-a']);
  assert.equal(quarantined.status, 'terminal_release_committed');
});

test('new generation can reopen only through an accepted generation event', () => {
  assert.throws(() => projectTerminalDrain([
    basePrepare({ participant_sessions: [], pending_assignments: [], in_flight_dispatches: [] }),
    commit('commit'),
    event('old-work', 'message', 'agent-a', '2026-07-15T04:06:00Z', {
      message_type: 'claim',
      statement: 'Old generation tries to resume.'
    })
  ]), /old generation cannot append/);

  const state = projectTerminalDrain([
    basePrepare({ participant_sessions: [], pending_assignments: [], in_flight_dispatches: [] }),
    commit('commit'),
    event('accept-next', 'generation.accept', 'remote', '2026-07-15T04:06:00Z', {
      generation_id: 'remote-generation-10'
    }),
    event('new-work', 'message', 'agent-a', '2026-07-15T04:07:00Z', {
      generation_id: 'remote-generation-10',
      message_type: 'claim',
      statement: 'New generation is accepted by the outer fence.'
    })
  ]);
  assert.equal(state.status, 'terminal_release_committed');
});
