const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const list = value => (Array.isArray(value) ? value : []).map(clean).filter(Boolean);
const timeOf = value => {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const DRAIN_KINDS = new Set([
  'terminal.drain.prepare',
  'terminal.drain.release',
  'terminal.drain.cancel',
  'terminal.drain.complete',
  'terminal.drain.quarantine',
  'terminal.drain.commit',
  'generation.accept'
]);

const ORDINARY_WORK_KINDS = new Set([
  'presence',
  'intent',
  'message',
  'recode.declare',
  'recode.join',
  'recode.event',
  'beacon.join'
]);

function fail(message, detail = {}) {
  const error = new Error(message);
  error.code = 'WEAVE_TERMINAL_DRAIN_INVALID';
  error.detail = detail;
  throw error;
}

function eventOf(message) {
  return message?.payload?.weave || message?.weave || message;
}

function bodyOf(event) {
  return event && typeof event.body === 'object' && !Array.isArray(event.body) ? event.body : {};
}

function normalizeEvent(message, index) {
  const event = eventOf(message) || {};
  const kind = clean(event.kind);
  const id = clean(event.id) || `implicit:${index}`;
  const issuedAt = clean(event.issued_at);
  const issuer = clean(event.issuer);
  if (!kind) fail('event kind is required', { index });
  if (!issuer) fail('event issuer is required', { index, id, kind });
  if (!Number.isFinite(Date.parse(issuedAt))) fail('event issued_at must be ISO-compatible', { index, id, kind });
  return {
    id,
    kind,
    issuer,
    issued_at: new Date(issuedAt).toISOString(),
    body: bodyOf(event)
  };
}

function sortedEvents(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(normalizeEvent)
    .sort((left, right) => timeOf(left.issued_at) - timeOf(right.issued_at) || left.id.localeCompare(right.id));
}

function requireField(body, name, event) {
  const value = clean(body[name]);
  if (!value) fail(`${name} is required`, { event_id: event.id, kind: event.kind });
  return value;
}

function sameReceipt(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assignmentId(event) {
  const body = event.body || {};
  return clean(body.assignment_id) || clean(body.dispatch_id) || event.id;
}

function activePresenceAt(sessions, timestamp) {
  const instant = timeOf(timestamp);
  return [...sessions.values()]
    .filter(session => timeOf(session.reported_at) <= instant && timeOf(session.lease_expires_at) > instant)
    .sort((left, right) => timeOf(right.reported_at) - timeOf(left.reported_at) || left.session_id.localeCompare(right.session_id));
}

function inferSessionForIntent(sessions, event) {
  const candidates = activePresenceAt(sessions, event.issued_at)
    .filter(session => session.reported_by === event.issuer);
  return candidates[0]?.session_id || null;
}

function snapshotAtPrepare({ sessions, assignments, prepareEvent }) {
  const preparedAt = timeOf(prepareEvent.issued_at);
  const explicitSessions = list(prepareEvent.body.participant_sessions);
  const explicitAssignments = list(prepareEvent.body.pending_assignments);
  const explicitInflight = list(prepareEvent.body.in_flight_dispatches);

  const activeSessions = explicitSessions.length
    ? explicitSessions
    : [...sessions.values()]
      .filter(session => timeOf(session.reported_at) <= preparedAt && timeOf(session.lease_expires_at) > preparedAt)
      .map(session => session.session_id)
      .sort();

  const pendingAssignments = explicitAssignments.length
    ? explicitAssignments
    : assignments
      .filter(assignment => timeOf(assignment.issued_at) <= preparedAt)
      .map(assignment => assignment.assignment_id)
      .sort();

  return {
    participant_sessions: activeSessions,
    pending_assignments: pendingAssignments,
    in_flight_dispatches: explicitInflight
  };
}

function receiptKey(kind, body) {
  if (kind === 'terminal.drain.release') return `release:${clean(body.session_id)}`;
  if (kind === 'terminal.drain.cancel') return `cancel:${clean(body.assignment_id) || clean(body.dispatch_id)}`;
  if (kind === 'terminal.drain.complete') return `complete:${clean(body.assignment_id) || clean(body.dispatch_id)}`;
  if (kind === 'terminal.drain.quarantine') return `quarantine:${clean(body.assignment_id) || clean(body.dispatch_id)}`;
  return null;
}

function accountParticipant({ state, event }) {
  const sessionId = requireField(event.body, 'session_id', event);
  const receipt = {
    session_id: sessionId,
    generation_id: requireField(event.body, 'generation_id', event),
    outer_receipt_id: requireField(event.body, 'outer_receipt_id', event),
    released_by: event.issuer,
    released_at: event.issued_at,
    reason: clean(event.body.reason) || null,
    event_id: event.id
  };
  const existing = state.releases.get(sessionId);
  if (existing) {
    if (!sameReceipt({ ...existing, event_id: undefined }, { ...receipt, event_id: undefined })) {
      fail('same participant lease released with different content', { session_id: sessionId, previous_event_id: existing.event_id, event_id: event.id });
    }
    return;
  }
  state.releases.set(sessionId, receipt);
}

function accountAssignment({ state, event, bucketName }) {
  const id = clean(event.body.assignment_id) || clean(event.body.dispatch_id);
  if (!id) fail('assignment_id or dispatch_id is required', { event_id: event.id, kind: event.kind });
  const receipt = {
    assignment_id: id,
    generation_id: requireField(event.body, 'generation_id', event),
    outer_receipt_id: requireField(event.body, 'outer_receipt_id', event),
    state: bucketName,
    by: event.issuer,
    at: event.issued_at,
    reason: clean(event.body.reason) || clean(event.body.outcome) || null,
    event_id: event.id
  };
  const bucket = state[bucketName];
  const existing = bucket.get(id);
  if (existing) {
    if (!sameReceipt({ ...existing, event_id: undefined }, { ...receipt, event_id: undefined })) {
      fail(`same assignment ${bucketName} receipt changed content`, { assignment_id: id, previous_event_id: existing.event_id, event_id: event.id });
    }
    return;
  }
  bucket.set(id, receipt);
}

function ensurePrepared(state, event) {
  if (!state.prepare) fail('terminal drain receipt appeared before prepare', { event_id: event.id, kind: event.kind });
}

function ensureBinding(state, event) {
  if (!state.prepare) return;
  const generationId = requireField(event.body, 'generation_id', event);
  const outerReceiptId = requireField(event.body, 'outer_receipt_id', event);
  if (generationId !== state.generation_id) fail('drain receipt generation does not match prepare', { event_id: event.id, expected: state.generation_id, received: generationId });
  if (outerReceiptId !== state.outer_receipt_id) fail('drain receipt outer_receipt_id does not match prepare', { event_id: event.id, expected: state.outer_receipt_id, received: outerReceiptId });
}

function releasedSessionByIssuer(state, issuer, at) {
  const candidates = [...state.releases.values()]
    .filter(release => release.released_by === issuer && timeOf(release.released_at) <= timeOf(at))
    .sort((left, right) => timeOf(right.released_at) - timeOf(left.released_at));
  return candidates[0] || null;
}

function commitDrain(state, event) {
  ensurePrepared(state, event);
  ensureBinding(state, event);
  const missingParticipants = state.snapshot.participant_sessions
    .filter(sessionId => {
      if (state.releases.has(sessionId)) return false;
      const session = state.sessions.get(sessionId);
      return !(session && timeOf(session.lease_expires_at) <= timeOf(event.issued_at));
    });
  const missingAssignments = state.snapshot.pending_assignments
    .filter(id => !state.canceled.has(id) && !state.completed.has(id) && !state.quarantined.has(id));
  const missingInflight = state.snapshot.in_flight_dispatches
    .filter(id => !state.completed.has(id) && !state.canceled.has(id) && !state.quarantined.has(id));

  if (missingParticipants.length || missingAssignments.length || missingInflight.length) {
    fail('terminal drain cannot commit with unaccounted participants or dispatch', {
      event_id: event.id,
      missingParticipants,
      missingAssignments,
      missingInflight
    });
  }

  state.commit = {
    drain_id: state.drain_id,
    generation_id: state.generation_id,
    outer_receipt_id: state.outer_receipt_id,
    event_id: event.id,
    committed_by: event.issuer,
    committed_at: event.issued_at,
    participant_count: state.snapshot.participant_sessions.length,
    canceled_count: state.canceled.size,
    completed_count: state.completed.size,
    quarantined_count: state.quarantined.size
  };
}

export function projectTerminalDrain(messages, options = {}) {
  const events = sortedEvents(messages);
  const state = {
    head: clean(options.head) || null,
    generated_at: new Date(Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()).toISOString(),
    sessions: new Map(),
    assignments: [],
    prepare: null,
    drain_id: null,
    generation_id: null,
    outer_receipt_id: null,
    snapshot: { participant_sessions: [], pending_assignments: [], in_flight_dispatches: [] },
    releases: new Map(),
    canceled: new Map(),
    completed: new Map(),
    quarantined: new Map(),
    accepted_generations: new Set(list(options.acceptedGenerationIds)),
    commit: null
  };

  for (const event of events) {
    const body = event.body || {};
    if (event.kind === 'presence') {
      state.sessions.set(clean(body.session_id), {
        agent_id: clean(body.agent_id),
        session_id: clean(body.session_id),
        lease_expires_at: clean(body.lease_expires_at),
        reported_at: event.issued_at,
        reported_by: event.issuer
      });
    } else if (event.kind === 'intent') {
      state.assignments.push({
        assignment_id: assignmentId(event),
        issuer: event.issuer,
        session_id: inferSessionForIntent(state.sessions, event),
        issued_at: event.issued_at,
        event_id: event.id
      });
    }

    if (state.commit && !DRAIN_KINDS.has(event.kind)) {
      const generation = clean(body.generation_id);
      if (!generation || generation === state.generation_id || !state.accepted_generations.has(generation)) {
        fail('old generation cannot append ordinary weave work after terminal release', { event_id: event.id, kind: event.kind, generation_id: generation || state.generation_id });
      }
    }

    if (state.prepare && ORDINARY_WORK_KINDS.has(event.kind)) {
      const released = releasedSessionByIssuer(state, event.issuer, event.issued_at);
      if (released) {
        const generation = clean(body.generation_id);
        if (!generation || generation === state.generation_id || !state.accepted_generations.has(generation)) {
          fail('participant appended ordinary work after release', { event_id: event.id, issuer: event.issuer, released_session_id: released.session_id });
        }
      }
    }

    if (event.kind === 'generation.accept') {
      state.accepted_generations.add(requireField(body, 'generation_id', event));
    } else if (event.kind === 'terminal.drain.prepare') {
      if (state.prepare) fail('only one terminal drain prepare is allowed', { previous_event_id: state.prepare.event_id, event_id: event.id });
      const generationId = requireField(body, 'generation_id', event);
      const outerReceiptId = requireField(body, 'outer_receipt_id', event);
      state.prepare = { ...body, event_id: event.id, issuer: event.issuer, issued_at: event.issued_at };
      state.drain_id = requireField(body, 'drain_id', event);
      state.generation_id = generationId;
      state.outer_receipt_id = outerReceiptId;
      state.snapshot = snapshotAtPrepare({ sessions: state.sessions, assignments: state.assignments, prepareEvent: event });
    } else if (event.kind === 'terminal.drain.release') {
      ensurePrepared(state, event);
      ensureBinding(state, event);
      accountParticipant({ state, event });
    } else if (event.kind === 'terminal.drain.cancel') {
      ensurePrepared(state, event);
      ensureBinding(state, event);
      accountAssignment({ state, event, bucketName: 'canceled' });
    } else if (event.kind === 'terminal.drain.complete') {
      ensurePrepared(state, event);
      ensureBinding(state, event);
      accountAssignment({ state, event, bucketName: 'completed' });
    } else if (event.kind === 'terminal.drain.quarantine') {
      ensurePrepared(state, event);
      ensureBinding(state, event);
      accountAssignment({ state, event, bucketName: 'quarantined' });
    } else if (event.kind === 'terminal.drain.commit') {
      commitDrain(state, event);
    }
  }

  return {
    head: state.head,
    generated_at: state.generated_at,
    status: state.commit ? 'terminal_release_committed' : state.prepare ? 'draining' : 'not_prepared',
    drain_id: state.drain_id,
    generation_id: state.generation_id,
    outer_receipt_id: state.outer_receipt_id,
    prepare: state.prepare,
    snapshot: state.snapshot,
    releases: [...state.releases.values()].sort((left, right) => left.session_id.localeCompare(right.session_id)),
    canceled: [...state.canceled.values()].sort((left, right) => left.assignment_id.localeCompare(right.assignment_id)),
    completed: [...state.completed.values()].sort((left, right) => left.assignment_id.localeCompare(right.assignment_id)),
    quarantined: [...state.quarantined.values()].sort((left, right) => left.assignment_id.localeCompare(right.assignment_id)),
    commit: state.commit
  };
}
