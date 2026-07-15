import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  MakerEngine,
  assertNoLeaseCollision,
  normalizeMakerLease,
  pathsOverlap,
  redactSecrets,
  verifyEventChain
} from '../maker-engine.mjs';
import { buildMakerModelRegistry, evaluateNativeCheckpoint, selectMakerProvider } from '../maker-foundry-adapter.mjs';

const execFileAsync = promisify(execFile);
const BASE = 'a'.repeat(40);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-engine-'));
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Maker Test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'maker@example.test'], { cwd: root });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'answer.mjs'), 'export const answer = 41;\n', 'utf8');
  await fs.writeFile(path.join(root, 'test.mjs'), "import assert from 'node:assert/strict'; import { answer } from './src/answer.mjs'; assert.equal(answer, 42);\n", 'utf8');
  await execFileAsync('git', ['add', '--all'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
  return root;
}

function task(branch = 'maker/test') {
  return { repository: 'owner/repo', base_sha: BASE, branch, request: 'Repair the fixture and prove it.' };
}

function lease(branch = 'maker/test') {
  return { base_sha: BASE, branch, writer_count: 1, owned_paths: ['src/**'], authority: { merge: 'human', deploy: 'human' } };
}

const policy = [
  { program: 'node', args: ['test.mjs'] },
  { program: 'git', args: ['diff', '--check'] }
];

test('autonomous Maker leases reject overlap and enforce one writer', () => {
  assert.equal(pathsOverlap('src/**', 'src/app.mjs'), true);
  assert.equal(pathsOverlap('maker/**', 'src/app.mjs'), false);
  assert.throws(() => normalizeMakerLease({ ...lease(), writer_count: 2 }), /exactly one writer/);
  assert.throws(() => assertNoLeaseCollision(lease(), [{ ...lease('maker/other'), owned_paths: ['src/app.mjs'] }]), /collision/);
});

test('autonomous Maker executes fail, diagnose, repair, resume, verify, and receipt', async t => {
  const root = await fixture();
  const statePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'maker-state-')), 'task.json');
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(path.dirname(statePath), { recursive: true, force: true })]));
  const engine = await MakerEngine.create({ root, state_path: statePath, task: task(), lease: lease(), command_policy: policy });
  const failed = await engine.run({ program: 'node', args: ['test.mjs'] });
  assert.equal(failed.ok, false);
  assert.equal(engine.snapshot().status, 'failed');
  await engine.beginRepair(failed.failure_id, 'fixture exports the wrong integer');
  await engine.replace('src/answer.mjs', '41', '42');
  await engine.markRepaired(failed.failure_id, 'changed the exact failing constant');
  const checkpoint = await engine.checkpoint('answer repaired');
  assert.match(checkpoint.digest, /^[0-9a-f]{64}$/);
  const resumed = await MakerEngine.resume({ root, state_path: statePath, command_policy: policy });
  assert.equal(resumed.snapshot().attempt, 2);
  const verified = await resumed.verify([{ program: 'node', args: ['test.mjs'] }, { program: 'git', args: ['diff', '--check'] }]);
  assert.equal(verified.ok, true);
  const receipt = await resumed.receipt();
  assert.deepEqual(receipt.changed_paths, ['src/answer.mjs']);
  assert.equal(receipt.failures[0].repaired, true);
  assert.equal(receipt.verification.length, 2);
  assert.match(receipt.receipt_digest, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => verifyEventChain(resumed.snapshot().events));
});

test('autonomous Maker rejects unleased paths and commands and restores rollback', async t => {
  const root = await fixture();
  const statePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'maker-state-')), 'task.json');
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(path.dirname(statePath), { recursive: true, force: true })]));
  const engine = await MakerEngine.create({ root, state_path: statePath, task: task(), lease: lease(), command_policy: policy });
  await assert.rejects(engine.write('README.md', 'nope\n'), /outside the Maker lease/);
  await assert.rejects(engine.run({ program: 'bash', args: ['-lc', 'rm -rf .'] }), /not allowlisted/);
  await engine.write('src/answer.mjs', 'export const answer = 99;\n');
  await engine.rollback('hostile test');
  assert.equal(await fs.readFile(path.join(root, 'src', 'answer.mjs'), 'utf8'), 'export const answer = 41;\n');
  assert.equal(redactSecrets('Bearer abcdefghijklmnopqrstuvwxyz'), '[REDACTED]');
});

test('Foundry proposals and proxies cannot masquerade as admitted models', () => {
  const generation = {
    receipt: { generation: 0, code_revision: BASE, claim_boundary: 'proxy only', final_model_weights_trained: false },
    verified: { manifest: { schema: 'sideways-foundry-artifact-manifest/v1' } },
    genomes: [{ identity: { candidate_id: 'candidate:one', family: 'field' } }],
    proxies: [{ candidate_id: 'candidate:one', status: 'survived-proxy', result_id: 'proxy:one' }],
    negatives: { retained: [] }
  };
  const registry = buildMakerModelRegistry({ generation });
  assert.equal(registry.candidates[0].state, 'proxy-only');
  assert.deepEqual(registry.admitted_native_models, []);
  const selection = selectMakerProvider({ registry, providers: [{ id: 'github-models', kind: 'hosted', model: 'openai/gpt-4.1', endpoint_host: 'models.github.ai', available: true }] });
  assert.equal(selection.selected.id, 'github-models');
  assert.equal(selection.degraded, true);
  assert.match(selection.reasons[0], /no admitted native checkpoint/);
});

test('native checkpoint admission requires reproducible weights and matched engineering evidence', () => {
  const rejected = evaluateNativeCheckpoint({ candidate_id: 'candidate:one', checkpoint: { id: 'x' }, evaluation: {} });
  assert.equal(rejected.admitted, false);
  const checkpoint = { id: 'ckpt:1', sha256: 'b'.repeat(64), code_revision: BASE, weights_bytes: 1024, format: 'safetensors', license: 'Apache-2.0', provenance: 'reproducible local training receipt', reproducible: true };
  const evaluation = { schema: 'sideways-maker-engineering-evaluation/v1', matched_tasks: true, hidden_evaluation_passed: true, tool_use_correctness_passed: true, regression_suite_passed: true, reproduced_seeds: 2, resources: { wall_time_ms: 1, peak_rss_bytes: 1, input_bytes: 1, output_bytes: 1 } };
  assert.equal(evaluateNativeCheckpoint({ candidate_id: 'candidate:one', checkpoint, evaluation }).admitted, true);
});
