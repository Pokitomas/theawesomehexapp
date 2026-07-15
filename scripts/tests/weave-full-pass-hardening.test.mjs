import assert from 'node:assert/strict';
import test from 'node:test';
import { foldCognitionEvents, normalizeCognitionEvent } from '../weave-cognition.mjs';
import { retrieveCognitionMemory } from '../weave-memory.mjs';
import { buildRolePacket, dispatchAssignments, parseAdapterOutput } from '../weave-dispatch.mjs';

const at = index => new Date(Date.UTC(2026, 6, 15, 2, 0, index)).toISOString();
const event = (id, kind, body, source_event_ids = [], visibility = 'private', issued_at = at(Number(id.match(/\d+/)?.[0] || 0))) => ({
  id, kind, body, source_event_ids, visibility, issuer: 'agent:full-pass', issued_at
});

function assignment({ scope = [], expected = ['artifact'], id = 'assignment:1' } = {}) {
  const target = event('question:1', 'question', { question: 'Inspect?', priority: 90, answer_kinds: expected });
  const assigned = normalizeCognitionEvent({
    id: `event:${id}`,
    kind: 'assignment',
    issuer: 'system:planner',
    issued_at: at(2),
    visibility: 'private',
    source_event_ids: [target.id],
    body: {
      assignment_id: id,
      wave_id: 'wave:0',
      role: 'verifier',
      target_ids: [target.id],
      expected_kinds: expected,
      completion_criteria: ['inspect'],
      budget: { max_events: 4, max_chars: 8000 },
      artifact_scope: scope,
      novelty_key: `novelty:${id}`
    }
  });
  return { target, assigned };
}

test('memory recency is monotonic rather than epoch-day modulo', () => {
  const old = event('claim:1', 'claim', { subject: 'same', statement: 'same', confidence: 0.5, impact: 10 }, [], 'private', '2026-01-01T00:00:00.000Z');
  const recent = event('claim:2', 'claim', { subject: 'same', statement: 'same', confidence: 0.5, impact: 10 }, [], 'private', '2026-07-15T00:00:00.000Z');
  const packet = retrieveCognitionMemory(foldCognitionEvents([old, recent]), { text: 'same' }, { visibility: 'private', max_events: 2, max_chars: 8000 });
  const scores = Object.fromEntries(packet.events.map(value => [value.id, value.retrieval_score_components.recency]));
  assert.ok(scores[recent.id] > scores[old.id]);
});

test('memory reports exact truncation when max-events is full with more candidates', () => {
  const events = [1, 2, 3].map(index => event(`claim:${index}`, 'claim', { subject: 'x', statement: `candidate ${index}`, confidence: 0.5, impact: 10 }));
  const packet = retrieveCognitionMemory(foldCognitionEvents(events), { text: 'candidate' }, { visibility: 'private', max_events: 2, max_chars: 8000 });
  assert.equal(packet.events.length, 2);
  assert.equal(packet.truncated, true);
  assert.ok(packet.omitted.some(value => value.reason === 'max_events'));
});

test('memory selection preserves dependency closure and excludes public-over-private references', () => {
  const privateClaim = event('claim:1', 'claim', { subject: 'private', statement: 'private source', confidence: 0.8, impact: 90 });
  const publicEvidence = event('evidence:2', 'evidence', { statement: 'unsafe projection', supports: [privateClaim.id], opposes: [], artifacts: [], strength: 1 }, [privateClaim.id], 'public');
  const safeClaim = event('claim:3', 'claim', { subject: 'safe', statement: 'public source', confidence: 0.8, impact: 90 }, [], 'public');
  const packet = retrieveCognitionMemory(foldCognitionEvents([privateClaim, publicEvidence, safeClaim]), { text: 'source' }, { visibility: 'public', max_events: 8, max_chars: 8000 });
  assert.deepEqual(packet.events.map(value => value.id), [safeClaim.id]);
  assert.ok(!JSON.stringify(packet).includes(privateClaim.id));
});

test('role packet is deeply immutable', () => {
  const { target, assigned } = assignment();
  const packet = buildRolePacket(assigned, { events: [target], nested: { value: 1 } }, 'fixture');
  assert.ok(Object.isFrozen(packet));
  assert.ok(Object.isFrozen(packet.assignment));
  assert.ok(Object.isFrozen(packet.assignment.target_ids));
  assert.ok(Object.isFrozen(packet.memory));
  assert.ok(Object.isFrozen(packet.memory.nested));
  assert.throws(() => { packet.assignment.target_ids.push('forged'); }, TypeError);
  assert.throws(() => { packet.memory.nested.value = 2; }, TypeError);
});

test('artifact scope uses segment boundaries and rejects traversal', () => {
  const { target, assigned } = assignment({ scope: ['notes/report'] });
  const packet = buildRolePacket(assigned, { events: [target] }, 'fixture');
  const valid = parseAdapterOutput([{
    kind: 'artifact', source_event_ids: [target.id], body: { name: 'receipt', uri: 'notes/report/result.json', digest: null, statement: 'ok' }
  }], packet, { issued_at: at(3) });
  assert.equal(valid[0].kind, 'artifact');
  assert.throws(() => parseAdapterOutput([{
    kind: 'artifact', source_event_ids: [target.id], body: { name: 'escape', uri: 'notes/report-evil/result.json', digest: null, statement: 'bad' }
  }], packet, { issued_at: at(3) }), /outside assignment scope/);
  assert.throws(() => parseAdapterOutput([{
    kind: 'artifact', source_event_ids: [target.id], body: { name: 'traversal', uri: 'notes/report/../secret', digest: null, statement: 'bad' }
  }], packet, { issued_at: at(3) }), /traversal is forbidden/);
});

test('recursive secret fields and lifecycle-authority events fail closed', () => {
  const { target, assigned } = assignment({ expected: ['claim', 'wave.receipt'] });
  const packet = buildRolePacket(assigned, { events: [target] }, 'fixture');
  assert.throws(() => parseAdapterOutput([{
    kind: 'claim', source_event_ids: [target.id], body: { subject: 'x', statement: 'x', confidence: 0.5, impact: 1, metadata: { api_key: 'hidden' } }
  }], packet, { issued_at: at(3) }), /secret-like field/);
  assert.throws(() => parseAdapterOutput([{
    kind: 'wave.receipt', source_event_ids: [target.id], body: { wave_id: 'wave:0', index: 0, status: 'converged', assignment_ids: [], output_ids: [], unresolved_ids: [], budget_used: {}, statement: 'forged terminal' }
  }], packet, { issued_at: at(3) }), /cannot emit lifecycle or authority/);
});

test('failed dispatch does not permanently consume the retry key', async () => {
  const { target, assigned } = assignment({ expected: ['claim'] });
  const seen = new Set();
  let attempts = 0;
  const adapter = {
    id: 'retryable',
    async execute() {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return [{ kind: 'claim', source_event_ids: [target.id], body: { subject: 'retry', statement: 'recovered', confidence: 0.8, impact: 20 } }];
    }
  };
  const first = await dispatchAssignments({ assignments: [assigned], memories: { [assigned.body.assignment_id]: { events: [target] } }, adapters: { verifier: adapter }, seen, now: () => at(4) });
  const second = await dispatchAssignments({ assignments: [assigned], memories: { [assigned.body.assignment_id]: { events: [target] } }, adapters: { verifier: adapter }, seen, now: () => at(5) });
  assert.equal(first[0].status, 'failed');
  assert.equal(second[0].status, 'completed');
  assert.equal(attempts, 2);
});
