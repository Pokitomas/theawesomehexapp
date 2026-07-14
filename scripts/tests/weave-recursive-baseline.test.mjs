import assert from 'node:assert/strict';
import test from 'node:test';
import { foldCognitionEvents, normalizeCognitionEvent } from '../weave-cognition.mjs';
import { planDeliberationWave } from '../weave-deliberation.mjs';
import { retrieveCognitionMemory } from '../weave-memory.mjs';
import { buildRolePacket, parseAdapterOutput } from '../weave-dispatch.mjs';
import { buildSynthesis, critiqueSynthesis } from '../weave-synthesis.mjs';
import { runRecursiveWeave } from '../weave-recursive-runtime.mjs';

const at = index => new Date(Date.UTC(2026, 6, 14, 22, 0, index)).toISOString();
const event = (id, kind, body, source_event_ids = [], visibility = 'private') => ({ id, kind, body, source_event_ids, visibility, issuer: 'agent:test', issued_at: at(Number(id.match(/\d+/)?.[0] || 0)) });

test('belief graph preserves contradiction, dissent, supersession, and duplicate delivery', () => {
  const claimA = event('claim:1', 'claim', { subject: 'runtime', statement: 'one wave is enough', confidence: 0.4, impact: 80 });
  const claimB = event('claim:2', 'claim', { subject: 'runtime', statement: 'multiple waves are required', confidence: 0.7, impact: 80 });
  const contradiction = event('contradiction:3', 'contradiction', { left_id: claimA.id, right_id: claimB.id, statement: 'wave count conflicts', severity: 90 }, [claimA.id, claimB.id]);
  const supersede = event('supersede:4', 'supersede', { target_ids: [claimA.id], statement: 'counterexample invalidated one-wave claim' }, [claimA.id, claimB.id]);
  const state = foldCognitionEvents([claimA, claimA, claimB, contradiction, supersede]);
  assert.equal(state.events.length, 4);
  assert.equal(state.claims[claimA.id].status, 'superseded');
  assert.deepEqual(state.unresolved_contradiction_ids, [contradiction.id]);
  assert.ok(state.dissent_event_ids.includes(claimB.id));
});

test('hidden reasoning and dangling references fail closed', () => {
  assert.throws(() => normalizeCognitionEvent(event('claim:1', 'claim', { subject: 'x', statement: 'x', chain_of_thought: 'secret' })), /not a permitted durable field/);
  assert.throws(() => foldCognitionEvents([event('evidence:1', 'evidence', { statement: 'ghost', supports: ['missing'], opposes: [], artifacts: [], strength: 1 }, ['missing'])]), /missing event/);
});

test('planner creates complementary deterministic assignments and stops after equivalent assignments exist', () => {
  const question = event('question:1', 'question', { question: 'Which architecture?', priority: 90, answer_kinds: ['claim'] });
  const state = foldCognitionEvents([question]);
  const first = planDeliberationWave(state, { wave_index: 0, issued_at: at(1) });
  const second = planDeliberationWave(state, { wave_index: 0, issued_at: at(1) });
  assert.deepEqual(first, second);
  assert.deepEqual(first.assignments.map(value => value.body.role), ['proposer', 'verifier']);
});

test('planner derives another bounded wave only after substantive frontier change', () => {
  const question = event('question:1', 'question', { question: 'Which architecture?', priority: 90, answer_kinds: ['claim'] });
  const initial = foldCognitionEvents([question]);
  const first = planDeliberationWave(initial, { wave_index: 0, issued_at: at(1) });
  const assignments = first.assignments.map(({ novelty_key, priority, ...value }) => normalizeCognitionEvent(value));
  const claim = event('claim:2', 'claim', { subject: 'architecture', statement: 'candidate A', confidence: 0.5, impact: 80 }, [question.id]);
  const advanced = foldCognitionEvents([question, ...assignments, claim]);
  const second = planDeliberationWave(advanced, { wave_index: 1, issued_at: at(2) });
  assert.ok(second.assignments.length > 0);
  assert.notDeepEqual(second.assignments.map(value => value.body.novelty_key), first.assignments.map(value => value.body.novelty_key));
});

