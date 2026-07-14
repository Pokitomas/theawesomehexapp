import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyTickState,
  parseDeclarationLines,
  parseStateComment,
  reduceCoordinationTick,
  renderStateComment
} from '../coordination-tick-core.mjs';
import {
  inventoryFromGitHub,
  normalizeGitHubTickEvent
} from '../coordination-tick.mjs';

const inventory = (...items) => items.map(item => ({
  kind: item.kind || 'pr',
  key: item.key,
  number: item.number,
  title: item.title || item.key,
  url: `https://example.test/${item.key}`,
  branch: item.branch || null,
  issue_refs: item.issue_refs || []
}));

function tick(state, key, laneKeys, items, extra = {}) {
  return reduceCoordinationTick(state, {
    policy: { quietTicks: 2, staleTicks: 4 },
    event: {
      key,
      name: 'issue_comment',
      action: 'created',
      actor: 'agent',
      source: `https://example.test/${key}`,
      observed_at: `2026-07-14T00:00:0${key.slice(-1)}Z`,
      lane_keys: laneKeys,
      branch: extra.branch || null
    },
    inventory: items,
    declarations: extra.declarations || []
  });
}

test('activity and non-activity are complementary legs on one atomic tick', () => {
  const items = inventory(
    { key: 'pr:1', number: 1, branch: 'agent/a', issue_refs: [10] },
    { key: 'pr:2', number: 2, branch: 'agent/b', issue_refs: [20] },
    { key: 'issue:10', kind: 'issue', number: 10 },
    { key: 'issue:20', kind: 'issue', number: 20 }
  );
  let state = tick(emptyTickState(), 'e1', ['pr:1'], items).state;
  assert.equal(state.lanes['pr:1'].stasis_ticks, 0);
  assert.equal(state.lanes['issue:10'].stasis_ticks, 0);
  assert.equal(state.lanes['pr:2'].stasis_ticks, 0);

  state = tick(state, 'e2', ['pr:1'], items).state;
  assert.equal(state.lanes['pr:1'].phase, 'active');
  assert.equal(state.lanes['pr:2'].stasis_ticks, 1);
  state = tick(state, 'e3', ['pr:1'], items).state;
  assert.equal(state.lanes['pr:2'].phase, 'quiet');
  assert.ok(state.signals.some(signal => signal.type === 'quiet' && signal.lane === 'pr:2'));

  state = tick(state, 'e4', ['pr:2'], items).state;
  assert.equal(state.lanes['pr:2'].phase, 'active');
  assert.ok(state.signals.some(signal => signal.type === 'reactivated' && signal.lane === 'pr:2'));
});

test('duplicate delivery does not advance the global tick', () => {
  const items = inventory({ key: 'pr:1', number: 1, branch: 'agent/a', issue_refs: [10] });
  const first = tick(emptyTickState(), 'same', ['pr:1'], items);
  const duplicate = tick(first.state, 'same', ['pr:1'], items);
  assert.equal(first.state.tick, 1);
  assert.equal(duplicate.state.tick, 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.changed, false);
});

test('multiple branches closing or claiming one issue enter collision state', () => {
  const items = inventory(
    { key: 'pr:1', number: 1, branch: 'agent/a', issue_refs: [10] },
    { key: 'pr:2', number: 2, branch: 'agent/b', issue_refs: [10] },
    { key: 'issue:10', kind: 'issue', number: 10 }
  );
  const result = tick(emptyTickState(), 'e1', ['issue:10'], items);
  assert.equal(result.state.lanes['issue:10'].phase, 'collision');
  assert.equal(result.state.lanes['pr:1'].phase, 'collision');
  assert.equal(result.state.lanes['pr:2'].phase, 'collision');
  assert.ok(result.newSignals.some(signal => signal.type === 'collision'));
});

