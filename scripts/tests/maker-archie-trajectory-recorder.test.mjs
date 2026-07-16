import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArchieLinuxCorpus } from '../maker-archie-corpus.mjs';
import {
  MAKER_ENGINE_RECEIPT_SCHEMA,
  MAKER_ENGINE_STATE_SCHEMA,
  SELF_HOSTING_TRAJECTORY_SCHEMA,
  recordMakerEngineReceipt,
  recordSelfHostingTrajectory
} from '../archie-trajectory-recorder.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-modern-corpus-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return createArchieLinuxCorpus({ root, clock: () => '2026-07-16T18:30:00.000Z' });
}

function positiveMakerReceipt() {
  return {
    schema: MAKER_ENGINE_RECEIPT_SCHEMA,
    task: {
      repository: 'Pokitomas/theawesomehexapp',
      request: 'Build and verify the bounded Archie app sample.',
      base_sha: 'a'.repeat(40),
      branch: 'agent/sample',
      protect: 'Do not deploy. Bearer secret-secret-secret-secret',
      proof: 'Run the exact verifier.'
    },
    lease: {
      version: 'sideways-maker-lease/v1',
      base_sha: 'a'.repeat(40),
      branch: 'agent/sample',
      writer_count: 1,
      owned_paths: ['samples/archie-app/**'],
      authority: { merge: 'human', deploy: 'human' }
    },
    status: 'ready',
    changed_paths: ['samples/archie-app/index.html'],
    commands: [{
      ok: true,
      program: 'node',
      args: ['scripts/verify.mjs'],
      exit_code: 0,
      duration_ms: 12,
      stdout: 'verified',
      stderr: ''
    }],
    failures: [],
    verification: [{
      ok: true,
      program: 'node',
      args: ['scripts/verify.mjs'],
      exit_code: 0,
      duration_ms: 12,
      stdout: 'verified',
      stderr: ''
    }],
    checkpoints: [{ label: 'written', digest: 'b'.repeat(64) }],
    event_count: 8,
    event_head: 'c'.repeat(64),
    receipt_digest: 'd'.repeat(64)
  };
}

test('verified MakerEngine receipt becomes a positive owned distillation example', async t => {
  const corpus = await fixture(t);
  const receipt = positiveMakerReceipt();
  const stored = await recordMakerEngineReceipt(corpus, receipt, {
    plan: { steps: ['write', 'verify', 'halt'] },
    source: { model: 'archie-student-fixture', teacher: 'teacher-fixture', cost_usd: 0.01 }
  });
  assert.equal(stored.status, 'stored');
  const examples = await corpus.examples();
  assert.equal(examples.length, 1);
  assert.equal(examples[0].negative, false);
  assert.equal(examples[0].outcome, 'completed');
  assert.deepEqual(examples[0].target, { steps: ['write', 'verify', 'halt'] });
  assert.equal(examples[0].tool_trace[0].tool, 'maker_process');
  assert.equal(examples[0].tool_trace[0].action, 'node');
  assert.equal(examples[0].teacher_evidence.model, 'archie-student-fixture');
  assert.equal(examples[0].artifact_refs[0].name, 'samples/archie-app/index.html');

  const matches = await corpus.query('bounded Archie app');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.input.context.protect.includes('secret-secret'), false);
  assert.equal(matches[0].record.input.context.protect.includes('[redacted]'), true);
});

test('failed MakerEngine state is retained as negative suppression knowledge', async t => {
  const corpus = await fixture(t);
  const state = {
    ...positiveMakerReceipt(),
    schema: MAKER_ENGINE_STATE_SCHEMA,
    status: 'failed',
    commands: [{
      ok: false,
      program: 'node',
      args: ['scripts/verify.mjs'],
      exit_code: 1,
      stderr: 'artifact digest mismatch',
      duration_ms: 5
    }],
    verification: [],
    failures: [{ id: 'failure-1', evidence: 'artifact digest mismatch', repaired: false }]
  };
  delete state.receipt_digest;
  const stored = await recordMakerEngineReceipt(corpus, state);
  assert.equal(stored.status, 'stored');
  const examples = await corpus.examples();
  assert.equal(examples.length, 1);
  assert.equal(examples[0].negative, true);
  assert.equal(examples[0].outcome, 'failed');
  assert.match(examples[0].reason, /artifact digest mismatch/);
  assert.deepEqual(examples[0].tool_trace, []);
  assert.equal(examples[0].tags.includes('suppress'), true);
});

test('self-hosting trajectory becomes positive or negative learning data without direct Archie writes', async t => {
  const corpus = await fixture(t);
  const positive = {
    schema: SELF_HOSTING_TRAJECTORY_SCHEMA,
    trajectory_digest: 'e'.repeat(64),
    payload: {
      outcome: 'completed',
      training_classification: 'positive',
      sideways: {
        scenario_id: 'archie-app-fixture',
        scenario_digest: 'f'.repeat(64),
        expected_artifact_digest: '1'.repeat(64),
        seed: 7
      },
      archie: {
        plan_source: 'deterministic-fixture',
        semantic_digest: '2'.repeat(64),
        schedule_digest: '3'.repeat(64),
        direct_write_authority: false
      },
      maker: {
        changed_paths: ['samples/archie-app/index.html'],
        verification: [{ ok: true, program: 'node', args: ['verify'], exit_code: 0, duration_ms: 4 }],
        human_gates: ['merge', 'deploy']
      }
    }
  };
  await recordSelfHostingTrajectory(corpus, positive);

  const negative = structuredClone(positive);
  negative.trajectory_digest = '4'.repeat(64);
  negative.payload.outcome = 'failed';
  negative.payload.training_classification = 'negative';
  negative.payload.error = 'verification rejected changed bytes';
  negative.payload.maker.verification = [];
  await recordSelfHostingTrajectory(corpus, negative);

  const examples = await corpus.examples();
  assert.equal(examples.length, 2);
  const accepted = examples.find(example => !example.negative);
  const rejected = examples.find(example => example.negative);
  assert.equal(accepted.compact_context.direct_write_authority, false);
  assert.equal(accepted.target.semantic_digest, '2'.repeat(64));
  assert.equal(accepted.tool_trace[0].tool, 'maker_process');
  assert.match(rejected.reason, /verification rejected/);
  assert.equal(rejected.tags.includes('suppress'), true);
});

test('unsupported receipt shapes are rejected instead of guessed', async t => {
  const corpus = await fixture(t);
  await assert.rejects(recordMakerEngineReceipt(corpus, { schema: 'unknown/v1' }), /Unsupported MakerEngine/);
  await assert.rejects(recordSelfHostingTrajectory(corpus, { schema: 'unknown/v1' }), /Unsupported Archie self-hosting/);
});
