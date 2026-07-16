import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createArchieMakerDecision,
  normalizeMakerExecutionPlan,
  verifyArchieMakerDecision
} from '../maker-archie-runtime-contract.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const makerScript = path.resolve(here, '..', 'maker.mjs');
const key = 'a'.repeat(64);

function plan() {
  return {
    title: 'Use the recalled Maker plan',
    branch_slug: 'use-recalled-maker-plan',
    selected_lane: 'operator',
    why_now: 'A prior verified run already established the bounded implementation lane.',
    owned_paths: ['README.md'],
    implementation_prompt: 'Update README.md, run the focused test, and preserve human merge authority.',
    focused_tests: ['node --test scripts/tests/maker-archie-runtime-contract.test.mjs'],
    deferred: ['Do not merge automatically.']
  };
}

function recall() {
  return {
    status: 'local',
    plan: plan(),
    specialist_id: 'skill_fixture',
    confidence: 0.91,
    margin: 0.42,
    model_digest: 'model-fixture',
    execution_eligible: true,
    execution_basis: { kind: 'normalized-exact-verified-recurrence', example_id: 'example-fixture', base_sha: 'base-fixture' }
  };
}

test('normalizes only complete Maker execution plans', () => {
  assert.deepEqual(normalizeMakerExecutionPlan(plan()), plan());
  assert.equal(normalizeMakerExecutionPlan({ ...plan(), implementation_prompt: '' }), null);
  assert.equal(normalizeMakerExecutionPlan({ ...plan(), selected_lane: 'scientist' }), null);
  assert.equal(normalizeMakerExecutionPlan({ ...plan(), owned_paths: ['../escape'] }), null);
});

test('binds a recalled plan to request, repository, base branch, expiry, and an ephemeral signature', () => {
  const issued = '2026-07-16T15:00:00.000Z';
  assert.throws(() => createArchieMakerDecision({
    request: 'Repeat the verified repair.', repository: '/tmp/repository', baseBranch: 'main',
    baseSha: 'base-fixture',
    recall: { ...recall(), execution_eligible: false, execution_basis: null }, key, clock: () => issued
  }), /normalized-exact verified recurrence/);
  const decision = createArchieMakerDecision({
    request: 'Repeat the verified repair.',
    repository: '/tmp/repository',
    baseBranch: 'main',
    baseSha: 'base-fixture',
    recall: recall(),
    key,
    clock: () => issued
  });
  const verified = verifyArchieMakerDecision(decision, {
    request: 'Repeat the verified repair.',
    repository: '/tmp/repository',
    baseBranch: 'main',
    baseSha: 'base-fixture',
    key,
    clock: () => '2026-07-16T15:05:00.000Z'
  });
  assert.deepEqual(verified.plan, plan());
  assert.equal(verified.specialist_id, 'skill_fixture');
  assert.throws(() => verifyArchieMakerDecision({ ...decision, plan: { ...decision.plan, why_now: 'tampered' } }, {
    request: 'Repeat the verified repair.', repository: '/tmp/repository', baseBranch: 'main', baseSha: 'base-fixture', key, clock: () => '2026-07-16T15:05:00.000Z'
  }), /integrity|signature/);
  assert.throws(() => verifyArchieMakerDecision(decision, {
    request: 'Different request.', repository: '/tmp/repository', baseBranch: 'main', baseSha: 'base-fixture', key, clock: () => '2026-07-16T15:05:00.000Z'
  }), /request/);
  assert.throws(() => verifyArchieMakerDecision(decision, {
    request: 'Repeat the verified repair.', repository: '/tmp/other', baseBranch: 'main', baseSha: 'base-fixture', key, clock: () => '2026-07-16T15:05:00.000Z'
  }), /repository/);
  assert.throws(() => verifyArchieMakerDecision(decision, {
    request: 'Repeat the verified repair.', repository: '/tmp/repository', baseBranch: 'trunk', baseSha: 'base-fixture', key, clock: () => '2026-07-16T15:05:00.000Z'
  }), /base branch/);
  assert.throws(() => verifyArchieMakerDecision(decision, {
    request: 'Repeat the verified repair.', repository: '/tmp/repository', baseBranch: 'main', baseSha: 'moved-base', key, clock: () => '2026-07-16T15:05:00.000Z'
  }), /base SHA/);
  assert.throws(() => verifyArchieMakerDecision(decision, {
    request: 'Repeat the verified repair.', repository: '/tmp/repository', baseBranch: 'main', baseSha: 'base-fixture', key, clock: () => '2026-07-16T15:11:00.000Z'
  }), /expired/);
  assert.throws(() => verifyArchieMakerDecision(decision, {
    request: 'Repeat the verified repair.', repository: '/tmp/repository', baseBranch: 'main', baseSha: 'base-fixture', key: 'b'.repeat(64), clock: () => '2026-07-16T15:05:00.000Z'
  }), /signature/);
});

async function command(program, args, cwd) {
  return execFileAsync(program, args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
}

test('Maker accepts a valid recalled plan as its actual dry-run plan and skips redundant assessment', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-archie-runtime-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  const remote = path.join(root, 'remote.git');
  await fs.mkdir(repository, { recursive: true });
  await command('git', ['init', '--bare', remote], root);
  await command('git', ['init', '-b', 'main'], repository);
  await command('git', ['config', 'user.name', 'Fixture'], repository);
  await command('git', ['config', 'user.email', 'fixture@example.com'], repository);
  await fs.writeFile(path.join(repository, 'README.md'), 'fixture\n');
  await command('git', ['add', 'README.md'], repository);
  await command('git', ['commit', '-m', 'fixture'], repository);
  await command('git', ['remote', 'add', 'origin', remote], repository);
  await command('git', ['push', '-u', 'origin', 'main'], repository);

  const request = 'Repeat the verified repair.';
  const baseSha = String((await command('git', ['rev-parse', 'origin/main'], repository)).stdout).trim();
  const alignedRecall = { ...recall(), execution_basis: { ...recall().execution_basis, base_sha: baseSha } };
  const decision = createArchieMakerDecision({ request, repository, baseBranch: 'main', baseSha, recall: alignedRecall, key });
  const decisionPath = path.join(root, 'decision.json');
  await fs.writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, { mode: 0o600 });
  const result = await execFileAsync(process.execPath, [
    makerScript,
    '--local-only',
    '--dry-run',
    '--agent', 'command',
    '--command-json', '["node"]',
    '--archie-decision-file', decisionPath,
    request
  ], {
    cwd: repository,
    env: { ...process.env, ARCHIE_MAKER_DECISION_KEY: key },
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024
  });
  assert.match(result.stdout, /accepted integrity-bound Archie plan skill_fixture/);
  assert.match(result.stdout, /selected operator via archie-native-recall/);
  assert.match(result.stdout, /"plan_source": "archie-native-recall"/);
  assert.doesNotMatch(result.stdout, /spawning four read-only agents/);
});
