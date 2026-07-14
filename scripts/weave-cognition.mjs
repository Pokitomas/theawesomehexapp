import { createHash, randomUUID } from 'node:crypto';

export const COGNITION_PROTOCOL = 'sideways-cognition';
export const COGNITION_VERSION = 1;

export const COGNITION_KINDS = Object.freeze([
  'claim',
  'evidence',
  'contradiction',
  'question',
  'goal',
  'plan',
  'decision',
  'test.result',
  'artifact',
  'uncertainty',
  'synthesis',
  'critique',
  'supersede',
  'assignment',
  'dispatch.started',
  'dispatch.completed',
  'wave.receipt'
]);

const HIDDEN_REASONING_KEYS = new Set([
  'chain_of_thought',
  'chainOfThought',
  'reasoning_trace',
  'reasoningTrace',
  'hidden_reasoning',
  'hiddenReasoning',
  'scratchpad',
  'private_scratchpad'
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const cleanList = (value, limit = 128) => [...new Set((Array.isArray(value) ? value : [])
  .map(clean)
  .filter(Boolean)
  .slice(0, limit))];

function fail(message, code = 'COGNITION_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactId(value, name = 'event id') {
  const id = clean(value);
  if (!ID_PATTERN.test(id)) fail(`${name} is invalid.`);
  return id;
}

function required(value, name, limit = 8000) {
  const result = clean(value).slice(0, limit);
  if (!result) fail(`${name} is required.`);
  return result;
}

function optional(value, limit = 8000) {
  return clean(value).slice(0, limit) || null;
}

function confidence(value, fallback = 0.5) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) fail('Confidence must be between 0 and 1.');
  return number;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rejectHiddenReasoning(value, path = 'body', depth = 0) {
  if (depth > 12) fail(`${path} is too deeply nested.`);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (HIDDEN_REASONING_KEYS.has(key)) fail(`${path}.${key} is not a permitted durable field.`);
    rejectHiddenReasoning(child, `${path}.${key}`, depth + 1);
  }
}

function exactReferences(value, limit = 128) {
  return cleanList(value, limit).map(id => exactId(id, 'source event id'));
}

