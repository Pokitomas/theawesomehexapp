import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  assertPlanGroundedInRepositoryEvidence,
  collectRepositoryEvidence,
  validateRepositoryEvidence
} from '../maker-archie-repository-evidence.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-evidence-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts', 'tests'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify({ scripts: { 'test:focused': 'node --test scripts/tests/focused.test.mjs' }, dependencies: { pg: '^8.0.0' } }, null, 2)}\n`),
    fs.writeFile(path.join(root, 'scripts', 'runtime.mjs'), 'export const runtime = true;\n'),
    fs.writeFile(path.join(root, 'scripts', 'tests', 'focused.test.mjs'), 'export const witness = true;\n')
  ]);
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Evidence Test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'evidence@example.invalid'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
  const sha = String((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout).trim();
  return { root, sha };
}

test('collects deterministic exact-base repository evidence and grounds existing and new subsystem paths', async t => {
  const { root, sha } = await fixture(t);
  await fs.writeFile(path.join(root, 'scripts', 'runtime.mjs'), 'export const runtime = false; // uncommitted mutation\n');
  const evidence = await collectRepositoryEvidence({ repoRoot: root, baseSha: sha, request: 'repair the runtime and run the focused test' });
  assert.equal(evidence.base_sha, sha);
  assert.equal(evidence.truncated, false);
  assert.ok(evidence.paths.includes('scripts/runtime.mjs'));
  assert.equal(evidence.package_scripts['test:focused'], 'node --test scripts/tests/focused.test.mjs');
  assert.ok(evidence.captured_source_bytes > 0);
  const runtimeSource = evidence.source_files.find(item => item.path === 'scripts/runtime.mjs');
  assert.ok(runtimeSource);
  assert.match(runtimeSource.content, /runtime = true/);
  assert.doesNotMatch(runtimeSource.content, /uncommitted mutation/);
  assert.match(runtimeSource.blob_oid, /^[a-f0-9]{40,64}$/);
  assert.deepEqual(validateRepositoryEvidence(evidence, { expectedBaseSha: sha }), evidence);

  const grounding = assertPlanGroundedInRepositoryEvidence({
    owned_paths: ['scripts/runtime.mjs', 'scripts/new-runtime.mjs'],
    focused_tests: ['npm run test:focused', 'node --test scripts/tests/focused.test.mjs']
  }, evidence);
  assert.equal(grounding.repository_evidence_digest, evidence.evidence_digest);
  assert.deepEqual(grounding.grounded_test_references, ['scripts/tests/focused.test.mjs']);
});

test('fails closed for unknown paths, stale bases, and truncated evidence', async t => {
  const { root, sha } = await fixture(t);
  const evidence = await collectRepositoryEvidence({ repoRoot: root, baseSha: sha });
  assert.throws(() => assertPlanGroundedInRepositoryEvidence({ owned_paths: ['unknown/new.mjs'], focused_tests: [] }, evidence), /not grounded/);
  assert.throws(() => validateRepositoryEvidence(evidence, { expectedBaseSha: 'a'.repeat(40) }), /stale/);
  const truncated = { ...evidence, truncated: true };
  assert.throws(() => validateRepositoryEvidence(truncated), /truncated/);
});
