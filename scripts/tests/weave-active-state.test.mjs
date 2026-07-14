import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { normalizeWeaveEvent, weavePayload } from '../weave-protocol.mjs';
import { projectActiveWeaveState } from '../weave-active-state.mjs';

function remote(event) {
  const normalized = normalizeWeaveEvent(event, { issuer: event.issuer, issued_at: event.issued_at });
  return {
    id: `remote-${normalized.id}`,
    session: 'repo:main',
    generation: 1,
    issuer: normalized.issuer,
    issued_at: normalized.issued_at,
    payload: weavePayload(normalized),
    visibility: 'private'
  };
}

test('projects sessions, collisions, responses, recovery, and beacons', () => {
  const messages = [
    remote({ id: '00', kind: 'message', issuer: 'agent-b', issued_at: '2026-07-14T16:29:00Z', body: { message_type: 'answer', reply_to: '07', statement: 'Too early to satisfy a later request.' } }),
    remote({ id: '01', kind: 'presence', issuer: 'agent-a', issued_at: '2026-07-14T16:30:00Z', body: { agent_id: 'agent-a', session_id: 'session-a', state: 'coding', lease_expires_at: '2026-07-14T16:50:00Z' } }),
    remote({ id: '02', kind: 'intent', issuer: 'agent-a', issued_at: '2026-07-14T16:31:00Z', body: { artifact: 'projection-a', intended_reality_change: 'Project current state.', expected_files: ['scripts/weave-active-state.mjs'], parallel_work_welcome: true, collision_policy: 'compare' } }),
    remote({ id: '03', kind: 'presence', issuer: 'agent-b', issued_at: '2026-07-14T16:30:30Z', body: { agent_id: 'agent-b', session_id: 'session-b', state: 'coding', lease_expires_at: '2026-07-14T16:50:00Z' } }),
    remote({ id: '04', kind: 'intent', issuer: 'agent-b', issued_at: '2026-07-14T16:31:30Z', body: { artifact: 'projection-b', intended_reality_change: 'Build alternate state.', expected_files: ['scripts/weave-active-state.mjs'], parallel_work_welcome: true, collision_policy: 'deliberately_overlap' } }),
    remote({ id: '05', kind: 'message', issuer: 'agent-a', issued_at: '2026-07-14T16:32:00Z', body: { message_type: 'question', statement: 'Resolved question?', expects_response: true } }),
    remote({ id: '06', kind: 'message', issuer: 'agent-b', issued_at: '2026-07-14T16:33:00Z', body: { message_type: 'answer', reply_to: '05', statement: 'Resolved.' } }),
    remote({ id: '07', kind: 'message', issuer: 'agent-a', issued_at: '2026-07-14T16:34:00Z', body: { message_type: 'question', statement: 'Unresolved question?', expects_response: true } }),
    remote({ id: '08', kind: 'presence', issuer: 'agent-c', issued_at: '2026-07-14T16:20:00Z', body: { agent_id: 'agent-c', session_id: 'session-c', state: 'testing', lease_expires_at: '2026-07-14T16:25:00Z' } }),
    remote({ id: '09', kind: 'session.handoff', issuer: 'agent-c', issued_at: '2026-07-14T16:24:00Z', body: { agent_id: 'agent-c', session_id: 'session-c', reason: 'completed', claimed_beacons: [], handoff_to: 'any' } }),
    remote({ id: '10', kind: 'presence', issuer: 'agent-d', issued_at: '2026-07-14T16:20:00Z', body: { agent_id: 'agent-d', session_id: 'session-d', state: 'coding', lease_expires_at: '2026-07-14T16:25:00Z' } }),
    remote({ id: '11', kind: 'beacon.emit', issuer: 'agent-a', issued_at: '2026-07-14T16:30:00Z', body: { beacon_id: 'beacon-1', kind: 'collision', signal: 'Compare projections.' } }),
    remote({ id: '12', kind: 'beacon.join', issuer: 'agent-a', issued_at: '2026-07-14T16:31:00Z', body: { beacon_id: 'beacon-1' } }),
    remote({ id: '13', kind: 'beacon.join', issuer: 'agent-b', issued_at: '2026-07-14T16:31:10Z', body: { beacon_id: 'beacon-1' } }),
    remote({ id: '14', kind: 'beacon.resolve', issuer: 'agent-a', issued_at: '2026-07-14T16:35:00Z', body: { beacon_id: 'beacon-1', outcome: 'satisfied', explanation: 'Selected one.' } })
  ];

  const state = projectActiveWeaveState(messages, { now: Date.parse('2026-07-14T16:40:00Z'), head: 'abc123' });
  assert.deepEqual(state.activeSessions.map(item => item.session_id), ['session-a', 'session-b']);
  assert.equal(state.activeIntents.length, 2);
  assert.deepEqual(state.collisions[0].artifacts, ['scripts/weave-active-state.mjs']);
  assert.deepEqual(state.unresolvedResponses.map(item => item.event_id), ['07']);
  assert.deepEqual(state.recoveryNeeded.map(item => item.session_id), ['session-d']);
  assert.ok(state.openBeacons.some(item => item.beacon_id === 'recovery:session-d'));
  assert.ok(!state.openBeacons.some(item => item.beacon_id === 'beacon-1'));
  assert.deepEqual(state.recentTerminations.map(item => item.session_id), ['session-c']);
});

