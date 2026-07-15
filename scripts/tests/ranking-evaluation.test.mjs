import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { baseScore, evaluateRankingFixture, lateralValue } from '../ranking-evaluation.mjs';

const fixture = JSON.parse(await readFile(new URL('../../audit/ranking-evaluation-fixture.json', import.meta.url), 'utf8'));
const result = evaluateRankingFixture(fixture);

test('reference equations match the documented coefficient geometry', () => {
  const candidate = fixture.candidates[0];
  assert.equal(baseScore(candidate), 0.55 * candidate.engagement + 0.30 * candidate.affinity + 0.15 * candidate.relevance);
  assert.ok(Number.isFinite(lateralValue(candidate)));
});

test('saturation fixture trades some base utility for source and topic breadth', () => {
  assert.deepEqual(result.baseline.ids.slice(0, 3), ['a', 'b', 'c']);
  assert.ok(result.deltas.unique_sources > 0);
  assert.ok(result.deltas.unique_topics > 0);
  assert.ok(result.deltas.mean_lateral_value > 0);
  assert.ok(result.deltas.mean_base_score < 0);
});

test('evaluation receipt refuses to become an outcome-science claim', () => {
  assert.equal(result.schema, 'sideways-ranking-evaluation/v1');
  assert.match(result.interpretation, /Synthetic fixture comparison only/);
  assert.doesNotMatch(result.interpretation, /proves wellbeing|proves satisfaction/i);
});
