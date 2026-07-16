import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  ARCHIE_SELF_HOSTING_TRAJECTORY_SCHEMA,
  createArchieSelfHostingProgram,
  createSidewaysSelfHostingScenario,
  runArchieSelfHostingSample
} from '../archie-self-hosting-sample.mjs';
import { verifyEventChain } from '../maker-engine.mjs';

const execFileAsync = promisify(execFile);
const BASE_SHA = 'a'.repeat(40);

async function rootFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-self-hosting-test-'));
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  const verifierSource = new URL('../verify-archie-self-hosting-sample.mjs', import.meta.url);
  await fs.copyFile(verifierSource, path.join(root, 'scripts', 'verify-archie-self-hosting-sample.mjs'));
  return root;
}

test('Sideways scenario and Archie AIL plan are deterministic for the same seed', () => {
  const left = createSidewaysSelfHostingScenario({ seed: 42, target_prefix: 'samples/archie-app' });
  const right = createSidewaysSelfHostingScenario({ seed: 42, target_prefix: 'samples/archie-app' });
  const other = createSidewaysSelfHostingScenario({ seed: 43, target_prefix: 'samples/archie-app' });
  assert.equal(left.scenario_digest, right.scenario_digest);
  assert.equal(left.expected_artifact_digest, right.expected_artifact_digest);
  assert.notEqual(left.scenario_digest, other.scenario_digest);

  const plan = createArchieSelfHostingProgram(left);
  assert.equal(plan.schema, 'archie-executable-plan/v1');
  assert.deepEqual(plan.schedule.map(item => item.id), ['writehtml', 'writejavascript', 'writestate', 'verifyapp', 'retaintrajectory', 'complete']);
  assert.equal(plan.world.find(item => item.id === 'archie').write_authority, false);
  assert.equal(plan.world.find(item => item.id === 'maker').write_authority, true);
});

test('self-hosting sample writes only through Maker lease and emits positive training trajectory', async t => {
  const root = await rootFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const statePath = path.join(os.tmpdir(), `archie-self-hosting-state-${process.pid}-${Date.now()}.json`);
  t.after(() => fs.rm(statePath, { force: true }));
  t.after(() => fs.rm(`${statePath}.trajectory.json`, { force: true }));

  const result = await runArchieSelfHostingSample({
    root,
    repository: 'Pokitomas/theawesomehexapp',
    base_sha: BASE_SHA,
    branch: 'agent/self-hosting-fixture',
    seed: 9,
    target_prefix: 'samples/archie-app',
    state_path: statePath,
    clock: (() => {
      let tick = 0;
      return () => new Date(Date.parse('2026-07-16T18:00:00.000Z') + tick++ * 1000).toISOString();
    })()
  });

  assert.equal(result.trajectory.schema, ARCHIE_SELF_HOSTING_TRAJECTORY_SCHEMA);
  assert.equal(result.trajectory.payload.outcome, 'completed');
  assert.equal(result.trajectory.payload.training_classification, 'positive');
  assert.equal(result.trajectory.payload.archie.direct_write_authority, false);
  assert.deepEqual(result.maker_receipt.changed_paths, [
    'samples/archie-app/app.js',
    'samples/archie-app/index.html',
    'samples/archie-app/state.json'
  ]);
  assert.deepEqual(result.maker_receipt.lease.owned_paths, ['samples/archie-app/**']);
  assert.deepEqual(result.maker_receipt.human_gates, ['merge', 'deploy', 'production data', 'training spend']);
  assert.equal(result.maker_receipt.verification.length, 1);
  assert.equal(result.maker_receipt.verification[0].program, 'node');
  assert.equal(result.maker_receipt.verification[0].ok, true);
  assert.match(result.maker_receipt.verification[0].stdout, /sideways-archie-self-hosting-verification\/v1/);

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  verifyEventChain(state.events);
  assert.equal(state.status, 'ready');
  assert.equal(state.events.some(event => event.type === 'file_written'), true);
  assert.equal(state.events.some(event => event.type === 'verification_passed'), true);
  assert.equal(state.events.some(event => event.type === 'receipt_created'), true);

  const trajectory = JSON.parse(await fs.readFile(`${statePath}.trajectory.json`, 'utf8'));
  assert.equal(trajectory.trajectory_digest, result.trajectory.trajectory_digest);
  assert.match(await fs.readFile(path.join(root, 'samples/archie-app/index.html'), 'utf8'), /main id="archie-app"/);
});

test('standalone verifier rejects changed app bytes and target traversal is blocked', async t => {
  const root = await rootFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenario = createSidewaysSelfHostingScenario({ seed: 3, target_prefix: 'samples/archie-app' });
  const target = path.join(root, scenario.target_prefix);
  await fs.mkdir(target, { recursive: true });
  for (const [name, content] of Object.entries(scenario.files)) await fs.writeFile(path.join(target, name), content);
  await fs.appendFile(path.join(target, 'app.js'), '\n// tampered\n');

  await assert.rejects(
    execFileAsync(process.execPath, [
      'scripts/verify-archie-self-hosting-sample.mjs',
      '--root',
      scenario.target_prefix,
      '--expected-digest',
      scenario.expected_artifact_digest
    ], { cwd: root }),
    /artifact digest mismatch/
  );
  assert.throws(() => createSidewaysSelfHostingScenario({ seed: 1, target_prefix: '../escape' }), /repository-relative/);
});
