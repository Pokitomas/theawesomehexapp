import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireExecutiveLease,
  assertMutationOwned,
  assignExecutiveLane,
  buildExecutiveSubtaskContract,
  buildReadOnlyScoutFanout,
  detectIntegrationScopeCollisions,
  expireExecutiveLeases,
  inheritExecutiveLease,
  normalizeExecutiveLeaseRegistry,
  reassignBlockedLane,
  transitionExecutiveLease,
  verifyCommitPaths
} from '../maker-executive-delegation.mjs';

const MAIN = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const NOW = '2026-07-20T09:00:00.000Z';

function emptyRegistry() {
  return normalizeExecutiveLeaseRegistry({ repository: 'owner/repo', generation_id: 'g1', main_sha: MAIN, leases: [] });
}

function writer(id, overrides = {}) {
  return { id, read_sources: ['github', 'ci'], write_authority: true, environments: ['linux'], hardware: ['cpu'], owned_scopes: [{ kind: 'repository', id: 'scripts/**' }], available: true, credentials: [], ...overrides };
}

test('lease acquisition is compare-and-swap and rejects overlapping ownership', () => {
  const initial = emptyRegistry();
  const one = acquireExecutiveLease({ registry: initial, expected_registry_digest: initial.registry_digest, now: NOW, request: { id: 'l1', lane_id: 'one', holder_id: 'p1', scopes: [{ kind: 'repository', id: 'scripts/live/**' }] } });
  assert.equal(one.leases[0].status, 'active');
  assert.throws(() => acquireExecutiveLease({ registry: one, expected_registry_digest: initial.registry_digest, now: NOW, request: { id: 'l2', lane_id: 'two', holder_id: 'p2', scopes: [{ kind: 'repository', id: 'docs/**' }] } }), /compare-and-swap/);
  assert.throws(() => acquireExecutiveLease({ registry: one, expected_registry_digest: one.registry_digest, now: NOW, request: { id: 'l2', lane_id: 'two', holder_id: 'p2', scopes: [{ kind: 'generated', id: 'scripts/live/out.js' }] } }), /overlapping ownership/);
});

test('bounded inheritance delegates the parent and reactivates it when the child releases', () => {
  const initial = emptyRegistry();
  const parent = acquireExecutiveLease({ registry: initial, expected_registry_digest: initial.registry_digest, now: NOW, request: { id: 'parent', lane_id: 'root', holder_id: 'p1', scopes: [{ kind: 'repository', id: 'scripts/**' }] } });
  const child = inheritExecutiveLease({ registry: parent, expected_registry_digest: parent.registry_digest, parent_lease_id: 'parent', now: '2026-07-20T09:01:00Z', child: { id: 'child', lane_id: 'sub', holder_id: 'p2', scopes: [{ kind: 'repository', id: 'scripts/live/**' }] } });
  assert.equal(child.leases.find(value => value.id === 'parent').status, 'delegated');
  assert.equal(child.leases.find(value => value.id === 'child').status, 'active');
  assert.throws(() => inheritExecutiveLease({ registry: parent, expected_registry_digest: parent.registry_digest, parent_lease_id: 'parent', now: NOW, child: { id: 'bad', lane_id: 'bad', holder_id: 'p2', scopes: [{ kind: 'repository', id: 'docs/**' }] } }), /exceeds parent/);
  const released = transitionExecutiveLease({ registry: child, expected_registry_digest: child.registry_digest, lease_id: 'child', action: 'release', now: '2026-07-20T09:02:00Z' });
  assert.equal(released.leases.find(value => value.id === 'parent').status, 'active');
});

test('revocation cascades and expiry removes mutable authority', () => {
  const initial = emptyRegistry();
  const parent = acquireExecutiveLease({ registry: initial, expected_registry_digest: initial.registry_digest, now: NOW, ttl_ms: 1000, request: { id: 'parent', lane_id: 'root', holder_id: 'p1', scopes: [{ kind: 'repository', id: 'scripts/**' }] } });
  const expired = expireExecutiveLeases(parent, { expected_registry_digest: parent.registry_digest, now: '2026-07-20T09:00:02Z' });
  assert.equal(expired.leases[0].status, 'revoked');
  const second = acquireExecutiveLease({ registry: expired, expected_registry_digest: expired.registry_digest, now: '2026-07-20T09:00:03Z', request: { id: 'fresh', lane_id: 'fresh', holder_id: 'p2', scopes: [{ kind: 'repository', id: 'scripts/**' }] } });
  const revoked = transitionExecutiveLease({ registry: second, expected_registry_digest: second.registry_digest, lease_id: 'fresh', action: 'revoke', reason: 'authority-loss', now: '2026-07-20T09:00:04Z' });
  assert.equal(revoked.leases.find(value => value.id === 'fresh').reason, 'authority-loss');
});

