import { randomUUID } from 'node:crypto';

export const WEAVE_PROTOCOL = 'sideways-weave';
export const WEAVE_VERSION = 1;

export const EVENT_KINDS = Object.freeze([
  'beacon.emit',
  'beacon.join',
  'beacon.release',
  'beacon.resolve',
  'presence',
  'intent',
  'message',
  'recode.declare',
  'recode.join',
  'recode.event',
  'recode.terminate',
  'session.handoff',
  'session.lost',
  'session.recover'
]);

const BEACON_KINDS = new Set([
  'join_me',
  'need_opposition',
  'need_second_implementation',
  'need_runtime_observation',
  'need_integration',
  'need_aesthetic_judgment',
  'need_debugging',
  'need_recode',
  'collision',
  'agent_disappeared',
  'release_blocked'
]);

const PRESENCE_STATES = new Set([
  'observing',
  'thinking',
  'coding',
  'testing',
  'messaging',
  'integrating',
  'blocked',
  'terminating'
]);

const COLLISION_POLICIES = new Set([
  'avoid',
  'compare',
  'deliberately_overlap',
  'integrate_after'
]);

const RECODE_MODES = new Set([
  'parallel_replacement',
  'progressive_transformation',
  'clean_room',
  'destructive_prototype'
]);

const RECODE_ACTIONS = new Set([
  'position',
  'challenge',
  'implement',
  'request_collision',
  'show_variant',
  'migrate',
  'integrate',
  'abandon'
]);

const RECODE_TERMINATIONS = new Set([
  'integrated',
  'preserved_variant',
  'abandoned',
  'rolled_back',
  'superseded'
]);

const BEACON_RESOLUTIONS = new Set([
  'satisfied',
  'withdrawn',
  'expired',
  'absorbed',
  'invalidated'
]);

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const cleanList = (value, limit = 64) => (Array.isArray(value) ? value : [])
  .map(clean)
  .filter(Boolean)
  .slice(0, limit);

function fail(message) {
  const error = new Error(message);
  error.code = 'WEAVE_PROTOCOL_INVALID';
  throw error;
}

function required(value, name, limit = 4000) {
  const result = clean(value).slice(0, limit);
  if (!result) fail(`${name} is required.`);
  return result;
}

