import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  emptyTickState,
  parseDeclarationLines,
  parseStateComment,
  reduceCoordinationTick,
  renderStateComment
} from '../coordination-tick-core.mjs';
import {
  declarationsFromSnapshots,
  inventoryFromGitHub,
  normalizeGitHubTickEvent,
  runCoordinationTick
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

test('review and edited-PR events use distinct delivery identities', () => {
  const items = inventoryFromGitHub([{
    number: 1,
    title: 'one',
    html_url: 'https://example.test/pr/1',
    head: { ref: 'agent/a' },
    body: 'Closes #10.'
  }], []);
  const reviewA = normalizeGitHubTickEvent({
    action: 'submitted',
    review: { id: 501, body: 'first' },
    pull_request: { number: 1, head: { ref: 'agent/a', sha: 'a'.repeat(40) } }
  }, { GITHUB_EVENT_NAME: 'pull_request_review' }, items);
  const reviewB = normalizeGitHubTickEvent({
    action: 'submitted',
    review: { id: 502, body: 'second' },
    pull_request: { number: 1, head: { ref: 'agent/a', sha: 'a'.repeat(40) } }
  }, { GITHUB_EVENT_NAME: 'pull_request_review' }, items);
  assert.notEqual(reviewA.key, reviewB.key);

  const editedA = normalizeGitHubTickEvent({
    action: 'edited',
    pull_request: { id: 9, number: 1, updated_at: '2026-07-14T01:00:00Z', head: { ref: 'agent/a', sha: 'a'.repeat(40) } }
  }, { GITHUB_EVENT_NAME: 'pull_request_target' }, items);
  const editedB = normalizeGitHubTickEvent({
    action: 'edited',
    pull_request: { id: 9, number: 1, updated_at: '2026-07-14T01:01:00Z', head: { ref: 'agent/a', sha: 'a'.repeat(40) } }
  }, { GITHUB_EVENT_NAME: 'pull_request_target' }, items);
  assert.notEqual(editedA.key, editedB.key);
});

test('completed branch claims retire and bounded history cannot grow forever', () => {
  const initialItems = inventory(
    { key: 'pr:1', number: 1, branch: 'agent/a', issue_refs: [10] },
    { key: 'issue:10', kind: 'issue', number: 10 }
  );
  const declarations = parseDeclarationLines('MATCHED #10 BRANCH agent/a', {
    actor: 'agent', branch: 'agent/a', issueNumbers: [10], source: 'comment'
  });
  let result = reduceCoordinationTick(emptyTickState(), {
    policy: { quietTicks: 2, staleTicks: 4, completedLaneLimit: 2, claimLimit: 2 },
    event: { key: 'e1', name: 'issue_comment', action: 'created', actor: 'agent', lane_keys: ['issue:10'] },
    inventory: initialItems,
    declarations
  });
  assert.equal(Object.values(result.state.claims)[0].active, true);

  result = reduceCoordinationTick(result.state, {
    event: { key: 'e2', name: 'pull_request_target', action: 'closed', actor: 'agent', lane_keys: ['pr:1'] },
    inventory: inventory({ key: 'issue:10', kind: 'issue', number: 10 })
  });
  assert.equal(Object.values(result.state.claims)[0].active, false);

  let state = result.state;
  for (let index = 0; index < 6; index += 1) {
    state.lanes[`pr:old-${index}`] = {
      key: `pr:old-${index}`,
      kind: 'pr',
      number: 100 + index,
      title: 'old',
      state: 'complete',
      phase: 'complete',
      collision: false,
      branch: `agent/old-${index}`,
      issue_refs: [],
      completed_tick: index,
      last_activity_tick: 0,
      stasis_ticks: 0
    };
  }
  state = reduceCoordinationTick(state, {
    event: { key: 'e3', name: 'workflow_dispatch', action: 'observed', actor: 'agent', lane_keys: [] },
    inventory: inventory({ key: 'issue:10', kind: 'issue', number: 10 })
  }).state;
  assert.ok(Object.values(state.lanes).filter(lane => lane.state === 'complete').length <= 2);
  assert.ok(Object.keys(state.claims).length <= 2);
});

test('bootstrap declarations preserve historical claim and release order', () => {
  const declarations = declarationsFromSnapshots([
    {
      number: 1,
      body: 'Closes #10. MATCHED #10 BRANCH agent/a',
      head: { ref: 'agent/a' },
      user: { login: 'agent' },
      html_url: 'https://example.test/pr/1'
    }
  ], [], {
    1: [{
      id: 2,
      body: 'SUPERSEDED #10 BRANCH agent/a',
      user: { login: 'agent' },
      html_url: 'https://example.test/comment/2'
    }]
  });
  const result = reduceCoordinationTick(emptyTickState(), {
    event: { key: 'bootstrap', name: 'workflow_dispatch', action: 'observed', actor: 'agent', lane_keys: [] },
    inventory: inventory(
      { key: 'pr:1', number: 1, branch: 'agent/a', issue_refs: [10] },
      { key: 'issue:10', kind: 'issue', number: 10 }
    ),
    declarations
  });
  assert.equal(Object.values(result.state.claims)[0].active, false);
});

test('runtime creates one state comment and duplicate delivery performs no second mutation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coordination-tick-'));
  const eventPath = path.join(directory, 'event.json');
  await fs.writeFile(eventPath, JSON.stringify({
    action: 'created',
    sender: { login: 'agent' },
    issue: { number: 10, id: 10, title: 'lane', body: '', html_url: 'https://example.test/issues/10' },
    comment: { id: 900, body: 'MATCHED #10 BRANCH agent/a', html_url: 'https://example.test/comments/900' }
  }));

  let stateBody = null;
  let mutations = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = options.method || 'GET';
    if (method === 'GET' && target.includes('/issues/131/comments')) {
      return new Response(JSON.stringify(stateBody ? [{ id: 77, body: stateBody }] : []), { status: 200 });
    }
    if (method === 'GET' && target.includes('/pulls?state=open')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === 'GET' && target.includes('/issues?state=open')) {
      return new Response(JSON.stringify([{ number: 10, id: 10, title: 'lane', body: '', html_url: 'https://example.test/issues/10', user: { login: 'agent' } }]), { status: 200 });
    }
    if (method === 'GET' && target.includes('/issues/10/comments')) {
      return new Response(JSON.stringify([{ id: 900, body: 'MATCHED #10 BRANCH agent/a', html_url: 'https://example.test/comments/900', user: { login: 'agent' } }]), { status: 200 });
    }
    if (method === 'POST' && target.endsWith('/issues/131/comments')) {
      mutations += 1;
      stateBody = JSON.parse(options.body).body;
      return new Response(JSON.stringify({ id: 77, body: stateBody }), { status: 201 });
    }
    if (method === 'PATCH' && target.endsWith('/issues/comments/77')) {
      mutations += 1;
      stateBody = JSON.parse(options.body).body;
      return new Response(JSON.stringify({ id: 77, body: stateBody }), { status: 200 });
    }
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };

  const env = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: 'issue_comment',
    GITHUB_EVENT_ACTION: 'created',
    GITHUB_ACTOR: 'agent',
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
    COORDINATION_ISSUE: '131'
  };
  try {
    const first = await runCoordinationTick(env);
    assert.equal(first.state.tick, 1);
    assert.equal(mutations, 1);
    assert.ok(stateBody.includes('coordination-tick-state:v1'));

    const duplicate = await runCoordinationTick(env);
    assert.equal(duplicate.duplicate, true);
    assert.equal(mutations, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
