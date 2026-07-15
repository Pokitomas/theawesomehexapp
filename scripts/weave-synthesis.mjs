import { normalizeCognitionEvent } from './weave-cognition.mjs';

const STRUCTURAL_CRITIC = 'system:weave-critic';
const INDEPENDENT_REVIEW_FINDING = 'independent semantic review is required before admission';

export function buildSynthesis({ id, issuer = 'system:weave-synthesizer', issued_at, source_events, unresolved_ids = [], minority_report_ids = [], proposed_actions = [] }) {
  const events = Array.isArray(source_events) ? source_events : [];
  const observations = events
    .filter(event => ['evidence', 'test.result', 'artifact'].includes(event.kind))
    .map(event => `${event.id}: ${event.body.statement || event.body.name}`);
  const inferences = events
    .filter(event => ['claim', 'decision', 'plan'].includes(event.kind))
    .map(event => `${event.id}: ${event.body.statement}`);
  return normalizeCognitionEvent({
    id,
    kind: 'synthesis',
    issuer,
    issued_at,
    visibility: 'private',
    source_event_ids: [...new Set([...events.map(event => event.id), ...unresolved_ids, ...minority_report_ids])],
    body: {
      statement: `Synthesis over ${events.length} typed events.`,
      observations,
      inferences,
      assumptions: [],
      unresolved_ids,
      minority_report_ids,
      proposed_actions
    }
  });
}

export function critiqueSynthesis({ id, synthesis, state, issuer = STRUCTURAL_CRITIC, issued_at }) {
  const findings = [];
  const corrections = [];
  const blocking = [];
  const cited = new Set(synthesis.source_event_ids);
  for (const sourceId of synthesis.body.unresolved_ids) {
    if (!cited.has(sourceId)) {
      findings.push(`unresolved event ${sourceId} is not cited`);
      corrections.push(`cite unresolved event ${sourceId}`);
      blocking.push(sourceId);
    }
  }
  for (const minorityId of synthesis.body.minority_report_ids) {
    if (!cited.has(minorityId)) {
      findings.push(`minority event ${minorityId} was omitted from citations`);
      corrections.push(`preserve minority event ${minorityId}`);
      blocking.push(minorityId);
    }
  }
  for (const contradictionId of state?.unresolved_contradiction_ids || []) {
    if (!synthesis.body.unresolved_ids.includes(contradictionId)) {
      findings.push(`live contradiction ${contradictionId} was erased`);
      corrections.push(`mark contradiction ${contradictionId} unresolved`);
      blocking.push(contradictionId);
    }
  }
  for (const failedId of state?.failed_test_ids || []) {
    if (!synthesis.body.unresolved_ids.includes(failedId)) {
      findings.push(`failed executable witness ${failedId} was omitted`);
      corrections.push(`preserve failed witness ${failedId}`);
      blocking.push(failedId);
    }
  }
  const missing = synthesis.source_event_ids.filter(id => !state?.by_id?.[id]);
  if (missing.length) {
    findings.push(`missing source events: ${missing.join(', ')}`);
    corrections.push('remove or restore missing source citations');
    blocking.push(...missing);
  }
  if (issuer === STRUCTURAL_CRITIC && !blocking.length) {
    findings.push(INDEPENDENT_REVIEW_FINDING);
    corrections.push('obtain an accept critique from a distinct critic principal citing this synthesis and structural critique');
  }
  const verdict = blocking.length ? 'block' : (findings.length ? 'revise' : 'accept');
  return normalizeCognitionEvent({
    id,
    kind: 'critique',
    issuer,
    issued_at,
    visibility: 'private',
    source_event_ids: [synthesis.id, ...synthesis.source_event_ids],
    body: {
      synthesis_id: synthesis.id,
      verdict,
      findings,
      required_corrections: corrections,
      blocking_event_ids: [...new Set(blocking)]
    }
  });
}

export function isIndependentAcceptance({ synthesis, critique, structuralCritique = null }) {
  if (!synthesis || !critique || critique.kind !== 'critique' || critique.body.verdict !== 'accept') return false;
  if (critique.body.synthesis_id !== synthesis.id) return false;
  if (!critique.source_event_ids.includes(synthesis.id)) return false;
  if (critique.issuer === synthesis.issuer || critique.issuer === STRUCTURAL_CRITIC) return false;
  if (structuralCritique && !critique.source_event_ids.includes(structuralCritique.id)) return false;
  return true;
}

export function buildAcceptanceDecision({ id, synthesis, critique, structural_critique = null, issuer = 'system:weave-integrator', issued_at, resolves = [] }) {
  if (!isIndependentAcceptance({ synthesis, critique, structuralCritique: structural_critique })) {
    throw new Error('Only an independently accepted synthesis can advance a decision.');
  }
  return normalizeCognitionEvent({
    id,
    kind: 'decision',
    issuer,
    issued_at,
    visibility: synthesis.visibility,
    source_event_ids: [synthesis.id, critique.id, ...(structural_critique ? [structural_critique.id] : []), ...synthesis.source_event_ids],
    body: {
      statement: synthesis.body.statement,
      supporting_ids: synthesis.source_event_ids.filter(sourceId => !synthesis.body.minority_report_ids.includes(sourceId)),
      opposing_ids: synthesis.body.minority_report_ids,
      rationale: `Independently accepted by critique ${critique.id}; remaining dissent stays cited.`,
      confidence: synthesis.body.unresolved_ids.length ? 0.55 : 0.8,
      resolves,
      rollback_trigger: 'new contradictory evidence or failed executable witness'
    }
  });
}

export const SYNTHESIS_REVIEW = Object.freeze({
  structural_critic: STRUCTURAL_CRITIC,
  independent_review_finding: INDEPENDENT_REVIEW_FINDING
});
