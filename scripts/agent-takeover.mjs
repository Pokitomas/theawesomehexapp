#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REQUIRED_FILES = Object.freeze([
  'README.md',
  'PROGRAM_ONTOLOGY.md',
  'NATIVE_MAKER.md',
  'package.json',
  'scripts/maker-native-worker.mjs',
]);

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryRun(command, args, cwd) {
  try {
    return run(command, args, cwd);
  } catch {
    return null;
  }
}

export function parseArgs(argv) {
  const options = { json: false, help: false };
  for (const argument of argv) {
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function assessCheckout(cwd = process.cwd()) {
  const repoRoot = tryRun('git', ['rev-parse', '--show-toplevel'], cwd);
  if (!repoRoot) {
    throw new Error('Run this command inside a Git checkout.');
  }

  const branch = run('git', ['branch', '--show-current'], repoRoot) || '(detached)';
  const head = run('git', ['rev-parse', 'HEAD'], repoRoot);
  const originMain = tryRun('git', ['rev-parse', '--verify', 'origin/main'], repoRoot);
  const status = run('git', ['status', '--porcelain=v1'], repoRoot);
  const dirtyPaths = status ? status.split('\n').filter(Boolean) : [];
  const missingFiles = REQUIRED_FILES.filter((file) => !existsSync(path.join(repoRoot, file)));
  const codexProbe = spawnSync('codex', ['--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const codexVersion = codexProbe.status === 0
    ? String(codexProbe.stdout || codexProbe.stderr || '').trim()
    : null;

  const warnings = [];
  if (dirtyPaths.length > 0) {
    warnings.push('Working tree is dirty. Preserve or isolate existing changes before any writer starts.');
  }
  if (branch !== 'main') {
    warnings.push(`Current branch is ${branch}; assessment is safe, but create the implementation branch deliberately from current origin/main.`);
  }
  if (!originMain) {
    warnings.push('origin/main is unavailable locally. Fetch origin before authorizing mutation.');
  } else if (head !== originMain) {
    warnings.push('HEAD differs from origin/main. Fetch and reconcile before authorizing mutation.');
  }
  if (missingFiles.length > 0) {
    warnings.push(`Expected repository files are missing: ${missingFiles.join(', ')}`);
  }
  if (!codexVersion) {
    warnings.push('Codex CLI is not available on PATH. Install it before launching the operator session.');
  }

  const checkoutReadyForMutation =
    missingFiles.length === 0 &&
    dirtyPaths.length === 0 &&
    branch === 'main' &&
    Boolean(originMain) &&
    head === originMain;

  return {
    schema: 'sideways-agent-takeover/v1',
    repoRoot,
    branch,
    head,
    originMain,
    clean: dirtyPaths.length === 0,
    dirtyPaths,
    missingFiles,
    codexInstalled: Boolean(codexVersion),
    codexVersion,
    readyForAssessment: missingFiles.length === 0,
    checkoutReadyForMutation,
    readyForMutation: checkoutReadyForMutation && Boolean(codexVersion),
    warnings,
  };
}

export function buildTakeoverPrompt(assessment) {
  const exactHead = assessment.head || 'UNKNOWN';
  const currentBranch = assessment.branch || 'UNKNOWN';

  return `You are the primary terminal operator for Pokitomas/theawesomehexapp.

Exact checkout at launch:
- branch: ${currentBranch}
- HEAD: ${exactHead}
- mutation-ready: ${assessment.readyForMutation ? 'yes' : 'no'}

PHASE 1 — ASSESSMENT ONLY
Inspect README.md, PROGRAM_ONTOLOGY.md, NATIVE_MAKER.md, package.json, the deployed product surfaces, native Maker implementation, current tests, git history, and live GitHub issue/PR state when available. Do not edit, create branches, or mutate GitHub during this phase. Return a compact architecture map, current product reality, code-local opportunities, external blockers, and collision risks.

PHASE 2 — READ-ONLY PARALLEL DELEGATION
Only after Phase 1 is complete, spawn four read-only subagents and wait for all results:
1. product journey: root reader to private archive, first-run UX, and phone behavior;
2. social reachability: server authority versus visible consumer operations;
3. operator runtime: native Maker, Codex terminal activation, and local/hosted model ergonomics;
4. hostile full-stack review: security, tests, operations, accessibility, network, and storage failure modes.

Each subagent must name inspected files, concrete evidence, one prioritized recommendation, and files it did not mutate. Subagents must not edit the shared worktree.

PHASE 3 — ONE WRITER
Synthesize the four reports, choose the highest-leverage code-local lane, and create exactly one branch named agent/fullstack-takeover from current origin/main. Use one primary writer in that branch. Parallel write-heavy work requires a separate git worktree per writer; never allow two agents to edit the same worktree.

Implement the selected lane end-to-end. Run focused tests plus npm run verify:repository. Review the final diff. Stop with a draft-PR-ready receipt containing exact HEAD, changed files, tests, remaining external blockers, and rollback notes.

AUTHORITY BOUNDARY
Do not merge, deploy, alter secrets, configure external infrastructure, rewrite GitHub Actions authority, force-push, or claim production readiness. Preserve private-archive/public-social/ranking authority boundaries and fail honestly when runtime facts are unavailable.`;
}

function printHelp() {
  process.stdout.write('Usage: node scripts/agent-takeover.mjs [--json]\n\n');
  process.stdout.write('Assesses the local checkout and emits an assessment-first Codex takeover prompt.\n');
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const assessment = assessCheckout(cwd);
  const prompt = buildTakeoverPrompt(assessment);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...assessment, prompt }, null, 2)}\n`);
    return;
  }

  process.stdout.write('SIDEWAYS TERMINAL TAKEOVER\n');
  process.stdout.write(`repo: ${assessment.repoRoot}\n`);
  process.stdout.write(`branch: ${assessment.branch}\n`);
  process.stdout.write(`HEAD: ${assessment.head}\n`);
  process.stdout.write(`clean: ${assessment.clean}\n`);
  process.stdout.write(`codex: ${assessment.codexVersion || 'not installed'}\n`);
  process.stdout.write(`checkout-ready: ${assessment.checkoutReadyForMutation}\n`);
  process.stdout.write(`mutation-ready: ${assessment.readyForMutation}\n`);
  for (const warning of assessment.warnings) {
    process.stdout.write(`warning: ${warning}\n`);
  }
  process.stdout.write('\nPaste the following into Codex after running `codex`:\n\n');
  process.stdout.write(`${prompt}\n`);
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`agent-takeover: ${error.message}\n`);
    process.exitCode = 1;
  }
}
