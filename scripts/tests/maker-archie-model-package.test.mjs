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
  '00-ARCHIE-MODEL/SCAN_ORDER.txt',
  '00-ARCHIE-MODEL/evidence/HOSTED-LINUX-CPU-RSLORA.json'
];

test('model package refuses to promote a deleted historical lane', async () => {
  const [model, status, evidence] = await Promise.all([
    readJson('00-ARCHIE-MODEL/MODEL.json'),
    readJson('00-ARCHIE-MODEL/STATUS.json'),
    readJson('00-ARCHIE-MODEL/evidence/HOSTED-LINUX-CPU-RSLORA.json')
  ]);
  assert.equal(model.canonical, false);
  assert.equal(model.status.promotion, 'not-admitted');
  assert.equal(status.canonical_candidate, false);
  assert.equal(status.retired_lane.status, 'retired');
  assert.equal(evidence.canonical_model_evidence, false);
});

test('package and preserved evidence files exist', async () => {
  await Promise.all(packageFiles.map(path => access(new URL(path, root))));
});

test('historical RSLoRA evidence remains exact and bounded', async () => {
  const evidence = await readJson('00-ARCHIE-MODEL/evidence/HOSTED-LINUX-CPU-RSLORA.json');
  const deep = evidence.runs.find(run => run.lane === 'deep-0.6b');
  const exact = evidence.runs.find(run => run.lane === 'target-1.7b-fast');
  assert.equal(deep.receipt_digest, '177f1f98ae0cb079b90b77d861a25b12e5e60ce3178ea22aa79bb889c24b46a9');
  assert.equal(exact.receipt_digest, '6893194b2343281bed96bfbb995bbb179fbae035e1e58b48d3f96f61224ccda8');
  assert.equal(exact.optimizer_steps, 1);
  assert.equal(evidence.promotion, 'not-admitted');
});

test('benchmark registry stays architecture independent', async () => {
  const benchmarks = await readJson('00-ARCHIE-MODEL/BENCHMARKS.json');
  assert.ok(benchmarks.benchmarks.length >= 7);
  assert.equal(benchmarks.current_result, 'not-yet-run-at-admission-quality');
});
