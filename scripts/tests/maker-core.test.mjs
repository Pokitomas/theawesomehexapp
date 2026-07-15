import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAKER_LANES,
  assertLease,
  buildIntegratorPrompt,
  buildLanePrompt,
  buildLease,
  codexExecArgs,
  expandCommandArgv,
  leaseMarker,
  leasesOverlap,
  normalizeLeasePaths,
  parseCommandArgv,
  parseLeaseMarker,
  parseMakerArgs,
  pathsOverlap,
  slugify
} from '../maker-core.mjs';

test('Maker exposes four exact read-only assessment lanes', () => {
  assert.deepEqual(MAKER_LANES.map(value => value.id), ['product', 'social', 'operator', 'hostile']);
  assert.equal(new Set(MAKER_LANES.map(value => value.scope)).size, 4);
  for (const lane of MAKER_LANES) assert.match(lane.scope, /Read only/);
});

test('arguments keep the terminal surface intentionally small', () => {
  const parsed = parseMakerArgs(['--base', 'trunk', '--agent', 'command', '--command-json', '["agent"]', 'finish', 'the', 'app']);
  assert.equal(parsed.base, 'trunk');
  assert.equal(parsed.agent, 'command');
  assert.equal(parsed.request, 'finish the app');
  assert.throws(() => parseMakerArgs(['--wat']), /Unknown Maker option/);
  assert.throws(() => parseMakerArgs(['--agent', 'command', 'x']), /requires/);
});

test('lease normalization is prefix-aware and fail-closed', () => {
  assert.deepEqual(normalizeLeasePaths(['./src/**', 'src', 'README.md']), ['README.md', 'src']);
  assert.equal(pathsOverlap('src', 'src/app.mjs'), true);
  assert.equal(pathsOverlap('src/app.mjs', 'scripts/app.mjs'), false);
  assert.equal(leasesOverlap(['src'], ['src/app.mjs']), true);
  assert.equal(leasesOverlap(['public'], ['scripts']), false);
  assert.deepEqual(normalizeLeasePaths([]), ['**']);
  assert.throws(() => normalizeLeasePaths(['../escape']), /traverse/);
  assert.throws(() => normalizeLeasePaths(['src/*.mjs']), /only exact paths/);
});

test('lease marker round-trips one writer and human merge authority', () => {
  const lease = buildLease({
    sessionId: 'abc123',
    request: 'Complete Maker.',
    branch: 'maker/complete-maker-abc123',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    selectedLane: 'operator',
    ownedPaths: ['scripts', '.github/workflows/maker-sprawl.yml'],
    createdAt: '2026-07-15T15:00:00.000Z'
  });
  const parsed = parseLeaseMarker(`${leaseMarker(lease)}\n\nbody`);
  assert.deepEqual(parsed, lease);
  assert.equal(parsed.writer_count, 1);
  assert.equal(parsed.authority.merge, 'human');
  assert.throws(() => assertLease({ ...lease, writer_count: 2 }), /exactly one writer/);
});

test('prompts bind read-only assessors and one isolated writer plan', () => {
  const lane = buildLanePrompt({ request: 'Finish it.', lane: MAKER_LANES[0], head: 'abc' });
  assert.match(lane, /Do not edit/);
  const integrate = buildIntegratorPrompt({ request: 'Finish it.', head: 'abc', reports: [{ lane: 'product' }] });
  assert.match(integrate, /exactly one highest-leverage/);
  assert.match(integrate, /one writer/);
});

test('Codex adapter uses stable non-interactive workspace sandboxes', () => {
  const args = codexExecArgs({ workspace: '/repo', sandbox: 'read-only', outputPath: '/tmp/out.json', schemaPath: '/tmp/schema.json' });
  assert.deepEqual(args.slice(0, 7), ['exec', '--cd', '/repo', '--sandbox', 'read-only', '--ask-for-approval', 'never']);
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('--output-schema'));
  assert.equal(args.at(-1), '-');
});

test('custom agent adapter never invokes a shell string', () => {
  const argv = parseCommandArgv('["agent","--cwd","{workspace}","--role={role}"]');
  assert.deepEqual(expandCommandArgv(argv, { workspace: '/repo', role: 'hostile' }), ['agent', '--cwd', '/repo', '--role=hostile']);
  assert.throws(() => parseCommandArgv('"rm -rf /"'), /JSON array/);
});

test('branch slugs are bounded', () => {
  assert.equal(slugify(' Complete Maker Fully!!! '), 'complete-maker-fully');
  assert.ok(slugify('x'.repeat(200)).length <= 48);
});
