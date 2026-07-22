import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  brainPackageInputFromTraining,
  compileArchieTrainingPlan,
  createStudentTrainingReceipt,
  verifyArchieTrainingPlan,
  verifyStudentTrainingReceipt
} from '../archie-training-compiler.mjs';
import { createArchieCheckpoint, createArchieStateContract } from '../archie-model-contract.mjs';
import { createTrajectoryBatch, normalizeArchieTrajectory } from '../archie-trajectory.mjs';
import { compileFromConfig } from '../../../scripts/archie-training-compile.mjs';

const stable = value => JSON.stringify(value, Object.keys(value || {}).sort());
const sha = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
const git = value => sha(value).slice(0, 40);

const profile = Object.freeze({
  schema: 'archie-distill-profile/v1',
  id: 'fixture',
  claim_boundary: 'test fixture',
  student: {
    model_id: 'fixture/student',
    revision: git('student-revision'),
    trust_remote_code: false,
    dtype: 'bfloat16',
    attention_implementation: 'sdpa',
    device_map: 'auto'
  },
  training: {
    seed: 42,
    holdout_rate: 0.25,
    epochs: 1,
    max_steps: 2
  }
});

function stateContract() {
  return createArchieStateContract({
    runtime_abi: 'archie-runtime/v1',
    architecture: 'dense-transformer-plus-symbolic-control',
    architecture_config: { layers: 2, hidden_size: 64 },
    axioms: { maker_is_only_effect_executor: true, evidence_bound_promotion: true },
    authority: { external_writes_require_grant: true },
    state_schema: 'archie-learned-state/v1',
    allowed_learning_operations: ['adapter-update', 'calibration-update', 'negative-memory-append'],
    mutable_state: {
      parameters_digest: sha('base-parameters'),
      sparse_state_digest: sha('sparse'),
      graph_state_digest: sha('graph'),
      routing_weights_digest: sha('routing'),
      action_transition_digest: sha('actions'),
      uncertainty_calibration_digest: sha('calibration'),
      negative_lessons_digest: sha('negative')
    }
  });
}

function sidepusFixture() {
  const selected = [
    { document_id: 'doc-a', object_digest: sha('alpha reasoning corpus'), measurement_digest: sha('measurement-a') },
    { document_id: 'doc-b', object_digest: sha('beta factual corpus'), measurement_digest: sha('measurement-b') }
  ];
  const manifest = {
    schema: 'sidepus-diet-manifest/v1',
    manifest_digest: sha('sidepus-manifest'),
    selected
  };
  const rows = [
    { text: 'alpha reasoning corpus', document_id: 'doc-a', source: { source_id: 'source-a' }, selection: selected[0] },
    { text: 'beta factual corpus', document_id: 'doc-b', source: { source_id: 'source-b' }, selection: selected[1] }
  ];
  const exportBytes = Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  return {
    manifest,
    manifest_file_sha256: sha(Buffer.from(JSON.stringify(manifest))),
    export_receipt: {
      schema: 'sidepus-export-receipt/v1',
      manifest_digest: manifest.manifest_digest,
      sha256: sha(exportBytes),
      bytes: exportBytes.length,
      documents: rows.length,
      receipt_digest: sha('sidepus-export-receipt')
    },
    export_bytes: exportBytes
  };
}

function trajectory(request, { negative = false, suffix = '' } = {}) {
  return normalizeArchieTrajectory({
    subject: `fixture${suffix}`,
    request,
    provenance: {
      repository: 'Pokitomas/fixture',
      branch: 'main',
      base_sha: git(`base${suffix}`),
      head_sha: git(`head${suffix}`),
      code_commit: git(`head${suffix}`),
      request_digest: sha(request),
      plan_digest: sha(`plan${suffix}`),
      patch_digest: sha(`patch${suffix}`),
      authority_digest: sha(`authority${suffix}`),
      environment_digest: sha(`environment${suffix}`)
    },
    events: [
      { sequence: 1, type: 'request', payload: { request } },
      { sequence: 2, type: 'plan', payload: { steps: ['inspect', 'edit', 'verify'] } },
      { sequence: 3, type: negative ? 'correction' : 'tool-result', payload: { status: negative ? 'failed' : 'completed' } },
      { sequence: 4, type: 'outcome', payload: { status: negative ? 'failed' : 'completed' } }
    ],
    verification: [{
      verifier: 'independent-fixture-verifier',
      status: 'passed',
      independent: true,
      evidence_digest: sha(`verification${suffix}`)
    }],
    outcome: {
      status: negative ? 'failed' : 'completed',
      negative,
      summary: negative ? 'Known failing approach.' : 'Verified completion.'
    }
  });
}

function trajectoryBatch() {
  return createTrajectoryBatch([
    trajectory('Implement the verified change.', { suffix: '-positive' }),
    trajectory('Avoid the known failing approach.', { negative: true, suffix: '-negative' })
  ]);
}

