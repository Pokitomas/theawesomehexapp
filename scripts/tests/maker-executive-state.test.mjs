import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFreshSnapshot,
  assertLaneCompletion,
  assertMemoryFresh,
  assertPlanValid,
  buildAttentionQueue,
  buildExecutivePlan,
  diffExecutiveSnapshots,
  enumerateLegalTransitions,
  normalizeExecutiveSnapshot,
  normalizeLaneMemory,
  pathsOverlap,
  rankExecutableActions
} from '../maker-executive-state.mjs';

const MAIN = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const RECEIPT = 'c'.repeat(64);
const observed = '2026-07-20T08:00:00.000Z';

function snapshot(overrides = {}) {
  return {
    repository: 'owner/repo',
    main_sha: MAIN,
    observed_at: observed,
    pulls: [{ id: '678', head_sha: 'd'.repeat(40), state: 'open' }],
    leases: [{ id: 'lease:reasoner', owned_paths: ['foundry/archie-reasoner/**'], status: 'active' }],
    issues: [], reviews: [], checks: [], jobs: [], runners: [], artifacts: [], datasets: [], checkpoints: [], receipts: [], deployments: [],
    promotion_states: [{ id: 'model:one', state: 'promotion:not-admitted' }],
    authority: { write: 'granted', merge: 'human', deploy: 'human' },
    ...overrides
  };
}

test('snapshot normalization is deterministic and stale state is rejected', () => {
  const left = normalizeExecutiveSnapshot(snapshot());
  const right = normalizeExecutiveSnapshot({ ...snapshot(), pulls: [...snapshot().pulls].reverse() });
  assert.equal(left.snapshot_digest, right.snapshot_digest);
  assert.equal(assertFreshSnapshot(left, { expected_main_sha: MAIN, now: '2026-07-20T08:01:00.000Z' }).main_sha, MAIN);
  assert.throws(() => assertFreshSnapshot(left, { expected_main_sha: NEXT, now: '2026-07-20T08:01:00.000Z' }), /Stale executive snapshot/);
  assert.throws(() => normalizeExecutiveSnapshot(snapshot({ main_sha: `${MAIN}0` })), /exact 40-character/);
  assert.throws(() => assertFreshSnapshot(left, { expected_main_sha: MAIN, now: '2026-07-20T09:00:00.000Z', max_age_ms: 1000 }), /age/);
});

test('state delta reports only changed live collections', () => {
  const before = snapshot();
  const after = snapshot({
    main_sha: NEXT,
    checks: [{ id: 'check:test', status: 'failed' }],
    pulls: [{ id: '678', head_sha: 'e'.repeat(40), state: 'open' }]
  });
  const delta = diffExecutiveSnapshots(before, after);
  assert.equal(delta.main_sha_changed, true);
  assert.deepEqual(delta.changed_collections, ['checks', 'pulls']);
  assert.deepEqual(delta.changed.checks.added, ['check:test']);
  assert.deepEqual(delta.changed.pulls.updated, ['678']);
});

test('dependency graph is exact-head bound, acyclic, and ranks executable actions', () => {
  const resolved = normalizeExecutiveSnapshot(snapshot());
  const plan = buildExecutivePlan({
    snapshot: resolved,
    lanes: [
      {
        id: 'state', owned_paths: ['scripts/maker-executive-state.mjs'], terminal_condition: 'snapshot contract passes',
        required_authority: ['write'], status: 'completed', unblock_value: 10, evidence_yield: 10
      },
      {
        id: 'planning', dependencies: ['state'], owned_paths: ['scripts/maker-executive-plan.mjs'], terminal_condition: 'plan contract passes',
        required_authority: ['write'], required_evidence: ['state-contract'], unblock_value: 8, evidence_yield: 7, compute_cost: 1
      },
      {
        id: 'release', dependencies: ['planning'], owned_paths: ['scripts/maker-release.mjs'], terminal_condition: 'release gate passes',
        required_authority: ['deploy'], unblock_value: 20, evidence_yield: 2, collision_risk: 3
      }
    ],
    created_at: observed
  });
  assert.deepEqual(plan.topological_order, ['state', 'planning', 'release']);
  const transitions = enumerateLegalTransitions({ plan, snapshot: resolved, completed_evidence: { 'state-contract': true } });
  assert.equal(transitions.find(value => value.lane_id === 'planning').legal_action, 'start');
  assert.equal(transitions.find(value => value.lane_id === 'release').reason, 'dependencies incomplete');
  assert.deepEqual(rankExecutableActions({ plan, snapshot: resolved, completed_evidence: { 'state-contract': true } }).map(value => value.lane_id), ['planning']);
  assert.throws(() => buildExecutivePlan({ snapshot: resolved, lanes: [
    { id: 'a', dependencies: ['b'], owned_paths: ['a'], terminal_condition: 'a' },
    { id: 'b', dependencies: ['a'], owned_paths: ['b'], terminal_condition: 'b' }
  ] }), /cycle/);
});

