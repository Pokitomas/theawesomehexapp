import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import test from 'node:test';
import { parseArgvJSON, runParallelFoundry } from '../runtime.mjs';

const execFileAsync = promisify(execFile);
const mockAgent = new URL('./mock-agent.mjs', import.meta.url).pathname;
const CI_RUNTIME_TIMEOUT_MS = 120000;
const CALIBRATED_DIVERSITY_BUDGET = 6;
const mission = {
  id: 'runtime-test',
  objective: 'Search without precommitting to a known architecture.',
  hardware: { device: 'test' },
  budget: { proxy_compute_units: CALIBRATED_DIVERSITY_BUDGET },
  success_metrics: ['capability', 'memory traffic'],
  forbidden_defaults: ['No default architecture winner.'],
  operator_constraints: ['Read-only assessment.']
};

async function cleanGitRepo() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-runtime-'));
  await execFileAsync('git', ['init', '-q'], { cwd });
  await execFileAsync('git', ['config', 'user.email', 'foundry@example.test'], { cwd });
  await execFileAsync('git', ['config', 'user.name', 'Foundry Test'], { cwd });
  await fs.writeFile(path.join(cwd, 'seed.txt'), 'seed\n');
  await execFileAsync('git', ['add', 'seed.txt'], { cwd });
  await execFileAsync('git', ['commit', '-qm', 'seed'], { cwd });
  return cwd;
}

async function withRuntimeDirectories(run) {
  const cwd = await cleanGitRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-output-'));
  try {
    return await run({ cwd, out });
  } finally {
    await Promise.all([
      fs.rm(cwd, { recursive: true, force: true }),
      fs.rm(out, { recursive: true, force: true })
    ]);
  }
}

test('parses argv as a JSON array and rejects shell strings', () => {
  assert.deepEqual(parseArgvJSON('["node","agent.mjs"]'), ['node', 'agent.mjs']);
  assert.throws(() => parseArgvJSON('node agent.mjs'), /valid JSON/);
  assert.throws(() => parseArgvJSON('[]'), /non-empty JSON array/);
});

test('runs all ten read-only roles concurrently and funds all diversity strata after cold-start cost calibration', async () => {
  await withRuntimeDirectories(async ({ cwd, out }) => {
    const result = await runParallelFoundry({
      mission,
      agent_argv: [process.execPath, mockAgent],
      cwd,
      out_dir: out,
      budget: CALIBRATED_DIVERSITY_BUDGET,
      timeout_ms: CI_RUNTIME_TIMEOUT_MS
    });
    assert.equal(result.assignments.length, 10);
    assert.equal(result.reports.length, 10);
    assert.equal(result.integration.candidates.length, 10);
    assert.ok(result.integration.candidates.every(candidate => candidate.cost === 2), 'cold-start calibration must double unproven unit-cost estimates');
    assert.equal(result.portfolio.budget, CALIBRATED_DIVERSITY_BUDGET);
    assert.equal(result.portfolio.spent, CALIBRATED_DIVERSITY_BUDGET);
    assert.equal(result.portfolio.selected.length, 3);
    assert.deepEqual(new Set(result.portfolio.selected.map(item => item.distance)), new Set(['conservative', 'adjacent', 'heretical']));
    assert.equal(result.receipt.assignment_count, 10);
    assert.equal(result.receipt.experiment_count, 3);
    for (const filename of ['mission.json', 'assignments.json', 'reports.json', 'integration.json', 'portfolio.json', 'receipt.json']) {
      await fs.access(path.join(out, filename));
    }
  });
});

test('fails closed when any read-only agent mutates the repository', async () => {
  await withRuntimeDirectories(async ({ cwd, out }) => {
    await assert.rejects(() => runParallelFoundry({
      mission,
      agent_argv: [process.execPath, mockAgent],
      cwd,
      out_dir: out,
      budget: CALIBRATED_DIVERSITY_BUDGET,
      timeout_ms: CI_RUNTIME_TIMEOUT_MS,
      env: { ...process.env, MOCK_FOUNDRY_MUTATE: '1' }
    }), /mutated the worktree/);
  });
});
