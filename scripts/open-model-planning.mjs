import { createCognitionEvent } from './weave-cognition.mjs';
import { runRecursiveWeave } from './weave-recursive-runtime.mjs';
import { createOpenModelRoleAdapter } from './open-model-adapter.mjs';

const clean = (value, limit = 12000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

export function makerPlanningSeed(intent = {}, now = () => new Date().toISOString()) {
  const issuedAt = now();
  const goal = createCognitionEvent({
    id: 'maker-goal:implementation',
    kind: 'goal',
    issuer: 'human:maker',
    issued_at: issuedAt,
    visibility: 'private',
    source_event_ids: [],
    body: {
      statement: clean(intent.request, 8000),
      success_criteria: [clean(intent.proof || 'produce a verified draft patch', 2000)],
      priority: 100,
      state: 'open'
    }
  });
  const question = createCognitionEvent({
    id: 'maker-question:implementation',
    kind: 'question',
    issuer: 'human:maker',
    issued_at: issuedAt,
    visibility: 'private',
    source_event_ids: [goal.id],
    body: {
      question: [
        `How should the repository implement: ${clean(intent.request, 6000)}`,
        intent.protect ? `Protected reality: ${clean(intent.protect, 3000)}` : '',
        intent.proof ? `Required proof: ${clean(intent.proof, 3000)}` : ''
      ].filter(Boolean).join('\n'),
      priority: 100,
      answer_kinds: ['claim', 'evidence', 'plan', 'test.result'],
      resolved_by: null
    }
  });
  return [goal, question];
}

export function planningBrief(result = {}) {
  const events = Array.isArray(result.events) ? result.events : [];
  const useful = events.filter(event => ['claim', 'evidence', 'plan', 'test.result', 'uncertainty', 'synthesis', 'critique'].includes(event.kind));
  const failures = events
    .filter(event => event.kind === 'dispatch.completed' && event.body?.status === 'failed')
    .map(event => ({
      assignment_id: clean(event.body?.assignment_id, 300),
      adapter_id: clean(event.body?.adapter_id, 300),
      error: clean(event.body?.error || 'planning adapter failed', 1000)
    }));
  const receipts = events
    .filter(event => event.kind === 'wave.receipt')
    .map(event => ({
      wave_id: clean(event.body?.wave_id, 200),
      status: clean(event.body?.status, 80),
      unresolved_ids: Array.isArray(event.body?.unresolved_ids) ? event.body.unresolved_ids.slice(0, 64) : []
    }));
  return {
    terminal: result.terminal || null,
    event_count: events.length,
    outputs: useful.slice(-48).map(event => ({
      id: event.id,
      kind: event.kind,
      issuer: event.issuer,
      source_event_ids: event.source_event_ids,
      body: event.body
    })),
    failures: failures.slice(-32),
    receipts: receipts.slice(-16),
    degraded: failures.length > 0 || ['blocked', 'failed', 'invalid_state'].includes(result.terminal),
    error: clean(result.error, 2000) || null
  };
}

export async function runOpenModelPlanning({
  intent,
  model_client,
  max_waves = 2,
  max_events = 160,
  max_assignments_per_wave = 6,
  now = () => new Date().toISOString()
} = {}) {
  if (!model_client?.complete) throw new Error('A model client is required for planning.');
  const roles = ['proposer', 'opponent', 'verifier', 'implementer', 'integrator', 'historian', 'critic'];
  const adapters = Object.fromEntries(roles.map(role => [role, createOpenModelRoleAdapter(model_client, {
    id: `open-model:${role}`,
    role
  })]));
  adapters.default = createOpenModelRoleAdapter(model_client, { id: 'open-model:default', role: 'default' });
  try {
    const result = await runRecursiveWeave({
      initial_events: makerPlanningSeed(intent, now),
      adapters,
      budget: {
        max_waves: Math.max(1, Math.min(8, Number(max_waves) || 2)),
        max_events: Math.max(32, Math.min(1024, Number(max_events) || 160)),
        max_assignments_per_wave: Math.max(1, Math.min(16, Number(max_assignments_per_wave) || 6)),
        max_open_questions: 32,
        max_memory_chars: 16000
      },
      now
    });
    return { ...result, brief: planningBrief(result) };
  } catch (error) {
    const result = {
      terminal: 'failed',
      events: makerPlanningSeed(intent, now),
      receipts: [],
      state: null,
      error: clean(error?.message || error, 2000)
    };
    return { ...result, brief: planningBrief(result) };
  }
}
