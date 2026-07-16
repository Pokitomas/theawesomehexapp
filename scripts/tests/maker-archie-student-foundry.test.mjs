import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArchieLinuxCorpus } from '../maker-archie-corpus.mjs';
import {
  ARCHIE_STUDENT_PACK_SCHEMA,
  ARCHIE_STUDENT_TRAINER_SCHEMA,
  ARCHIE_STUDENT_TRAINING_RECEIPT_SCHEMA,
  inspectStudentTrainingPack,
  prepareStudentTrainingPack,
  runStudentTrainer
} from '../archie-student-foundry.mjs';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-student-foundry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function seedCorpus(root) {
  const corpus = createArchieLinuxCorpus({ root, clock: () => '2026-07-16T19:00:00.000Z' });
  for (let index = 0; index < 8; index += 1) {
    await corpus.ingest({
      kind: 'maker_engine_trace',
      subject: 'Pokitomas/theawesomehexapp',
      input: {
        text: `Repair and verify held-out fixture family ${index}.`,
        context: { family: index % 4, authority: 'maker-only' }
      },
      output: {
        text: `Completed fixture ${index}.`,
        plan: { steps: ['inspect', `repair-${index}`, 'verify', 'halt'] }
      },
      tool_trace: [{ tool: 'maker_process', action: 'node', input: { args: [`verify-${index}`] }, output: { exit_code: 0 }, ok: true }],
      outcome: 'completed',
      source: { system: 'test', run_id: `positive-${index}`, teacher: 'teacher-fixture', model: 'teacher-model' },
      tags: ['maker', 'verified', 'positive']
    });
  }
  for (let index = 0; index < 3; index += 1) {
    await corpus.ingest({
      kind: 'maker_engine_trace',
      subject: 'Pokitomas/theawesomehexapp',
      input: { text: `Attempt forbidden deployment fixture ${index}.`, context: { authority: 'human-required' } },
      output: { text: 'No deployment authority.', plan: null },
      outcome: 'rejected',
      source: { system: 'test', run_id: `negative-${index}` },
      tags: ['negative', 'suppress', 'authority']
    });
  }
  return corpus;
}

function sourceSet(rows) {
  return new Set(rows.map(row => row.source_digest));
}

function intersection(left, right) {
  return [...left].filter(value => right.has(value));
}

test('prepares deterministic source-grouped train and held-out packs without leakage', async t => {
  const root = await workspace(t);
  const corpusRoot = path.join(root, 'corpus');
  await seedCorpus(corpusRoot);
  const first = await prepareStudentTrainingPack({
    corpus_root: corpusRoot,
    output_directory: path.join(root, 'pack-one'),
    holdout_rate: 0.5,
    split_salt: 'fixed-heldout-salt',
    clock: () => Date.parse('2026-07-16T19:10:00.000Z')
  });
  const second = await prepareStudentTrainingPack({
    corpus_root: corpusRoot,
    output_directory: path.join(root, 'pack-two'),
    holdout_rate: 0.5,
    split_salt: 'fixed-heldout-salt',
    clock: () => Date.parse('2026-07-16T19:10:00.000Z')
  });
  assert.equal(first.manifest.schema, ARCHIE_STUDENT_PACK_SCHEMA);
  assert.equal(first.manifest.pack_digest, second.manifest.pack_digest);
  assert.equal(first.manifest.files.train.rows > 0, true);
  assert.equal(first.manifest.files.heldout.rows > 0, true);
  assert.equal(first.manifest.files.negative_train.rows + first.manifest.files.negative_heldout.rows, 3);

  const inspected = await inspectStudentTrainingPack(path.join(root, 'pack-one'));
  const trainSources = sourceSet(inspected.partitions.train.rows);
  const heldoutSources = sourceSet(inspected.partitions.heldout.rows);
  assert.deepEqual(intersection(trainSources, heldoutSources), []);
  assert.equal(inspected.partitions.train.rows.every(row => row.schema === 'archie-student-supervised-example/v1'), true);
  assert.equal(inspected.partitions.negative_train.rows.concat(inspected.partitions.negative_heldout.rows).every(row => row.schema === 'archie-student-negative-example/v1'), true);

  await fs.appendFile(inspected.partitions.train.filename, '{"tampered":true}\n');
  await assert.rejects(inspectStudentTrainingPack(path.join(root, 'pack-one')), /byte mismatch|digest mismatch|row-count mismatch/);
});

async function writeFixtureTrainer(root) {
  const filename = path.join(root, 'fixture-trainer.mjs');
  await fs.writeFile(filename, `import fs from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1] || '';
if (args.includes('--fail')) { process.stderr.write('forced trainer failure\\n'); process.exit(3); }
const train = (await fs.readFile(value('--train'), 'utf8')).trim().split(/\\r?\\n/).filter(Boolean);
const heldout = (await fs.readFile(value('--heldout'), 'utf8')).trim().split(/\\r?\\n/).filter(Boolean);
const output = value('--output-dir');
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'student.gguf'), Buffer.from(JSON.stringify({ base: value('--base'), seed: value('--seed'), trained: train.length })));
await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify({ heldout_examples: heldout.length, heldout_success_rate: heldout.length ? 0.75 : 0, optimizer_steps: train.length }));
process.stdout.write(JSON.stringify({ trained: train.length, heldout: heldout.length }) + '\\n');
`);
  return filename;
}

