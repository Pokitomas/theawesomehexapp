#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const requiredScalars = Object.freeze({
  repository: 'Pokitomas/theawesomehexapp',
  canonical_branch: 'assembly/recursive-weave-cognition',
  canonical_pr: '188',
  single_ledger: '.frankenstate',
  duplicate_implementation_branches_created: '0',
  duplicate_pull_requests_created: '0',
  merge_performed: 'false',
  live_owner_receipt_found: 'false'
});

function scalar(text, key) {
  const match = String(text).match(new RegExp(`^\\s*${key}:\\s*(.*?)\\s*$`, 'm'));
  return match ? match[1] : null;
}

function fail(message) {
  const error = new Error(message);
  error.code = 'FRANKENSTATE_INVALID';
  throw error;
}

export function validateFrankenstate({ text, trackedPaths, isAncestor }) {
  const value = String(text || '');
  if (!value.endsWith('\n')) fail('.frankenstate must end with a newline');
  const version = Number(scalar(value, 'version'));
  if (!Number.isInteger(version) || version < 35) fail('version must be an integer >= 35');

  for (const [key, expected] of Object.entries(requiredScalars)) {
    const actual = scalar(value, key);
    if (actual !== expected) fail(`${key} must equal ${expected}; received ${actual}`);
  }

  const state = scalar(value, 'state');
  if (!['implementation_complete_pending_exact_head_receipt', 'complete'].includes(state)) {
    fail(`unsupported state ${state}`);
  }

  const owner = scalar(value, 'owner');
  if (!owner || owner === 'heartbeat-audit (claude-sonnet-5, external co-engineer session)') {
    fail('top-level owner must identify the current generation');
  }

  if (/^\s*active_pr:/m.test(value)) fail('stale active_pr schema is forbidden');
  if (/^\s*branch:\s*main\s*$/m.test(value)) fail('stale branch: main claim is forbidden');

  const ledgers = [...trackedPaths].filter(path => path === '.frankenstate' || path.endsWith('/.frankenstate'));
  if (ledgers.length !== 1 || ledgers[0] !== '.frankenstate') {
    fail(`exactly one root .frankenstate must be tracked; found ${JSON.stringify(ledgers)}`);
  }

  const observed = scalar(value, 'observed_head_before_ledger');
  if (!/^[0-9a-f]{40}$/.test(observed || '')) fail('observed_head_before_ledger must be a full commit SHA');
  if (!isAncestor(observed)) fail(`observed head ${observed} is not an ancestor of the tested tree`);

  if (!value.includes('witness_substitution_allowed: false')) fail('witness substitution denial is required');
  if (!value.includes('No model, comment, or MATCHED receipt grants merge authority.')) fail('merge-authority denial is required');

  return Object.freeze({
    schema: 'sideways-frankenstate-verification/v1',
    version,
    repository: scalar(value, 'repository'),
    canonical_branch: scalar(value, 'canonical_branch'),
    canonical_pr: Number(scalar(value, 'canonical_pr')),
    state,
    observed_head_before_ledger: observed,
    ledger_sha256: createHash('sha256').update(value).digest('hex'),
    tracked_ledger: ledgers[0]
  });
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

export function verifyRepositoryFrankenstate() {
  const text = readFileSync(new URL('../.frankenstate', import.meta.url), 'utf8');
  const listed = git(['ls-files']);
  if (listed.status !== 0) fail(`git ls-files failed: ${listed.stderr.trim()}`);
  const trackedPaths = listed.stdout.split(/\r?\n/).filter(Boolean);
  const receipt = validateFrankenstate({
    text,
    trackedPaths,
    isAncestor(sha) {
      return git(['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;
    }
  });
  return {
    ...receipt,
    tested_head: process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']).stdout.trim()
  };
}

function main() {
  try {
    console.log(JSON.stringify(verifyRepositoryFrankenstate(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      schema: 'sideways-frankenstate-verification/v1',
      status: 'failed',
      code: error?.code || 'FRANKENSTATE_ERROR',
      error: String(error?.message || error)
    }, null, 2));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
