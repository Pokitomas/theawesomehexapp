import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTEGRATION_ORDER,
  PLATFORM_LANES,
  admitSourceCandidates,
  assertPlatformLaneMap,
  digest,
  parseLeaseMarker,
  validateSourceCandidate
} from '../maker-source-admission.mjs';

const BASE = '1'.repeat(40);
const headFor = issue => Number(issue).toString(16).padStart(40, '0').slice(-40);
const laneFor = issue => PLATFORM_LANES.find(value => value.issue === issue);

function leaseFor(issue, overrides = {}) {
  const lane = laneFor(issue);
  return {
    schema: 'sideways-maker-lease/v1',
    session_id: `issue-${issue}-test`,
    base_branch: 'main',
    base_sha: BASE,
    branch: `maker/issue-${issue}-test-1`,
    writer_count: 1,
    owned_paths: [...lane.paths],
    authority: { merge: 'human', deploy: 'human' },
    ...overrides
  };
}

function bodyFor(lease) {
  return `Source receipt\n\n<!-- sideways-maker-lease:v1\n${JSON.stringify(lease)}\n-->`;
}

function candidateFor(issue, overrides = {}) {
  const lane = laneFor(issue);
  const lease = leaseFor(issue, overrides.lease || {});
  const head = overrides.head_sha || headFor(issue);
  return {
    repository: 'Pokitomas/theawesomehexapp',
    issue,
    pull_request: issue + 100,
    base_sha: overrides.base_sha || BASE,
    head_sha: head,
    branch: overrides.branch || lease.branch,
    draft: overrides.draft ?? true,
    mergeable: overrides.mergeable ?? true,
    changed_paths: overrides.changed_paths || [...lane.paths],
    body: overrides.body || bodyFor(lease),
    witnesses: overrides.witnesses || [
      { name: 'focused tests', ok: true, head_sha: head, run_id: issue * 10 },
      { name: 'npm run verify:repository', ok: true, head_sha: head, run_id: issue * 10 + 1 }
    ],
    prior_attempts: overrides.prior_attempts || [
      { run_id: issue, head_sha: BASE, outcome: 'model_or_runtime_error', evidence: `run:${issue}` }
    ],
    claim: `Implemented ${lane.purpose}.`
  };
}

test('platform lane map has one owner for every path and a total integration order', () => {
  const summary = assertPlatformLaneMap();
  assert.equal(summary.lanes, 15);
  assert.equal(summary.order.length, 15);
  assert.equal(new Set(summary.order).size, 15);
  assert.equal(summary.order.at(-1), 312);
  assert.ok(summary.paths >= 46);
});

test('lease marker parser selects the final valid Maker marker', () => {
  const valid = leaseFor(301);
  const parsed = parseLeaseMarker(`<!-- sideways-maker-lease:v1\nnot json\n-->\n${bodyFor(valid)}`);
  assert.equal(parsed.base_sha, BASE);
  assert.equal(parsed.branch, valid.branch);
  assert.deepEqual(parsed.owned_paths, [...valid.owned_paths].sort());
});

test('one exact candidate is admitted only with exact paths, lease, and head witnesses', () => {
  const result = validateSourceCandidate(candidateFor(301), { canonical_base: BASE });
  assert.equal(result.admitted, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.candidate.prior_attempts[0].outcome, 'model_or_runtime_error');
});

test('extra, missing, and escaped paths fail closed', () => {
  const extra = validateSourceCandidate(candidateFor(301, {
    changed_paths: [...laneFor(301).paths, 'package.json']
  }), { canonical_base: BASE });
  assert.equal(extra.admitted, false);
  assert.match(extra.errors.join('\n'), /changed paths differ/);

  const missing = validateSourceCandidate(candidateFor(301, {
    changed_paths: laneFor(301).paths.filter(value => !value.includes('/tests/'))
  }), { canonical_base: BASE });
  assert.equal(missing.admitted, false);
  assert.match(missing.errors.join('\n'), /changed paths differ|missing focused test/);

  assert.throws(() => candidateFor(301, { changed_paths: ['../escape.mjs'] }) && validateSourceCandidate(candidateFor(301, { changed_paths: ['../escape.mjs'] })), /Invalid repository path/);
});

test('lease mismatch, multiple writers, and widened merge authority are rejected', () => {
  const wrongLease = validateSourceCandidate(candidateFor(302, {
    lease: { owned_paths: ['package.json'] }
  }), { canonical_base: BASE });
  assert.equal(wrongLease.admitted, false);
  assert.match(wrongLease.errors.join('\n'), /lease paths differ/);

  const multiple = validateSourceCandidate(candidateFor(302, {
    lease: { writer_count: 2 }
  }), { canonical_base: BASE });
  assert.match(multiple.errors.join('\n'), /writer_count/);

  const widened = validateSourceCandidate(candidateFor(302, {
    lease: { authority: { merge: 'worker', deploy: 'human' } }
  }), { canonical_base: BASE });
  assert.match(widened.errors.join('\n'), /widen merge\/deploy authority/);
});

