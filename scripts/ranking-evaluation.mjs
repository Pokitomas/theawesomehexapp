#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const RECEIPT_SCHEMA = 'sideways-ranking-evaluation/v2';
export const FIXTURE_SCHEMA = 'sideways-ranking-evaluation-fixture/v2';
export const FEEDBACK_SCHEMA = 'sideways-delayed-feedback/v1';

const BASE_FIELDS = Object.freeze(['engagement', 'affinity', 'relevance']);
const LATERAL_FIELDS = Object.freeze(['axisDistance', 'sourceNovelty', 'viewpointGap', 'context', 'motive', 'place', 'topicDistance', 'duplicateRisk', 'graphicRisk']);
const ALL_NUMERIC_FIELDS = Object.freeze([...BASE_FIELDS, ...LATERAL_FIELDS]);
const FORBIDDEN_FEEDBACK_KEYS = /(^|_)(text|body|content|archive|asset|blob|profile|email|password|secret|token|credential)(_|$)/i;
const SOURCE_CHECKS = Object.freeze([
  ['baseScore weights', /baseScore\s*=\s*\.55\*post\.base\s*\+\s*\.30\*f\.affinity\s*\+\s*\.15\*post\.relevance/],
  ['lateralValue weights', /\.24\*f\.sameWhyDifferentAxis[\s\S]{0,240}?\-\s*\.15\*f\.graphicRepeat/],
  ['posteriorChoice sigmoid', /sigmoid\(\s*4\.2\s*\*\s*delta\s*\+\s*1\.15\s*\*\s*\(maxZ\s*\-\s*\.85\)\s*\)/],
  ['riskFloor clamp', /clamp\(\s*\(maxZ\s*\-\s*\.55\)\s*\/\s*2\.8\s*,\s*0\s*,\s*\.43\s*\)/],
  ['gate target blend', /riskFloor\s*\+\s*\.54\s*\*\s*posteriorChoice/],
  ['deep_saturation floor', /Math\.max\(target,\s*\.48\)/]
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sigmoid = value => 1 / (1 + Math.exp(-value));
const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite.`);
  return number;
};
const round = value => Number(value.toFixed(9));

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function baseScore(candidate) {
  return 0.55 * finite(candidate.engagement, `${candidate.id}.engagement`)
    + 0.30 * finite(candidate.affinity, `${candidate.id}.affinity`)
    + 0.15 * finite(candidate.relevance, `${candidate.id}.relevance`);
}

export function lateralValue(candidate) {
  return 0.24 * finite(candidate.axisDistance, `${candidate.id}.axisDistance`)
    + 0.15 * finite(candidate.sourceNovelty, `${candidate.id}.sourceNovelty`)
    + 0.12 * finite(candidate.viewpointGap, `${candidate.id}.viewpointGap`)
    + 0.19 * finite(candidate.context, `${candidate.id}.context`)
    + 0.18 * finite(candidate.motive, `${candidate.id}.motive`)
    + 0.06 * finite(candidate.place, `${candidate.id}.place`)
    + 0.06 * finite(candidate.topicDistance, `${candidate.id}.topicDistance`)
    - 0.16 * finite(candidate.duplicateRisk, `${candidate.id}.duplicateRisk`)
    - 0.15 * finite(candidate.graphicRisk, `${candidate.id}.graphicRisk`);
}

export function sourceKernelEvidence(source) {
  const normalized = String(source || '');
  const checks = SOURCE_CHECKS.map(([name, pattern]) => ({ name, present: pattern.test(normalized) }));
  return Object.freeze({
    ok: checks.every(item => item.present),
    signature: digest(checks.map(item => [item.name, item.present])),
    checks
  });
}

export function deriveSaturationState(session) {
  const axes = Object.values(session.axes || {}).map((value, index) => finite(value, `session.axes[${index}]`));
  if (!axes.length) throw new Error('session.axes must contain at least one finite load.');
  const sorted = [...axes].sort((a, b) => b - a);
  const maxZ = sorted[0];
  const topThreePositive = sorted.slice(0, 3).reduce((sum, value) => sum + Math.max(0, value), 0);
  const high = finite(session.high_threshold, 'session.high_threshold');
  const joint = finite(session.joint_threshold, 'session.joint_threshold');
  const low = finite(session.low_threshold, 'session.low_threshold');
  const previous = String(session.previous_state || 'normal');
  const enter = maxZ > high || topThreePositive > joint;
  const exit = axes.every(value => value < low)
    && Number(session.exposures_since_boundary || 0) >= Number(session.min_exit_exposures || 0)
    && session.interacted_with_new_axis === true;
  const deep = Number(session.lateral_rejections || 0) >= Number(session.deep_rejection_threshold || 3) && maxZ > high;
  let state = previous;
  if (previous === 'normal' && enter) state = deep ? 'deep_saturation' : 'saturation';
  else if (previous !== 'normal' && exit) state = 'normal';
  else if (previous !== 'normal' && deep) state = 'deep_saturation';
  return Object.freeze({ state, enter, exit, maxZ, topThreePositive });
}

export function deriveGate(session, saturation = deriveSaturationState(session)) {
  const baseSample = finite(session.posterior_sample_base, 'session.posterior_sample_base');
  const lateralSample = finite(session.posterior_sample_lateral, 'session.posterior_sample_lateral');
  const delta = lateralSample - baseSample;
  const posteriorChoice = sigmoid(4.2 * delta + 1.15 * (saturation.maxZ - 0.85));
  const riskFloor = clamp((saturation.maxZ - 0.55) / 2.8, 0, 0.43);
  let target = clamp(riskFloor + 0.54 * posteriorChoice, 0.08, 0.88);
  if (saturation.state === 'deep_saturation') target = Math.max(target, 0.48);
  const previousGate = finite(session.previous_gate, 'session.previous_gate');
  const elapsed = finite(session.elapsed_seconds, 'session.elapsed_seconds');
  const tau = finite(session.gate_tau_seconds, 'session.gate_tau_seconds');
  if (elapsed < 0 || tau <= 0) throw new Error('Gate elapsed_seconds must be non-negative and gate_tau_seconds positive.');
  const smoothing = 1 - Math.exp(-elapsed / tau);
  const gate = clamp(previousGate + smoothing * (target - previousGate), 0.08, 0.88);
  return Object.freeze({ gate, target, riskFloor, posteriorChoice, delta, smoothing, state: saturation.state });
}

function hash32(text) {
  const bytes = createHash('sha256').update(String(text)).digest();
  return bytes.readUInt32LE(0) || 1;
}

function seededUnit(seed, key) {
  let x = (Number(seed) >>> 0) ^ hash32(key);
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return (x >>> 0) / 0x1_0000_0000;
}

export function explorationNoise(seed, candidateId, bound) {
  if (!Number.isInteger(seed)) throw new Error('An explicit integer exploration seed is required.');
  const limit = finite(bound, 'exploration_bound');
  if (limit < 0 || limit > 0.25) throw new Error('exploration_bound must be between 0 and 0.25.');
  const value = (seededUnit(seed, candidateId) * 2 - 1) * limit;
  if (Math.abs(value) > limit + Number.EPSILON) throw new Error('Exploration noise escaped its declared bound.');
  return value;
}

function validateFeedbackContract(contract) {
  if (!contract || contract.schema !== FEEDBACK_SCHEMA) throw new Error(`delayed_feedback.schema must be ${FEEDBACK_SCHEMA}.`);
  const required = ['event_id', 'occurred_at', 'anonymous_session_id', 'candidate_id', 'event_type', 'eligible', 'rank_position', 'explanation_state', 'dwell_bucket', 'later_outcome'];
  if (digest(contract.required_fields) !== digest(required)) throw new Error('Delayed-feedback required fields changed.');
  const eventTypes = new Set(contract.event_types || []);
  for (const type of ['impression', 'save', 'hide', 'follow', 'dwell', 'later_outcome']) if (!eventTypes.has(type)) throw new Error(`Delayed-feedback event type ${type} is missing.`);
  const walk = (value, path = 'delayed_feedback') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_FEEDBACK_KEYS.test(key)) throw new Error(`Raw/private field forbidden at ${path}.${key}.`);
      walk(nested, `${path}.${key}`);
    }
  };
  walk(contract);
  return Object.freeze({ schema: contract.schema, required_fields: required, event_types: [...eventTypes].sort(), raw_private_content: false });
}

function validateFixture(fixture) {
  if (!fixture || fixture.schema !== FIXTURE_SCHEMA) throw new Error(`Fixture schema must be ${FIXTURE_SCHEMA}.`);
  if (!Number.isInteger(fixture.seed)) throw new Error('Fixture seed is required and must be an integer.');
  const candidates = Array.isArray(fixture.candidates) ? fixture.candidates : [];
  if (!candidates.length) throw new Error('Fixture candidates are required.');
  const ids = candidates.map(candidate => String(candidate.id || ''));
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('Candidate IDs must be non-empty and unique.');
  if (digest(ids) !== fixture.integrity?.candidate_ids_digest) throw new Error('Candidate set identity does not match the fixture integrity digest.');
  if (digest(candidates) !== fixture.integrity?.candidate_payload_digest) throw new Error('Candidate fixture payload was mutated.');
  const matched = fixture.matched_candidate_ids || [];
  if (digest(matched) !== digest(ids)) throw new Error('Baseline candidate pool does not match the production candidate pool.');
  for (const candidate of candidates) {
    if (!['base', 'lateral'].includes(candidate.family)) throw new Error(`${candidate.id}.family must be base or lateral.`);
    if (candidate.eligible !== true) throw new Error(`${candidate.id} is in the matched pool without eligibility=true.`);
    if (!candidate.source || !candidate.topic || !candidate.duplicateFamily) throw new Error(`${candidate.id} requires source, topic, and duplicateFamily.`);
    for (const field of ALL_NUMERIC_FIELDS) finite(candidate[field], `${candidate.id}.${field}`);
  }
  const size = Number(fixture.slate_size);
  if (!Number.isInteger(size) || size <= 0 || size > candidates.length) throw new Error('slate_size must be a positive integer no larger than the pool.');
  const feedback = validateFeedbackContract(fixture.delayed_feedback);
  if (digest(fixture.delayed_feedback) !== fixture.integrity?.feedback_contract_digest) throw new Error('Delayed-feedback contract was mutated.');
  return Object.freeze({ candidates, ids, size, feedback });
}

function candidateRows(candidates, seed, gate, delta, bound) {
  return candidates.map(candidate => {
    const base = baseScore(candidate);
    const lateral = lateralValue(candidate);
    const familyAdvantage = candidate.family === 'lateral' ? delta : -delta;
    const noise = explorationNoise(seed, candidate.id, bound);
    const score = base + gate * lateral + gate * familyAdvantage + noise;
    if (![base, lateral, familyAdvantage, noise, score].every(Number.isFinite)) throw new Error(`Non-finite score for ${candidate.id}.`);
    return Object.freeze({ ...candidate, base_score: base, lateral_value: lateral, family_advantage: familyAdvantage, exploration_noise: noise, pre_diversity_score: score });
  });
}

function greedySlate(rows, size, penalties) {
  const remaining = [...rows];
  const selected = [];
  while (selected.length < size && remaining.length) {
    const ranked = remaining.map(candidate => {
      const sourceCount = selected.filter(item => item.source === candidate.source).length;
      const topicCount = selected.filter(item => item.topic === candidate.topic).length;
      const duplicateCount = selected.filter(item => item.duplicateFamily === candidate.duplicateFamily).length;
      const diversityPenalty = sourceCount * finite(penalties.same_source, 'diversity.same_source')
        + topicCount * finite(penalties.same_topic, 'diversity.same_topic')
        + duplicateCount * finite(penalties.same_duplicate_family, 'diversity.same_duplicate_family');
      return { ...candidate, diversity_penalty: diversityPenalty, final_score: candidate.pre_diversity_score - diversityPenalty };
    }).sort((left, right) => right.final_score - left.final_score || left.id.localeCompare(right.id));
    const winner = ranked[0];
    selected.push(Object.freeze(winner));
    remaining.splice(remaining.findIndex(item => item.id === winner.id), 1);
  }
  return selected;
}

function metrics(slate) {
  const mean = key => slate.reduce((sum, item) => sum + item[key], 0) / Math.max(1, slate.length);
  return Object.freeze({
    size: slate.length,
    unique_sources: new Set(slate.map(item => item.source)).size,
    unique_topics: new Set(slate.map(item => item.topic)).size,
    mean_base_score: round(mean('base_score')),
    mean_lateral_value: round(mean('lateral_value')),
    mean_final_score: round(mean('final_score')),
    mean_diversity_penalty: round(mean('diversity_penalty'))
  });
}

function runPolicy(fixture, seed, { gate, delta }) {
  const rows = candidateRows(fixture.candidates, seed, gate, delta, fixture.exploration_bound);
  const slate = greedySlate(rows, fixture.slate_size, fixture.diversity_penalties);
  return Object.freeze({ seed, ids: slate.map(item => item.id), metrics: metrics(slate), rows: slate.map(item => ({ id: item.id, base_score: round(item.base_score), lateral_value: round(item.lateral_value), posterior_term: round(gate * item.family_advantage), exploration_noise: round(item.exploration_noise), diversity_penalty: round(item.diversity_penalty), final_score: round(item.final_score) })) });
}

function instability(runs) {
  const pairs = [];
  for (let i = 0; i < runs.length; i += 1) for (let j = i + 1; j < runs.length; j += 1) {
    const a = runs[i].ids;
    const b = runs[j].ids;
    const overlap = a.filter(id => b.includes(id)).length / Math.max(1, new Set([...a, ...b]).size);
    const displacement = a.reduce((sum, id, index) => sum + (b.includes(id) ? Math.abs(index - b.indexOf(id)) : a.length), 0) / Math.max(1, a.length);
    pairs.push({ seeds: [runs[i].seed, runs[j].seed], jaccard: round(overlap), mean_rank_displacement: round(displacement) });
  }
  return Object.freeze({ pairs, max_mean_rank_displacement: round(Math.max(0, ...pairs.map(pair => pair.mean_rank_displacement))), min_jaccard: round(Math.min(1, ...pairs.map(pair => pair.jaccard))) });
}

export function evaluateRankingFixture(fixture, { kernelSources = [] } = {}) {
  const validated = validateFixture(fixture);
  const saturation = deriveSaturationState(fixture.session);
  const gate = deriveGate(fixture.session, saturation);
  const seeds = fixture.replay_seeds || [fixture.seed];
  if (!Array.isArray(seeds) || seeds.length < 2 || seeds.some(seed => !Number.isInteger(seed))) throw new Error('At least two integer replay_seeds are required.');
  const productionRuns = seeds.map(seed => runPolicy(fixture, seed, { gate: gate.gate, delta: gate.delta }));
  const baselineRuns = seeds.map(seed => runPolicy(fixture, seed, { gate: 0, delta: 0 }));
  if (fixture.expected_baseline_ids && digest(baselineRuns[0].ids) !== digest(fixture.expected_baseline_ids)) throw new Error('Baseline mismatch: expected baseline IDs do not match the evaluated kernel baseline.');
  const production = productionRuns[0];
  const baseline = baselineRuns[0];
  const sourceEvidence = kernelSources.map(sourceKernelEvidence);
  if (sourceEvidence.some(evidence => !evidence.ok)) throw new Error('A supplied shipped-kernel source is missing a required load-bearing term.');
  const sourceBinding = sourceEvidence.length >= 2 ? 'root-and-manual' : sourceEvidence.length === 1 ? 'single-shipped-source' : 'pending-build-source-check';
  return Object.freeze({
    schema: RECEIPT_SCHEMA,
    fixture_schema: fixture.schema,
    fixture_digest: digest(fixture),
    source_binding: sourceBinding,
    source_evidence: sourceEvidence,
    candidate_pool: { count: validated.candidates.length, ids_digest: fixture.integrity.candidate_ids_digest, payload_digest: fixture.integrity.candidate_payload_digest, matched_across_policies: true },
    saturation,
    gate: Object.fromEntries(Object.entries(gate).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value])),
    exploration: { seed: fixture.seed, replay_seeds: seeds, bound: fixture.exploration_bound, deterministic: true },
    production,
    matched_baseline: baseline,
    deltas: {
      unique_sources: production.metrics.unique_sources - baseline.metrics.unique_sources,
      unique_topics: production.metrics.unique_topics - baseline.metrics.unique_topics,
      mean_base_score: round(production.metrics.mean_base_score - baseline.metrics.mean_base_score),
      mean_lateral_value: round(production.metrics.mean_lateral_value - baseline.metrics.mean_lateral_value),
      mean_final_score: round(production.metrics.mean_final_score - baseline.metrics.mean_final_score)
    },
    instability: { production: instability(productionRuns), matched_baseline: instability(baselineRuns) },
    delayed_feedback: validated.feedback,
    interpretation: 'Deterministic proxy evaluation of the shipped ranking geometry on a fixed synthetic fixture. It reports utility-proxy, breadth, and replay instability tradeoffs; it does not measure or prove satisfaction, wellbeing, truth, or production outcomes.'
  });
}

async function main() {
  const target = process.argv[2] || 'audit/ranking-evaluation-fixture.json';
  const fixture = JSON.parse(await readFile(target, 'utf8'));
  const sources = [];
  for (const sourcePath of process.argv.slice(3)) sources.push(await readFile(sourcePath, 'utf8'));
  process.stdout.write(`${JSON.stringify(evaluateRankingFixture(fixture, { kernelSources: sources }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
