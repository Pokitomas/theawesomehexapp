import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLassoEvents,
  normalizeGitHubArrival,
  selectAssemblies,
  shouldLassoArrival
} from '../weave-lasso.mjs';
import {
  normalizeWeaveEvent,
  weavePayload
} from '../weave-protocol.mjs';

function remoteMessage(event) {
  const normalized = normalizeWeaveEvent(event, {
    issuer: event.issuer || 'weave-lasso',
    issued_at: event.issued_at || '2026-07-14T14:00:00Z'
  });
  return {
    id: `remote-${normalized.id}`,
    session: 'Pokitomas/theawesomehexapp:main',
    generation: 1,
    issuer: normalized.issuer,
    issued_at: normalized.issued_at,
    payload: weavePayload(normalized),
    visibility: event.visibility === 'public' ? 'public' : 'private'
  };
}

const arrival = {
  actor: 'claude-agent',
  repository: 'Pokitomas/theawesomehexapp',
  event_name: 'issue_comment',
  action: 'created',
  source_id: '42',
  title: 'What is the corpus?',
  body: 'The importer, public feed, ranking candidate pool, and social network appear conflated.',
  ref: 'https://github.com/Pokitomas/theawesomehexapp/issues/108#issuecomment-42',
  default_branch: 'main'
};

test('normalizes GitHub arrivals across comment-shaped events', () => {
  const normalized = normalizeGitHubArrival({
    action: 'created',
    sender: { login: 'co-agent' },
    repository: { full_name: 'owner/repo', default_branch: 'trunk' },
    issue: { id: 12, title: 'Question' },
    comment: { id: 99, body: 'What does this program actually do?', html_url: 'https://example.test/comment' }
  }, { GITHUB_EVENT_NAME: 'issue_comment' });
  assert.equal(normalized.actor, 'co-agent');
  assert.equal(normalized.repository, 'owner/repo');
  assert.equal(normalized.source_id, '99');
  assert.equal(normalized.default_branch, 'trunk');
});

test('ignores infrastructure bots but accepts opaque co-agents', () => {
  assert.equal(shouldLassoArrival({ actor: 'github-actions[bot]' }), false);
  assert.equal(shouldLassoArrival({ actor: 'claude-agent' }), true);
  assert.equal(shouldLassoArrival({ actor: 'Pokitomas' }), true);
});

test('always routes arrivals through execution and corpus ontology rooms', () => {
  const selected = selectAssemblies(arrival).map(assembly => assembly.id);
  assert.deepEqual(selected.slice(0, 2), ['program-execution', 'corpus-boundaries']);
  assert.equal(selected.length, 3);
});

test('creates private backend seeds and invitations with no generic corpus escape hatch', () => {
  const events = buildLassoEvents(arrival);
  const corpusSeed = events.find(event => event.kind === 'beacon.emit' && event.body.beacon_id === 'assembly:corpus-boundaries');
  const corpusInvite = events.find(event => event.kind === 'message' && event.body.thread_id === 'assembly:corpus-boundaries');
  assert.ok(corpusSeed);
  assert.ok(corpusInvite);
  assert.equal(corpusSeed.visibility, 'private');
  assert.equal(corpusInvite.visibility, 'private');
  assert.match(corpusInvite.body.statement, /public social graph/);
  assert.match(corpusInvite.body.statement, /private personal archive/);
  assert.match(corpusInvite.body.statement, /candidate pool/);
  assert.match(corpusInvite.body.statement, /Do not use the unqualified word corpus/);
});

test('does not re-invite an actor already present in an assembly', () => {
  const seed = remoteMessage({
    id: 'seed',
    kind: 'beacon.emit',
    body: {
      beacon_id: 'assembly:program-execution',
      kind: 'join_me',
      thread_id: 'assembly:program-execution',
      signal: 'Trace execution.'
    }
  });
  const invite = remoteMessage({
    id: 'invite',
    kind: 'message',
    body: {
      message_type: 'assembly.invite',
      thread_id: 'assembly:program-execution',
      statement: 'Join.',
      artifacts: [{ kind: 'github-arrival', actor: 'claude-agent' }]
    }
  });
  const events = buildLassoEvents(arrival, [seed, invite]);
  assert.equal(events.some(event => event.kind === 'message'
    && event.body.message_type === 'assembly.invite'
    && event.body.thread_id === 'assembly:program-execution'), false);
});

test('forms an adversarial round when a second participant enters the same room', () => {
  const firstArrival = { ...arrival, actor: 'agent-one', source_id: '1' };
  const firstEvents = buildLassoEvents(firstArrival);
  const existing = firstEvents.map(remoteMessage);
  const secondArrival = { ...arrival, actor: 'agent-two', source_id: '2' };
  const secondEvents = buildLassoEvents(secondArrival, existing);
  const round = secondEvents.find(event => event.kind === 'message'
    && event.body.message_type === 'assembly.round'
    && event.body.thread_id === 'assembly:corpus-boundaries');
  assert.ok(round);
  assert.match(round.body.statement, /agent-one, agent-two/);
  assert.match(round.body.statement, /direct contradiction/);
  assert.match(round.body.statement, /one thing the program should delete/);
});

test('event identifiers are deterministic so repeated hooks do not create chatter storms', () => {
  const left = buildLassoEvents(arrival).map(event => event.id);
  const right = buildLassoEvents(arrival).map(event => event.id);
  assert.deepEqual(left, right);
  assert.equal(new Set(left).size, left.length);
});
