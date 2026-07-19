import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../..', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const readJson = async path => JSON.parse(await read(path));

const packageFiles = [
  '00-ARCHIE-MODEL/README.md',
  '00-ARCHIE-MODEL/MODEL.json',
  '00-ARCHIE-MODEL/STATUS.json',
  '00-ARCHIE-MODEL/ARCHITECTURE.md',
  '00-ARCHIE-MODEL/BENCHMARKS.json',
  '00-ARCHIE-MODEL/BENCHMARKS.md',
  '00-ARCHIE-MODEL/RUNBOOK.md',
  '00-ARCHIE-MODEL/SCAN_ORDER.txt'
];

test('root and package identify one canonical Archie model', async () => {
  const [rootReadme, packageReadme, model, status, benchmarks] = await Promise.all([
    read('README.md'),
    read('00-ARCHIE-MODEL/README.md'),
    readJson('00-ARCHIE-MODEL/MODEL.json'),
    readJson('00-ARCHIE-MODEL/STATUS.json'),
    readJson('00-ARCHIE-MODEL/BENCHMARKS.json')
  ]);

  assert.match(rootReadme, /^# Archie Model/m);
  assert.match(rootReadme, /begin with \[`00-ARCHIE-MODEL\/`\]/);
  assert.match(packageReadme, /first directory an AI or human should inspect/);

  assert.equal(model.canonical, true);
  assert.equal(model.model_id, 'archie-qwen3-1.7b-information-budgeted-rslora-v1');
  assert.equal(model.base_model.repository, 'Qwen/Qwen3-1.7B');
  assert.equal(model.training.method, 'information-budgeted-causal-fork-rslora/v1');
  assert.equal(model.training.adapter.rank, 32);
  assert.equal(model.training.adapter.specialists, 2);
  assert.equal(model.training.fusion.maximum_rank, 64);

  assert.equal(status.model_id, model.model_id);
  assert.equal(status.promotion, 'not-admitted');
  assert.equal(benchmarks.current_result, 'not-yet-run-at-admission-quality');
});

test('canonical package files and implementation paths exist', async () => {
  const model = await readJson('00-ARCHIE-MODEL/MODEL.json');
  const paths = [...packageFiles, ...Object.values(model.canonical_paths)];
  await Promise.all(paths.map(path => access(new URL(path, root))));
});

test('model package preserves missing empirical evidence as missing', async () => {
  const [model, status, benchmarks, scanOrder] = await Promise.all([
    readJson('00-ARCHIE-MODEL/MODEL.json'),
    readJson('00-ARCHIE-MODEL/STATUS.json'),
    readJson('00-ARCHIE-MODEL/BENCHMARKS.json'),
    read('00-ARCHIE-MODEL/SCAN_ORDER.txt')
  ]);

  assert.equal(model.status.promotion, 'not-admitted');
  assert.equal(model.status.empirical_capability_claim, 'none');

  for (const key of [
    'canonical_cuda_gradient_run',
    'changed_archie_adapter_tensors',
    'held_out_quality_gain',
    'compute_quality_pareto_gain',
    'fused_candidate_gain',
    'quantization_retention',
    'independent_reproduction'
  ]) {
    assert.equal(status.observed_evidence[key].status, 'not-established-in-repository', key);
    assert.equal(status.observed_evidence[key].required, true, key);
  }

  assert.ok(Array.isArray(benchmarks.benchmarks));
  assert.ok(benchmarks.benchmarks.length >= 7);
  assert.match(scanOrder, /MODEL\.json/);
  assert.match(scanOrder, /Older experiments do not supersede MODEL\.json/);
});
