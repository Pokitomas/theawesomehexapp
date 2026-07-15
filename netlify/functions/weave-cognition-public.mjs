import { foldCognitionEvents, normalizeCognitionEvent } from '../../scripts/weave-cognition.mjs';

const clean = (value, limit = 320) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const bounded = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

function refs(event) {
  const body = event?.body || {};
  return [...new Set([
    ...(event?.source_event_ids || []),
    ...(event?.parent ? [event.parent] : []),
    ...(body.supports || []),
    ...(body.opposes || []),
    ...(body.left_id ? [body.left_id] : []),
    ...(body.right_id ? [body.right_id] : []),
    ...(body.goal_ids || []),
    ...(body.supporting_ids || []),
    ...(body.opposing_ids || []),
    ...(body.resolves || []),
    ...(body.targets || []),
    ...(body.target_id ? [body.target_id] : []),
    ...(body.unresolved_ids || []),
    ...(body.minority_report_ids || []),
    ...(body.synthesis_id ? [body.synthesis_id] : []),
    ...(body.blocking_event_ids || []),
    ...(body.target_ids || []),
    ...(body.assignment_event_id ? [body.assignment_event_id] : []),
    ...(body.assignment_ids || []),
    ...(body.output_ids || [])
  ].filter(Boolean))];
}

function cognitionFromMessage(message) {
  if (message?.visibility !== 'public') return null;
  const candidate = message?.payload?.cognition;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  try {
    const event = normalizeCognitionEvent(candidate);
    return event.visibility === 'public' ? event : null;
  } catch {
    return null;
  }
}

export function closedPublicCognitionEvents(messages = []) {
  const normalized = [];
  let rejected = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const hadCandidate = Boolean(message?.payload?.cognition);
    const event = cognitionFromMessage(message);
    if (event) normalized.push(event);
    else if (hadCandidate) rejected += 1;
  }
  const byId = new Map();
  for (const event of normalized) {
    const previous = byId.get(event.id);
    if (!previous) byId.set(event.id, event);
    else if (JSON.stringify(previous) !== JSON.stringify(event)) {
      byId.delete(event.id);
      rejected += 2;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    const ids = new Set(byId.keys());
    for (const [id, event] of byId) {
      if (refs(event).some(reference => !ids.has(reference))) {
        byId.delete(id);
        rejected += 1;
        changed = true;
      }
    }
  }
  const events = [...byId.values()];
  try {
    foldCognitionEvents(events);
    return { events, rejected };
  } catch {
    return { events: [], rejected: rejected + events.length };
  }
}

function statusOf(state) {
  const receipts = Object.values(state?.waves || {}).sort((left, right) => Number(left.body.index) - Number(right.body.index));
  return receipts.at(-1)?.body.status || (state?.events?.length ? 'active' : 'empty');
}

function projectGoal(event) {
  return {
    id: event.id,
    statement: clean(event.body.statement),
    state: event.body.state,
    priority: bounded(event.body.priority, 0, 100, 50)
  };
}

function projectQuestion(event, state) {
  return {
    id: event.id,
    question: clean(event.body.question),
    status: state.questions[event.id]?.status || 'open',
    priority: bounded(event.body.priority, 0, 100, 50)
  };
}

function projectContradiction(event, state) {
  return {
    id: event.id,
    statement: clean(event.body.statement),
    status: state.contradictions[event.id]?.status || 'open',
    severity: bounded(event.body.severity, 0, 100, 50)
  };
}

function projectDecision(event) {
  return {
    id: event.id,
    statement: clean(event.body.statement),
    confidence: bounded(event.body.confidence, 0, 1, 0.5),
    support_count: event.body.supporting_ids.length,
    opposition_count: event.body.opposing_ids.length,
    resolves_count: event.body.resolves.length,
    rationale: clean(event.body.rationale, 480)
  };
}

function projectPlan(event, state) {
  return {
    id: event.id,
    statement: clean(event.body.statement),
    state: state.plans[event.id]?.status || event.body.state,
    step_count: Array.isArray(event.body.steps) ? event.body.steps.length : 0
  };
}

