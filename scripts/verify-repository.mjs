#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const manifestPath = new URL('../audit/repository-verification.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function checkedHeadSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function tail(value, limit = 6000) {
  const text = String(value || '');
  return text.length <= limit ? text : text.slice(-limit);
}

const checkedHead = checkedHeadSha();
const receipt = {
  schema: 'sideways-repository-verification/v1',
  repository: process.env.GITHUB_REPOSITORY || 'Pokitomas/theawesomehexapp',
  checked_head_sha: checkedHead,
  candidate_head_sha: process.env.CANDIDATE_HEAD_SHA || checkedHead,
  manifest_version: manifest.version,
  node: process.version,
  started_at: new Date().toISOString(),
  suites: [],
  external_suites: (manifest.external_suites || []).map(id => ({ id, status: 'separate-workflow' }))
};

let failed = false;
for (const suite of manifest.suites || []) {
  const [command, ...args] = suite.command || [];
  const started = Date.now();
  process.stdout.write(`\n[repository-gate] ${suite.id}: ${[command, ...args].join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: new URL('..', import.meta.url),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const status = result.status === 0 ? 'passed' : 'failed';
  receipt.suites.push({
    id: suite.id,
    command: [command, ...args],
    status,
    exit_code: result.status ?? 1,
    duration_ms: Date.now() - started,
    ...(status === 'failed' ? {
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr)
    } : {})
  });
  if (status === 'failed') failed = true;
}

receipt.finished_at = new Date().toISOString();
receipt.status = failed ? 'failed' : 'passed';
const output = process.env.REPOSITORY_VERIFICATION_RECEIPT || 'repository-verification.json';
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`\n${JSON.stringify(receipt, null, 2)}`);
if (failed) process.exitCode = 1;
