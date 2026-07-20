import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEventTriggeredRescan,
  evictSupersededAttention,
  parseExecutiveLeaseMarker,
  selectCanonicalInvestigations,
  synthesizeExecutiveLiveState
} from '../maker-executive-live-state.mjs';

const MAIN = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const NOW = '2026-07-20T08:30:00.000Z';
const leaseBody = `<!-- sideways-maker-lease:v1\n${JSON.stringify({
  schema: 'sideways-maker-lease/v1', session_id: 's1', branch: 'maker/one', base_branch: 'main', base_sha: MAIN,
  owned_paths: ['scripts/live/**'], writer_count: 1, authority: { merge: 'human', deploy: 'human' }
})}\n-->`;

function source(overrides = {}) {
  return {
    source_id: 'github', kind: 'repository', repository: 'owner/repo', main_sha: MAIN, observed_at: '2026-07-20T08:29:30.000Z',
    pulls: [{ id: '680', head_sha: HEAD, state: 'open', body: leaseBody }],
    issues: [{ id: '679', state: 'open' }], checks: [], jobs: [], runners: [], artifacts: [], datasets: [], checkpoints: [], receipts: [], deployments: [], promotion_states: [], reviews: [], leases: [],
    authority: { write: 'granted', merge: 'human' }, ...overrides
  };
}

test('synthesizes exact live state, extracts leases, deduplicates identical evidence, and defaults model promotion', () => {
  const result = synthesizeExecutiveLiveState({
    repository: 'owner/repo', main_sha: MAIN, observed_at: NOW,
    sources: [
      source({ artifacts: [{ id: 'model:1', kind: 'model', artifact_digest: 'd'.repeat(64) }] }),
      { ...source({ source_id: 'ci', kind: 'ci', pulls: [], issues: [], authority: {}, checks: [{ id: 'check:1', status: 'success' }], artifacts: [{ id: 'model:1', kind: 'model', artifact_digest: 'd'.repeat(64) }] }) }
    ]
  });
  assert.equal(result.snapshot.main_sha, MAIN);
  assert.equal(result.snapshot.leases[0].id, 'lease:pr:680');
  assert.deepEqual(result.snapshot.leases[0].owned_paths, ['scripts/live/**']);
  assert.equal(result.snapshot.artifacts.length, 1);
  assert.deepEqual(result.snapshot.promotion_states, [{ id: 'promotion:model:1', state: 'promotion:not-admitted', subject_id: 'model:1' }]);
  assert.match(result.synthesis_receipt.synthesis_digest, /^[0-9a-f]{64}$/);
});

test('lease markers fail closed on writer count and paths', () => {
  assert.equal(parseExecutiveLeaseMarker('none'), null);
  assert.throws(() => parseExecutiveLeaseMarker(`<!-- sideways-maker-lease:v1\n${JSON.stringify({ schema: 'sideways-maker-lease/v1', base_sha: MAIN, branch: 'x', writer_count: 2, owned_paths: ['x'] })}\n-->`, { id: '1' }), /exactly one writer/);
  assert.throws(() => parseExecutiveLeaseMarker(`<!-- sideways-maker-lease:v1\n${JSON.stringify({ schema: 'sideways-maker-lease/v1', base_sha: MAIN, branch: 'x', writer_count: 1, owned_paths: ['../x'] })}\n-->`, { id: '1' }), /Invalid lease path/);
});

test('rejects stale, mismatched, and conflicting source state', () => {
  assert.throws(() => synthesizeExecutiveLiveState({ repository: 'owner/repo', main_sha: MAIN, observed_at: NOW, max_source_age_ms: 1000, sources: [source({ observed_at: '2026-07-20T08:00:00.000Z' })] }), /stale by/);
  assert.throws(() => synthesizeExecutiveLiveState({ repository: 'owner/repo', main_sha: NEXT, observed_at: NOW, sources: [source()] }), /stale main SHA/);
  assert.throws(() => synthesizeExecutiveLiveState({ repository: 'owner/repo', main_sha: MAIN, observed_at: NOW, sources: [source(), source({ source_id: 'other', issues: [{ id: '679', state: 'closed' }], authority: {} })] }), /Conflicting live state/);
  assert.throws(() => synthesizeExecutiveLiveState({ repository: 'owner/repo', main_sha: MAIN, observed_at: NOW, sources: [source(), source({ source_id: 'other', pulls: [], issues: [], authority: { write: 'denied' } })] }), /Conflicting authority/);
});

