import { normalizeCognitionEvent } from './weave-cognition.mjs';

export function buildSynthesis({ id, issuer = 'system:weave-synthesizer', issued_at, source_events, unresolved_ids = [], minority_report_ids = [], proposed_actions = [] }) {
  const events = Array.isArray(source_events) ? source_events : [];
  const observations = events.filter(event => ['evidence', 'test.result', 'artifact'].includes(event.kind)).map(event => `${event.id}: ${event.body.statement || event.body.name}`);
  const inferences = events.filter(event => ['claim', 'decision', 'plan'].includes(event.kind)).map(event => `${event.id}: ${event.body.statement}`);
  return normalizeCognitionEvent({
    id,
    kind: 'synthesis',
    issuer,
    issued_at,
    visibility: 'private',
    source_event_ids: events.map(event => event.id),
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

export function critiqueSynthesis({ id, synthesis, state, issuer = 'system:weave-critic', issued_at }) {
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
  const missing = synthesis.source_event_ids.filter(id => !state?.by_id?.[id]);
  if (missing.length) {
    findings.push(`missing source events: ${missing.join(', ')}`);
    corrections.push('remove or restore missing source citations');
    blocking.push(...missing);
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

export function buildAcceptanceDecision({ id, synthesis, critique, issuer = 'system:weave-integrator', issued_at, resolves = [] }) {
  if (critique.body.verdict !== 'accept') throw new Error('Only an accepted synthesis can advance a decision.');
  return normalizeCognitionEvent({
    id,
    kind: 'decision',
    issuer,
    issued_at,
    visibility: 'private',
    source_event_ids: [synthesis.id, critique.id, ...synthesis.source_event_ids],
    body: {
      statement: synthesis.body.statement,
      supporting_ids: synthesis.source_event_ids.filter(id => !synthesis.body.minority_report_ids.includes(id)),
      opposing_ids: synthesis.body.minority_report_ids,
      rationale: `Accepted by critique ${critique.id}; unresolved dissent remains explicitly cited.`,
      confidence: synthesis.body.unresolved_ids.length ? 0.55 : 0.8,
      resolves,
      rollback_trigger: 'new contradictory evidence or failed executable witness'
    }
  });
}
