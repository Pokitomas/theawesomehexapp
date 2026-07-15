import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assessCheckout,
  buildTakeoverPrompt,
  parseArgs,
} from '../agent-takeover.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createFixtureRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'sideways-takeover-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Sideways Test');
  git(repo, 'config', 'user.email', 'sideways@example.invalid');

  for (const file of [
    'README.md',
    'PROGRAM_ONTOLOGY.md',
    'NATIVE_MAKER.md',
    'package.json',
    'scripts/maker-native-worker.mjs',
  ]) {
    const target = path.join(repo, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${file}\n`);
  }

  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

test('parseArgs accepts only documented switches', () => {
  assert.deepEqual(parseArgs([]), { json: false, help: false });
  assert.deepEqual(parseArgs(['--json']), { json: true, help: false });
  assert.deepEqual(parseArgs(['-h']), { json: false, help: true });
  assert.throws(() => parseArgs(['--launch']), /Unknown argument/);
});

test('assessment distinguishes a clean exact main checkout from dirty state', () => {
  const repo = createFixtureRepo();
  const clean = assessCheckout(repo);
  assert.equal(clean.branch, 'main');
  assert.equal(clean.clean, true);
  assert.equal(clean.readyForAssessment, true);
  assert.equal(clean.readyForMutation, true);

  writeFileSync(path.join(repo, 'README.md'), 'changed\n');
  const dirty = assessCheckout(repo);
  assert.equal(dirty.clean, false);
  assert.equal(dirty.readyForMutation, false);
  assert.match(dirty.warnings.join('\n'), /Working tree is dirty/);
});

test('prompt enforces assessment before spawning and one-writer mutation', () => {
  const prompt = buildTakeoverPrompt({
    branch: 'main',
    head: '0123456789abcdef',
    readyForMutation: true,
  });

  assert.match(prompt, /PHASE 1 — ASSESSMENT ONLY/);
  assert.match(prompt, /Only after Phase 1 is complete, spawn four read-only subagents/);
  assert.match(prompt, /wait for all results/);
  assert.match(prompt, /exactly one branch named agent\/fullstack-takeover/);
  assert.match(prompt, /never allow two agents to edit the same worktree/);
  assert.match(prompt, /npm run verify:repository/);
  assert.match(prompt, /Do not merge, deploy, alter secrets/);
});