function compiled(overrides = {}) {
  return compileArchieTrainingPlan({
    profile,
    state_contract: stateContract(),
    sidepus: [sidepusFixture()],
    trajectory_batches: [trajectoryBatch()],
    code_commit: git('compiler-code'),
    ...overrides
  });
}

function checkpointFor(plan, overrides = {}) {
  return createArchieCheckpoint({
    model_id: 'fixture-student',
    version: '0.1.0',
    manifest_digest: sha('signed-runtime-manifest'),
    runtime_abi: plan.state_contract.runtime_abi,
    immutable_digest: plan.state_contract.immutable_digest,
    mutable_state: { parameters_digest: sha('trained-parameters') },
    training: {
      code_commit: plan.code_commit,
      dataset_digests: Object.values(plan.datasets).map(item => item.sha256),
      trajectory_batch_digests: plan.inputs.trajectories.map(item => item.batch_digest),
      teacher_ids: ['teacher-a'],
      teacher_model_ids: ['teacher-model-a'],
      seed: 42,
      optimizer: { name: 'adamw' },
      config: { epochs: 1 }
    },
    benchmark_receipt_digests: [sha('development-benchmark')],
    ...overrides
  });
}

test('compilation is deterministic and emits every required dataset lane', () => {
  const first = compiled();
  const second = compiled();
  assert.deepEqual(first, second);
  assert.equal(verifyArchieTrainingPlan(first.plan), first.plan.plan_digest);
  const development = first.files['datasets/development-holdout.jsonl']
    .split(/\n/).filter(Boolean).map(JSON.parse);
  assert.equal(
    first.plan.counts.pretrain
      + development.filter(item => item.kind === 'continued-pretraining').length,
    2
  );
  assert.equal(first.plan.counts.supervised, 1);
  assert.equal(first.plan.counts.negative, 1);
  assert.ok(first.files['datasets/pretrain.train.jsonl']);
  assert.ok(first.files['datasets/sft.train.jsonl']);
  assert.ok(first.files['datasets/negative.train.jsonl']);
  assert.ok(Object.hasOwn(first.files, 'datasets/development-holdout.jsonl'));
  assert.equal(first.plan.development_evaluation.promotion_eligible, false);
  assert.equal(first.plan.development_evaluation.independent_hidden_evaluation_still_required, true);
});

test('Sidepus export tampering fails against exact receipt and object digests', () => {
  const source = sidepusFixture();
  source.export_bytes = Buffer.from(source.export_bytes.toString('utf8').replace('alpha reasoning corpus', 'tampered corpus'));
  assert.throws(() => compileArchieTrainingPlan({
    profile,
    state_contract: stateContract(),
    sidepus: [source],
    code_commit: git('compiler-code')
  }), /export bytes do not match|text bytes do not match/);
});

test('negative trajectories never enter supervised fine-tuning targets', () => {
  const result = compiled({ sidepus: [] });
  const supervised = result.files['datasets/sft.train.jsonl'].split(/\n/).filter(Boolean).map(JSON.parse);
  const negative = result.files['datasets/negative.train.jsonl'].split(/\n/).filter(Boolean).map(JSON.parse);
  assert.equal(supervised.length, 1);
  assert.equal(negative.length, 1);
  assert.equal(supervised[0].kind, 'supervised-distillation');
  assert.equal(negative[0].kind, 'negative-suppression');
  assert.equal(negative[0].target, null);
});

test('training receipt and persistent Trainer package remain bound to plan and checkpoint', () => {
  const result = compiled();
  const checkpoint = checkpointFor(result.plan);
  const trainingReceipt = createStudentTrainingReceipt({
    plan: result.plan,
    checkpoint,
    artifact: {
      path: 'student.gguf',
      sha256: sha('student-artifact'),
      bytes: 4096,
      format: 'gguf',
      model_id: 'fixture-student',
      checkpoint_id: 'fixture-checkpoint'
    },
    metrics: { training_loss: 0.25 },
    trainer: { implementation: 'fixture' }
  });
  assert.equal(verifyStudentTrainingReceipt(trainingReceipt), trainingReceipt.receipt_digest);
  assert.equal(trainingReceipt.promotion, 'not-admitted');
  const packageInput = brainPackageInputFromTraining({
    plan: result.plan,
    checkpoint,
    training_receipt: trainingReceipt,
    tokenizer: { id: 'fixture-tokenizer' },
    architecture: { family: 'fixture' }
  });
  assert.equal(packageInput.sidepus_manifest_digests[0], result.plan.inputs.sidepus[0].manifest_digest);
  assert.equal(packageInput.artifacts.length, 3);
  assert.equal(packageInput.metadata.plan_digest, result.plan.plan_digest);
});