test('child expiry reactivates a still-valid delegated parent and delegated parents cannot release early', () => {
  const initial = emptyRegistry();
  const parent = acquireExecutiveLease({ registry: initial, expected_registry_digest: initial.registry_digest, now: NOW, ttl_ms: 10000, request: { id: 'parent', lane_id: 'root', holder_id: 'p1', scopes: [{ kind: 'repository', id: 'scripts/**' }] } });
  const child = inheritExecutiveLease({ registry: parent, expected_registry_digest: parent.registry_digest, parent_lease_id: 'parent', now: NOW, ttl_ms: 1000, child: { id: 'child', lane_id: 'sub', holder_id: 'p2', scopes: [{ kind: 'repository', id: 'scripts/live/**' }] } });
  assert.throws(() => transitionExecutiveLease({ registry: child, expected_registry_digest: child.registry_digest, lease_id: 'parent', action: 'release', now: '2026-07-20T09:00:00.500Z' }), /cannot release/);
  const expired = expireExecutiveLeases(child, { expected_registry_digest: child.registry_digest, now: '2026-07-20T09:00:02Z' });
  assert.equal(expired.leases.find(value => value.id === 'child').status, 'revoked');
  assert.equal(expired.leases.find(value => value.id === 'parent').status, 'active');
});

test('commit-time verification rejects stale heads and unowned generated paths', () => {
  const initial = emptyRegistry();
  const registry = acquireExecutiveLease({ registry: initial, expected_registry_digest: initial.registry_digest, now: NOW, request: { id: 'l1', lane_id: 'one', holder_id: 'p1', scopes: [{ kind: 'repository', id: 'scripts/live/**' }] } });
  assert.equal(assertMutationOwned({ registry, lease_id: 'l1', source_sha: MAIN, changed_scopes: [{ kind: 'repository', id: 'scripts/live/a.mjs' }] }).holder_id, 'p1');
  assert.throws(() => assertMutationOwned({ registry, lease_id: 'l1', source_sha: 'c'.repeat(40), changed_scopes: [{ kind: 'repository', id: 'scripts/live/a.mjs' }] }), /stale head/);
  assert.throws(() => verifyCommitPaths({ registry, lease_id: 'l1', source_sha: MAIN, changed_paths: ['scripts/live/a.mjs'], generated_paths: ['dist/live.js'] }), /outside the granted lease/);
});

test('integration detects hidden generated-file collisions across lanes', () => {
  const collisions = detectIntegrationScopeCollisions([
    { lane_id: 'one', scopes: [{ kind: 'repository', id: 'dist/**' }] },
    { lane_id: 'two', scopes: [{ kind: 'generated', id: 'dist/app.js' }] },
    { lane_id: 'three', scopes: [{ kind: 'artifact', id: 'model:one' }] }
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].left_lane_id, 'one');
  assert.equal(collisions[0].right_lane_id, 'two');
});

test('capability-aware assignment routes writer lanes and reports precise blockers', () => {
  const lane = { id: 'write', mode: 'writer', source_sha: MAIN, required_read_sources: ['github'], environment: 'linux', compute_class: 'cpu', owned_scopes: [{ kind: 'repository', id: 'scripts/live/**' }] };
  const assigned = assignExecutiveLane({ lane, principals: [writer('b'), writer('a')] });
  assert.equal(assigned.principal_id, 'a');
  const blocked = assignExecutiveLane({ lane: { ...lane, compute_class: 'cuda' }, principals: [writer('a')] });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.denial_reasons[0].missing[0], /hardware:cuda/);
  const reassigned = reassignBlockedLane({ lane, principals: [writer('a'), writer('b')], prior_assignment: assigned });
  assert.equal(reassigned.principal_id, 'b');
});

test('read-only scout fanout has no mutation authority', () => {
  const fanout = buildReadOnlyScoutFanout({ source_sha: MAIN, snapshot_digest: DIGEST, sources: [{ id: 'github' }, { id: 'ci' }], principals: [writer('p')] });
  assert.equal(fanout.length, 2);
  assert.deepEqual(fanout[0].allowed_mutations, []);
  assert.equal(fanout[0].assignment.mode, 'scout');
});

test('subtask contracts bind exact inputs, allowed mutations, evidence, terminal output, and budgets', () => {
  const contract = buildExecutiveSubtaskContract({
    id: 'task:one', lane_id: 'one', source_sha: MAIN, snapshot_digest: DIGEST,
    exact_inputs: [{ id: 'dataset', digest: 'd'.repeat(64) }],
    allowed_mutations: [{ kind: 'repository', id: 'scripts/live/**' }],
    required_evidence: ['focused-test', 'tree-receipt'], terminal_output: 'ready receipt or explicit blocker',
    budget: { tokens: 1000, compute_ms: 10000, storage_bytes: 100000, workflow_reruns: 1 }
  });
  assert.match(contract.contract_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(contract.required_evidence, ['focused-test', 'tree-receipt']);
  assert.throws(() => buildExecutiveSubtaskContract({ id: 'bad', lane_id: 'one', source_sha: MAIN, snapshot_digest: DIGEST, required_evidence: [], terminal_output: '' }), /incomplete/);
});