function optional(value, limit = 4000) {
  return clean(value).slice(0, limit) || null;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function exactKind(value) {
  const kind = clean(value);
  if (!EVENT_KINDS.includes(kind)) fail(`Unknown weave event kind: ${kind || '<missing>'}.`);
  return kind;
}

function normalizeBeaconEmit(body) {
  const kind = required(body.kind, 'Beacon kind', 80);
  if (!BEACON_KINDS.has(kind)) fail(`Unknown beacon kind: ${kind}.`);
  return {
    beacon_id: required(body.beacon_id, 'Beacon id', 160),
    kind,
    thread_id: optional(body.thread_id, 160),
    target: body.target ?? null,
    signal: required(body.signal, 'Beacon signal', 2000),
    current_understanding: optional(body.current_understanding, 4000),
    useful_contribution: cleanList(body.useful_contribution, 32),
    urgency: Math.max(0, Math.min(100, Number(body.urgency ?? 50) || 0)),
    desired_agents: Math.max(1, Math.min(32, Number(body.desired_agents ?? 1) || 1)),
    expires_at: optional(body.expires_at, 80)
  };
}

function normalizeBeaconJoin(body) {
  return {
    beacon_id: required(body.beacon_id, 'Beacon id', 160),
    mode: optional(body.mode, 80) || 'join',
    statement: optional(body.statement, 2000),
    artifact_intent: body.artifact_intent ?? null
  };
}

function normalizeBeaconRelease(body) {
  return {
    beacon_id: required(body.beacon_id, 'Beacon id', 160),
    reason: optional(body.reason, 2000)
  };
}

function normalizeBeaconResolve(body) {
  const outcome = required(body.outcome, 'Beacon resolution', 80);
  if (!BEACON_RESOLUTIONS.has(outcome)) fail(`Unknown beacon resolution: ${outcome}.`);
  return {
    beacon_id: required(body.beacon_id, 'Beacon id', 160),
    outcome,
    explanation: required(body.explanation, 'Beacon resolution explanation', 4000),
    evidence: Array.isArray(body.evidence) ? body.evidence.slice(0, 64) : [],
    resulting_thread: optional(body.resulting_thread, 160),
    resulting_assignment: optional(body.resulting_assignment, 160)
  };
}

function normalizePresence(body) {
  const state = required(body.state, 'Presence state', 80);
  if (!PRESENCE_STATES.has(state)) fail(`Unknown presence state: ${state}.`);
  return {
    agent_id: required(body.agent_id, 'Agent id', 160),
    session_id: required(body.session_id, 'Session id', 160),
    state,
    thread_ids: cleanList(body.thread_ids, 64),
    assignment_ids: cleanList(body.assignment_ids, 64),
    artifact_intents: Array.isArray(body.artifact_intents) ? body.artifact_intents.slice(0, 64) : [],
    waiting_for: Array.isArray(body.waiting_for) ? body.waiting_for.slice(0, 64) : [],
    last_evidence: Array.isArray(body.last_evidence) ? body.last_evidence.slice(0, 64) : [],
    lease_expires_at: required(body.lease_expires_at, 'Presence lease expiry', 80)
  };
}

function normalizeIntent(body) {
  const collisionPolicy = required(body.collision_policy, 'Collision policy', 80);
  if (!COLLISION_POLICIES.has(collisionPolicy)) fail(`Unknown collision policy: ${collisionPolicy}.`);
  return {
    artifact: body.artifact ?? null,
    intended_reality_change: required(body.intended_reality_change, 'Intended reality change', 4000),
    expected_files: cleanList(body.expected_files, 128),
    parallel_work_welcome: body.parallel_work_welcome !== false,
    collision_policy: collisionPolicy
  };
}

function normalizeMessage(body) {
  return {
    message_type: required(body.message_type, 'Message type', 80),
    thread_id: optional(body.thread_id, 160),
    reply_to: optional(body.reply_to, 160),
    statement: required(body.statement, 'Message statement', 8000),
    expects_response: body.expects_response ?? false,
    artifacts: Array.isArray(body.artifacts) ? body.artifacts.slice(0, 64) : [],
    evidence: Array.isArray(body.evidence) ? body.evidence.slice(0, 64) : []
  };
}

function normalizeRecodeDeclare(body) {
  const mode = required(body.mode, 'Recode mode', 80);
  if (!RECODE_MODES.has(mode)) fail(`Unknown recode mode: ${mode}.`);
  return {
    recode_id: required(body.recode_id, 'Recode id', 160),
    thread_id: optional(body.thread_id, 160),
    target: Array.isArray(body.target) ? body.target.slice(0, 64) : [body.target].filter(Boolean),
    reason: required(body.reason, 'Recode reason', 4000),
    current_reality: required(body.current_reality, 'Current reality', 8000),
    proposed_reality: required(body.proposed_reality, 'Proposed reality', 8000),
    inherited_assumptions_to_reject: cleanList(body.inherited_assumptions_to_reject, 64),
    invariants_to_preserve: cleanList(body.invariants_to_preserve, 64),
    estimated_blast_radius: Array.isArray(body.estimated_blast_radius) ? body.estimated_blast_radius.slice(0, 128) : [],
    desired_agents: Math.max(1, Math.min(32, Number(body.desired_agents ?? 2) || 2)),
    mode,
    rollback_plan: optional(body.rollback_plan, 4000)
  };
}

function normalizeRecodeJoin(body) {
  return {
    recode_id: required(body.recode_id, 'Recode id', 160),
    position: optional(body.position, 8000),
    independent_until: optional(body.independent_until, 1000)
  };
}

function normalizeRecodeEvent(body) {
  const action = required(body.action, 'Recode action', 80);
  if (!RECODE_ACTIONS.has(action)) fail(`Unknown recode action: ${action}.`);
  return {
    recode_id: required(body.recode_id, 'Recode id', 160),
    action,
    statement: required(body.statement, 'Recode statement', 8000),
    artifacts: Array.isArray(body.artifacts) ? body.artifacts.slice(0, 128) : [],
    patch: body.patch ?? null
  };
}

function normalizeRecodeTerminate(body) {
  const state = required(body.state, 'Recode termination state', 80);
  if (!RECODE_TERMINATIONS.has(state)) fail(`Unknown recode termination state: ${state}.`);
  return {
    recode_id: required(body.recode_id, 'Recode id', 160),
    state,
    resulting_reality: optional(body.resulting_reality, 8000),
    evidence_learned: cleanList(body.evidence_learned, 128),
    artifacts: Array.isArray(body.artifacts) ? body.artifacts.slice(0, 128) : [],
    superseded_by: optional(body.superseded_by, 160)
  };
}

function normalizeSessionHandoff(body) {
  return {
    agent_id: required(body.agent_id, 'Agent id', 160),
    session_id: required(body.session_id, 'Session id', 160),
    reason: required(body.reason, 'Termination reason', 120),
    active_threads: cleanList(body.active_threads, 64),
    active_assignments: cleanList(body.active_assignments, 64),
    claimed_beacons: cleanList(body.claimed_beacons, 64),
    modified_artifacts: Array.isArray(body.modified_artifacts) ? body.modified_artifacts.slice(0, 128) : [],
    uncommitted_changes: Array.isArray(body.uncommitted_changes) ? body.uncommitted_changes.slice(0, 128) : [],
    beliefs_worth_preserving: cleanList(body.beliefs_worth_preserving, 128),
    unresolved_concerns: cleanList(body.unresolved_concerns, 128),
    recommended_next_actions: cleanList(body.recommended_next_actions, 128),
    handoff_to: body.handoff_to === 'any' ? 'any' : cleanList(body.handoff_to, 32)
  };
}

function normalizeSessionLost(body) {
  return {
    agent_id: required(body.agent_id, 'Agent id', 160),
    session_id: required(body.session_id, 'Session id', 160),
    last_presence_at: optional(body.last_presence_at, 80),
    workspace: body.workspace ?? null,
    observed_changes: Array.isArray(body.observed_changes) ? body.observed_changes.slice(0, 128) : []
  };
}

function normalizeSessionRecover(body) {
  return {
    agent_id: required(body.agent_id, 'Missing agent id', 160),
    session_id: required(body.session_id, 'Missing session id', 160),
    recovered_by: required(body.recovered_by, 'Recovering agent id', 160),
    outcome: required(body.outcome, 'Recovery outcome', 80),
    artifacts: Array.isArray(body.artifacts) ? body.artifacts.slice(0, 128) : [],
    statement: required(body.statement, 'Recovery statement', 4000)
  };
}

const BODY_NORMALIZERS = Object.freeze({
  'beacon.emit': normalizeBeaconEmit,
  'beacon.join': normalizeBeaconJoin,
  'beacon.release': normalizeBeaconRelease,
  'beacon.resolve': normalizeBeaconResolve,
  presence: normalizePresence,
  intent: normalizeIntent,
  message: normalizeMessage,
  'recode.declare': normalizeRecodeDeclare,
  'recode.join': normalizeRecodeJoin,
  'recode.event': normalizeRecodeEvent,
  'recode.terminate': normalizeRecodeTerminate,
  'session.handoff': normalizeSessionHandoff,
  'session.lost': normalizeSessionLost,
  'session.recover': normalizeSessionRecover
});

export function normalizeWeaveEvent(input = {}, context = {}) {
  const source = object(input);
  const kind = exactKind(source.kind);
  const issuer = required(source.issuer || context.issuer, 'Issuer', 160);
  const issuedAt = required(source.issued_at || context.issued_at || new Date().toISOString(), 'Issued at', 80);
  if (!Number.isFinite(Date.parse(issuedAt))) fail('Issued at must be an ISO-compatible timestamp.');
  return {
    protocol: WEAVE_PROTOCOL,
    version: WEAVE_VERSION,
    id: optional(source.id, 160) || randomUUID(),
    kind,
    issuer,
    issued_at: new Date(issuedAt).toISOString(),
    parent: optional(source.parent, 160),
    body: BODY_NORMALIZERS[kind](object(source.body))
  };
}

export function weavePayload(event, context = {}) {
  const normalized = normalizeWeaveEvent(event, context);
  return {
    summary: context.summary || summarizeWeaveEvent(normalized),
    action: normalized.kind,
    weave: normalized
  };
}

export function isWeaveMessage(message) {
  return message?.payload?.weave?.protocol === WEAVE_PROTOCOL
    && Number(message?.payload?.weave?.version) === WEAVE_VERSION;
}

export function summarizeWeaveEvent(event) {
  const body = event.body || {};
  switch (event.kind) {
    case 'beacon.emit': return `Beacon ${body.beacon_id}: ${body.signal}`;
    case 'beacon.join': return `${event.issuer} joined beacon ${body.beacon_id}.`;
    case 'beacon.release': return `${event.issuer} released beacon ${body.beacon_id}.`;
    case 'beacon.resolve': return `Beacon ${body.beacon_id} ${body.outcome}.`;
    case 'presence': return `${body.agent_id} is ${body.state}.`;
    case 'intent': return `${event.issuer}: ${body.intended_reality_change}`;
    case 'message': return `${body.message_type}: ${body.statement}`;
    case 'recode.declare': return `Recode ${body.recode_id}: ${body.proposed_reality}`;
    case 'recode.join': return `${event.issuer} joined recode ${body.recode_id}.`;
    case 'recode.event': return `Recode ${body.recode_id} ${body.action}: ${body.statement}`;
    case 'recode.terminate': return `Recode ${body.recode_id} ${body.state}.`;
    case 'session.handoff': return `${body.agent_id} handed off session ${body.session_id}.`;
    case 'session.lost': return `Session ${body.session_id} for ${body.agent_id} became unreachable.`;
    case 'session.recover': return `${body.recovered_by} recorded recovery for ${body.session_id}.`;
    default: return event.kind;
  }
}

function sortedEvents(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(isWeaveMessage)
    .map(message => ({ message, event: normalizeWeaveEvent(message.payload.weave) }))
    .sort((left, right) => {
      const stamp = Date.parse(left.event.issued_at) - Date.parse(right.event.issued_at);
      return stamp || left.event.id.localeCompare(right.event.id);
    });
}

export function foldWeaveMessages(messages, now = Date.now()) {
  const state = {
    protocol: WEAVE_PROTOCOL,
    version: WEAVE_VERSION,
    beacons: {},
    presence: {},
    intents: [],
    recodes: {},
    sessions: {},
    messages: [],
    recovery_beacons: []
  };

  for (const { event } of sortedEvents(messages)) {
    const body = event.body;
    if (event.kind === 'beacon.emit') {
      state.beacons[body.beacon_id] = {
        ...body,
        emitted_by: event.issuer,
        emitted_at: event.issued_at,
        participants: [],
        state: 'open',
        resolution: null
      };
    } else if (event.kind === 'beacon.join') {
      const beacon = state.beacons[body.beacon_id];
      if (beacon && !beacon.participants.includes(event.issuer)) {
        beacon.participants.push(event.issuer);
        beacon.state = 'active';
      }
    } else if (event.kind === 'beacon.release') {
      const beacon = state.beacons[body.beacon_id];
      if (beacon) {
        beacon.participants = beacon.participants.filter(id => id !== event.issuer);
        if (!beacon.participants.length && !beacon.resolution) beacon.state = 'open';
      }
    } else if (event.kind === 'beacon.resolve') {
      const beacon = state.beacons[body.beacon_id];
      if (beacon) {
        beacon.state = body.outcome;
        beacon.resolution = { ...body, resolved_by: event.issuer, resolved_at: event.issued_at };
      }
    } else if (event.kind === 'presence') {
      state.presence[body.agent_id] = { ...body, reported_by: event.issuer, reported_at: event.issued_at };
    } else if (event.kind === 'intent') {
      state.intents.push({ ...body, issuer: event.issuer, issued_at: event.issued_at, event_id: event.id });
    } else if (event.kind === 'message') {
      state.messages.push({ ...body, issuer: event.issuer, issued_at: event.issued_at, event_id: event.id });
    } else if (event.kind === 'recode.declare') {
      state.recodes[body.recode_id] = {
        ...body,
        declared_by: event.issuer,
        declared_at: event.issued_at,
        participants: [event.issuer],
        events: [],
        state: 'forming',
        termination: null
      };
    } else if (event.kind === 'recode.join') {
      const recode = state.recodes[body.recode_id];
      if (recode && !recode.participants.includes(event.issuer)) recode.participants.push(event.issuer);
    } else if (event.kind === 'recode.event') {
      const recode = state.recodes[body.recode_id];
      if (recode) {
        recode.events.push({ ...body, issuer: event.issuer, issued_at: event.issued_at, event_id: event.id });
        recode.state = body.action === 'integrate' ? 'integrating' : 'active';
      }
    } else if (event.kind === 'recode.terminate') {
      const recode = state.recodes[body.recode_id];
      if (recode) {
        recode.state = body.state;
        recode.termination = { ...body, terminated_by: event.issuer, terminated_at: event.issued_at };
      }
    } else if (event.kind === 'session.handoff') {
      state.sessions[body.session_id] = {
        ...body,
        state: 'handed_off',
        event_id: event.id,
        issued_at: event.issued_at
      };
      for (const beaconId of body.claimed_beacons) {
        const beacon = state.beacons[beaconId];
        if (beacon) beacon.participants = beacon.participants.filter(id => id !== body.agent_id);
      }
    } else if (event.kind === 'session.lost') {
      state.sessions[body.session_id] = {
        ...body,
        state: 'lost',
        event_id: event.id,
        issued_at: event.issued_at
      };
    } else if (event.kind === 'session.recover') {
      state.sessions[body.session_id] = {
        ...(state.sessions[body.session_id] || {}),
        ...body,
        state: 'recovered',
        event_id: event.id,
        issued_at: event.issued_at
      };
    }
  }

  for (const presence of Object.values(state.presence)) {
    const expiry = Date.parse(presence.lease_expires_at);
    if (Number.isFinite(expiry) && expiry <= now && presence.state !== 'terminating') {
      const explained = state.sessions[presence.session_id];
      if (!explained) {
        state.recovery_beacons.push({
          beacon_id: `recovery:${presence.session_id}`,
          kind: 'agent_disappeared',
          target: { agent_id: presence.agent_id, session_id: presence.session_id },
          signal: `Presence lease expired for ${presence.agent_id}.`,
          useful_contribution: ['inspect workspace', 'recover intent', 'package or revert changes'],
          state: 'open'
        });
      }
    }
  }

  for (const beacon of Object.values(state.beacons)) {
    if (beacon.resolution) continue;
    const expiry = Date.parse(beacon.expires_at || '');
    if (Number.isFinite(expiry) && expiry <= now) beacon.state = 'expired';
  }

  return state;
}
