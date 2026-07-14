import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASSIGNMENT_MARKER,
  OUTPUT_MARKER,
  SEED_MARKER,
  parseCognitionOutputComment,
  runRecursiveCognitionBridge,
  trustedCognitionComment
} from '../weave-recursive-bridge.mjs';

const at = index => new Date(Date.UTC(2026, 6, 15, 0, 0, index)).toISOString();

class FakeRemote {
  constructor() {
    this.events = [];
    this.generation = 1;
  }
  async listMessages() {
    return {
      generation: this.generation,
      messages: this.events.map((event, index) => ({
        id: `message:${index}`,
        visibility: event.visibility,
        payload: { action: 'cognition.event', summary: event.kind, cognition: structuredClone(event) }
      }))
    };
  }
  async appendEvent(event) {
    if (this.events.some(value => value.id === event.id)) return { event, duplicate: true };
    this.events.push(structuredClone(event));
    return { event, duplicate: false };
  }
  async appendEvents(events) {
    const values = [];
    for (const event of events) values.push(await this.appendEvent(event));
    return values;
  }
}

class FakeGitHub {
  constructor(comments = []) {
    this.comments = comments;
    this.nextId = 1000;
  }
  async listComments() { return structuredClone(this.comments); }
  async postComment(issueNumber, body) {
    const comment = {
      id: this.nextId++,
      body,
      html_url: `https://example.test/issues/${issueNumber}#issuecomment-${this.nextId}`,
      created_at: at(this.nextId % 60),
      author_association: 'NONE',
      user: { login: 'github-actions[bot]' }
    };
    this.comments.push(comment);
    return structuredClone(comment);
  }
  addOwnerComment(body, index) {
    this.comments.push({
      id: this.nextId++,
      body,
      html_url: `https://example.test/issues/178#issuecomment-${this.nextId}`,
      created_at: at(index),
      author_association: 'OWNER',
      user: { login: 'Pokitomas' }
    });
  }
}

function jsonBlocks(body) {
  return [...String(body).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => JSON.parse(match[1]));
}

function seedComment() {
  return `<!-- ${SEED_MARKER} -->\n\`\`\`json\n${JSON.stringify({
    events: [{
      id: 'question:seed',
      kind: 'question',
      body: { question: 'Should the recursive weave stop when its question is resolved?', priority: 95, answer_kinds: ['decision'] },
      source_event_ids: []
    }]
  }, null, 2)}\n\`\`\``;
}

function outputForPacket(packet, index) {
  const target = packet.target_event_ids[0];
  let events;
  if (packet.role === 'proposer') {
    events = [
      {
        id: `claim:output:${index}`,
        kind: 'claim',
        source_event_ids: [target],
        body: { subject: 'recursion', statement: 'Stop only when folded unresolved state is empty.', confidence: 0.8, impact: 90, tags: ['termination'] }
      },
      {
        id: `evidence:output:${index}`,
        kind: 'evidence',
        source_event_ids: [target, `claim:output:${index}`],
        body: { statement: 'A terminal receipt proves the bounded stop.', supports: [`claim:output:${index}`], opposes: [], artifacts: [], strength: 0.9 }
      }
    ];
  } else {
    events = [{
      id: `decision:output:${index}`,
      kind: 'decision',
      source_event_ids: [target],
      body: {
        statement: 'Stop when the question is resolved and no contradictory receipt remains.',
        supporting_ids: [target],
        opposing_ids: [],
        rationale: 'The event graph and terminal receipt are replayable.',
        confidence: 0.9,
        resolves: [target],
        rollback_trigger: 'new unresolved contradiction'
      }
    }];
  }
  return `<!-- ${OUTPUT_MARKER} -->\n\`\`\`json\n${JSON.stringify({ assignment_id: packet.assignment_id, events }, null, 2)}\n\`\`\``;
}

test('trusted output parser requires a typed envelope', () => {
  const comment = { body: outputForPacket({ assignment_id: 'assign:1', role: 'verifier', target_event_ids: ['question:1'] }, 1) };
  assert.equal(parseCognitionOutputComment(comment).assignment_id, 'assign:1');
  assert.equal(parseCognitionOutputComment({ body: 'plain prose' }), null);
  assert.equal(trustedCognitionComment({ author_association: 'OWNER', user: { login: 'owner' } }), true);
  assert.equal(trustedCognitionComment({ author_association: 'NONE', user: { login: 'stranger' } }), false);
});

test('one seed fans out to parallel agents, folds their outputs, and terminalizes one shared state', async () => {
  const remote = new FakeRemote();
  const github = new FakeGitHub();
  github.addOwnerComment(seedComment(), 1);
  let clock = 10;
  const now = () => at(clock++);

  const first = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now });
  assert.equal(first.status, 'dispatched');
  assert.equal(first.assignments, 2);
  assert.equal(first.comments_posted, 2);
  const assignmentComments = github.comments.filter(comment => comment.body.includes(ASSIGNMENT_MARKER));
  assert.equal(assignmentComments.length, 2);
  assert.ok(assignmentComments.some(comment => comment.body.includes('@codex')));
  assert.ok(assignmentComments.some(comment => comment.body.includes('@copilot')));
  assert.equal(remote.events.filter(event => event.kind === 'assignment').length, 2);
  assert.equal(remote.events.filter(event => event.kind === 'dispatch.started').length, 2);

  assignmentComments.forEach((comment, index) => {
    const packet = jsonBlocks(comment.body)[0];
    github.addOwnerComment(outputForPacket(packet, index + 1), 20 + index);
  });

  const second = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now });
  assert.equal(second.status, 'converged');
  assert.equal(remote.events.filter(event => event.kind === 'dispatch.completed').length, 2);
  assert.ok(remote.events.some(event => event.kind === 'synthesis'));
  assert.ok(remote.events.some(event => event.kind === 'critique' && event.body.verdict === 'accept'));
  assert.ok(remote.events.some(event => event.kind === 'wave.receipt' && event.body.status === 'converged'));
  const question = remote.events.find(event => event.id === 'question:seed');
  assert.equal(question.visibility, 'public');

  const count = remote.events.length;
  const comments = github.comments.length;
  const third = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now });
  assert.equal(third.status, 'converged');
  assert.equal(remote.events.length, count);
  assert.equal(github.comments.length, comments);
});

test('unauthorized seed does not become canonical state', async () => {
  const remote = new FakeRemote();
  const github = new FakeGitHub([{
    id: 1,
    body: seedComment(),
    created_at: at(1),
    author_association: 'NONE',
    user: { login: 'stranger' }
  }]);
  const result = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now: () => at(2) });
  assert.equal(result.status, 'idle');
  assert.equal(remote.events.length, 0);
  assert.equal(github.comments.length, 1);
});

test('private assignments fail closed instead of leaking memory to a public issue', async () => {
  const remote = new FakeRemote();
  await remote.appendEvent({
    protocol: 'sideways-cognition', version: 1, id: 'question:private', kind: 'question', issuer: 'private:test', issued_at: at(1), visibility: 'private', parent: null, source_event_ids: [],
    body: { question: 'Private?', priority: 90, answer_kinds: ['decision'], resolved_by: null }
  });
  const github = new FakeGitHub();
  let clock = 10;
  const first = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now: () => at(clock++) });
  assert.equal(first.status, 'dispatched');
  assert.equal(first.comments_posted, 0);
  const second = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now: () => at(clock++) });
  assert.ok(['blocked', 'human_required'].includes(second.status));
  assert.equal(github.comments.length, 0);
  assert.ok(remote.events.some(event => event.kind === 'dispatch.completed' && event.body.status === 'failed'));
});
