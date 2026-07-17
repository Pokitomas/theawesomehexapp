import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  inspectArchieFirstRun,
  renderArchieFirstRun
} from '../archie-first-run.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ARCHIE = path.join(ROOT, 'scripts', 'archie.mjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(ROOT, '.archie-install-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function execute(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ARCHIE, ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1', ...env },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('package exposes Archie as a normal cross-platform executable', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.bin.archie, 'scripts/archie.mjs');
  assert.equal(packageJson.scripts['test:archie:install'], 'node --test scripts/tests/maker-archie-install.test.mjs');
  assert.ok(packageJson.files.includes('scripts/*.mjs'));
  assert.ok(packageJson.files.includes('foundry/archie-neural/*.mjs'));
  assert.match(await fs.readFile(ARCHIE, 'utf8'), /^#!\/usr\/bin\/env node/);
});

test('fresh first launch is polished, useful, and honest about missing capability', async t => {
  const home = await fixture(t);
  const state = await inspectArchieFirstRun({
    home,
    env: { PATH: '', ARCHIE_RUNNER: '' },
    platform: 'win32',
    nodeVersion: 'v20.0.0',
    version: '0.1.0-test'
  });
  assert.equal(state.runtime_ready, true);
  assert.deepEqual(state.installed_artifacts, []);
  assert.equal(state.local_runner.available, false);
  assert.equal(state.execution_ready, false);
  assert.match(state.capability_claim, /do not prove model capability/i);
  assert.deepEqual(state.next_steps.map(step => step.id), ['model', 'runner', 'help']);

  const screen = renderArchieFirstRun(state);
  assert.match(screen, /A R C H I E  \/\/  LOCAL WORLD/);
  assert.match(screen, /Runtime 0\.1\.0-test/);
  assert.match(screen, /Model artifacts: none installed/);
  assert.match(screen, /archie pull <manifest>/);
  assert.doesNotMatch(screen, /\u001b\[/);
});

test('the installed command supports pretty empty launch and machine-readable setup', async t => {
  const home = await fixture(t);
  const pretty = await execute(['--home', home], { PATH: '' });
  assert.equal(pretty.code, 0, pretty.stderr);
  assert.equal(pretty.stderr, '');
  assert.match(pretty.stdout, /LOCAL WORLD/);
  assert.match(pretty.stdout, /do not prove model capability/i);

  const machine = await execute(['setup', '--json', '--home', home], { PATH: '' });
  assert.equal(machine.code, 0, machine.stderr);
  const state = JSON.parse(machine.stdout);
  assert.equal(state.schema, 'archie-first-run/v1');
  assert.equal(state.runtime_ready, true);
  assert.equal(state.execution_ready, false);
  assert.deepEqual(state.installed_artifacts, []);
});

test('existing list command remains scriptable after first-launch routing', async t => {
  const home = await fixture(t);
  const result = await execute(['list', '--home', home]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).models, []);
});
