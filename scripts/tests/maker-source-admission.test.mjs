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
const COORDINATOR_HEAD = 'c'.repeat(40);
const COORDINATOR = 'agent/maker-execution-completion';
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
    mode: 'source_pr',
    issue,
    pull_request: overrides.pull_request ?? issue + 100,
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

function adoptionFor(issue, overrides = {}) {
  const lane = laneFor(issue);
  const head = overrides.head_sha || COORDINATOR_HEAD;
  const lease = leaseFor(issue, {
    branch: overrides.branch || COORDINATOR,
    session_id: `coordinator-adoption-${issue}`,
    ...(overrides.lease || {})
  });
  return {
    repository: 'Pokitomas/theawesomehexapp',
    mode: 'coordinator_adoption',
    issue,
    pull_request: overrides.pull_request ?? null,
    base_sha: overrides.base_sha || BASE,
    head_sha: head,
    branch: overrides.branch || COORDINATOR,
    adopted_by: overrides.adopted_by ?? COORDINATOR,
    adoption_reason: overrides.adoption_reason ?? `Native worker run failed before write; coordinator adopted exact lane #${issue}.`,
    changed_paths: overrides.changed_paths || [...lane.paths],
    body: overrides.body || bodyFor(lease),
    witnesses: overrides.witnesses || [
      { name: 'focused tests', ok: true, head_sha: head, run_id: issue * 100 },
      { name: 'npm run verify:repository', ok: true, head_sha: head, run_id: issue * 100 + 1 }
    ],
    prior_attempts: overrides.prior_attempts || [
      { run_id: issue * 1000, head_sha: BASE, outcome: 'model_or_runtime_error', evidence: `https://github.com/acme/run/${issue}` }
    ],
    claim: `Coordinator implemented ${lane.purpose}.`
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

test('one exact source PR candidate is admitted only with exact paths, lease, and head witnesses', () => {
  const result = validateSourceCandidate(candidateFor(301), { canonical_base: BASE });
  assert.equal(result.admitted, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.candidate.mode, 'source_pr');
  assert.equal(result.candidate.prior_attempts[0].outcome, 'model_or_runtime_error');
});

test('coordinator adoption is admitted only as explicit failed-lane takeover with no fake source PR', () => {
  const result = validateSourceCandidate(adoptionFor(301), { canonical_base: BASE, coordinator_branch: COORDINATOR });
  assert.equal(result.admitted, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.candidate.mode, 'coordinator_adoption');
  assert.equal(result.candidate.pull_request, null);
  assert.equal(result.candidate.adopted_by, COORDINATOR);
  assert.equal(result.candidate.prior_attempts[0].outcome, 'model_or_runtime_error');
});

test('fake coordinator adoption without failed-run evidence or exact branch fails closed', () => {
  const noFailure = validateSourceCandidate(adoptionFor(301, { prior_attempts: [] }), { canonical_base: BASE, coordinator_branch: COORDINATOR });
  assert.match(noFailure.errors.join('\n'), /prior failed worker evidence/);

  const fakeOutcome = validateSourceCandidate(adoptionFor(301, {
    prior_attempts: [{ run_id: 1, head_sha: BASE, outcome: 'success', evidence: 'run:1' }]
  }), { canonical_base: BASE, coordinator_branch: COORDINATOR });
  assert.match(fakeOutcome.errors.join('\n'), /no admissible failed-worker outcome/);

  const wrongCoordinator = validateSourceCandidate(adoptionFor(301, { adopted_by: 'agent/impostor' }), { canonical_base: BASE, coordinator_branch: COORDINATOR });
  assert.match(wrongCoordinator.errors.join('\n'), /must name agent\/maker-execution-completion/);

  const wrongBranch = validateSourceCandidate(adoptionFor(301, { branch: 'maker/fake' }), { canonical_base: BASE, coordinator_branch: COORDINATOR });
  assert.match(wrongBranch.errors.join('\n'), /authoritative integration branch/);

  const fakePr = validateSourceCandidate(adoptionFor(301, { pull_request: 999 }), { canonical_base: BASE, coordinator_branch: COORDINATOR });
  assert.match(fakePr.errors.join('\n'), /must not fabricate a source PR/);
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

  assert.throws(() => validateSourceCandidate(candidateFor(301, { changed_paths: ['../escape.mjs'] })), /Invalid repository path/);
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

test('stale bases, no-op heads, missing PR identity, non-draft sources, and missing exact-head proof are rejected', () => {
  const stale = validateSourceCandidate(candidateFor(303, { base_sha: '2'.repeat(40) }), { canonical_base: BASE });
  assert.match(stale.errors.join('\n'), /base mismatch|lease base differs/);

  const noPatch = validateSourceCandidate(candidateFor(303, { head_sha: BASE }), { canonical_base: BASE });
  assert.match(noPatch.errors.join('\n'), /head equals base/);

  const noPr = validateSourceCandidate(candidateFor(303, { pull_request: null }), { canonical_base: BASE });
  assert.match(noPr.errors.join('\n'), /PR number is required/);

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

test('partial admission preserves coordinator order, source mode, and negative attempts', () => {
  const inputs = [candidateFor(312), adoptionFor(301), candidateFor(309)];
  const result = admitSourceCandidates(inputs, { canonical_base: BASE, coordinator_branch: COORDINATOR });
  assert.equal(result.admitted, true);
  assert.deepEqual(result.receipt.integration_order, [301, 309, 312]);
  assert.deepEqual(result.candidates.map(value => value.issue), [301, 309, 312]);
  assert.equal(result.receipt.candidates[0].mode, 'coordinator_adoption');
  assert.equal(result.receipt.candidates[0].prior_attempts[0].outcome, 'model_or_runtime_error');
  assert.match(result.receipt.receipt_digest, /^[0-9a-f]{64}$/);
});

test('multiple coordinator-adopted lanes may share one exact integration head without hiding path collisions', () => {
  const result = admitSourceCandidates([adoptionFor(301), adoptionFor(302)], {
    canonical_base: BASE,
    coordinator_branch: COORDINATOR
  });
  assert.equal(result.admitted, true);
  assert.deepEqual(result.candidates.map(value => value.issue), [301, 302]);
  assert.equal(new Set(result.candidates.map(value => value.head_sha)).size, 1);
});

test('require-all mode refuses a persuasive partial sprawl', () => {
  const result = admitSourceCandidates([adoptionFor(301), adoptionFor(302)], {
    canonical_base: BASE,
    coordinator_branch: COORDINATOR,
    require_all: true
  });
  assert.equal(result.admitted, false);
  assert.match(result.errors.join('\n'), /missing admitted source lane #315/);
});

test('all fifteen exact candidates admit in deterministic integration order with mixed source modes', () => {
  const scrambled = [...PLATFORM_LANES].reverse().map(lane => lane.issue <= 302 ? adoptionFor(lane.issue) : candidateFor(lane.issue));
  const first = admitSourceCandidates(scrambled, { canonical_base: BASE, coordinator_branch: COORDINATOR, require_all: true });
  const second = admitSourceCandidates([...scrambled].reverse(), { canonical_base: BASE, coordinator_branch: COORDINATOR, require_all: true });
  assert.equal(first.admitted, true);
  assert.deepEqual(first.receipt.integration_order, INTEGRATION_ORDER);
  assert.deepEqual(first.candidates.map(value => value.issue), INTEGRATION_ORDER);
  assert.equal(first.receipt.candidates[0].mode, 'coordinator_adoption');
  assert.equal(first.receipt.candidates[2].mode, 'source_pr');
  assert.equal(first.receipt.receipt_digest, second.receipt.receipt_digest);
});

test('duplicate source PR heads and candidate path collisions remain visible', () => {
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

test('receipt digests change when source or adoption evidence changes', () => {
  const first = admitSourceCandidates([adoptionFor(301)], { canonical_base: BASE, coordinator_branch: COORDINATOR });
  const changed = adoptionFor(301, {
    prior_attempts: [{ run_id: 999, head_sha: BASE, outcome: 'planning_blocked', evidence: 'run:999' }]
  });
  const second = admitSourceCandidates([changed], { canonical_base: BASE, coordinator_branch: COORDINATOR });
  assert.notEqual(first.receipt.receipt_digest, second.receipt.receipt_digest);
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
