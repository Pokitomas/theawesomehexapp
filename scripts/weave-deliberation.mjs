import { createHash } from 'node:crypto';
import { unresolvedCognitionIds } from './weave-cognition.mjs';

const roleOrder = ['proposer', 'opponent', 'verifier', 'implementer', 'integrator', 'historian', 'critic'];
const assignmentKey = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

function existingNoveltyKeys(state) {
  return new Set(Object.values(state?.assignments || {}).map(event => event.body?.novelty_key).filter(Boolean));
}

function candidate(role, targetIds, reason, priority, expectedKinds) {
  const novelty = `novelty:${role}:${[...targetIds].sort().join(',')}`;
  return { role, target_ids: [...targetIds].sort(), reason, priority, expected_kinds: expectedKinds, novelty_key: novelty };
}

export function planDeliberationWave(state, config = {}) {
  const maxAssignments = Math.max(1, Math.min(32, Number(config.max_assignments ?? 8) || 8));
  const waveIndex = Math.max(0, Number(config.wave_index ?? Object.keys(state?.waves || {}).length) || 0);
  const candidates = [];

  for (const id of state?.open_question_ids || []) {
    const priority = Number(state.questions[id]?.body.priority || 50);
    candidates.push(candidate('proposer', [id], 'answer unresolved question', priority + 20, ['claim', 'evidence', 'decision']));
    candidates.push(candidate('verifier', [id], 'verify answerability and evidence', priority + 10, [...new Set(['evidence', 'test.result', 'uncertainty', ...(state.questions[id]?.body.answer_kinds || [])]) ]));
  }
  for (const id of state?.unresolved_contradiction_ids || []) {
    const contradiction = state.contradictions[id];
    const priority = Number(contradiction?.body.severity || 50);
    candidates.push(candidate('opponent', [id, contradiction.body.left_id, contradiction.body.right_id], 'preserve strongest countercase', priority + 30, ['evidence', 'critique', 'uncertainty']));
    candidates.push(candidate('integrator', [id, contradiction.body.left_id, contradiction.body.right_id], 'seek discriminating test or bounded resolution', priority + 20, ['test.result', 'decision', 'question']));
  }
  for (const id of state?.unsupported_claim_ids || []) {
    const claim = state.claims[id];
    candidates.push(candidate('verifier', [id], 'seek evidence for unsupported claim', Number(claim?.body.impact || 50) + (1 - Number(claim?.body.confidence || 0.5)) * 40, ['evidence', 'test.result', 'uncertainty']));
  }
  for (const id of state?.failed_test_ids || []) candidates.push(candidate('implementer', [id], 'repair failed executable witness', 90, ['artifact', 'test.result', 'plan']));
  for (const id of state?.active_plan_ids || []) {
    if (state.plans[id]?.body.state === 'blocked') candidates.push(candidate('integrator', [id], 'unblock active plan', 85, ['plan', 'decision', 'question']));
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
        visibility: 'private',
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

  const unresolved = unresolvedCognitionIds(state);
  let terminal = null;
  if (!unresolved.length) terminal = 'converged';
  else if (!assignments.length) terminal = 'human_required';
  return { wave_id: `wave:${waveIndex}`, wave_index: waveIndex, assignments, unresolved_ids: unresolved, terminal };
}