function projectAssignment(event, state) {
  const completed = state.dispatch_completed[event.body.assignment_id];
  const started = state.dispatch_started[event.body.assignment_id];
  return {
    event_id: event.id,
    assignment_id: event.body.assignment_id,
    wave_id: event.body.wave_id,
    role: clean(event.body.role, 80),
    status: completed?.body.status || (started ? 'dispatched' : 'planned'),
    target_count: event.body.target_ids.length,
    expected_kinds: event.body.expected_kinds.slice(0, 16)
  };
}

function projectWave(event) {
  return {
    event_id: event.id,
    wave_id: event.body.wave_id,
    index: bounded(event.body.index, 0, 100000, 0),
    status: event.body.status,
    assignment_count: event.body.assignment_ids.length,
    output_count: event.body.output_ids.length,
    unresolved_count: event.body.unresolved_ids.length
  };
}

export function publicCognitionStateProjection(messages = [], options = {}) {
  const maxItems = Math.floor(bounded(options.max_items, 1, 100, 24));
  const { events, rejected } = closedPublicCognitionEvents(messages);
  let state;
  try { state = foldCognitionEvents(events); }
  catch { state = foldCognitionEvents([]); }
  const ordered = values => values.sort((left, right) => Date.parse(right.issued_at) - Date.parse(left.issued_at) || left.id.localeCompare(right.id)).slice(0, maxItems);
  return {
    protocol: 'sideways-cognition-public',
    version: 1,
    status: statusOf(state),
    counts: {
      events: events.length,
      rejected,
      goals: Object.keys(state.goals).length,
      questions_open: state.open_question_ids.length,
      contradictions_open: state.unresolved_contradiction_ids.length,
      critiques_open: state.unresolved_critique_ids.length,
      decisions: Object.keys(state.decisions).length,
      plans_active: state.active_plan_ids.length,
      assignments_pending: state.pending_assignment_event_ids.length,
      dissent_events: state.dissent_event_ids.length,
      waves: Object.keys(state.waves).length
    },
    goals: ordered(Object.values(state.goals)).map(projectGoal),
    questions: ordered(Object.values(state.questions)).map(event => projectQuestion(event, state)),
    contradictions: ordered(Object.values(state.contradictions)).map(event => projectContradiction(event, state)),
    decisions: ordered(Object.values(state.decisions)).map(projectDecision),
    plans: ordered(Object.values(state.plans)).map(event => projectPlan(event, state)),
    assignments: ordered(Object.values(state.assignments)).map(event => projectAssignment(event, state)),
    waves: ordered(Object.values(state.waves)).map(projectWave)
  };
}

export function publicCognitionEventProjection(message) {
  const event = cognitionFromMessage(message);
  if (!event) return null;
  const body = event.body || {};
  const base = { id: event.id, kind: event.kind, issued_at: event.issued_at };
  if (event.kind === 'goal') return { ...base, statement: clean(body.statement), state: body.state };
  if (event.kind === 'question') return { ...base, statement: clean(body.question), state: body.resolved_by ? 'resolved' : 'open' };
  if (event.kind === 'contradiction') return { ...base, statement: clean(body.statement), state: body.resolved_by ? 'resolved' : 'open' };
  if (event.kind === 'decision') return { ...base, statement: clean(body.statement), confidence: bounded(body.confidence, 0, 1, 0.5) };
  if (event.kind === 'plan') return { ...base, statement: clean(body.statement), state: body.state };
  if (event.kind === 'assignment') return { ...base, role: clean(body.role, 80), wave_id: body.wave_id, expected_kinds: body.expected_kinds.slice(0, 16) };
  if (event.kind === 'wave.receipt') return { ...base, wave_id: body.wave_id, status: body.status, unresolved_count: body.unresolved_ids.length };
  if (event.kind === 'critique') return { ...base, verdict: body.verdict, finding_count: body.findings.length };
  return { ...base };
}