test('binds intent to the latest live session reported by the signed issuer', () => {
  const messages = [
    remote({ id: '01', kind: 'presence', issuer: 'principal-a', issued_at: '2026-07-14T16:30:00Z', body: { agent_id: 'worker-a', session_id: 'session-a1', state: 'coding', lease_expires_at: '2026-07-14T17:00:00Z' } }),
    remote({ id: '02', kind: 'presence', issuer: 'principal-a', issued_at: '2026-07-14T16:31:00Z', body: { agent_id: 'worker-a', session_id: 'session-a2', state: 'testing', lease_expires_at: '2026-07-14T17:00:00Z' } }),
    remote({ id: '03', kind: 'intent', issuer: 'principal-a', issued_at: '2026-07-14T16:32:00Z', body: { artifact: 'latest', intended_reality_change: 'Change the latest reported session.', expected_files: ['x.js'], collision_policy: 'avoid' } })
  ];
  const state = projectActiveWeaveState(messages, { now: Date.parse('2026-07-14T16:40:00Z') });
  assert.deepEqual(state.activeSessions.map(item => item.session_id), ['session-a1', 'session-a2']);
  assert.equal(state.activeIntents[0].session_id, 'session-a2');
  assert.deepEqual(state.activeIntents[0].candidate_session_ids, ['session-a2', 'session-a1']);
  assert.equal(state.unboundIntents.length, 0);
});

test('later presence renews a previously terminated session id', () => {
  const messages = [
    remote({ id: '01', kind: 'presence', issuer: 'principal-a', issued_at: '2026-07-14T16:10:00Z', body: { agent_id: 'worker-a', session_id: 'session-a', state: 'coding', lease_expires_at: '2026-07-14T16:20:00Z' } }),
    remote({ id: '02', kind: 'session.handoff', issuer: 'principal-a', issued_at: '2026-07-14T16:15:00Z', body: { agent_id: 'worker-a', session_id: 'session-a', reason: 'paused', claimed_beacons: [], handoff_to: 'any' } }),
    remote({ id: '03', kind: 'presence', issuer: 'principal-a', issued_at: '2026-07-14T16:30:00Z', body: { agent_id: 'worker-a', session_id: 'session-a', state: 'coding', lease_expires_at: '2026-07-14T17:00:00Z' } }),
    remote({ id: '04', kind: 'intent', issuer: 'principal-a', issued_at: '2026-07-14T16:31:00Z', body: { artifact: 'renewed', intended_reality_change: 'Continue after renewal.', expected_files: ['renewed.js'], collision_policy: 'avoid' } })
  ];
  const state = projectActiveWeaveState(messages, { now: Date.parse('2026-07-14T16:40:00Z') });
  assert.deepEqual(state.activeSessions.map(item => item.session_id), ['session-a']);
  assert.equal(state.activeIntents[0].session_id, 'session-a');
  assert.equal(state.recentTerminations.length, 0);
});

test('keeps recovery state separate for simultaneous sessions of one agent', () => {
  const messages = [
    remote({ id: '01', kind: 'presence', issuer: 'principal-a', issued_at: '2026-07-14T16:10:00Z', body: { agent_id: 'worker-a', session_id: 'session-a1', state: 'coding', lease_expires_at: '2026-07-14T16:20:00Z' } }),
    remote({ id: '02', kind: 'presence', issuer: 'principal-a', issued_at: '2026-07-14T16:11:00Z', body: { agent_id: 'worker-a', session_id: 'session-a2', state: 'testing', lease_expires_at: '2026-07-14T16:21:00Z' } })
  ];
  const state = projectActiveWeaveState(messages, { now: Date.parse('2026-07-14T16:40:00Z') });
  assert.deepEqual(state.recoveryNeeded.map(item => item.session_id), ['session-a1', 'session-a2']);
  assert.deepEqual(
    state.openBeacons.filter(item => item.kind === 'agent_disappeared').map(item => item.beacon_id),
    ['recovery:session-a1', 'recovery:session-a2']
  );
});

test('CLI projects a real Remote page and preserves requested head', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-active-'));
  const input = path.join(directory, 'remote-page.json');
  try {
    fs.writeFileSync(input, JSON.stringify({
      messages: [
        remote({ id: '01', kind: 'presence', issuer: 'principal-a', issued_at: '2026-07-14T16:30:00Z', body: { agent_id: 'worker-a', session_id: 'session-a', state: 'coding', lease_expires_at: '2026-07-14T17:00:00Z' } })
      ]
    }));
    const result = spawnSync(process.execPath, [
      'scripts/weave-active.mjs',
      input,
      '--now', '2026-07-14T16:40:00Z',
      '--head', 'abc123'
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.head, 'abc123');
    assert.deepEqual(state.activeSessions.map(item => item.session_id), ['session-a']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