function normalizeBody(kind, input) {
  const body = plainObject(input);
  rejectHiddenReasoning(body);
  switch (kind) {
    case 'claim':
      return {
        subject: required(body.subject, 'Claim subject', 240),
        statement: required(body.statement, 'Claim statement'),
        confidence: confidence(body.confidence),
        impact: Math.max(0, Math.min(100, Number(body.impact ?? 50) || 0)),
        tags: cleanList(body.tags, 32)
      };
    case 'evidence':
      return {
        statement: required(body.statement, 'Evidence statement'),
        supports: exactReferences(body.supports, 64),
        opposes: exactReferences(body.opposes, 64),
        artifacts: cleanList(body.artifacts, 64),
        strength: confidence(body.strength, 0.5)
      };
    case 'contradiction':
      return {
        left_id: exactId(body.left_id, 'Contradiction left id'),
        right_id: exactId(body.right_id, 'Contradiction right id'),
        statement: required(body.statement, 'Contradiction statement'),
        severity: Math.max(0, Math.min(100, Number(body.severity ?? 50) || 0)),
        resolved_by: body.resolved_by ? exactId(body.resolved_by, 'Contradiction resolution id') : null
      };
    case 'question':
      return {
        question: required(body.question, 'Question'),
        priority: Math.max(0, Math.min(100, Number(body.priority ?? 50) || 0)),
        answer_kinds: cleanList(body.answer_kinds, 16),
        resolved_by: body.resolved_by ? exactId(body.resolved_by, 'Question resolution id') : null
      };
    case 'goal':
      return {
        statement: required(body.statement, 'Goal statement'),
        success_criteria: cleanList(body.success_criteria, 64),
        priority: Math.max(0, Math.min(100, Number(body.priority ?? 50) || 0)),
        state: ['open', 'satisfied', 'blocked', 'abandoned'].includes(body.state) ? body.state : 'open'
      };
    case 'plan':
      return {
        statement: required(body.statement, 'Plan statement'),
        goal_ids: exactReferences(body.goal_ids, 32),
        steps: (Array.isArray(body.steps) ? body.steps : []).slice(0, 128),
        state: ['proposed', 'active', 'blocked', 'completed', 'abandoned'].includes(body.state) ? body.state : 'proposed'
      };
    case 'decision':
      return {
        statement: required(body.statement, 'Decision statement'),
        supporting_ids: exactReferences(body.supporting_ids, 128),
        opposing_ids: exactReferences(body.opposing_ids, 128),
        rationale: required(body.rationale, 'Decision rationale', 4000),
        confidence: confidence(body.confidence),
        resolves: exactReferences(body.resolves, 64),
        rollback_trigger: optional(body.rollback_trigger, 2000)
      };
    case 'test.result':
      return {
        name: required(body.name, 'Test name', 240),
        status: ['passed', 'failed', 'skipped', 'error'].includes(body.status) ? body.status : fail('Unknown test status.'),
        statement: required(body.statement, 'Test result statement', 4000),
        targets: exactReferences(body.targets, 64),
        artifacts: cleanList(body.artifacts, 64)
      };
    case 'artifact':
      return {
        name: required(body.name, 'Artifact name', 240),
        uri: required(body.uri, 'Artifact uri', 2000),
        digest: optional(body.digest, 240),
        statement: optional(body.statement, 4000)
      };
    case 'uncertainty':
      return {
        target_id: exactId(body.target_id, 'Uncertainty target id'),
        confidence: confidence(body.confidence),
        statement: required(body.statement, 'Uncertainty statement', 4000)
      };
    case 'synthesis':
      return {
        statement: required(body.statement, 'Synthesis statement'),
        observations: cleanList(body.observations, 128),
        inferences: cleanList(body.inferences, 128),
        assumptions: cleanList(body.assumptions, 128),
        unresolved_ids: exactReferences(body.unresolved_ids, 128),
        minority_report_ids: exactReferences(body.minority_report_ids, 128),
        proposed_actions: cleanList(body.proposed_actions, 128)
      };
    case 'critique':
      return {
        synthesis_id: exactId(body.synthesis_id, 'Synthesis id'),
        verdict: ['accept', 'revise', 'block'].includes(body.verdict) ? body.verdict : fail('Unknown critique verdict.'),
        findings: cleanList(body.findings, 128),
        required_corrections: cleanList(body.required_corrections, 128),
        blocking_event_ids: exactReferences(body.blocking_event_ids, 128)
      };
    case 'supersede':
      return {
        target_ids: exactReferences(body.target_ids, 128),
        statement: required(body.statement, 'Supersession statement', 4000)
      };
    case 'assignment':
      return {
        assignment_id: exactId(body.assignment_id, 'Assignment id'),
        wave_id: exactId(body.wave_id, 'Wave id'),
        role: required(body.role, 'Assignment role', 80),
        target_ids: exactReferences(body.target_ids, 128),
        expected_kinds: cleanList(body.expected_kinds, 32),
        completion_criteria: cleanList(body.completion_criteria, 32),
        budget: {
          max_events: Math.max(1, Math.min(32, Number(body.budget?.max_events ?? 4) || 4)),
          max_chars: Math.max(256, Math.min(64000, Number(body.budget?.max_chars ?? 12000) || 12000))
        },
        artifact_scope: cleanList(body.artifact_scope, 128),
        novelty_key: required(body.novelty_key, 'Assignment novelty key', 240)
      };
    case 'dispatch.started':
      return {
        dispatch_id: exactId(body.dispatch_id, 'Dispatch id'),
        assignment_event_id: exactId(body.assignment_event_id, 'Assignment event id'),
        assignment_id: exactId(body.assignment_id, 'Assignment id'),
        adapter_id: required(body.adapter_id, 'Adapter id', 160),
        idempotency_key: required(body.idempotency_key, 'Dispatch idempotency key', 160)
      };
    case 'dispatch.completed':
      return {
        dispatch_id: exactId(body.dispatch_id, 'Dispatch id'),
        assignment_event_id: exactId(body.assignment_event_id, 'Assignment event id'),
        assignment_id: exactId(body.assignment_id, 'Assignment id'),
        adapter_id: required(body.adapter_id, 'Adapter id', 160),
        idempotency_key: required(body.idempotency_key, 'Dispatch idempotency key', 160),
        status: ['completed', 'failed'].includes(body.status) ? body.status : fail('Unknown dispatch status.'),
        output_ids: exactReferences(body.output_ids, 64),
        error: optional(body.error, 500)
      };
    case 'wave.receipt':
      return {
        wave_id: exactId(body.wave_id, 'Wave id'),
        index: Math.max(0, Number(body.index ?? 0) || 0),
        status: ['advanced', 'converged', 'blocked', 'budget_exhausted', 'invalid_state', 'human_required'].includes(body.status)
          ? body.status
          : fail('Unknown wave status.'),
        assignment_ids: exactReferences(body.assignment_ids, 128),
        output_ids: exactReferences(body.output_ids, 256),
        unresolved_ids: exactReferences(body.unresolved_ids, 256),
        budget_used: plainObject(body.budget_used),
        statement: required(body.statement, 'Wave receipt statement', 4000)
      };
    default:
      fail(`Unknown cognition kind: ${kind}.`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function stableDigest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function normalizeCognitionEvent(input = {}, context = {}) {
  const source = plainObject(input);
  const kind = clean(source.kind);
  if (!COGNITION_KINDS.includes(kind)) fail(`Unknown cognition kind: ${kind || '<missing>'}.`);
  const issuedAt = required(source.issued_at || context.issued_at || new Date().toISOString(), 'Issued at', 80);
  if (!Number.isFinite(Date.parse(issuedAt))) fail('Issued at must be an ISO-compatible timestamp.');
  const visibility = clean(source.visibility || context.visibility || 'private');
  if (!['public', 'private'].includes(visibility)) fail('Visibility must be public or private.');
  return {
    protocol: COGNITION_PROTOCOL,
    version: COGNITION_VERSION,
    id: source.id ? exactId(source.id) : randomUUID(),
    kind,
    issuer: required(source.issuer || context.issuer, 'Issuer', 160),
    issued_at: new Date(issuedAt).toISOString(),
    visibility,
    parent: source.parent ? exactId(source.parent, 'Parent id') : null,
    source_event_ids: exactReferences(source.source_event_ids, 256),
    body: normalizeBody(kind, source.body)
  };
}

function sortedUniqueEvents(events) {
  const byId = new Map();
  for (const raw of Array.isArray(events) ? events : []) {
    const event = normalizeCognitionEvent(raw);
    const digest = stableDigest(event);
    const previous = byId.get(event.id);
    if (previous && previous.digest !== digest) fail(`Conflicting cognition event id: ${event.id}.`, 'COGNITION_ID_CONFLICT');
    if (!previous) byId.set(event.id, { event, digest });
  }
  return [...byId.values()].map(value => value.event).sort((left, right) => {
    const stamp = Date.parse(left.issued_at) - Date.parse(right.issued_at);
    return stamp || left.id.localeCompare(right.id);
  });
}

function allReferences(event) {
  const body = event.body;
  const refs = [...event.source_event_ids];
  if (event.parent) refs.push(event.parent);
  if (event.kind === 'evidence') refs.push(...body.supports, ...body.opposes);
  if (event.kind === 'contradiction') refs.push(body.left_id, body.right_id);
  if (event.kind === 'plan') refs.push(...body.goal_ids);
  if (event.kind === 'decision') refs.push(...body.supporting_ids, ...body.opposing_ids, ...body.resolves);
  if (event.kind === 'test.result') refs.push(...body.targets);
  if (event.kind === 'uncertainty') refs.push(body.target_id);
  if (event.kind === 'synthesis') refs.push(...body.unresolved_ids, ...body.minority_report_ids);
  if (event.kind === 'critique') refs.push(body.synthesis_id, ...body.blocking_event_ids);
  if (event.kind === 'supersede') refs.push(...body.target_ids);
  if (event.kind === 'assignment') refs.push(...body.target_ids);
  if (event.kind === 'dispatch.started') refs.push(body.assignment_event_id);
  if (event.kind === 'dispatch.completed') refs.push(body.assignment_event_id, ...body.output_ids);
  if (event.kind === 'wave.receipt') refs.push(...body.assignment_ids, ...body.output_ids, ...body.unresolved_ids);
  return [...new Set(refs.filter(Boolean))];
}

export function foldCognitionEvents(events = []) {
  const ordered = sortedUniqueEvents(events);
  const ids = new Set(ordered.map(event => event.id));
  const eventById = new Map(ordered.map(event => [event.id, event]));
  const referencesById = new Map();
  for (const event of ordered) {
    const references = allReferences(event);
    referencesById.set(event.id, references);
    for (const reference of references) {
      if (!ids.has(reference)) fail(`Event ${event.id} references missing event ${reference}.`, 'COGNITION_DANGLING_REFERENCE');
      if (reference === event.id) fail(`Event ${event.id} cannot reference itself.`, 'COGNITION_SELF_REFERENCE');
    }
  }
  for (const event of ordered) {
    if (!['question', 'contradiction'].includes(event.kind) || !event.body.resolved_by) continue;
    const resolver = eventById.get(event.body.resolved_by);
    if (!resolver) fail(`Event ${event.id} names missing resolution event ${event.body.resolved_by}.`, 'COGNITION_DANGLING_RESOLUTION');
    if (resolver.kind !== 'decision') fail(`Event ${event.id} resolution ${resolver.id} is not a decision.`, 'COGNITION_INVALID_RESOLUTION');
    if (!resolver.body.resolves.includes(event.id)) fail(`Decision ${resolver.id} does not resolve event ${event.id}.`, 'COGNITION_INCONSISTENT_RESOLUTION');
  }
  for (const event of ordered) {
    if (!['dispatch.started', 'dispatch.completed'].includes(event.kind)) continue;
    const assignment = eventById.get(event.body.assignment_event_id);
    if (!assignment || assignment.kind !== 'assignment') fail(`Dispatch ${event.id} does not reference an assignment event.`, 'COGNITION_INVALID_DISPATCH');
    if (assignment.body.assignment_id !== event.body.assignment_id) fail(`Dispatch ${event.id} assignment identity mismatch.`, 'COGNITION_INVALID_DISPATCH');
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = id => {
    if (visiting.has(id)) fail(`Cyclic cognition references include ${id}.`, 'COGNITION_REFERENCE_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const reference of referencesById.get(id) || []) visit(reference);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  const state = {
    protocol: COGNITION_PROTOCOL,
    version: COGNITION_VERSION,
    events: ordered,
    by_id: {},
    claims: {},
    questions: {},
    goals: {},
    plans: {},
    decisions: {},
    contradictions: {},
    assignments: {},
    dispatch_started: {},
    dispatch_completed: {},
    waves: {},
    syntheses: {},
    critiques: {},
    evidence: [],
    tests: [],
    artifacts: [],
    uncertainty: {},
    superseded: {},
    open_question_ids: [],
    unresolved_contradiction_ids: [],
    unresolved_critique_ids: [],
    unsupported_claim_ids: [],
    failed_test_ids: [],
    active_plan_ids: [],
    pending_assignment_event_ids: [],
    dissent_event_ids: []
  };

  const support = new Map();
  for (const event of ordered) {
    state.by_id[event.id] = event;
    const body = event.body;
    if (event.kind === 'claim') state.claims[event.id] = { ...event, status: 'active' };
    else if (event.kind === 'question') state.questions[event.id] = { ...event, status: body.resolved_by ? 'resolved' : 'open' };
    else if (event.kind === 'goal') state.goals[event.id] = event;
    else if (event.kind === 'plan') state.plans[event.id] = { ...event, status: body.state };
    else if (event.kind === 'decision') {
      state.decisions[event.id] = event;
      for (const target of body.resolves) {
        if (state.questions[target]) state.questions[target].status = 'resolved';
        if (state.contradictions[target]) state.contradictions[target].status = 'resolved';
      }
    } else if (event.kind === 'contradiction') {
      state.contradictions[event.id] = { ...event, status: body.resolved_by ? 'resolved' : 'open' };
      state.dissent_event_ids.push(event.id, body.left_id, body.right_id);
    } else if (event.kind === 'evidence') {
      state.evidence.push(event);
      for (const target of body.supports) support.set(target, (support.get(target) || 0) + body.strength);
      for (const target of body.opposes) state.dissent_event_ids.push(event.id, target);
    } else if (event.kind === 'test.result') state.tests.push(event);
    else if (event.kind === 'artifact') state.artifacts.push(event);
    else if (event.kind === 'uncertainty') state.uncertainty[body.target_id] = event;
    else if (event.kind === 'synthesis') state.syntheses[event.id] = event;
    else if (event.kind === 'critique') state.critiques[event.id] = event;
    else if (event.kind === 'assignment') state.assignments[body.assignment_id] = event;
    else if (event.kind === 'dispatch.started') state.dispatch_started[body.assignment_id] = event;
    else if (event.kind === 'dispatch.completed') state.dispatch_completed[body.assignment_id] = event;
    else if (event.kind === 'wave.receipt') state.waves[body.wave_id] = event;
    else if (event.kind === 'supersede') {
      for (const target of body.target_ids) {
        state.superseded[target] = event.id;
        if (state.claims[target]) state.claims[target].status = 'superseded';
        if (state.questions[target]) state.questions[target].status = 'superseded';
        if (state.plans[target]) state.plans[target].status = 'abandoned';
      }
    }
  }

  for (const decision of Object.values(state.decisions)) {
    for (const target of decision.body.resolves) {
      if (state.questions[target]) state.questions[target].status = 'resolved';
      if (state.contradictions[target]) state.contradictions[target].status = 'resolved';
    }
  }

  const acceptedCritiqueSources = new Set(Object.values(state.critiques)
    .filter(event => event.body.verdict === 'accept')
    .flatMap(event => event.source_event_ids));
  state.open_question_ids = Object.entries(state.questions)
    .filter(([id, value]) => value.status === 'open' && !state.superseded[id])
    .map(([id]) => id);
  state.unresolved_contradiction_ids = Object.entries(state.contradictions)
    .filter(([id, value]) => value.status === 'open' && !state.superseded[id])
    .map(([id]) => id);
  state.unresolved_critique_ids = Object.entries(state.critiques)
    .filter(([id, value]) => value.body.verdict !== 'accept' && !state.superseded[id] && !acceptedCritiqueSources.has(id))
    .map(([id]) => id);
  state.unsupported_claim_ids = Object.entries(state.claims)
    .filter(([id, value]) => value.status === 'active' && !state.superseded[id] && !support.has(id))
    .map(([id]) => id);
  state.failed_test_ids = state.tests.filter(event => event.body.status === 'failed').map(event => event.id);
  state.active_plan_ids = Object.entries(state.plans)
    .filter(([id, value]) => ['proposed', 'active', 'blocked'].includes(value.status) && !state.superseded[id])
    .map(([id]) => id);
  state.pending_assignment_event_ids = Object.values(state.assignments)
    .filter(event => !state.dispatch_completed[event.body.assignment_id])
    .map(event => event.id);
  state.dissent_event_ids = [...new Set(state.dissent_event_ids.filter(id => ids.has(id)))];
  return state;
}

export function unresolvedCognitionIds(state) {
  return [...new Set([
    ...(state?.open_question_ids || []),
    ...(state?.unresolved_contradiction_ids || []),
    ...(state?.unresolved_critique_ids || []),
    ...(state?.unsupported_claim_ids || []),
    ...(state?.failed_test_ids || []),
    ...(state?.active_plan_ids || []).filter(id => state.plans[id]?.status === 'blocked'),
    ...(state?.pending_assignment_event_ids || [])
  ])];
}
