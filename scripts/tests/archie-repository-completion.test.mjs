import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = path.join(repoRoot, 'scripts', 'archie-repository-completion.mjs');
const fakeWriter = path.join(repoRoot, 'scripts', 'tests', 'fixtures', 'archie-completion-fake-writer.mjs');

async function command(program, args, options = {}) {
  return execFileAsync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-completion-test-'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: 'completion-fixture',
    private: true,
    scripts: { test: 'node test.mjs', deploy: 'node deploy.mjs' }
  }, null, 2) + '\n');
  await fs.writeFile(path.join(source, 'test.mjs'), "import fs from 'node:fs'; if (!fs.existsSync('completion.txt')) throw new Error('not complete');\n");
  await fs.writeFile(path.join(source, 'deploy.mjs'), "throw new Error('must never run deploy');\n");
  await command('git', ['init', '-b', 'main'], { cwd: source });
  await command('git', ['config', 'user.name', 'Fixture'], { cwd: source });
  await command('git', ['config', 'user.email', 'fixture@example.test'], { cwd: source });
  await command('git', ['add', '.'], { cwd: source });
  await command('git', ['commit', '-m', 'initial'], { cwd: source });
  return { root, source, output: path.join(root, 'isolated'), artifacts: path.join(root, 'artifacts') };
}

test('prepares an exact read-only clone without touching the source', async t => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const before = await command('git', ['status', '--porcelain=v1'], { cwd: item.source });
  await command(process.execPath, [runner,
    '--source', item.source,
    '--output', item.output,
    '--artifacts', item.artifacts,
    '--objective', 'Make the fixture complete',
    '--prepare-only'
  ]);
  const receipt = JSON.parse(await fs.readFile(path.join(item.artifacts, 'receipt.json'), 'utf8'));
  assert.equal(receipt.state, 'prepared');
  assert.equal(receipt.upstream_push_url, 'disabled://archie-read-only-source');
  assert.equal(receipt.source_checkout_unchanged, true);
  assert.deepEqual(receipt.verification_commands, ['npm run test']);
  assert.equal(receipt.baseline[0].ok, false);
  const after = await command('git', ['status', '--porcelain=v1'], { cwd: item.source });
  assert.equal(after.stdout, before.stdout);
  assert.equal(await fs.readFile(path.join(item.source, 'completion.txt'), 'utf8').catch(() => null), null);
});

test('runs a writer only in the isolated clone and emits a verified patch', async t => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const commandJson = JSON.stringify([process.execPath, fakeWriter]);
  const result = await command(process.execPath, [runner,
    '--source', item.source,
    '--output', item.output,
    '--artifacts', item.artifacts,
    '--objective', 'Make the fixture complete',
    '--agent', 'command',
    '--command-json', commandJson,
    '--max-passes', '2'
  ]);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.source_checkout_unchanged, true);
  assert.equal(receipt.final_verification[0].ok, true);
  assert.equal(receipt.passes.length, 1);
  assert.equal(receipt.passes[0].passed, true);
  assert.match(await fs.readFile(path.join(item.artifacts, 'completion.patch'), 'utf8'), /completion\.txt/);
  assert.equal(await fs.readFile(path.join(item.output, 'completion.txt'), 'utf8'), 'complete\n');
  assert.equal(await fs.readFile(path.join(item.source, 'completion.txt'), 'utf8').catch(() => null), null);
});
