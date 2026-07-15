import { createHash } from 'node:crypto';
import { stableDigest, unresolvedCognitionIds } from './weave-cognition.mjs';

const roleOrder = ['proposer', 'opponent', 'verifier', 'implementer', 'integrator', 'historian', 'critic'];
const assignmentKey = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const INDEPENDENT_REVIEW_FINDING = 'independent semantic review is required before admission';

function assignmentIsLive(state, event) {
  if (!event || state?.superseded?.[event.id]) return false;
  const completion = state?.dispatch_completed?.[event.body.assignment_id];
  return !completion || completion.body.status === 'completed';
}

function existingNoveltyKeys(state) {
  return new Set(Object.values(state?.assignments || {})
    .filter(event => assignmentIsLive(state, event))
    .map(event => event.body?.novelty_key)
    .filter(Boolean));
}

function substantiveFrontier(state, targetIds) {
  const targets = new Set(targetIds);
  return (state?.events || [])
    .filter(event => {
      if (!['assignment', 'dispatch.started', 'dispatch.completed', 'wave.receipt'].includes(event.kind)) return true;
      return event.kind === 'dispatch.completed' && event.body.status !== 'completed';
    })
    .filter(event => targets.has(event.id)
      || (event.source_event_ids || []).some(id => targets.has(id))
      || (event.kind === 'dispatch.completed' && targets.has(event.body.assignment_event_id)))
    .map(event => ({ id: event.id, kind: event.kind, digest: stableDigest(event) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function candidate(state, role, targetIds, reason, priority, expectedKinds) {
  const sortedTargets = [...targetIds].sort();
  const frontier = stableDigest(substantiveFrontier(state, sortedTargets)).slice(0, 16);
  const novelty = `novelty:${role}:${sortedTargets.join(',')}:${frontier}`;
  return { role, target_ids: sortedTargets, reason, priority, expected_kinds: [...new Set(expectedKinds.filter(kind => kind !== 'decision'))], novelty_key: novelty };
}

function pendingAdmissionTargets(state) {
  const targets = new Set();
  for (const critiqueId of state?.unresolved_critique_ids || []) {
    const critique = state.critiques[critiqueId];
    if (!critique || critique.body.verdict !== 'revise' || !critique.body.findings.includes(INDEPENDENT_REVIEW_FINDING)) continue;
    const synthesis = state.syntheses[critique.body.synthesis_id];
    for (const id of synthesis?.body?.unresolved_ids || []) targets.add(id);
  }
  return targets;
}

export function planDeliberationWave(state, config = {}) {
  const maxAssignments = Math.max(1, Math.min(32, Number(config.max_assignments ?? 8) || 8));
  const waveIndex = Math.max(0, Number(config.wave_index ?? Object.keys(state?.waves || {}).length) || 0);
  const assignmentVisibility = config.visibility === 'public' ? 'public' : 'private';
  const candidates = [];
  const admissionTargets = pendingAdmissionTargets(state);

  for (const id of state?.open_question_ids || []) {
    if (admissionTargets.has(id)) continue;
    const priority = Number(state.questions[id]?.body.priority || 50);
    candidates.push(candidate(state, 'proposer', [id], 'answer unresolved question with candidate material', priority + 20, ['claim', 'evidence', 'uncertainty']));
    candidates.push(candidate(state, 'verifier', [id], 'verify answerability and evidence', priority + 10, [...new Set(['evidence', 'test.result', 'uncertainty', ...(state.questions[id]?.body.answer_kinds || [])])]));
  }
  for (const id of state?.unresolved_contradiction_ids || []) {
    if (admissionTargets.has(id)) continue;
    const contradiction = state.contradictions[id];
    const priority = Number(contradiction?.body.severity || 50);
    candidates.push(candidate(state, 'opponent', [id, contradiction.body.left_id, contradiction.body.right_id], 'preserve strongest countercase', priority + 30, ['evidence', 'critique', 'uncertainty']));
    candidates.push(candidate(state, 'integrator', [id, contradiction.body.left_id, contradiction.body.right_id], 'seek discriminating test or bounded candidate resolution', priority + 20, ['test.result', 'claim', 'evidence', 'question']));
  }
  for (const id of state?.unresolved_critique_ids || []) {
    const critique = state.critiques[id];
    if (!critique) continue;
    const targets = [id, critique.body.synthesis_id, ...critique.body.blocking_event_ids];
    const independenceOnly = critique.body.verdict === 'revise' && critique.body.findings.includes(INDEPENDENT_REVIEW_FINDING);
    if (!independenceOnly) candidates.push(candidate(state, 'integrator', targets, 'repair blocked or revision-required synthesis', 98, ['synthesis', 'evidence', 'test.result', 'claim']));
    candidates.push(candidate(state, 'critic', targets, independenceOnly ? 'independently review structurally valid synthesis' : 'independently re-evaluate corrected synthesis', 96, ['critique', 'evidence', 'test.result']));
  }
  for (const id of state?.unsupported_claim_ids || []) {
    if (admissionTargets.has(id)) continue;
    const claim = state.claims[id];
    candidates.push(candidate(state, 'verifier', [id], 'seek evidence for unsupported claim', Number(claim?.body.impact || 50) + (1 - Number(claim?.body.confidence || 0.5)) * 40, ['evidence', 'test.result', 'uncertainty']));
  }
  for (const id of state?.failed_test_ids || []) {
    if (!admissionTargets.has(id)) candidates.push(candidate(state, 'implementer', [id], 'repair failed executable witness', 90, ['artifact', 'test.result', 'plan']));
  }
  for (const id of state?.active_plan_ids || []) {
    if (state.plans[id]?.status === 'blocked' && !admissionTargets.has(id)) candidates.push(candidate(state, 'integrator', [id], 'unblock active plan', 85, ['plan', 'claim', 'evidence', 'question']));
  }
  for (const completion of Object.values(state?.dispatch_completed || {})) {
    if (completion.body.status === 'completed' || state?.superseded?.[completion.id]) continue;
    const assignment = state.assignments[completion.body.assignment_id];
    if (!assignment) continue;
    candidates.push(candidate(
      state,
      assignment.body.role,
      [assignment.id, ...assignment.body.target_ids, completion.id],
      `retry ${completion.body.status} dispatch within bounded wave budget`,
      94,
      assignment.body.expected_kinds
    ));
  }

  const existing = existingNoveltyKeys(state);
  const unique = new Map();
  for (const value of candidates) {
    if (existing.has(value.novelty_key)) continue;
    const key = `${value.role}:${value.target_ids.join(',')}`;
    if (!unique.has(key) || unique.get(key).priority < value.priority) unique.set(key, value);
  }

  const assignments = [...unique.values()]
    .sort((left, right) => right.priority - left.priority || roleOrder.indexOf(left.role) - roleOrder.indexOf(right.role) || left.target_ids.join(',').localeCompare(right.target_ids.join(',')))
    .slice(0, maxAssignments)
    .map(value => {
      const assignmentId = `assign:${assignmentKey(`${waveIndex}|${value.novelty_key}`)}`;
      return {
        id: `event:${assignmentId}`,
        kind: 'assignment',
        issuer: 'system:weave-planner',
        issued_at: config.issued_at || new Date(0 + waveIndex).toISOString(),
        visibility: assignmentVisibility,
        source_event_ids: [...value.target_ids],
        body: {
          assignment_id: assignmentId,
          wave_id: `wave:${waveIndex}`,
          role: value.role,
          target_ids: value.target_ids,
          expected_kinds: value.expected_kinds,
          completion_criteria: [value.reason, 'cite exact source event ids', 'emit typed candidate events only'],
          budget: {
            max_events: Math.max(1, Math.min(16, Number(config.max_events_per_assignment ?? 4) || 4)),
            max_chars: Math.max(256, Math.min(64000, Number(config.max_chars_per_assignment ?? 12000) || 12000))
          },
          artifact_scope: config.artifact_scope || [],
          novelty_key: value.novelty_key
        },
        novelty_key: value.novelty_key,
        priority: value.priority
      };
    });

  const unresolved = unresolvedCognitionIds(state).filter(id => !(state?.pending_assignment_event_ids || []).includes(id));
  let terminal = null;
  if (!unresolved.length && !(state?.pending_assignment_event_ids || []).length) terminal = 'converged';
  else if (!assignments.length && !(state?.pending_assignment_event_ids || []).length) terminal = 'human_required';
  return { wave_id: `wave:${waveIndex}`, wave_index: waveIndex, assignments, unresolved_ids: unresolved, terminal };
}
