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
import { runGuardedRecursiveCognitionBridge } from '../weave-recursive-bridge-runner.mjs';

const at = index => new Date(Date.UTC(2026, 6, 15, 0, 0, index)).toISOString();

class Remote {
  constructor(events = []) { this.events = structuredClone(events); }
  async listMessages() {
    return { generation: 1, messages: this.events.map((event, index) => ({ id: `m:${index}`, visibility: event.visibility, payload: { cognition: structuredClone(event) } })) };
  }
  async appendEvent(event) {
    if (!this.events.some(value => value.id === event.id)) this.events.push(structuredClone(event));
    return { event };
  }
  async appendEvents(events) { for (const event of events) await this.appendEvent(event); }
}

class Issue {
  constructor(comments = []) { this.comments = structuredClone(comments); this.id = 1000; }
  async listComments() { return structuredClone(this.comments); }
  async postComment(issue, body) {
    const comment = { id: this.id++, body, created_at: at(this.id % 60), author_association: 'NONE', user: { login: 'github-actions[bot]' } };
    this.comments.push(comment);
    return structuredClone(comment);
  }
  owner(body, index = this.id % 60, login = 'Pokitomas') {
    this.comments.push({ id: this.id++, body, created_at: at(index), author_association: 'OWNER', user: { login } });
  }
}

const fenced = value => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const seed = `<!-- ${SEED_MARKER} -->\n${fenced({ events: [{ id: 'question:seed', kind: 'question', source_event_ids: [], body: { question: 'When should recursion stop?', priority: 95, answer_kinds: ['decision'] } }] })}`;
const packet = comment => JSON.parse(String(comment.body).match(/```json\s*([\s\S]*?)```/i)[1]);
const envelope = (assignment, index) => {
  const target = assignment.target_event_ids[0];
  let events;
  if (assignment.role === 'proposer') {
    events = [
      { id: `claim:${index}`, kind: 'claim', source_event_ids: [target], body: { subject: 'recursion', statement: 'Stop when unresolved state is empty.', confidence: 0.8, impact: 90, tags: [] } },
      { id: `evidence:${index}`, kind: 'evidence', source_event_ids: [target, `claim:${index}`], body: { statement: 'The terminal receipt is replayable.', supports: [`claim:${index}`], opposes: [], artifacts: [], strength: 0.9 } }
    ];
  } else if (assignment.role === 'critic') {
    const structuralId = assignment.target_event_ids.find(id => id.startsWith('critique:'));
    const synthesisId = assignment.target_event_ids.find(id => id.startsWith('synthesis:'));
    events = [{
      id: `critique:independent:${index}`,
      kind: 'critique',
      source_event_ids: [structuralId, synthesisId],
      body: { synthesis_id: synthesisId, verdict: 'accept', findings: [], required_corrections: [], blocking_event_ids: [] }
    }];
  } else {
    events = [{
      id: `test:${index}`,
      kind: 'test.result',
      source_event_ids: [target],
      body: { name: 'bridge witness', status: 'passed', statement: 'Candidate material passed a bounded witness.', targets: [target], artifacts: [] }
    }];
  }
  return `<!-- ${OUTPUT_MARKER} -->\n${fenced({ assignment_id: assignment.assignment_id, events })}`;
};

test('trusted output parser requires a typed envelope', () => {
  assert.equal(parseCognitionOutputComment({ body: envelope({ assignment_id: 'a:1', role: 'verifier', target_event_ids: ['q:1'] }, 1) }).assignment_id, 'a:1');
  assert.equal(parseCognitionOutputComment({ body: 'plain prose' }), null);
  assert.equal(trustedCognitionComment({ author_association: 'OWNER', user: { login: 'owner' } }), true);
  assert.equal(trustedCognitionComment({ author_association: 'NONE', user: { login: 'stranger' } }), false);
});

test('one seed fans out, requires an independent critic tick, and converges idempotently', async () => {
  const remote = new Remote();
  const github = new Issue();
  github.owner(seed, 1);
  let clock = 10;
  const now = () => at(clock++);
  const first = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now });
  assert.deepEqual([first.status, first.assignments, first.comments_posted], ['dispatched', 2, 2]);
  let assignments = github.comments.filter(comment => comment.body.includes(ASSIGNMENT_MARKER));
  assignments.forEach((comment, index) => github.owner(envelope(packet(comment), index + 1), 20 + index));

  const second = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now });
  assert.equal(second.status, 'dispatched');
  assert.equal(second.assignments, 1);
  assert.ok(remote.events.some(event => event.kind === 'critique' && event.issuer === 'system:weave-critic' && event.body.verdict === 'revise'));
  assert.ok(!remote.events.some(event => event.kind === 'decision'));

  assignments = github.comments.filter(comment => comment.body.includes(ASSIGNMENT_MARKER));
  const criticComment = assignments.find(comment => packet(comment).role === 'critic');
  github.owner(envelope(packet(criticComment), 3), 30, 'IndependentReviewer');
  const third = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas', 'IndependentReviewer'], now });
  assert.equal(third.status, 'converged');
  assert.ok(remote.events.some(event => event.kind === 'critique' && event.issuer === 'github:IndependentReviewer' && event.body.verdict === 'accept'));
  assert.ok(remote.events.some(event => event.kind === 'decision' && event.issuer === 'system:weave-integrator'));

  const eventCount = remote.events.length;
  const commentCount = github.comments.length;
  assert.equal((await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas', 'IndependentReviewer'], now })).status, 'converged');
  assert.deepEqual([remote.events.length, github.comments.length], [eventCount, commentCount]);
});

test('unauthorized seed leaves the canonical bridge idle', async () => {
  const remote = new Remote();
  const github = new Issue([{ id: 1, body: seed, created_at: at(1), author_association: 'NONE', user: { login: 'stranger' } }]);
  const result = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now: () => at(2) });
  assert.equal(result.status, 'idle');
  assert.equal(remote.events.length, 0);
  assert.equal(github.comments.length, 1);

  const guarded = await runGuardedRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now: () => at(3) });
  assert.equal(guarded.status, 'idle');
  assert.equal(remote.events.length, 0);
  assert.equal(github.comments.length, 1);
});

test('private assignments fail closed without posting private memory', async () => {
  const remote = new Remote([{ protocol: 'sideways-cognition', version: 1, id: 'question:private', kind: 'question', issuer: 'private:test', issued_at: at(1), visibility: 'private', parent: null, source_event_ids: [], body: { question: 'Private?', priority: 90, answer_kinds: ['decision'], resolved_by: null } }]);
  const github = new Issue();
  let clock = 10;
  const first = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now: () => at(clock++) });
  assert.equal(first.status, 'dispatched');
  assert.equal(first.comments_posted, 0);
  const second = await runRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now: () => at(clock++) });
  assert.ok(['blocked', 'human_required'].includes(second.status));
  assert.equal(github.comments.length, 0);
  assert.ok(remote.events.some(event => event.kind === 'dispatch.completed' && event.body.status === 'failed'));
});
