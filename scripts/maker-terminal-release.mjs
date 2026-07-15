const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const unique = value => [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))].sort();

function fail(message, detail = {}) {
  const error = new Error(message);
  error.code = 'MAKER_TERMINAL_RELEASE_INVALID';
  error.detail = detail;
  throw error;
}

export function createMakerTerminalRelease({
  generation_id,
  outer_receipt_id,
  participant_sessions = ['native-implementation'],
  assignments = ['implementation'],
  now = () => new Date().toISOString()
} = {}) {
  const generationId = clean(generation_id);
  const outerReceiptId = clean(outer_receipt_id);
  if (!generationId) throw new Error('Maker generation_id is required.');
  if (!outerReceiptId) throw new Error('Maker outer_receipt_id is required.');

  const participants = unique(participant_sessions);
  const pending = unique(assignments);
  const releases = new Map();
  const accounted = new Map();
  let phase = 'active';
  let prepare = null;
  let commit = null;

  function assertActive() {
    if (phase !== 'active') fail('Maker generation cannot admit new work after terminal prepare.', { phase, generation_id: generationId });
  }

  function start(assignmentId) {
    assertActive();
    const id = clean(assignmentId);
    if (!id) throw new Error('Maker assignment_id is required.');
    if (!pending.includes(id)) pending.push(id);
    pending.sort();
    return api;
  }

  function prepareDrain(reason = 'terminal outcome reached') {
    if (phase === 'committed') fail('Maker terminal release is already committed.');
    const receipt = {
      drain_id: `maker-drain:${generationId}`,
      generation_id: generationId,
      outer_receipt_id: outerReceiptId,
      participant_sessions: [...participants],
      pending_assignments: [...pending],
      prepared_at: now(),
      reason: clean(reason) || null
    };
    if (prepare) {
      const comparable = { ...prepare, prepared_at: undefined };
      const incoming = { ...receipt, prepared_at: undefined };
      if (JSON.stringify(comparable) !== JSON.stringify(incoming)) fail('Changed duplicate Maker terminal prepare receipt.');
      return api;
    }
    prepare = receipt;
    phase = 'draining';
    return api;
  }

  function account(assignmentId, state, reason = '') {
    if (phase !== 'draining') fail('Maker assignment terminal receipt requires prepare.', { phase });
    if (!['completed', 'canceled', 'quarantined'].includes(state)) throw new Error(`Invalid Maker assignment terminal state: ${state}.`);
    const id = clean(assignmentId);
    if (!pending.includes(id)) fail('Maker terminal receipt references an unknown assignment.', { assignment_id: id });
    const receipt = { assignment_id: id, state, reason: clean(reason) || null, at: now() };
    const existing = accounted.get(id);
    if (existing) {
      const comparable = { ...existing, at: undefined };
      const incoming = { ...receipt, at: undefined };
      if (JSON.stringify(comparable) !== JSON.stringify(incoming)) fail('Changed duplicate Maker assignment terminal receipt.', { assignment_id: id });
      return api;
    }
    accounted.set(id, receipt);
    return api;
  }

  function release(sessionId, reason = '') {
    if (phase !== 'draining') fail('Maker participant release requires prepare.', { phase });
    const id = clean(sessionId);
    if (!participants.includes(id)) fail('Maker release references an unknown participant.', { session_id: id });
    const receipt = { session_id: id, reason: clean(reason) || null, released_at: now() };
    const existing = releases.get(id);
    if (existing) {
      const comparable = { ...existing, released_at: undefined };
      const incoming = { ...receipt, released_at: undefined };
      if (JSON.stringify(comparable) !== JSON.stringify(incoming)) fail('Changed duplicate Maker participant release.', { session_id: id });
      return api;
    }
    releases.set(id, receipt);
    return api;
  }

  function commitRelease() {
    if (phase !== 'draining') fail('Maker terminal release commit requires prepare.', { phase });
    const missingParticipants = participants.filter(id => !releases.has(id));
    const missingAssignments = pending.filter(id => !accounted.has(id));
    if (missingParticipants.length || missingAssignments.length) {
      fail('Maker terminal release cannot commit with unaccounted work.', { missingParticipants, missingAssignments });
    }
    commit = {
      generation_id: generationId,
      outer_receipt_id: outerReceiptId,
      committed_at: now(),
      participant_count: participants.length,
      completed_count: [...accounted.values()].filter(value => value.state === 'completed').length,
      canceled_count: [...accounted.values()].filter(value => value.state === 'canceled').length,
      quarantined_count: [...accounted.values()].filter(value => value.state === 'quarantined').length
    };
    phase = 'committed';
    return projection();
  }

  function projection() {
    return {
      schema: 'sideways-maker-terminal-release/v1',
      status: phase === 'committed' ? 'terminal_release_committed' : phase === 'draining' ? 'draining' : 'active',
      generation_id: generationId,
      outer_receipt_id: outerReceiptId,
      prepare,
      releases: [...releases.values()].sort((a, b) => a.session_id.localeCompare(b.session_id)),
      assignments: [...accounted.values()].sort((a, b) => a.assignment_id.localeCompare(b.assignment_id)),
      commit
    };
  }

  const api = Object.freeze({ assertActive, start, prepare: prepareDrain, account, release, commit: commitRelease, projection });
  return api;
}

export function terminalReleaseForNativeAgent({ status, generation_id = 'native-agent', outer_receipt_id = 'native-agent-result', now } = {}) {
  const lifecycle = createMakerTerminalRelease({ generation_id, outer_receipt_id, now });
  lifecycle.prepare(status === 'finished' ? 'implementation admitted finish' : 'implementation budget exhausted');
  lifecycle.account('implementation', status === 'finished' ? 'completed' : 'quarantined', status);
  lifecycle.release('native-implementation', status);
  return lifecycle.commit();
}
