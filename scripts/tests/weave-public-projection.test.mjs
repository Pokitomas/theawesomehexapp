import assert from 'node:assert/strict';
import test from 'node:test';
import { messageKey, stateKey } from '../../netlify/functions/remote-core.mjs';
import { createWeaveCollectiveHandler } from '../../netlify/functions/weave-collective.mjs';
import {
  closedPublicCognitionEvents,
  publicCognitionEventProjection,
  publicCognitionStateProjection
} from '../../netlify/functions/weave-cognition-public.mjs';

const session = 'Pokitomas/theawesomehexapp:collective-test';
const at = index => new Date(Date.UTC(2026, 6, 14, 23, 0, index)).toISOString();
const cognition = (id, kind, body, source_event_ids = [], visibility = 'public') => ({
  protocol: 'sideways-cognition', version: 1, id, kind, issuer: 'agent:test', issued_at: at(Number(id.match(/\d+/)?.[0] || 0)), visibility, parent: null, source_event_ids, body
});
const message = (id, event, visibility = 'public', extra = {}) => ({
  id: `message:${id}`, session, generation: 1, issuer: 'bridge:test', parent: null, issued_at: event.issued_at,
  expires_at: null, head_sha: null, scope: [], visibility, nonce: `nonce:${id}`, signature: 'secret-signature',
  payload: { summary: `event ${id}`, cognition: { ...event, future_secret: 'must-not-flow' }, private_prompt: 'raw hidden prompt', ...extra }
});

class MemoryStore {
  constructor() { this.values = new Map(); }
  async get(key, options = {}) {
    if (!this.values.has(key)) return null;
    const value = this.values.get(key);
    return options.type === 'json' ? structuredClone(value) : JSON.stringify(value);
  }
  async setJSON(key, value) { this.values.set(key, structuredClone(value)); }
  async list({ prefix = '', cursor } = {}) {
    const keys = [...this.values.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = cursor ? Math.max(0, keys.indexOf(cursor) + 1) : 0;
    const page = keys.slice(start, start + 100);
    return { blobs: page.map(key => ({ key })), cursor: start + 100 < keys.length ? page.at(-1) : null };
  }
}

test('public projection is explicit, bounded, and omits raw payload fields', () => {
  const goal = cognition('goal:1', 'goal', { statement: 'Build one bounded mind', success_criteria: ['replay'], priority: 90, state: 'open', api_key: 'hidden' });
  const question = cognition('question:2', 'question', { question: 'What remains?', priority: 80, answer_kinds: ['decision'], resolved_by: null });
  const decision = cognition('decision:3', 'decision', {
    statement: 'Use typed receipts', supporting_ids: [goal.id, question.id], opposing_ids: [], rationale: 'Evidence, not fluency.', confidence: 0.8, resolves: [question.id], rollback_trigger: 'failed replay'
  }, [goal.id, question.id]);
  const receipt = cognition('receipt:4', 'wave.receipt', {
    wave_id: 'wave:0', index: 0, status: 'converged', assignment_ids: [], output_ids: [decision.id], unresolved_ids: [], budget_used: { events: 3 }, statement: 'Converged.'
  }, [decision.id]);
  const messages = [message('goal', goal), message('question', question), message('decision', decision), message('receipt', receipt)];
  const projection = publicCognitionStateProjection(messages);
  assert.equal(projection.status, 'converged');
  assert.equal(projection.counts.events, 4);
  assert.equal(projection.questions[0].status, 'resolved');
  assert.equal(projection.decisions[0].statement, 'Use typed receipts');
  const serialized = JSON.stringify(projection);
  for (const forbidden of ['api_key', 'future_secret', 'private_prompt', 'secret-signature', 'nonce:']) assert.doesNotMatch(serialized, new RegExp(forbidden));
  assert.ok(serialized.length < 12000);
});

test('public closure drops events that reference private or malformed cognition', () => {
  const publicClaim = cognition('claim:1', 'claim', { subject: 'public', statement: 'safe', confidence: 0.7, impact: 50, tags: [] });
  const privateClaim = cognition('claim:2', 'claim', { subject: 'private', statement: 'secret countercase', confidence: 0.9, impact: 90, tags: [] }, [], 'private');
  const leaking = cognition('contradiction:3', 'contradiction', { left_id: publicClaim.id, right_id: privateClaim.id, statement: 'must not project', severity: 90, resolved_by: null }, [publicClaim.id, privateClaim.id]);
  const malformed = { ...cognition('claim:4', 'claim', { subject: 'x', statement: 'x', confidence: 0.5, impact: 1, tags: [] }), body: { subject: 'x', statement: 'x', chain_of_thought: 'hidden' } };
  const result = closedPublicCognitionEvents([
    message('public', publicClaim),
    message('private', privateClaim, 'private'),
    message('leaking', leaking),
    message('malformed', malformed)
  ]);
  assert.deepEqual(result.events.map(event => event.id), [publicClaim.id]);
  assert.ok(result.rejected >= 2);
  assert.deepEqual(publicCognitionEventProjection(message('leaking', leaking)), { id: leaking.id, kind: leaking.kind, issued_at: leaking.issued_at, statement: 'must not project', state: 'open' });
  assert.equal(publicCognitionStateProjection([message('public', publicClaim), message('leaking', leaking)]).counts.events, 1);
});

test('collective endpoint reads only public messages and returns no mutation surface', async () => {
  const store = new MemoryStore();
  const goal = cognition('goal:1', 'goal', { statement: 'Public goal', success_criteria: [], priority: 80, state: 'open' });
  const privateGoal = cognition('goal:2', 'goal', { statement: 'Private goal', success_criteria: [], priority: 100, state: 'open' }, [], 'private');
  await store.setJSON(stateKey(session), { session, generation: 1, updated_at: at(5) });
  await store.setJSON(messageKey(session, 1, goal.issued_at, 'public'), message('public', goal));
  await store.setJSON(messageKey(session, 1, privateGoal.issued_at, 'private'), message('private', privateGoal, 'private'));
  const handler = createWeaveCollectiveHandler({ store, env: { REMOTE_PUBLIC_SESSION: session } });
  const response = await handler(new Request('https://sideways.test/api/weave/collective'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.collective.counts.events, 1);
  assert.equal(body.collective.goals[0].statement, 'Public goal');
  const serialized = JSON.stringify(body);
  for (const forbidden of ['Private goal', 'signature', 'nonce', 'payload', 'control', 'dispatch_now', 'merge', 'deploy', 'grant']) assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
  assert.equal((await handler(new Request('https://sideways.test/api/weave/collective', { method: 'POST' }))).status, 405);
});