test('supersession changes derived plan status without mutating immutable event body', () => {
  const goal = event('goal:1', 'goal', { statement: 'ship', success_criteria: ['green'], priority: 80, state: 'open' });
  const plan = event('plan:2', 'plan', { statement: 'old plan', goal_ids: [goal.id], steps: [], state: 'active' }, [goal.id]);
  const supersede = event('supersede:3', 'supersede', { target_ids: [plan.id], statement: 'replace old plan' }, [plan.id]);
  const state = foldCognitionEvents([goal, plan, supersede]);
  assert.equal(state.plans[plan.id].status, 'abandoned');
  assert.equal(state.by_id[plan.id].body.state, 'active');
});

test('memory preserves dissent diversity and private/public boundary under budget', () => {
  const publicClaim = event('claim:1', 'claim', { subject: 'x', statement: 'public architecture', confidence: 0.6, impact: 50 }, [], 'public');
  const privateClaim = event('claim:2', 'claim', { subject: 'x', statement: 'private countercase', confidence: 0.8, impact: 50 });
  const contradiction = event('contradiction:3', 'contradiction', { left_id: publicClaim.id, right_id: privateClaim.id, statement: 'countercase', severity: 80 }, [publicClaim.id, privateClaim.id], 'public');
  const state = foldCognitionEvents([publicClaim, privateClaim, contradiction]);
  const packet = retrieveCognitionMemory(state, { text: 'architecture countercase', target_ids: [contradiction.id] }, { visibility: 'public', max_chars: 4000 });
  assert.ok(packet.events.some(value => value.id === publicClaim.id));
  assert.ok(!packet.events.some(value => value.id === contradiction.id));
  assert.ok(!JSON.stringify(packet).includes(privateClaim.id));
});

test('dispatch packets are advisory and output must cite targets and stay in schema', () => {
  const question = event('question:1', 'question', { question: 'Q?', priority: 80, answer_kinds: ['claim'] });
  const assignment = normalizeCognitionEvent({
    id: 'event:assignment:1', kind: 'assignment', issuer: 'system', issued_at: at(2), visibility: 'private', source_event_ids: [question.id],
    body: { assignment_id: 'assignment:1', wave_id: 'wave:0', role: 'proposer', target_ids: [question.id], expected_kinds: ['claim'], completion_criteria: ['answer'], budget: { max_events: 2, max_chars: 2000 }, artifact_scope: [], novelty_key: 'novelty:proposer:question:1' }
  });
  const packet = buildRolePacket(assignment, { events: [question] }, 'fake');
  assert.equal(packet.authority.merge, false);
  const parsed = parseAdapterOutput([{ kind: 'claim', source_event_ids: [question.id], body: { subject: 'Q', statement: 'A', confidence: 0.7, impact: 50 } }], packet, { issued_at: at(3) });
  assert.equal(parsed[0].kind, 'claim');
  assert.throws(() => parseAdapterOutput([{ kind: 'claim', source_event_ids: [], body: { subject: 'Q', statement: 'A', confidence: 0.7, impact: 50 } }], packet), /missing assignment target citations/);
  assert.throws(() => parseAdapterOutput([{ kind: 'claim', authority: { repo_write: true }, source_event_ids: [question.id], body: { subject: 'Q', statement: 'A', confidence: 0.7, impact: 50 } }], packet), /Forbidden adapter authority/);
  assert.throws(() => parseAdapterOutput([{ kind: 'claim', source_event_ids: [question.id], body: { subject: 'Q', statement: 'token=leaked-value', confidence: 0.7, impact: 50 } }], packet), /secret-like material/);
});

test('critic blocks a synthesis that erases live contradiction or minority evidence', () => {
  const claimA = event('claim:1', 'claim', { subject: 'x', statement: 'A', confidence: 0.6, impact: 80 });
  const claimB = event('claim:2', 'claim', { subject: 'x', statement: 'B', confidence: 0.6, impact: 80 });
  const contradiction = event('contradiction:3', 'contradiction', { left_id: claimA.id, right_id: claimB.id, statement: 'A vs B', severity: 90 }, [claimA.id, claimB.id]);
  const state = foldCognitionEvents([claimA, claimB, contradiction]);
  const synthesis = buildSynthesis({ id: 'synthesis:4', issued_at: at(4), source_events: [claimA], unresolved_ids: [], minority_report_ids: [], proposed_actions: [] });
  const stateWithSynthesis = foldCognitionEvents([claimA, claimB, contradiction, synthesis]);
  const critique = critiqueSynthesis({ id: 'critique:5', synthesis, state: stateWithSynthesis, issued_at: at(5) });
  assert.equal(critique.body.verdict, 'block');
  assert.ok(critique.body.blocking_event_ids.includes(contradiction.id));
});