test('plan invalidates on new head or lease collision', () => {
  const resolved = normalizeExecutiveSnapshot(snapshot());
  const plan = buildExecutivePlan({ snapshot: resolved, lanes: [{ id: 'kernel', owned_paths: ['scripts/executive/**'], terminal_condition: 'verified' }], created_at: observed });
  assert.equal(assertPlanValid({ plan, snapshot: resolved }), true);
  assert.throws(() => assertPlanValid({ plan, snapshot: normalizeExecutiveSnapshot(snapshot({ main_sha: NEXT })) }), /snapshot digest changed/);
  assert.throws(() => assertPlanValid({ plan, snapshot: resolved, active_leases: [{ owned_paths: ['scripts/executive/file.mjs'] }] }), /lease collision/);
  assert.equal(pathsOverlap('scripts/executive/**', 'scripts/executive/file.mjs'), true);
  assert.equal(pathsOverlap('scripts/executive/**', 'docs/executive.md'), false);
});

test('lane memory expires with mutable repository truth and preserves negative results', () => {
  const memory = normalizeLaneMemory({
    lane_id: 'kernel', source_sha: MAIN, owned_paths: ['scripts/executive/**'],
    negative_results: [{ hypothesis: 'full narration improves throughput', result: 'rejected' }],
    provenance: [{ type: 'commit', id: MAIN }], next_action: 'run exact-head contract', expires_at: '2026-07-20T09:00:00.000Z'
  });
  assert.equal(memory.negative_results.length, 1);
  assert.equal(assertMemoryFresh(memory, { main_sha: MAIN, now: '2026-07-20T08:30:00.000Z' }).lane_id, 'kernel');
  assert.throws(() => assertMemoryFresh(memory, { main_sha: NEXT, now: '2026-07-20T08:30:00.000Z' }), /repository head changed/);
  assert.throws(() => assertMemoryFresh(memory, { main_sha: MAIN, now: '2026-07-20T10:00:00.000Z' }), /expired by time/);
});

test('attention queue prioritizes blockers and completion requires receipt, evidence, and observed terminal state', () => {
  const queue = buildAttentionQueue([
    { id: 'lease', type: 'expiring_lease', summary: 'lease expires soon', source: 'lease:1', expires_at: '2026-07-20T08:10:00.000Z' },
    { id: 'blocker', type: 'blocker', summary: 'runner unavailable', source: 'runner:gpu' }
  ], observed);
  assert.equal(queue[0].id, 'blocker');
  const lane = { id: 'kernel', terminal_condition: 'contract passes', required_evidence: ['independent-test'] };
  assert.throws(() => assertLaneCompletion({ lane, mutation_receipt: { status: 'ready', receipt_digest: RECEIPT }, evidence: [], terminal_observed: true }), /missing evidence/);
  assert.deepEqual(assertLaneCompletion({
    lane,
    mutation_receipt: { status: 'ready', receipt_digest: RECEIPT },
    evidence: [{ type: 'independent-test', artifact: 'test-output' }],
    terminal_observed: true
  }), { lane_id: 'kernel', status: 'completed', receipt_digest: RECEIPT });
});
