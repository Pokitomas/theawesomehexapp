import { foldCognitionEvents, normalizeCognitionEvent, unresolvedCognitionIds } from './weave-cognition.mjs';
import { planDeliberationWave } from './weave-deliberation.mjs';
import { retrieveCognitionMemory } from './weave-memory.mjs';
import { buildRolePacket, parseAdapterOutput } from './weave-dispatch.mjs';
import { buildSynthesis, critiqueSynthesis } from './weave-synthesis.mjs';

export function normalizeRecursiveBudget(input = {}) {
  const bounded = (name, fallback, min, max) => {
    const value = input[name] === undefined ? fallback : Number(input[name]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid recursive budget: ${name}.`);
    return Math.floor(value);
  };
  return Object.freeze({
    max_waves: bounded('max_waves', 4, 1, 32),
    max_events: bounded('max_events', 128, 1, 4096),
    max_assignments_per_wave: bounded('max_assignments_per_wave', 8, 1, 32),
    max_open_questions: bounded('max_open_questions', 64, 1, 512),
    max_memory_chars: bounded('max_memory_chars', 12000, 256, 64000)
  });
}

function terminalReceipt({ waveIndex, status, assignments = [], outputs = [], unresolved = [], events, now }) {
  return normalizeCognitionEvent({
    id: `receipt:wave:${waveIndex}:${status}`,
    kind: 'wave.receipt',
    issuer: 'system:weave-runtime',
    issued_at: now(),
    visibility: 'private',
    source_event_ids: [...assignments.map(event => event.id), ...outputs.map(event => event.id), ...unresolved],
    body: {
      wave_id: `wave:${waveIndex}`,
      index: waveIndex,
      status,
      assignment_ids: assignments.map(event => event.id),
      output_ids: outputs.map(event => event.id),
      unresolved_ids: unresolved,
      budget_used: { events: events.length, assignments: assignments.length },
      statement: `Recursive weave wave ${waveIndex} ${status}.`
    }
  });
}

function adapterForAssignment(adapters, assignment, started = null) {
  if (started) {
    const exact = Object.values(adapters).find(adapter => adapter?.id === started.body.adapter_id);
    if (exact) return exact;
  }
  return adapters[assignment.body.role] || adapters.default || null;
}

function dispatchLifecycle(packet, assignment, now, status = null, outputs = [], error = null) {
  const short = packet.idempotency_key.slice(0, 32);
  const shared = {
    issuer: 'system:weave-runtime',
    issued_at: now(),
    visibility: 'private',
    source_event_ids: [assignment.id, ...outputs.map(event => event.id)],
    body: {
      dispatch_id: `dispatch:${short}`,
      assignment_event_id: assignment.id,
      assignment_id: assignment.body.assignment_id,
      adapter_id: packet.adapter_id,
      idempotency_key: packet.idempotency_key
    }
  };
  if (!status) return normalizeCognitionEvent({ ...shared, id: `dispatch-start:${short}`, kind: 'dispatch.started' });
  return normalizeCognitionEvent({
    ...shared,
    id: `dispatch-complete:${short}`,
    kind: 'dispatch.completed',
    body: {
      ...shared.body,
      status,
      output_ids: outputs.map(event => event.id),
      error: error ? String(error).slice(0, 500) : null
    }
  });
}

function existingAssignmentOutputs(state, assignment) {
  const allowed = new Set(assignment.body.expected_kinds);
  return (state.events || []).filter(event => allowed.has(event.kind) && event.source_event_ids.includes(assignment.id));
}

function waveIndexOfAssignment(assignment, fallback) {
  const match = String(assignment?.body?.wave_id || '').match(/:(\d+)$/);
  return match ? Number(match[1]) : fallback;
}

export async function runRecursiveWeave({ initial_events = [], adapters = {}, budget: budgetInput = {}, now = () => new Date().toISOString() }) {
  const budget = normalizeRecursiveBudget(budgetInput);
  let events;
  try {
    events = initial_events.map(event => normalizeCognitionEvent(event));
  } catch (error) {
    const receipt = terminalReceipt({ waveIndex: 0, status: 'invalid_state', unresolved: [], events: [], now });
    return { terminal: 'invalid_state', events: [receipt], receipts: [receipt], state: foldCognitionEvents([receipt]), budget, error: String(error?.message || error) };
  }
  const receipts = events.filter(event => event.kind === 'wave.receipt');
  const terminalReceiptEvent = [...receipts].reverse().find(event => event.body.status !== 'advanced');
  if (terminalReceiptEvent) {
    return { terminal: terminalReceiptEvent.body.status, events, receipts, state: foldCognitionEvents(events), budget };
  }
  const startWave = receipts.length
    ? Math.max(...receipts.map(event => Number(event.body.index || 0))) + 1
    : 0;
  let terminal = null;

  waves: for (let loopIndex = startWave; loopIndex < budget.max_waves; loopIndex += 1) {
    let state;
    try {
      state = foldCognitionEvents(events);
    } catch (error) {
      terminal = 'invalid_state';
      const receipt = terminalReceipt({ waveIndex: loopIndex, status: terminal, unresolved: [], events, now });
      events.push(receipt);
      receipts.push(receipt);
      break;
    }
    if (state.open_question_ids.length > budget.max_open_questions || events.length >= budget.max_events) {
      terminal = 'budget_exhausted';
      const receipt = terminalReceipt({ waveIndex: loopIndex, status: terminal, unresolved: unresolvedCognitionIds(state), events, now });
      events.push(receipt);
      receipts.push(receipt);
      break;
    }

    let assignmentEvents = state.pending_assignment_event_ids.map(id => state.by_id[id]);
    let waveIndex = assignmentEvents.length ? waveIndexOfAssignment(assignmentEvents[0], loopIndex) : loopIndex;
    if (!assignmentEvents.length) {
      const plan = planDeliberationWave(state, {
        wave_index: waveIndex,
        max_assignments: budget.max_assignments_per_wave,
        issued_at: now()
      });
      if (plan.terminal) {
        terminal = plan.terminal;
        const receipt = terminalReceipt({ waveIndex, status: terminal, unresolved: plan.unresolved_ids, events, now });
        events.push(receipt);
        receipts.push(receipt);
        break;
      }
      assignmentEvents = plan.assignments.map(value => {
        const { novelty_key, priority, ...event } = value;
        return normalizeCognitionEvent(event);
      });
      events.push(...assignmentEvents);
      state = foldCognitionEvents(events);
    }

    const memories = {};
    for (const assignment of assignmentEvents) {
      memories[assignment.body.assignment_id] = retrieveCognitionMemory(state, {
        role: assignment.body.role,
        target_ids: assignment.body.target_ids,
        text: assignment.body.completion_criteria.join(' ')
      }, { visibility: 'private', max_chars: budget.max_memory_chars });
    }

    const results = [];
    const outputs = [];
    try {
      for (const assignment of assignmentEvents) {
        const started = state.dispatch_started[assignment.body.assignment_id] || null;
        const completed = state.dispatch_completed[assignment.body.assignment_id] || null;
        if (completed) {
          const existing = completed.body.output_ids.map(id => state.by_id[id]).filter(Boolean);
          outputs.push(...existing);
          results.push({ assignment_id: assignment.body.assignment_id, status: completed.body.status, events: existing });
          continue;
        }

        const adapter = adapterForAssignment(adapters, assignment, started);
        const adapterId = started?.body.adapter_id || adapter?.id || assignment.body.role;
        const packet = buildRolePacket(assignment, memories[assignment.body.assignment_id], adapterId);
        if (started && started.body.idempotency_key !== packet.idempotency_key) throw new Error(`Dispatch identity changed for ${assignment.id}.`);

        const recoveredOutputs = existingAssignmentOutputs(state, assignment);
        if (recoveredOutputs.length) {
          const recovered = dispatchLifecycle(packet, assignment, now, 'completed', recoveredOutputs);
          events.push(recovered);
          outputs.push(...recoveredOutputs);
          results.push({ assignment_id: assignment.body.assignment_id, status: 'completed', events: recoveredOutputs, recovered: true });
          state = foldCognitionEvents(events);
          continue;
        }

        if (!started) {
          events.push(dispatchLifecycle(packet, assignment, now));
          state = foldCognitionEvents(events);
        }
        if (!adapter?.execute) {
          const failed = dispatchLifecycle(packet, assignment, now, 'failed', [], 'adapter unavailable');
          events.push(failed);
          results.push({ assignment_id: assignment.body.assignment_id, status: 'failed', events: [], error: 'adapter unavailable' });
          state = foldCognitionEvents(events);
          continue;
        }
        try {
          const raw = await adapter.execute(packet);
          const parsed = parseAdapterOutput(raw, packet, { issued_at: now(), issuer: `adapter:${adapterId}` });
          events.push(...parsed);
          const done = dispatchLifecycle(packet, assignment, now, 'completed', parsed);
          events.push(done);
          outputs.push(...parsed);
          results.push({ assignment_id: assignment.body.assignment_id, status: 'completed', events: parsed });
          state = foldCognitionEvents(events);
        } catch (error) {
          const failed = dispatchLifecycle(packet, assignment, now, 'failed', [], error?.message || error);
          events.push(failed);
          results.push({ assignment_id: assignment.body.assignment_id, status: 'failed', events: [], error: String(error?.message || error).slice(0, 500) });
          state = foldCognitionEvents(events);
        }
      }
    } catch (error) {
      terminal = 'invalid_state';
      const receipt = terminalReceipt({ waveIndex, status: terminal, assignments: assignmentEvents, outputs, unresolved: [], events, now });
      events.push(receipt);
      receipts.push(receipt);
      break waves;
    }

    let stateAfterOutputs = foldCognitionEvents(events);
    let waveCritique = null;
    if (outputs.length) {
      const unresolved = unresolvedCognitionIds(stateAfterOutputs);
      const priorCritiques = stateAfterOutputs.unresolved_critique_ids.map(id => stateAfterOutputs.by_id[id]).filter(Boolean);
      const material = [...new Map([...outputs, ...priorCritiques].map(event => [event.id, event])).values()];
      const synthesis = buildSynthesis({
        id: `synthesis:wave:${waveIndex}`,
        issued_at: now(),
        source_events: material,
        unresolved_ids: unresolved,
        minority_report_ids: stateAfterOutputs.dissent_event_ids.filter(id => material.some(value => value.id === id)),
        proposed_actions: unresolved.length ? ['derive another bounded wave'] : ['terminalize convergence']
      });
      events.push(synthesis);
      stateAfterOutputs = foldCognitionEvents(events);
      waveCritique = critiqueSynthesis({
        id: `critique:wave:${waveIndex}`,
        synthesis,
        state: stateAfterOutputs,
        issued_at: now()
      });
      events.push(waveCritique);
    }

    const finalState = foldCognitionEvents(events);
    const unresolved = unresolvedCognitionIds(finalState);
    const accepted = !waveCritique || waveCritique.body.verdict === 'accept';
    const status = events.length >= budget.max_events
      ? 'budget_exhausted'
      : (unresolved.length || !accepted ? 'advanced' : 'converged');
    const receipt = terminalReceipt({ waveIndex, status, assignments: assignmentEvents, outputs, unresolved, events, now });
    events.push(receipt);
    receipts.push(receipt);
    if (status !== 'advanced') {
      terminal = status;
      break;
    }
    if (!outputs.length || results.every(result => result.status !== 'completed')) {
      terminal = 'blocked';
      const blocked = terminalReceipt({ waveIndex: waveIndex + 1, status: terminal, unresolved, events, now });
      events.push(blocked);
      receipts.push(blocked);
      break;
    }
  }

  if (!terminal) {
    const state = foldCognitionEvents(events);
    terminal = 'budget_exhausted';
    const receipt = terminalReceipt({ waveIndex: budget.max_waves, status: terminal, unresolved: unresolvedCognitionIds(state), events, now });
    events.push(receipt);
    receipts.push(receipt);
  }

  return { terminal, events, receipts, state: foldCognitionEvents(events), budget };
}