function trainerConfig(script, extraArgs = []) {
  return {
    schema: ARCHIE_STUDENT_TRAINER_SCHEMA,
    program: 'node',
    args: [
      script,
      '--train', '{train_jsonl}',
      '--heldout', '{heldout_jsonl}',
      '--negative-train', '{negative_train_jsonl}',
      '--negative-heldout', '{negative_heldout_jsonl}',
      '--output-dir', '{output_dir}',
      '--base', '{base_model_id}',
      '--seed', '{seed}',
      ...extraArgs
    ],
    base_model: { id: 'open-student-base', digest: 'a'.repeat(64) },
    output_artifact: 'student.gguf',
    metrics_file: 'metrics.json',
    seed: 17,
    timeout_ms: 30_000,
    optimizer: { name: 'fixture-adapter', learning_rate: 0.0002, epochs: 1 },
    teacher_ids: ['teacher-fixture']
  };
}

test('runs an allowlisted local trainer and emits artifact, evaluation, and lineage digests', async t => {
  const root = await workspace(t);
  const corpusRoot = path.join(root, 'corpus');
  await seedCorpus(corpusRoot);
  const packDirectory = path.join(root, 'pack');
  await prepareStudentTrainingPack({
    corpus_root: corpusRoot,
    output_directory: packDirectory,
    holdout_rate: 0.5,
    split_salt: 'trainer-pack-salt',
    clock: () => Date.parse('2026-07-16T19:20:00.000Z')
  });
  const script = await writeFixtureTrainer(root);
  let tick = 0;
  const result = await runStudentTrainer({
    pack_directory: packDirectory,
    trainer: trainerConfig(script),
    output_directory: path.join(root, 'trained'),
    clock_ms: () => Date.parse('2026-07-16T19:30:00.000Z') + tick++ * 250
  });
  assert.equal(result.receipt.schema, ARCHIE_STUDENT_TRAINING_RECEIPT_SCHEMA);
  assert.equal(result.receipt.status, 'completed');
  assert.equal(result.receipt.result.ok, true);
  assert.equal(result.receipt.duration_ms, 250);
  assert.match(result.receipt.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.receipt.evaluation_receipt_digest, /^[a-f0-9]{64}$/);
  assert.match(result.receipt.training_data_digest, /^[a-f0-9]{64}$/);
  assert.match(result.receipt.training_config_digest, /^[a-f0-9]{64}$/);
  assert.match(result.receipt.optimizer_digest, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.base_model.id, 'open-student-base');
  assert.equal(result.receipt.metrics.value.heldout_examples > 0, true);
  assert.equal((await fs.stat(result.artifact_path)).size > 0, true);
  assert.equal(JSON.stringify(result).includes('OPENAI_API_KEY'), false);
  assert.equal(JSON.parse(await fs.readFile(result.receipt_path, 'utf8')).receipt_digest, result.receipt.receipt_digest);
});

test('preserves failed trainer attempts and rejects secrets or unsupported placeholders', async t => {
  const root = await workspace(t);
  const corpusRoot = path.join(root, 'corpus');
  await seedCorpus(corpusRoot);
  const packDirectory = path.join(root, 'pack');
  await prepareStudentTrainingPack({
    corpus_root: corpusRoot,
    output_directory: packDirectory,
    holdout_rate: 0.5,
    split_salt: 'failure-pack-salt',
    clock: () => Date.parse('2026-07-16T19:40:00.000Z')
  });
  const script = await writeFixtureTrainer(root);
  let failedTrainingError;
  await assert.rejects(runStudentTrainer({
    pack_directory: packDirectory,
    trainer: trainerConfig(script, ['--fail']),
    output_directory: path.join(root, 'failed-training'),
    clock_ms: (() => {
      let tick = 0;
      return () => Date.parse('2026-07-16T19:50:00.000Z') + tick++ * 100;
    })()
  }), error => {
    failedTrainingError = error;
    assert.match(error.message, /exit code 3/);
    assert.equal(error.training_receipt.status, 'failed');
    assert.equal(error.training_receipt.result.ok, false);
    assert.equal(error.training_receipt.artifact, null);
    assert.match(error.training_receipt.receipt_digest, /^[a-f0-9]{64}$/);
    return true;
  });
  assert.equal((await fs.stat(failedTrainingError.training_receipt_path)).isFile(), true);

  const secret = trainerConfig(script);
  secret.api_key = 'sk-12345678901234567890';
  await assert.rejects(runStudentTrainer({
    pack_directory: packDirectory,
    trainer: secret,
    output_directory: path.join(root, 'secret-training')
  }), /secret-like|secret or private-key/);

  const placeholder = trainerConfig(script);
  placeholder.args.push('{unknown_path}');
  await assert.rejects(runStudentTrainer({
    pack_directory: packDirectory,
    trainer: placeholder,
    output_directory: path.join(root, 'placeholder-training')
  }), /Unsupported trainer placeholder/);
});