test('recursive runtime feeds outputs into later waves and terminates on resolved question', async () => {
  const question = event('question:1', 'question', { question: 'Should recursion continue?', priority: 90, answer_kinds: ['decision'] });
  let calls = 0;
  const adapter = {
    id: 'fixture',
    async execute(packet) {
      calls += 1;
      const questionId = packet.assignment.target_ids[0];
      if (packet.assignment.role === 'proposer') {
        const claimId = `claim:${calls}`;
        return [
          { id: claimId, kind: 'claim', source_event_ids: [questionId], body: { subject: 'recursion', statement: 'continue only while unresolved', confidence: 0.8, impact: 90 } },
          { id: `evidence:${calls}`, kind: 'evidence', source_event_ids: [questionId, claimId], body: { statement: 'bounded runtime witness', supports: [claimId], opposes: [], artifacts: [], strength: 0.9 } }
        ];
      }
      return [{
        id: `decision:${calls}`,
        kind: 'decision',
        source_event_ids: [questionId],
        body: { statement: 'stop when unresolved state is empty', supporting_ids: [questionId], opposing_ids: [], rationale: 'bounded recursive invariant', confidence: 0.9, resolves: [questionId], rollback_trigger: 'new contradiction' }
      }];
    }
  };
  const result = await runRecursiveWeave({ initial_events: [question], adapters: { proposer: adapter, verifier: adapter }, budget: { max_waves: 4, max_events: 64 }, now: (() => { let i = 10; return () => at(i++); })() });
  assert.equal(result.terminal, 'converged');
  assert.ok(result.receipts.length >= 1);
  assert.equal(result.state.open_question_ids.length, 0);
  assert.ok(result.events.some(value => value.kind === 'synthesis'));
  assert.ok(calls >= 2);
});

test('recursive runtime terminates cyclic nonprogress at finite budget', async () => {
  const question = event('question:1', 'question', { question: 'loop?', priority: 90, answer_kinds: ['claim'] });
  const adapter = {
    id: 'loop',
    async execute(packet) {
      return [{ kind: 'claim', source_event_ids: [packet.assignment.target_ids[0]], body: { subject: 'loop', statement: 'still unresolved', confidence: 0.5, impact: 10 } }];
    }
  };
  const result = await runRecursiveWeave({ initial_events: [question], adapters: { proposer: adapter, verifier: adapter, default: adapter }, budget: { max_waves: 2, max_events: 48 }, now: (() => { let i = 20; return () => at(i++); })() });
  assert.ok(['blocked', 'budget_exhausted'].includes(result.terminal));
  assert.ok(result.events.length <= 49);
});

test('terminal receipt makes a retry an exact no-op', async () => {
  const question = event('question:1', 'question', { question: 'resolve?', priority: 90, answer_kinds: ['decision'] });
  const adapter = {
    id: 'resolver',
    async execute(packet) {
      return [{
        kind: 'decision',
        source_event_ids: [packet.assignment.target_ids[0]],
        body: { statement: 'resolved', supporting_ids: [packet.assignment.target_ids[0]], opposing_ids: [], rationale: 'fixture', confidence: 0.9, resolves: [packet.assignment.target_ids[0]], rollback_trigger: 'counterexample' }
      }];
    }
  };
  const now = (() => { let i = 40; return () => at(i++); })();
  const first = await runRecursiveWeave({ initial_events: [question], adapters: { proposer: adapter, verifier: adapter }, now });
  const second = await runRecursiveWeave({ initial_events: first.events, adapters: { proposer: adapter, verifier: adapter }, now });
  assert.equal(second.terminal, first.terminal);
  assert.equal(second.events.length, first.events.length);
  assert.deepEqual(second.receipts.map(value => value.id), first.receipts.map(value => value.id));
});

test('invalid initial event terminates as typed invalid-state receipt', async () => {
  const result = await runRecursiveWeave({ initial_events: [{ kind: 'claim', issuer: 'x', body: { subject: 'x', statement: 'x', scratchpad: 'hidden' } }], now: () => at(50) });
  assert.equal(result.terminal, 'invalid_state');
  assert.equal(result.receipts[0].body.status, 'invalid_state');
});
