import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../..', import.meta.url);

test('model registry preserves distinct artifact identities and lineage', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['scripts/verify-model-registry.mjs', 'MODEL_REGISTRY.json'],
    { cwd: ROOT }
  );
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.schema, 'archie-model-registry/v1');
  assert.ok(result.artifacts >= 7);
  assert.ok(result.existing_weight_artifacts >= 3);
  assert.equal(result.admitted_artifacts, 1);
  assert.equal(result.status, 'valid');
});
