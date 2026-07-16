import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  ARCHIE_CANDIDATE_RESULTS_SCHEMA,
  createArchieBenchmarkPromptPack,
  runArchieEquivalenceBenchmark,
  scoreArchieCandidateResults
} from '../maker-archie-benchmark.mjs';

const suiteURL = new URL('../../maker/evaluations/archie-equivalence-suite.json', import.meta.url);

async function suite() {
  return JSON.parse(await fs.readFile(suiteURL, 'utf8'));
}

test('runs the sequential substitution benchmark with adaptation, safety, and retention receipts', async () => {
  const result = await runArchieEquivalenceBenchmark({ suite: await suite(), clock: () => '2026-07-16T06:30:00.000Z' });
  assert.equal(result.candidate.schema, ARCHIE_CANDIDATE_RESULTS_SCHEMA);
  assert.equal(result.report.schema, 'archie-equivalence-report/v1');
  assert.equal(result.report.counts.episodes, 21);
  assert.equal(result.report.metrics.one_shot_adaptation_rate, 1);
  assert.equal(result.report.metrics.safety_rejection_rate, 1);
  assert.equal(result.report.metrics.retention_rate, 1);
  assert.equal(result.report.equivalence_score, 92.22);
  assert.equal(result.report.benchmark_scope, 'declared-suite-controlled-substitution');
  assert.equal(result.report.comparison_status, 'named-model-unmeasured');
  assert.equal(result.report.publication_eligible_as_named_model_equivalence, false);
  assert.equal(result.report.counts.successes, 19);
  assert.deepEqual(result.report.episodes.filter(item => !item.success).map(item => item.episode_id), [
    'heldout-safe-negative-mention',
    'heldout-near-neighbor-bike'
  ]);
  assert.match(result.report.report_digest, /^[a-f0-9]{64}$/);
  assert.equal(result.report.named_model_equivalence, 'unmeasured-until-the-same-suite-is-run-through-that-model');
});

test('scores arbitrary LLM or agent result files through the identical executable contract', async () => {
  const benchmark = await suite();
  const perfect = {
    schema: ARCHIE_CANDIDATE_RESULTS_SCHEMA,
    candidate_id: 'external-model-fixture',
    candidate_role: 'teacher-model',
    results: benchmark.episodes.map(episode => ({
      episode_id: episode.id,
      state: episode.expected_state === 'reject' ? 'reject' : 'local',
      tool_trace: (episode.reference_actions || []).map(value => {
        const [tool, action] = value.split(':');
        return { tool, action, ok: true };
      })
    }))
  };
  const report = scoreArchieCandidateResults(benchmark, perfect, { candidate_id: perfect.candidate_id });
  assert.equal(report.equivalence_score, 100);
  assert.equal(report.metrics.task_success_rate, 1);
  assert.equal(report.metrics.local_teacher_replacement_rate, null);
  assert.equal(report.metrics.direct_task_capability_rate, 1);
});


test('exports a leakage-minimized prompt pack for running named language models on the same tasks', async () => {
  const pack = createArchieBenchmarkPromptPack(await suite());
  assert.equal(pack.schema, 'archie-benchmark-prompt-pack/v1');
  assert.equal(pack.candidate_role, 'teacher-model');
  assert.equal(pack.episodes.length, 21);
  const serialized = JSON.stringify(pack);
  assert.ok(!serialized.includes('expected_state'));
  assert.ok(!serialized.includes('reference_actions'));
  assert.ok(!serialized.includes('teacher_fixture'));
  assert.match(pack.prompt_pack_digest, /^[a-f0-9]{64}$/);
});

test('ships a benchmark contract covering suites, candidate outputs, reports, and prompt packs', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../../maker/contracts/archie-benchmark.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$id, 'https://theawesomehexapp.local/maker/contracts/archie-benchmark.schema.json');
  const refs = new Set(schema.oneOf.map(item => item.$ref));
  for (const name of ['suite', 'candidateResults', 'report', 'promptPack']) assert.ok(refs.has(`#/$defs/${name}`));
  assert.deepEqual(schema.$defs.candidateResults.properties.candidate_role.enum, ['substitution-system', 'teacher-model']);
});
