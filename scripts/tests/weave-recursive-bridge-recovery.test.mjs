import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSIGNMENT_MARKER, OUTPUT_MARKER, SEED_MARKER } from '../weave-recursive-bridge.mjs';
import { runGuardedRecursiveCognitionBridge } from '../weave-recursive-bridge-runner.mjs';

const at = index => new Date(Date.UTC(2026, 6, 15, 1, 0, index)).toISOString();

class Remote {
  constructor() { this.events = []; }
  async listMessages() {
    return { generation: 1, messages: this.events.map((event, index) => ({ id: `m:${index}`, visibility: event.visibility, payload: { cognition: structuredClone(event) } })) };
  }
  async appendEvent(event) {
    if (!this.events.some(value => value.id === event.id)) this.events.push(structuredClone(event));
    return { event };
  }
  async appendEvents(events) { for (const event of events) await this.appendEvent(event); }
}

class GitHub {
  constructor() { this.comments = []; this.id = 1; }
  async listComments() { return structuredClone(this.comments); }
  async postComment(issue, body) {
    const value = { id: this.id++, body, created_at: at(this.id), author_association: 'NONE', user: { login: 'github-actions[bot]' } };
    this.comments.push(value);
    return value;
  }
  owner(body) {
    this.comments.push({ id: this.id++, body, created_at: at(this.id), author_association: 'OWNER', user: { login: 'Pokitomas' } });
  }
}

const fenced = value => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const seed = `<!-- ${SEED_MARKER} -->\n${fenced({ events: [{ id: 'question:recover', kind: 'question', source_event_ids: [], body: { question: 'Can a corrected output recover?', priority: 90, answer_kinds: ['decision'] } }] })}`;

function packet(comment) {
  return JSON.parse(String(comment.body).match(/```json\s*([\s\S]*?)```/i)[1]);
}

function outputEnvelope(assignmentId, events) {
  return `<!-- ${OUTPUT_MARKER} -->\n${fenced({ assignment_id: assignmentId, events })}`;
}

test('latest valid typed output is ingested after an earlier malformed attempt', async () => {
  const remote = new Remote();
  const github = new GitHub();
  github.owner(seed);
  let clock = 10;
  const now = () => at(clock++);
  const first = await runGuardedRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now });
  assert.equal(first.status, 'dispatched');
  const assignments = github.comments.filter(comment => comment.body.includes(ASSIGNMENT_MARKER)).map(comment => packet(comment));
  assert.equal(assignments.length, 2);

  for (let index = 0; index < assignments.length; index += 1) {
    const value = assignments[index];
    const target = value.target_event_ids[0];
    github.owner(outputEnvelope(value.assignment_id, [{ kind: 'claim', source_event_ids: [], body: { subject: 'bad', statement: 'missing citation', confidence: 0.5, impact: 1 } }]));
    const events = value.role === 'proposer'
      ? [
          { id: `claim:recover:${index}`, kind: 'claim', source_event_ids: [target], body: { subject: 'recovery', statement: 'A later valid output can recover.', confidence: 0.8, impact: 80, tags: [] } },
          { id: `evidence:recover:${index}`, kind: 'evidence', source_event_ids: [target, `claim:recover:${index}`], body: { statement: 'The bridge selects the latest valid envelope.', supports: [`claim:recover:${index}`], opposes: [], artifacts: [], strength: 0.9 } }
        ]
      : [{
          id: `decision:recover:${index}`, kind: 'decision', source_event_ids: [target],
          body: { statement: 'Accept corrected output.', supporting_ids: [target], opposing_ids: [], rationale: 'Malformed attempts remain noncanonical.', confidence: 0.9, resolves: [target], rollback_trigger: 'invalid retry selection' }
        }];
    github.owner(outputEnvelope(value.assignment_id, events));
  }

  const second = await runGuardedRecursiveCognitionBridge({ remote, github, issue_number: 178, allow_logins: ['Pokitomas'], now });
  assert.equal(second.status, 'converged');
  assert.ok(remote.events.some(event => event.id.startsWith('decision:recover:')));
  assert.ok(!remote.events.some(event => event.body?.statement === 'missing citation'));
  assert.ok(remote.events.every(event => !String(event.body?.error || '').includes('invalid output comment')));
});
