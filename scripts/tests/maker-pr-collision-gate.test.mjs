import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePathLease,
  normalizeLeasePath,
  parsePathLease,
  pathPatternCovers,
  pathPatternsOverlap
} from '../maker-pr-collision-gate.mjs';

const SHA = '5bc28784e1634334dacba624d19fcb87ee8c2cd7';

function body(paths, overrides = {}) {
  return `Draft\n\n<!-- sideways-path-lease:v1\n${JSON.stringify({
    version: 'sideways-path-lease/v1',
    base_sha: SHA,
    owner: 'test',
    purpose: 'test lease',
    owned_paths: paths,
    ...overrides
  }, null, 2)}\n-->`;
}

function pr(number, paths, overrides = {}) {
  return {
    number,
    title: overrides.title || `Agent PR ${number}`,
    body: overrides.body ?? body(paths),
    head: { ref: overrides.branch || `agent/lane-${number}` },
    base: { sha: overrides.base_sha || SHA }
  };
}

test('path leases normalize exact files and terminal directory wildcards', () => {
  assert.equal(normalizeLeasePath('./scripts\\gate.mjs'), 'scripts/gate.mjs');
  assert.equal(normalizeLeasePath('studio/manual/**'), 'studio/manual/**');
  assert.throws(() => normalizeLeasePath('../secret'), /invalid lease path/);
  assert.throws(() => normalizeLeasePath('studio/*/file.js'), /terminal \/\*\*/);
  assert.equal(pathPatternCovers('studio/manual/**', 'studio/manual/product/client.js'), true);
  assert.equal(pathPatternCovers('studio/manual/**', 'studio/other.js'), false);
});

test('overlap detection handles exact, parent, child, and disjoint claims', () => {
  assert.equal(pathPatternsOverlap('package.json', 'package.json'), true);
  assert.equal(pathPatternsOverlap('studio/manual/**', 'studio/manual/product/client.js'), true);
  assert.equal(pathPatternsOverlap('studio/**', 'studio/manual/**'), true);
  assert.equal(pathPatternsOverlap('scripts/a.mjs', 'scripts/b.mjs'), false);
});

test('lease parser requires one versioned lease, a full base SHA, and owned paths', () => {
  const lease = parsePathLease(body(['scripts/a.mjs', 'scripts/a.mjs']));
  assert.deepEqual(lease.owned_paths, ['scripts/a.mjs']);
  assert.throws(() => parsePathLease('<!-- sideways-path-lease:v1\n{}\n-->'), /version/);
  assert.throws(() => parsePathLease(body(['scripts/a.mjs'], { base_sha: 'main' })), /full commit SHA/);
  assert.throws(() => parsePathLease(`${body(['a'])}\n${body(['b'])}`), /exactly one/);
});

test('a covered non-overlapping Maker PR clears', () => {
  const current = pr(10, ['scripts/**']);
  const result = evaluatePathLease({
    current,
    changed_files: ['scripts/a.mjs', 'scripts/tests/a.test.mjs'],
    open_pull_requests: [current, pr(11, ['studio/manual/**'])]
  });
  assert.equal(result.status, 'clear');
  assert.deepEqual(result.collisions, []);
  assert.deepEqual(result.uncovered_paths, []);
});

test('uncovered changed paths block the PR', () => {
  const result = evaluatePathLease({
    current: pr(10, ['scripts/a.mjs']),
    changed_files: ['scripts/a.mjs', 'package.json'],
    open_pull_requests: []
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.uncovered_paths, ['package.json']);
});

test('overlapping peer leases block both exact-file and directory collisions', () => {
  const result = evaluatePathLease({
    current: pr(10, ['package.json', 'studio/manual/**']),
    changed_files: ['package.json'],
    open_pull_requests: [pr(11, ['package.json']), pr(12, ['studio/manual/product/client.js'])]
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.collisions.map(value => value.number), [11, 12]);
});

test('unleased or invalid open Maker peers fail closed', () => {
  const result = evaluatePathLease({
    current: pr(10, ['scripts/a.mjs']),
    changed_files: ['scripts/a.mjs'],
    open_pull_requests: [
      pr(11, [], { body: 'no lease' }),
      pr(12, [], { body: '<!-- sideways-path-lease:v1\nnope\n-->' })
    ]
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.invalid_peers.length, 2);
});

test('a moved base SHA invalidates the lease', () => {
  const result = evaluatePathLease({
    current: pr(10, ['scripts/a.mjs'], { base_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    changed_files: ['scripts/a.mjs'],
    open_pull_requests: []
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'stale_base_sha');
});

test('ordinary non-Maker pull requests are outside the gate', () => {
  const result = evaluatePathLease({
    current: { number: 2, title: 'Docs', body: '', head: { ref: 'docs/readme' }, base: { sha: SHA } },
    changed_files: ['README.md'],
    open_pull_requests: []
  });
  assert.equal(result.status, 'not_applicable');
});