test('CLI atomically creates a self-indexed workspace and refuses overwrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archie-training-compiler-'));
  try {
    const source = sidepusFixture();
    const state = stateContract();
    const batch = trajectoryBatch();
    fs.writeFileSync(path.join(root, 'profile.json'), `${JSON.stringify(profile)}\n`);
    fs.writeFileSync(path.join(root, 'state.json'), `${JSON.stringify(state)}\n`);
    fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(source.manifest)}\n`);
    fs.writeFileSync(path.join(root, 'export-receipt.json'), `${JSON.stringify(source.export_receipt)}\n`);
    fs.writeFileSync(path.join(root, 'export.jsonl'), source.export_bytes);
    fs.writeFileSync(path.join(root, 'trajectory-batch.json'), `${JSON.stringify(batch)}\n`);
    fs.writeFileSync(path.join(root, 'config.json'), `${JSON.stringify({
      profile: './profile.json',
      state_contract: './state.json',
      sidepus: [{ manifest: './manifest.json', export_receipt: './export-receipt.json', export_jsonl: './export.jsonl' }],
      trajectory_batches: ['./trajectory-batch.json'],
      code_commit: git('compiler-code')
    })}\n`);
    const destination = path.join(root, 'workspace');
    const receipt = compileFromConfig(path.join(root, 'config.json'), destination);
    assert.equal(receipt.schema, 'archie-training-input-receipt/v1');
    assert.ok(fs.existsSync(path.join(destination, 'training-plan.json')));
    assert.ok(fs.existsSync(path.join(destination, 'input-receipt.json')));
    assert.ok(fs.existsSync(path.join(destination, 'inputs', 'source-index.json')));
    assert.ok(fs.existsSync(path.join(destination, 'datasets', 'sft.train.jsonl')));
    const storedReceipt = JSON.parse(fs.readFileSync(path.join(destination, 'input-receipt.json'), 'utf8'));
    assert.equal(storedReceipt.receipt_digest, receipt.receipt_digest);
    assert.throws(() => compileFromConfig(path.join(root, 'config.json'), destination), /Refusing to overwrite/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('group-wise development split never leaks one Sidepus source across train and holdout', () => {
  const source = sidepusFixture();
  source.manifest.selected = [
    { document_id: 'doc-a', object_digest: sha('alpha one'), measurement_digest: sha('measurement-a') },
    { document_id: 'doc-b', object_digest: sha('alpha two'), measurement_digest: sha('measurement-b') },
    { document_id: 'doc-c', object_digest: sha('alpha three'), measurement_digest: sha('measurement-c') }
  ];
  const rows = [
    { text: 'alpha one', document_id: 'doc-a', source: { source_id: 'same-source' }, selection: source.manifest.selected[0] },
    { text: 'alpha two', document_id: 'doc-b', source: { source_id: 'same-source' }, selection: source.manifest.selected[1] },
    { text: 'alpha three', document_id: 'doc-c', source: { source_id: 'same-source' }, selection: source.manifest.selected[2] }
  ];
  source.export_bytes = Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  source.export_receipt = {
    ...source.export_receipt,
    sha256: sha(source.export_bytes),
    bytes: source.export_bytes.length,
    documents: 3
  };
  const result = compileArchieTrainingPlan({
    profile: { ...profile, training: { ...profile.training, holdout_rate: 0.99 } },
    state_contract: stateContract(),
    sidepus: [source],
    code_commit: git('compiler-code')
  });
  const train = result.files['datasets/pretrain.train.jsonl'].split(/\n/).filter(Boolean).map(JSON.parse);
  const holdout = result.files['datasets/development-holdout.jsonl'].split(/\n/).filter(Boolean).map(JSON.parse);
  const trainGroups = new Set(train.map(item => item.group_id));
  const holdoutGroups = new Set(holdout.map(item => item.group_id));
  assert.equal([...trainGroups].some(group => holdoutGroups.has(group)), false);
  assert.equal(train.length, 3);
  assert.equal(holdout.length, 0);
});

test('training receipt rejects a checkpoint trained on any different compiled dataset', () => {
  const result = compiled();
  const checkpoint = checkpointFor(result.plan, { training: {
    code_commit: result.plan.code_commit,
    dataset_digests: [sha('different-dataset')],
    trajectory_batch_digests: result.plan.inputs.trajectories.map(item => item.batch_digest),
    teacher_ids: [],
    teacher_model_ids: [],
    seed: 42,
    optimizer: {},
    config: {}
  } });
  assert.throws(() => createStudentTrainingReceipt({
    plan: result.plan,
    checkpoint,
    artifact: { path: 'student.gguf', sha256: sha('artifact'), bytes: 100, format: 'gguf', model_id: 'fixture-student', checkpoint_id: 'fixture-checkpoint' }
  }), /dataset digests/);
});
