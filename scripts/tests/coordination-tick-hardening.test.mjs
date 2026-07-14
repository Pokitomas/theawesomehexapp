import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_STATE_COMMENT_CHARS,
  emptyTickState,
  parseStateComment,
  reduceCoordinationTick,
  renderStateComment
} from '../coordination-tick-core.mjs';

const issueInventory = [{
  key: 'issue:10',
  kind: 'issue',
  number: 10,
  title: 'authority lane',
  url: 'https://example.test/issues/10',
  branch: null,
  issue_refs: []
}];

function event(key) {
  return {
    key,
    name: 'issue_comment',
    action: 'created',
    actor: 'same-agent',
    source: `https://example.test/events/${key}`,
    observed_at: '2026-07-14T00:00:00.000Z',
    lane_keys: ['issue:10']
  };
}

test('one actor claiming two branches remains two claims and produces a collision', () => {
  let state = reduceCoordinationTick(emptyTickState(), {
    event: event('claim-a'),
    inventory: issueInventory,
    declarations: [{ type: 'claim', issue: 10, actor: 'same-agent', branch: 'agent/a', source: 'a', line: 'MATCHED #10 agent/a' }]
  }).state;
  state = reduceCoordinationTick(state, {
    event: event('claim-b'),
    inventory: issueInventory,
    declarations: [{ type: 'claim', issue: 10, actor: 'same-agent', branch: 'agent/b', source: 'b', line: 'MATCHED #10 agent/b' }]
  }).state;

  assert.equal(Object.values(state.claims).filter(claim => claim.active).length, 2);
  assert.equal(state.lanes['issue:10'].phase, 'collision');

  state = reduceCoordinationTick(state, {
    event: event('release-b'),
    inventory: issueInventory,
    declarations: [{ type: 'release', issue: 10, actor: 'same-agent', branch: 'agent/b', source: 'release', line: 'SUPERSEDED #10 agent/b' }]
  }).state;
  assert.equal(state.lanes['issue:10'].phase, 'active');
});

test('persisted coordination state remains inside GitHub comment limits without dropping open lanes or active claims', () => {
  const state = emptyTickState({ seenLimit: 512, completedLaneLimit: 64, claimLimit: 256, signalLimit: 40 });
  state.tick = 999;
  state.updated_at = '2026-07-14T00:00:00.000Z';
  state.last_event = {
    key: 'x'.repeat(240), name: 'workflow_run', action: 'completed', actor: 'github-actions[bot]',
    source: `https://example.test/${'s'.repeat(450)}`, lane_keys: [], branch: null
  };
  state.seen = Array.from({ length: 512 }, (_, index) => `event-${index}-${'z'.repeat(120)}`);

  for (let index = 0; index < 80; index += 1) {
    state.lanes[`issue:${index}`] = {
      key: `issue:${index}`, kind: 'issue', number: index, title: 't'.repeat(240),
      url: `https://example.test/issues/${index}/${'u'.repeat(300)}`, branch: null, issue_refs: [],
      state: 'open', phase: 'active', collision: false, discovered_tick: 1,
      last_activity_tick: 900, stasis_ticks: 99, activity_count: 2, completed_tick: null
    };
  }
  for (let index = 0; index < 100; index += 1) {
    const id = `10|agent-${index}|agent/branch-${index}`;
    state.claims[id] = {
      id, issue: 10, actor: `agent-${index}`, branch: `agent/branch-${index}`,
      active: true, claimed_tick: 1, last_seen_tick: 900,
      source: `https://example.test/${'q'.repeat(450)}`, line: 'MATCHED '.repeat(60)
    };
  }
  state.signals = Array.from({ length: 40 }, (_, index) => ({
    id: `${index}:stale:issue:${index}`, type: 'stale', lane: `issue:${index}`,
    tick: index, detail: 'd'.repeat(240), event_key: 'e'.repeat(240), source: 's'.repeat(500)
  }));

  const rendered = renderStateComment(state);
  assert.ok(rendered.length <= MAX_STATE_COMMENT_CHARS, `${rendered.length} exceeds comment limit`);
  const parsed = parseStateComment(rendered);
  assert.equal(Object.values(parsed.lanes).filter(lane => lane.state === 'open').length, 80);
  assert.equal(Object.values(parsed.claims).filter(claim => claim.active).length, 100);
});

test('fingerprinted seen history still recognizes legacy raw keys and exact duplicate deliveries', () => {
  const legacy = emptyTickState();
  legacy.seen = ['legacy-event-key'];
  const legacyDuplicate = reduceCoordinationTick(legacy, {
    event: event('legacy-event-key'),
    inventory: issueInventory
  });
  assert.equal(legacyDuplicate.duplicate, true);

  const first = reduceCoordinationTick(emptyTickState(), {
    event: event('new-event-key'),
    inventory: issueInventory
  });
  assert.match(first.state.seen[0], /^[a-f0-9]{24}$/);
  const duplicate = reduceCoordinationTick(first.state, {
    event: event('new-event-key'),
    inventory: issueInventory
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.tick, 1);
});
