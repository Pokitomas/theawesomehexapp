import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = new URL('../../.github/workflows/maker-sprawl.yml', import.meta.url);

test('Maker Actions owns collision and verification sprawl without write authority', async () => {
  const source = await readFile(workflow, 'utf8');
  const top = source.match(/^permissions:\n([\s\S]*?)\nconcurrency:/m)?.[1] || '';
  assert.match(top, /^  contents: read$/m);
  assert.doesNotMatch(source, /^\s+(?:contents|pull-requests|issues): write$/m);
  assert.match(source, /startsWith\(github\.head_ref, 'maker\/'\)/);
  assert.match(source, /writer_count !== 1/);
  assert.match(source, /github\.paginate\(github\.rest\.pulls\.list/);
  assert.match(source, /leasesOverlap\(current, lease\)/);
  assert.match(source, /fail-fast: false/);
  for (const lane of ['product', 'social', 'operator', 'hostile']) assert.match(source, new RegExp(`lane: ${lane}`));
});

test('Maker candidate checkout is exact and credential-free', async () => {
  const source = await readFile(workflow, 'utf8');
  assert.match(source, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(source, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /npm ci --ignore-scripts/);
});
