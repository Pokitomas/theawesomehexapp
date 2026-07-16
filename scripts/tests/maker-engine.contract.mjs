import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { runAutonomousMakerAgent } from '../../maker/runtime/autonomous-agent.mjs';
import {
  MakerEngine,
  assertNoLeaseCollision,
  normalizeMakerLease,
  pathsOverlap,
  redactSecrets,
  verifyEventChain
} from '../maker-engine.mjs';
import { buildMakerModelRegistry, evaluateNativeCheckpoint, selectMakerProvider } from '../maker-foundry-adapter.mjs';
import { nativeCommandPolicy, parseMakerLeaseMarker } from '../maker-native-worker.mjs';

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

function sequenceClient(actions) {
  let index = 0;
  return {
    async complete() {
      const action = actions[Math.min(index, actions.length - 1)];
      index += 1;
      return { text: JSON.stringify(action) };
    }
  };
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
  const repairWitness = await engine.run({ program: 'node', args: ['test.mjs'] });
  assert.equal(repairWitness.ok, true);
  await engine.markRepaired(failed.failure_id, 'changed the exact failing constant and reran the failing command');
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

test('repair is hypothesis-gated and cannot complete without the exact successful witness', async t => {
  const root = await fixture();
  const statePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'maker-proof-state-')), 'task.json');
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(path.dirname(statePath), { recursive: true, force: true })]));
  const engine = await MakerEngine.create({ root, state_path: statePath, task: task('maker/proof-gate'), lease: lease('maker/proof-gate'), command_policy: policy });
  const failed = await engine.run({ program: 'node', args: ['test.mjs'] });
  await assert.rejects(engine.replace('src/answer.mjs', '41', '42'), /Begin a falsifiable repair/);
  await assert.rejects(engine.beginRepair(failed.failure_id, ''), /hypothesis is required/);
  await engine.beginRepair(failed.failure_id, 'The exported answer is one too low.');
  await assert.rejects(engine.markRepaired(failed.failure_id, 'prose only'), /successful rerun/);
  const repeated = await engine.run({ program: 'node', args: ['test.mjs'] });
  assert.equal(repeated.failure_id, failed.failure_id);
  assert.equal(engine.snapshot().failures.length, 1);
  await engine.replace('src/answer.mjs', '41', '42');
  const unrelated = await engine.run({ program: 'git', args: ['diff', '--check'] });
  assert.equal(unrelated.ok, true);
  await assert.rejects(engine.markRepaired(failed.failure_id, 'unrelated witness'), /successful rerun/);
  const witness = await engine.run({ program: 'node', args: ['test.mjs'] });
  assert.equal(witness.ok, true);
  const repaired = await engine.markRepaired(failed.failure_id, 'exact command passed after the bounded patch');
  assert.equal(repaired.repair.status, 'proved');
  assert.deepEqual(repaired.repair.witness.command, ['node', 'test.mjs']);
});

test('model-driven Maker loop must lease, observe failure, repair, verify, and finish', async t => {
  const root = await fixture();
  const statePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'maker-agent-state-')), 'task.json');
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(path.dirname(statePath), { recursive: true, force: true })]));
  const model = sequenceClient([
    { tool: 'read', path: 'src/answer.mjs', start: 1, end: 20 },
    { tool: 'lease', owned_paths: ['src/**'], summary: 'Only the failing source file needs mutation.' },
    { tool: 'run', program: 'node', args: ['test.mjs'] },
    { tool: 'repair_start', failure_id: 'failure-1', hypothesis: 'The exported answer is one too low.' },
    { tool: 'replace', path: 'src/answer.mjs', before: '41', after: '42', expected: 1 },
    { tool: 'run', program: 'node', args: ['test.mjs'] },
    { tool: 'repair_complete', failure_id: 'failure-1', evidence: 'Replaced the exact failing literal and reran the failing command.' },
    { tool: 'verify', commands: [{ program: 'node', args: ['test.mjs'] }, { program: 'git', args: ['diff', '--check'] }] },
    { tool: 'finish', summary: 'Repaired and verified the fixture.', risks: [] }
  ]);
  const result = await runAutonomousMakerAgent({
    root,
    state_path: statePath,
    task: task('maker/model-loop'),
    model_client: model,
    command_policy: policy,
    budget: { max_turns: 12, max_model_tokens: 1000 }
  });
  assert.equal(result.status, 'finished');
  assert.deepEqual(result.lease.owned_paths, ['src/**']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].repaired, true);
  assert.equal(result.verification.length, 2);
  assert.match(result.receipt.receipt_digest, /^[0-9a-f]{64}$/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'answer.mjs'), 'utf8'), 'export const answer = 42;\n');
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

test('worker understands authoritative and legacy Maker lease receipts', () => {
  const authoritative = parseMakerLeaseMarker(`<!-- sideways-maker-lease:v1\n${JSON.stringify({
    schema: 'sideways-maker-lease/v1',
    session_id: 'session-1',
    base_branch: 'main',
    base_sha: BASE,
    branch: 'maker/one',
    writer_count: 1,
    owned_paths: ['maker/**'],
    authority: { merge: 'human', deploy: 'human' }
  })}\n-->`);
  assert.equal(authoritative.session_id, 'session-1');
  assert.equal(authoritative.base_branch, 'main');
  assert.deepEqual(authoritative.owned_paths, ['maker/**']);
  const legacy = parseMakerLeaseMarker(`<!-- sideways-maker-lease/v1\n${JSON.stringify({
    base_sha: BASE,
    branch: 'maker/legacy',
    writer_count: 1,
    owned_paths: ['src/**'],
    authority: { merge: 'human', deploy: 'human' }
  })}\n-->`);
  assert.equal(legacy.branch, 'maker/legacy');
  assert.equal(parseMakerLeaseMarker('no marker'), null);
  const commandPolicy = nativeCommandPolicy();
  assert.ok(commandPolicy.some(rule => rule.program === 'node' && rule.args[0] === '--test' && rule.prefix));
  assert.ok(commandPolicy.some(rule => rule.program === 'npm' && rule.args[0] === 'run' && rule.prefix));
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
