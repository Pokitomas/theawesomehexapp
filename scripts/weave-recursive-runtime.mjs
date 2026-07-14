import { foldCognitionEvents, normalizeCognitionEvent, unresolvedCognitionIds } from './weave-cognition.mjs';
import { planDeliberationWave } from './weave-deliberation.mjs';
import { retrieveCognitionMemory } from './weave-memory.mjs';
import { dispatchAssignments } from './weave-dispatch.mjs';
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

export async function runRecursiveWeave({ initial_events = [], adapters = {}, budget: budgetInput = {}, now = () => new Date().toISOString() }) {
  const budget = normalizeRecursiveBudget(budgetInput);
  const events = initial_events.map(event => normalizeCognitionEvent(event));
  const seenDispatches = new Set();
  const receipts = [];
  let terminal = null;

  for (let waveIndex = 0; waveIndex < budget.max_waves; waveIndex += 1) {
    let state;
    try {
      state = foldCognitionEvents(events);
    } catch (error) {
      terminal = 'invalid_state';
      const receipt = terminalReceipt({ waveIndex, status: terminal, unresolved: [], events, now });
      events.push(receipt);
      receipts.push(receipt);
      break;
    }
    if (state.open_question_ids.length > budget.max_open_questions || events.length >= budget.max_events) {
      terminal = 'budget_exhausted';
      const receipt = terminalReceipt({ waveIndex, status: terminal, unresolved: unresolvedCognitionIds(state), events, now });
      events.push(receipt);
      receipts.push(receipt);
      break;
    }

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

    const assignmentEvents = plan.assignments.map(value => {
      const { novelty_key, priority, ...event } = value;
      return normalizeCognitionEvent(event);
    });
    events.push(...assignmentEvents);
    const stateWithAssignments = foldCognitionEvents(events);
    const memories = {};
    for (const assignment of assignmentEvents) {
      memories[assignment.body.assignment_id] = retrieveCognitionMemory(stateWithAssignments, {
        role: assignment.body.role,
        target_ids: assignment.body.target_ids,
        text: assignment.body.completion_criteria.join(' ')
      }, { visibility: 'private', max_chars: budget.max_memory_chars });
    }

    const results = await dispatchAssignments({ assignments: assignmentEvents, memories, adapters, seen: seenDispatches, now });
    const outputs = results.flatMap(result => result.events);
    events.push(...outputs);
    let stateAfterOutputs = foldCognitionEvents(events);

    if (outputs.length) {
      const unresolved = unresolvedCognitionIds(stateAfterOutputs);
      const synthesis = buildSynthesis({
        id: `synthesis:wave:${waveIndex}`,
        issued_at: now(),
        source_events: outputs,
        unresolved_ids: unresolved,
        minority_report_ids: stateAfterOutputs.dissent_event_ids.filter(id => outputs.some(output => output.id === id)),
        proposed_actions: unresolved.length ? ['derive another bounded wave'] : ['terminalize convergence']
      });
      events.push(synthesis);
      stateAfterOutputs = foldCognitionEvents(events);
      const critique = critiqueSynthesis({
        id: `critique:wave:${waveIndex}`,
        synthesis,
        state: stateAfterOutputs,
        issued_at: now()
      });
      events.push(critique);
    }

    const finalState = foldCognitionEvents(events);
    const unresolved = unresolvedCognitionIds(finalState);
    const status = events.length >= budget.max_events
      ? 'budget_exhausted'
      : (unresolved.length ? 'advanced' : 'converged');
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