test('stale bases, no-op heads, non-draft sources, and missing exact-head proof are rejected', () => {
  const stale = validateSourceCandidate(candidateFor(303, { base_sha: '2'.repeat(40) }), { canonical_base: BASE });
  assert.match(stale.errors.join('\n'), /base mismatch|lease base differs/);

  const noPatch = validateSourceCandidate(candidateFor(303, { head_sha: BASE }), { canonical_base: BASE });
  assert.match(noPatch.errors.join('\n'), /head equals base/);

  const ready = validateSourceCandidate(candidateFor(303, { draft: false }), { canonical_base: BASE });
  assert.match(ready.errors.join('\n'), /must remain draft/);

  const staleWitness = validateSourceCandidate(candidateFor(303, {
    witnesses: [{ name: 'focused tests', ok: true, head_sha: 'f'.repeat(40), run_id: 1 }]
  }), { canonical_base: BASE });
  assert.match(staleWitness.errors.join('\n'), /no exact-head witness/);
});

test('failed witnesses and scaffolding-only claims cannot become admission evidence', () => {
  const failed = validateSourceCandidate(candidateFor(304, {
    witnesses: [{ name: 'phone test', ok: false, head_sha: headFor(304), run_id: 1 }]
  }), { canonical_base: BASE });
  assert.match(failed.errors.join('\n'), /witnesses failed/);

  const noTests = validateSourceCandidate(candidateFor(304, {
    witnesses: [{ name: 'design receipt', ok: true, head_sha: headFor(304), run_id: 1 }]
  }), { canonical_base: BASE });
  assert.match(noTests.errors.join('\n'), /no test or repository verification/);
});

test('partial admission preserves the coordinator order and negative attempts', () => {
  const inputs = [candidateFor(312), candidateFor(301), candidateFor(309)];
  const result = admitSourceCandidates(inputs, { canonical_base: BASE });
  assert.equal(result.admitted, true);
  assert.deepEqual(result.receipt.integration_order, [301, 309, 312]);
  assert.deepEqual(result.candidates.map(value => value.issue), [301, 309, 312]);
  assert.equal(result.receipt.candidates[0].prior_attempts[0].outcome, 'model_or_runtime_error');
  assert.match(result.receipt.receipt_digest, /^[0-9a-f]{64}$/);
});

test('require-all mode refuses a persuasive partial sprawl', () => {
  const result = admitSourceCandidates([candidateFor(301), candidateFor(302)], {
    canonical_base: BASE,
    require_all: true
  });
  assert.equal(result.admitted, false);
  assert.match(result.errors.join('\n'), /missing admitted source lane #315/);
});

test('all fifteen exact candidates admit in deterministic integration order', () => {
  const scrambled = [...PLATFORM_LANES].reverse().map(lane => candidateFor(lane.issue));
  const first = admitSourceCandidates(scrambled, { canonical_base: BASE, require_all: true });
  const second = admitSourceCandidates([...scrambled].reverse(), { canonical_base: BASE, require_all: true });
  assert.equal(first.admitted, true);
  assert.deepEqual(first.receipt.integration_order, INTEGRATION_ORDER);
  assert.deepEqual(first.candidates.map(value => value.issue), INTEGRATION_ORDER);
  assert.equal(first.receipt.receipt_digest, second.receipt.receipt_digest);
});

test('duplicate heads and candidate collisions remain visible even when individual receipts look valid', () => {
  const duplicate = candidateFor(302, { head_sha: headFor(301) });
  duplicate.witnesses = duplicate.witnesses.map(value => ({ ...value, head_sha: headFor(301) }));
  const duplicateResult = admitSourceCandidates([candidateFor(301), duplicate], { canonical_base: BASE });
  assert.equal(duplicateResult.admitted, false);
  assert.match(duplicateResult.errors.join('\n'), /duplicate source head/);

  const custom = [
    { issue: 1, purpose: 'one', paths: ['scripts/one.mjs', 'scripts/tests/one.test.mjs'] },
    { issue: 2, purpose: 'two', paths: ['scripts/one.mjs', 'scripts/tests/two.test.mjs'] }
  ];
  assert.throws(() => assertPlatformLaneMap(custom, [1, 2]), /Source lane collision/);
});

test('receipt digests change when source evidence changes', () => {
  const first = admitSourceCandidates([candidateFor(301)], { canonical_base: BASE });
  const changed = candidateFor(301, { prior_attempts: [{ run_id: 999, head_sha: BASE, outcome: 'blocked' }] });
  const second = admitSourceCandidates([changed], { canonical_base: BASE });
  assert.notEqual(first.receipt.receipt_digest, second.receipt.receipt_digest);
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