test('MATCHED and branch declarations become collision inputs and releases clear them', () => {
  const items = inventory(
    { key: 'pr:1', number: 1, branch: 'agent/a', issue_refs: [10] },
    { key: 'issue:10', kind: 'issue', number: 10 }
  );
  const declarations = parseDeclarationLines('MATCHED: #10\nBRANCH: agent/b', {
    actor: 'other-agent',
    branch: 'agent/b',
    issueNumbers: [10],
    source: 'comment:1'
  });
  let state = tick(emptyTickState(), 'e1', ['issue:10'], items, { declarations }).state;
  assert.equal(state.lanes['issue:10'].phase, 'collision');

  const releases = parseDeclarationLines('SUPERSEDED #10 branch agent/b', {
    actor: 'other-agent',
    branch: 'agent/b',
    issueNumbers: [10],
    source: 'comment:2'
  });
  state = tick(state, 'e2', ['issue:10'], items, { declarations: releases }).state;
  assert.equal(state.lanes['issue:10'].phase, 'active');
  assert.ok(state.signals.some(signal => signal.type === 'collision-cleared'));
});

test('a lane completes only when it leaves the open inventory', () => {
  const items = inventory({ key: 'pr:1', number: 1, branch: 'agent/a', issue_refs: [10] });
  let state = tick(emptyTickState(), 'e1', ['pr:1'], items).state;
  state = tick(state, 'e2', [], []).state;
  assert.equal(state.lanes['pr:1'].state, 'complete');
  assert.equal(state.lanes['pr:1'].phase, 'complete');
  assert.ok(state.signals.some(signal => signal.type === 'completed'));
});

test('rendered state comment round-trips the machine state', () => {
  const items = inventory({ key: 'pr:1', number: 1, branch: 'agent/a', issue_refs: [10] });
  const state = tick(emptyTickState(), 'e1', ['pr:1'], items).state;
  const rendered = renderStateComment(state);
  const parsed = parseStateComment(rendered);
  assert.deepEqual(parsed, state);
  assert.match(rendered, /Total repository silence creates no tick/);
});

test('GitHub inventory and event normalization bind PR activity to its closing issue', () => {
  const items = inventoryFromGitHub([
    {
      number: 154,
      title: 'assembly',
      html_url: 'https://example.test/pr/154',
      head: { ref: 'assembly/remote-authority-wave' },
      body: 'Closes #152. Includes source PR #145.'
    }
  ], [{ number: 152, title: 'wave', html_url: 'https://example.test/issues/152' }]);
  const event = normalizeGitHubTickEvent({
    action: 'synchronize',
    sender: { login: 'agent' },
    pull_request: {
      number: 154,
      head: { ref: 'assembly/remote-authority-wave', sha: 'a'.repeat(40) },
      body: 'Closes #152.',
      html_url: 'https://example.test/pr/154'
    }
  }, { GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_ACTION: 'synchronize' }, items);
  assert.deepEqual(event.lane_keys.sort(), ['issue:152', 'pr:154']);
  assert.deepEqual(event.issue_numbers, [152]);
  assert.equal(event.branch, 'assembly/remote-authority-wave');
});

test('workflow completion maps back to the PR by head branch when pull_requests is empty', () => {
  const items = inventoryFromGitHub([
    {
      number: 155,
      title: 'assembly',
      html_url: 'https://example.test/pr/155',
      head: { ref: 'assembly/social-authority-wave' },
      body: 'Closes #153.'
    }
  ], []);
  const event = normalizeGitHubTickEvent({
    action: 'completed',
    sender: { login: 'github-actions[bot]' },
    workflow_run: {
      id: 99,
      run_attempt: 2,
      name: 'Verify social authority assembly',
      conclusion: 'success',
      head_branch: 'assembly/social-authority-wave',
      pull_requests: [],
      html_url: 'https://example.test/run/99'
    }
  }, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_ACTION: 'completed' }, items);
  assert.deepEqual(event.lane_keys.sort(), ['issue:153', 'pr:155']);
  assert.equal(event.key, 'workflow_run:99:2:success');
});
