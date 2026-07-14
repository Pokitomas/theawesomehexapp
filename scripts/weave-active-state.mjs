import { foldWeaveMessages, isWeaveMessage, normalizeWeaveEvent } from './weave-protocol.mjs';

const clean = value => String(value ?? '').trim();
const timeOf = value => {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

function sortedEvents(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(isWeaveMessage)
    .map(message => normalizeWeaveEvent(message.payload.weave))
    .sort((left, right) => timeOf(left.issued_at) - timeOf(right.issued_at) || left.id.localeCompare(right.id));
}

function artifactKeys(intent = {}) {
  const keys = new Set((Array.isArray(intent.expected_files) ? intent.expected_files : []).map(clean).filter(Boolean));
  if (intent.artifact != null) keys.add(typeof intent.artifact === 'string' ? clean(intent.artifact) : JSON.stringify(intent.artifact));
  return [...keys].filter(Boolean).sort();
}

function overlap(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter(value => rightSet.has(value));
}

function uniqueBeacons(beacons = []) {
  const byId = new Map();
  for (const beacon of beacons) {
    const id = clean(beacon?.beacon_id);
    if (id) byId.set(id, beacon);
  }
  return [...byId.values()].sort((left, right) => clean(left.beacon_id).localeCompare(clean(right.beacon_id)));
}

function terminalRecord(event) {
  const body = event.body || {};
  const state = event.kind === 'session.handoff'
    ? 'handed_off'
    : event.kind === 'session.lost'
      ? 'lost'
      : 'recovered';
  return {
    ...body,
    state,
    event_id: event.id,
    issued_at: event.issued_at,
    issued_by: event.issuer
  };
}

function terminalSupersedesPresence(terminal, presence) {
  return Boolean(terminal && timeOf(terminal.issued_at) >= timeOf(presence.reported_at));
}

export function projectActiveWeaveState(messages, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const folded = foldWeaveMessages(messages, now);
  const events = sortedEvents(messages);
  const sessions = new Map();
  const terminals = new Map();
  const intents = [];
  const expectedResponses = new Map();
  const responseTimes = new Map();

  for (const event of events) {
    const body = event.body || {};
    if (event.kind === 'presence') {
      sessions.set(body.session_id, {
        agent_id: body.agent_id,
        session_id: body.session_id,
        state: body.state,
        thread_ids: body.thread_ids || [],
        assignment_ids: body.assignment_ids || [],
        artifact_intents: body.artifact_intents || [],
        waiting_for: body.waiting_for || [],
        last_evidence: body.last_evidence || [],
        lease_expires_at: body.lease_expires_at,
        reported_at: event.issued_at,
        reported_by: event.issuer
      });
    } else if (event.kind === 'intent') {
      const eventTime = timeOf(event.issued_at);
      const candidates = [...sessions.values()]
        .filter(candidate => candidate.reported_by === event.issuer
          && timeOf(candidate.reported_at) <= eventTime
          && timeOf(candidate.lease_expires_at) > eventTime
          && !terminalSupersedesPresence(terminals.get(candidate.session_id), candidate))
        .sort((left, right) => timeOf(right.reported_at) - timeOf(left.reported_at)
          || left.session_id.localeCompare(right.session_id));
      intents.push({
        ...body,
        issuer: event.issuer,
        session_id: candidates[0]?.session_id || null,
        candidate_session_ids: candidates.map(candidate => candidate.session_id),
        issued_at: event.issued_at,
        event_id: event.id,
        artifact_keys: artifactKeys(body)
      });
    } else if (event.kind === 'message') {
      if (body.expects_response) expectedResponses.set(event.id, {
        ...body,
        issuer: event.issuer,
        issued_at: event.issued_at,
        event_id: event.id
      });
      if (body.reply_to) {
        const responseTime = timeOf(event.issued_at);
        responseTimes.set(body.reply_to, Math.max(responseTimes.get(body.reply_to) || 0, responseTime));
      }
    } else if (['session.handoff', 'session.lost', 'session.recover'].includes(event.kind)) {
      terminals.set(body.session_id, terminalRecord(event));
    }
  }

  const activeSessions = [...sessions.values()]
    .filter(session => timeOf(session.lease_expires_at) > now
      && !terminalSupersedesPresence(terminals.get(session.session_id), session))
    .sort((left, right) => left.session_id.localeCompare(right.session_id));
  const activeSessionIds = new Set(activeSessions.map(session => session.session_id));

  const activeIntents = intents
    .filter(intent => intent.session_id && activeSessionIds.has(intent.session_id))
    .sort((left, right) => left.event_id.localeCompare(right.event_id));
  const unboundIntents = intents
    .filter(intent => !intent.session_id)
    .sort((left, right) => left.event_id.localeCompare(right.event_id));

  const collisions = [];
  for (let leftIndex = 0; leftIndex < activeIntents.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < activeIntents.length; rightIndex += 1) {
      const left = activeIntents[leftIndex];
      const right = activeIntents[rightIndex];
      const shared = overlap(left.artifact_keys, right.artifact_keys);
      if (!shared.length) continue;
      collisions.push({
        artifacts: shared,
        participants: [left.issuer, right.issuer],
        sessions: [left.session_id, right.session_id],
        policies: [left.collision_policy, right.collision_policy],
        parallel_work_welcome: Boolean(left.parallel_work_welcome && right.parallel_work_welcome)
      });
    }
  }

  const recoveryNeeded = [...sessions.values()]
    .filter(session => timeOf(session.lease_expires_at) <= now
      && !terminalSupersedesPresence(terminals.get(session.session_id), session))
    .map(session => ({
      agent_id: session.agent_id,
      session_id: session.session_id,
      lease_expires_at: session.lease_expires_at,
      last_state: session.state,
      reported_by: session.reported_by,
      recovery_beacon_id: `recovery:${session.session_id}`
    }))
    .sort((left, right) => left.session_id.localeCompare(right.session_id));

  const recoveryBeacons = recoveryNeeded.map(session => ({
    beacon_id: session.recovery_beacon_id,
    kind: 'agent_disappeared',
    target: { agent_id: session.agent_id, session_id: session.session_id },
    signal: `Presence lease expired for ${session.agent_id}.`,
    useful_contribution: ['inspect workspace', 'recover intent', 'package or revert changes'],
    state: 'open'
  }));
  const openBeacons = uniqueBeacons([
    ...Object.values(folded.beacons || {}).filter(beacon => ['open', 'active'].includes(beacon.state)),
    ...recoveryBeacons
  ]);

  const unresolvedResponses = [...expectedResponses.values()]
    .filter(message => (responseTimes.get(message.event_id) || 0) <= timeOf(message.issued_at))
    .sort((left, right) => left.event_id.localeCompare(right.event_id));

  const recentTerminations = [...terminals.values()]
    .filter(terminal => {
      const presence = sessions.get(terminal.session_id);
      return !presence || terminalSupersedesPresence(terminal, presence);
    })
    .sort((left, right) => timeOf(right.issued_at) - timeOf(left.issued_at)
      || clean(left.session_id).localeCompare(clean(right.session_id)));

  return {
    head: clean(options.head) || null,
    generated_at: new Date(now).toISOString(),
    activeSessions,
    activeIntents,
    unboundIntents,
    collisions,
    unresolvedResponses,
    recoveryNeeded,
    openBeacons,
    recentTerminations
  };
}
