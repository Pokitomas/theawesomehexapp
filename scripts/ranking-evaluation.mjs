#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function baseScore(candidate) {
  return 0.55 * candidate.engagement + 0.30 * candidate.affinity + 0.15 * candidate.relevance;
}

export function lateralValue(candidate) {
  return 0.24 * candidate.axisDistance
    + 0.15 * candidate.sourceNovelty
    + 0.12 * candidate.viewpointGap
    + 0.19 * candidate.context
    + 0.18 * candidate.motive
    + 0.06 * candidate.place
    + 0.06 * candidate.topicDistance
    - 0.16 * candidate.duplicateRisk
    - 0.15 * candidate.graphicRisk;
}

function ranked(candidates, score) {
  return [...candidates]
    .map(candidate => ({ ...candidate, base_score: baseScore(candidate), lateral_value: lateralValue(candidate), score: score(candidate) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function metrics(slate) {
  const sources = new Set(slate.map(item => item.source));
  const topics = new Set(slate.map(item => item.topic));
  const mean = key => slate.reduce((sum, item) => sum + item[key], 0) / Math.max(1, slate.length);
  return {
    size: slate.length,
    unique_sources: sources.size,
    unique_topics: topics.size,
    mean_base_score: mean('base_score'),
    mean_lateral_value: mean('lateral_value')
  };
}

export function evaluateRankingFixture(fixture) {
  const candidates = fixture.candidates || [];
  const size = Number(fixture.slate_size || 4);
  const gate = Number(fixture.gate || 0);
  const baseline = ranked(candidates, candidate => baseScore(candidate)).slice(0, size);
  const saturation = ranked(candidates, candidate => baseScore(candidate) + gate * lateralValue(candidate)).slice(0, size);
  const baselineMetrics = metrics(baseline);
  const saturationMetrics = metrics(saturation);
  return {
    schema: 'sideways-ranking-evaluation/v1',
    fixture_schema: fixture.schema,
    gate,
    model_scope: 'deterministic B_i + fixed_gate * V_i comparison',
    omitted_production_terms: [
      'sampled posterior family advantage U_i',
      'bounded exploration noise eta_i',
      'dynamic saturation load, hysteresis, and gate smoothing',
      'greedy set-diversity reranking',
      'online posterior updates from interaction proxies'
    ],
    baseline: { ids: baseline.map(item => item.id), metrics: baselineMetrics },
    saturation: { ids: saturation.map(item => item.id), metrics: saturationMetrics },
    deltas: {
      unique_sources: saturationMetrics.unique_sources - baselineMetrics.unique_sources,
      unique_topics: saturationMetrics.unique_topics - baselineMetrics.unique_topics,
      mean_base_score: saturationMetrics.mean_base_score - baselineMetrics.mean_base_score,
      mean_lateral_value: saturationMetrics.mean_lateral_value - baselineMetrics.mean_lateral_value
    },
    interpretation: 'Synthetic deterministic geometry comparison only; not a full production-kernel reproduction and not user satisfaction, wellbeing, or production outcome evidence.'
  };
}

async function main() {
  const target = process.argv[2] || 'audit/ranking-evaluation-fixture.json';
  const fixture = JSON.parse(await readFile(target, 'utf8'));
  console.log(JSON.stringify(evaluateRankingFixture(fixture), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