test('event-triggered rescans inspect only changed collections and rebind exact-head watchpoints', () => {
  const before = synthesizeExecutiveLiveState({ repository: 'owner/repo', main_sha: MAIN, observed_at: NOW, sources: [source()] }).snapshot;
  const after = synthesizeExecutiveLiveState({ repository: 'owner/repo', main_sha: MAIN, observed_at: '2026-07-20T08:31:00.000Z', sources: [source({ observed_at: '2026-07-20T08:30:30.000Z', checks: [{ id: 'check:1', status: 'failure' }] })] }).snapshot;
  const rescan = buildEventTriggeredRescan({
    previous_snapshot: before, current_snapshot: after,
    watchpoints: [{ id: 'mutation-gate', source_sha: MAIN, collections: ['checks', 'leases'], identities: { checks: ['check:1'] }, mutation_surfaces: ['scripts/live/**'] }]
  });
  assert.deepEqual(rescan.inspect_collections, ['checks']);
  assert.equal(rescan.triggered_watchpoints[0].exact_head, MAIN);
  assert.deepEqual(rescan.triggered_watchpoints[0].changed, { checks: ['check:1'] });
  assert.throws(() => buildEventTriggeredRescan({ previous_snapshot: before, current_snapshot: after, watchpoints: [{ id: 'stale', source_sha: NEXT, collections: ['checks'] }] }), /stale/);
});

test('main-head changes trigger exact-head watchpoints without invented collection changes', () => {
  const before = synthesizeExecutiveLiveState({ repository: 'owner/repo', main_sha: MAIN, observed_at: NOW, sources: [source()] }).snapshot;
  const nextSource = source({ main_sha: NEXT, observed_at: '2026-07-20T08:30:30.000Z', pulls: [] });
  const after = synthesizeExecutiveLiveState({ repository: 'owner/repo', main_sha: NEXT, observed_at: '2026-07-20T08:31:00.000Z', sources: [nextSource] }).snapshot;
  const rescan = buildEventTriggeredRescan({ previous_snapshot: before, current_snapshot: after, watchpoints: [{ id: 'head', source_sha: MAIN, collections: [], mutation_surfaces: ['**'] }] });
  assert.equal(rescan.triggered_watchpoints[0].reason, 'repository-head-changed');
  assert.equal(rescan.triggered_watchpoints[0].exact_head, NEXT);
});

test('overlapping investigations collapse to one canonical lane', () => {
  const result = selectCanonicalInvestigations([
    { id: 'a', hypothesis_key: 'same-root-cause', source_sha: MAIN, owned_paths: ['scripts/live/**'], status: 'pending', evidence_count: 1, created_at: '2026-07-20T08:00:00Z' },
    { id: 'b', hypothesis_key: 'same-root-cause', source_sha: MAIN, owned_paths: ['scripts/live/file.mjs'], status: 'running', evidence_count: 0, created_at: '2026-07-20T08:05:00Z' },
    { id: 'c', hypothesis_key: 'same-root-cause', source_sha: MAIN, owned_paths: ['scripts/live/nested/**'], status: 'ready', evidence_count: 2, created_at: '2026-07-20T08:10:00Z' },
    { id: 'd', hypothesis_key: 'different', source_sha: MAIN, owned_paths: ['docs/live.md'], status: 'ready', evidence_count: 2, created_at: '2026-07-20T08:10:00Z' }
  ], { main_sha: MAIN });
  assert.deepEqual(result.canonical.map(value => value.id), ['b', 'd']);
  assert.deepEqual(result.terminated, [
    { canonical_lane_id: 'b', id: 'a', reason: 'duplicate-investigation', status: 'terminated' },
    { canonical_lane_id: 'b', id: 'c', reason: 'duplicate-investigation', status: 'terminated' }
  ]);
});

test('attention eviction removes stale heads, superseded branches, stale logs, and disproven assumptions', () => {
  const result = evictSupersededAttention([
    { id: 'keep', source_sha: MAIN, branch: 'maker/live' },
    { id: 'head', source_sha: NEXT },
    { id: 'branch', source_sha: MAIN, branch: 'maker/old' },
    { id: 'hypothesis', source_sha: MAIN, hypothesis_key: 'false' },
    { id: 'log', source_sha: MAIN, expires_at: '2026-07-20T08:00:00Z' }
  ], { current_main_sha: MAIN, active_branches: ['maker/live'], disproven_hypotheses: ['false'], now: NOW });
  assert.deepEqual(result.kept.map(value => value.id), ['keep']);
  assert.deepEqual(result.evicted.map(value => value.eviction_reason).sort(), ['disproven-assumption', 'stale-head', 'stale-log', 'superseded-branch']);
});
