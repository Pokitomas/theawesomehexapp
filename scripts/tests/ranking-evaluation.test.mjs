import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  FEEDBACK_SCHEMA,
  FIXTURE_SCHEMA,
  baseScore,
  deriveGate,
  deriveSaturationState,
  digest,
  evaluateRankingFixture,
  explorationNoise,
  lateralValue,
  sourceKernelEvidence
} from '../ranking-evaluation.mjs';

const fixture = JSON.parse(await readFile(new URL('../../audit/ranking-evaluation-fixture.json', import.meta.url), 'utf8'));
const result = evaluateRankingFixture(fixture);
const shippedSource = `
const baseScore=.55*post.base+.30*f.affinity+.15*post.relevance;
const lateralValue=.24*f.sameWhyDifferentAxis+.15*f.sourceNovelty+.12*f.viewpointGap+.19*f.context+.18*f.motive+.06*f.place+.06*f.topicDistance-.16*f.duplicateRisk-.15*f.graphicRepeat;
const posteriorChoice=sigmoid(4.2*delta+1.15*(maxZ-.85));
const riskFloor=clamp((maxZ-.55)/2.8,0,.43);
let target=riskFloor+.54*posteriorChoice;
if(state==='deep_saturation')target=Math.max(target,.48);
`;

test('fixture integrity, candidate identity, and matched baseline are fail-closed', () => {
  assert.equal(fixture.schema, FIXTURE_SCHEMA);
  assert.equal(digest(fixture.candidates.map(candidate => candidate.id)), fixture.integrity.candidate_ids_digest);
  assert.equal(digest(fixture.candidates), fixture.integrity.candidate_payload_digest);
  assert.equal(digest(fixture.delayed_feedback), fixture.integrity.feedback_contract_digest);
  assert.deepEqual(result.matched_baseline.ids, fixture.expected_baseline_ids);
  assert.equal(result.candidate_pool.matched_across_policies, true);
  const mutated = structuredClone(fixture);
  mutated.candidates[0].engagement += 0.01;
  assert.throws(() => evaluateRankingFixture(mutated), /fixture payload was mutated/);
  const mismatched = structuredClone(fixture);
  mismatched.matched_candidate_ids.pop();
  assert.throws(() => evaluateRankingFixture(mismatched), /Baseline candidate pool does not match/);
});

test('documented base and lateral equations are represented exactly', () => {
  const candidate = fixture.candidates[0];
  assert.equal(baseScore(candidate), 0.55 * candidate.engagement + 0.30 * candidate.affinity + 0.15 * candidate.relevance);
  assert.equal(lateralValue(candidate), 0.24 * candidate.axisDistance + 0.15 * candidate.sourceNovelty + 0.12 * candidate.viewpointGap + 0.19 * candidate.context + 0.18 * candidate.motive + 0.06 * candidate.place + 0.06 * candidate.topicDistance - 0.16 * candidate.duplicateRisk - 0.15 * candidate.graphicRisk);
});

test('dynamic saturation, posterior gate, smoothing, and deep-saturation floor are deterministic', () => {
  const saturation = deriveSaturationState(fixture.session);
  const gate = deriveGate(fixture.session, saturation);
  assert.equal(saturation.state, 'saturation');
  assert.equal(saturation.enter, true);
  assert.equal(saturation.exit, false);
  assert.ok(gate.gate >= 0.08 && gate.gate <= 0.88);
  assert.ok(gate.target >= gate.riskFloor);
  assert.equal(gate.delta, fixture.session.posterior_sample_lateral - fixture.session.posterior_sample_base);
  const deepSession = { ...fixture.session, previous_state: 'saturation', lateral_rejections: 5 };
  const deep = deriveGate(deepSession, deriveSaturationState(deepSession));
  assert.equal(deep.state, 'deep_saturation');
  assert.ok(deep.target >= 0.48);
});

test('bounded exploration is seeded, replayable, and rejects missing seeds', () => {
  const first = explorationNoise(fixture.seed, 'a', fixture.exploration_bound);
  const second = explorationNoise(fixture.seed, 'a', fixture.exploration_bound);
  assert.equal(first, second);
  assert.ok(Math.abs(first) <= fixture.exploration_bound);
  assert.notEqual(first, explorationNoise(fixture.seed + 1, 'a', fixture.exploration_bound));
  assert.throws(() => explorationNoise(undefined, 'a', fixture.exploration_bound), /explicit integer exploration seed/);
});

test('production and matched baseline report utility, breadth, and replay instability without outcome claims', () => {
  assert.equal(result.schema, 'sideways-ranking-evaluation/v2');
  assert.equal(result.source_binding, 'pending-build-source-check');
  assert.ok(result.production.metrics.unique_sources >= 1);
  assert.ok(result.production.metrics.unique_topics >= 1);
  assert.ok(result.deltas.mean_lateral_value > 0);
  assert.ok(result.deltas.mean_base_score < 0);
  assert.ok(Number.isFinite(result.instability.production.max_mean_rank_displacement));
  assert.match(result.interpretation, /does not measure or prove satisfaction, wellbeing, truth, or production outcomes/);
});

test('actual root/manual source binding requires every load-bearing source marker', () => {
  assert.equal(sourceKernelEvidence(shippedSource).ok, true);
  const bound = evaluateRankingFixture(fixture, { kernelSources: [shippedSource, shippedSource] });
  assert.equal(bound.source_binding, 'root-and-manual');
  assert.equal(bound.source_evidence.length, 2);
  assert.throws(() => evaluateRankingFixture(fixture, { kernelSources: ['const baseScore=0;'] }), /missing a required load-bearing term/);
});

test('delayed-feedback contract contains required events and forbids raw private content', () => {
  assert.equal(result.delayed_feedback.schema, FEEDBACK_SCHEMA);
  for (const type of ['impression', 'save', 'hide', 'follow', 'dwell', 'later_outcome']) assert.ok(result.delayed_feedback.event_types.includes(type));
  assert.equal(result.delayed_feedback.raw_private_content, false);
  const bad = structuredClone(fixture);
  bad.delayed_feedback.raw_content = 'forbidden';
  bad.integrity.feedback_contract_digest = digest(bad.delayed_feedback);
  assert.throws(() => evaluateRankingFixture(bad), /Raw\/private field forbidden/);
});

test('nonfinite scores and baseline mismatches fail closed', () => {
  const nonfinite = structuredClone(fixture);
  nonfinite.candidates[0].engagement = 'NaN';
  nonfinite.integrity.candidate_payload_digest = digest(nonfinite.candidates);
  assert.throws(() => evaluateRankingFixture(nonfinite), /must be finite/);
  const mismatch = structuredClone(fixture);
  mismatch.expected_baseline_ids = ['wrong'];
  assert.throws(() => evaluateRankingFixture(mismatch), /Baseline mismatch/);
});
