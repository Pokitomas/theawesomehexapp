import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildArchieRepositoryContext } from '../maker-archie-repository-context.mjs';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  return execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-grounding-'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.email', 'archie@example.test']);
  await git(root, ['config', 'user.name', 'Archie Test']);
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await fs.writeFile(path.join(root, 'scripts', 'planner.mjs'), 'export const plan = "base evidence";\n');
  await fs.writeFile(path.join(root, 'scripts', 'unrelated.mjs'), 'export const unrelated = true;\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'fixture base']);
  const { stdout } = await git(root, ['rev-parse', 'HEAD']);
  return { root, baseSha: stdout.trim() };
}

test('repository context is ranked, bounded, and read from the exact base commit', async t => {
  const { root, baseSha } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'scripts', 'planner.mjs'), 'export const plan = "uncommitted mutation";\n');

  const context = await buildArchieRepositoryContext({
    repoRoot: root,
    request: 'make the planner smarter and inspect planner code',
    baseBranch: 'main',
    baseSha
  });

  assert.equal(context.schema, 'archie-repository-context/v1');
  assert.equal(context.source, 'exact-git-commit');
  assert.equal(context.base_sha, baseSha);
  assert.ok(context.captured_file_count >= 3);
  assert.ok(context.captured_bytes > 0);
  const planner = context.files.find(file => file.path === 'scripts/planner.mjs');
  assert.ok(planner);
  assert.match(planner.content, /base evidence/);
  assert.doesNotMatch(planner.content, /uncommitted mutation/);
  assert.ok(context.files.findIndex(file => file.path === 'scripts/planner.mjs') < context.files.findIndex(file => file.path === 'scripts/unrelated.mjs'));
});

test('repository context rejects a missing exact base commit', async t => {
  const { root } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(
    buildArchieRepositoryContext({ repoRoot: root, request: 'inspect', baseSha: 'f'.repeat(40) }),
    /Command failed|Not a valid object|bad object|unknown revision/i
  );
});
