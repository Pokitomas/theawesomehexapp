import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { baseScore, evaluateRankingFixture, lateralValue } from '../ranking-evaluation.mjs';

const fixture = JSON.parse(await readFile(new URL('../../audit/ranking-evaluation-fixture.json', import.meta.url), 'utf8'));
const math = await readFile(new URL('../../MATH.md', import.meta.url), 'utf8');
const result = evaluateRankingFixture(fixture);

test('reference equations match the documented coefficient geometry', () => {
  const candidate = fixture.candidates[0];
  assert.equal(baseScore(candidate), 0.55 * candidate.engagement + 0.30 * candidate.affinity + 0.15 * candidate.relevance);
  assert.ok(Number.isFinite(lateralValue(candidate)));
  for (const coefficient of ['0.55', '0.30', '0.15', '0.24', '0.19', '0.18', '0.16']) assert.match(math, new RegExp(coefficient.replace('.', '\\.')));
});

test('deterministic saturation geometry trades some base utility for source and topic breadth', () => {
  assert.deepEqual(result.baseline.ids.slice(0, 3), ['a', 'b', 'c']);
  assert.ok(result.deltas.unique_sources > 0);
  assert.ok(result.deltas.unique_topics > 0);
  assert.ok(result.deltas.mean_lateral_value > 0);
  assert.ok(result.deltas.mean_base_score < 0);
});

test('evaluation receipt states every omitted production term and refuses outcome-science claims', () => {
  assert.equal(result.schema, 'sideways-ranking-evaluation/v1');
  assert.match(result.model_scope, /fixed_gate/);
  assert.deepEqual(result.omitted_production_terms, [
    'sampled posterior family advantage U_i',
    'bounded exploration noise eta_i',
    'dynamic saturation load, hysteresis, and gate smoothing',
    'greedy set-diversity reranking',
    'online posterior updates from interaction proxies'
  ]);
  assert.match(result.interpretation, /not a full production-kernel reproduction/);
  assert.doesNotMatch(result.interpretation, /proves wellbeing|proves satisfaction/i);
});
