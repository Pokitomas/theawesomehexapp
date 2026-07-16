import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyWorkerMismatch,
  createFleetAdapterRegistry,
  createWorkerFleet,
  fleetDigest,
  normalizeArtifactReference,
  normalizeFleetTask,
  normalizeWorkerDescriptor,
  registerDefaultFleetAdapters,
  scoreWorker
} from '../maker-worker-fleet.mjs';

const worker = overrides => ({
  id: 'worker-a',
  display_name: 'Worker A',
  mode: 'self_hosted',
  identity: { state: 'attested', issuer: 'maker', subject: 'worker-a', digest: 'sha256:abc' },
  platform: { os: 'linux', arch: 'x64', labels: ['coding', 'repair'], toolchains: ['node', 'git'], providers: ['native'] },
  isolation: { containers: true, sandbox: true, ephemeral_workspace: true, network: 'restricted' },
  resources: { cpu: 8, memory_mb: 16384, disk_mb: 100000, time_ms: 3600000, concurrency: 2, queue_depth: 0 },
  placement: { region: 'us-west', locality: 'local', privacy: 'local', latency_ms: 10, cost_per_hour_usd: 1, operator_rank: 0 },
  health: { state: 'healthy' },
  reliability: { success_rate: 0.99, samples: 100, lost_runs: 0 },
  state: 'active',
  ...overrides
});
const task = overrides => ({
  id: 'task-a',
  repository: 'Pokitomas/theawesomehexapp',
  owner: 'Pokitomas',
  backend: 'auto',
  priority: 50,
  requirements: {
    modes: ['self_hosted', 'local'],
    os: 'linux', arch: 'x64', labels: ['coding'], toolchains: ['node'], providers: ['native'],
    network: 'restricted', containers: true, sandbox: true, ephemeral_workspace: true,
    cpu: 4, memory_mb: 4096, disk_mb: 10000, time_ms: 60000,
    locality: 'local', privacy_minimum: 'private', verified_identity: true, max_cost_per_hour_usd: 5
  },
  ...overrides
});
function deterministic() {
  let tick = Date.parse('2026-07-15T00:00:00.000Z');
  let serial = 0;
  return { clock: () => tick, id: () => `id-${++serial}`, advance: ms => { tick += ms; } };
}

test('worker registration captures identity, platform, isolation, resources, placement, health, and cost', () => {
  const value = normalizeWorkerDescriptor(worker());
  assert.equal(value.verified, true);
  assert.equal(value.platform.os, 'linux');
  assert.equal(value.isolation.sandbox, true);
  assert.equal(value.resources.concurrency, 2);
  assert.equal(value.placement.privacy, 'local');
  assert.match(value.descriptor_digest, /^[a-f0-9]{64}$/);
});

test('unverified workers are rejected when verified identity is required', () => {
  const value = normalizeWorkerDescriptor(worker({ identity: { state: 'unverified' } }));
  assert.ok(classifyWorkerMismatch(value, normalizeFleetTask(task())).includes('unverified_identity'));
});

test('hard capability matching covers mode, platform, tools, providers, isolation, resources, region, privacy, and cost', () => {
  const value = normalizeWorkerDescriptor(worker());
  assert.deepEqual(classifyWorkerMismatch(value, normalizeFleetTask(task())), []);
  const bad = normalizeWorkerDescriptor(worker({ resources: { ...worker().resources, memory_mb: 1000 }, isolation: { ...worker().isolation, sandbox: false } }));
  const reasons = classifyWorkerMismatch(bad, normalizeFleetTask(task()));
  assert.ok(reasons.includes('memory'));
  assert.ok(reasons.includes('sandbox'));
});

test('deterministic scoring prefers reliability, empty queue, locality, privacy, latency, cost, and operator preference', () => {
  const a = normalizeWorkerDescriptor(worker({ id: 'a' }));
  const b = normalizeWorkerDescriptor(worker({ id: 'b', placement: { ...worker().placement, latency_ms: 100, cost_per_hour_usd: 3 } }));
  const normalized = normalizeFleetTask(task({ preferences: { worker_ids: ['a'], locality: 'local', privacy: 'local', max_latency_ms: 50 } }));
  assert.ok(scoreWorker(a, normalized, { active: 0, queued: 0 }).score > scoreWorker(b, normalized, { active: 0, queued: 1 }).score);
});

test('fleet supports multiple worker modes and truthfully classifies no capacity', () => {
  const fleet = createWorkerFleet({ workers: [worker({ id: 'gh', mode: 'github_hosted', placement: { ...worker().placement, locality: 'remote', privacy: 'provider' } })] });
  const classification = fleet.classify(task());
  assert.equal(classification.code, 'capability_mismatch');
  assert.ok(classification.mismatches[0].reasons.includes('execution_mode'));
});

test('placement emits isolated workspace, lease, fencing token, and integrity receipt', () => {
  const d = deterministic();
  const fleet = createWorkerFleet({ workers: [worker()], ...d });
  const placement = fleet.place(task());
  assert.equal(placement.worker_id, 'worker-a');
  assert.equal(placement.workspace.ephemeral, true);
  assert.match(placement.lease.fencing_token, /^worker-a:/);
  assert.equal(placement.receipt_digest, fleetDigest({ ...placement, receipt_digest: undefined }));
});

test('concurrency prevents duplicate over-placement', () => {
  const d = deterministic();
  const fleet = createWorkerFleet({ workers: [worker({ resources: { ...worker().resources, concurrency: 1 } })], ...d });
  fleet.place(task({ id: 'one' }));
  assert.throws(() => fleet.place(task({ id: 'two' })), error => error.code === 'capability_mismatch');
});

test('heartbeat extends active leases and fencing rejects stale writers', () => {
  const d = deterministic();
  const fleet = createWorkerFleet({ workers: [worker()], lease_ms: 1000, ...d });
  const placement = fleet.place(task());
  d.advance(500);
  const lease = fleet.heartbeat(placement.task_id, placement.lease.fencing_token);
  assert.equal(Date.parse(lease.expires_at), d.clock() + 1000);
  assert.throws(() => fleet.heartbeat(placement.task_id, 'stale'), error => error.code === 'fencing_mismatch');
});

test('expired leases recover queued tasks and increment attempt', () => {
  const d = deterministic();
  const fleet = createWorkerFleet({ workers: [worker()], lease_ms: 1000, ...d });
  fleet.enqueue(task());
  fleet.scheduleNext();
  d.advance(1001);
  assert.deepEqual(fleet.recoverExpired(), ['task-a']);
  const snapshot = fleet.snapshot();
  const entry = snapshot.tasks.find(item => item.task_id === 'task-a');
  assert.equal(entry.state, 'queued');
  assert.equal(entry.attempt, 2);
});

test('lost worker retry policy can fail terminally', () => {
  const d = deterministic();
  const fleet = createWorkerFleet({ workers: [worker()], lease_ms: 1000, ...d });
  fleet.enqueue(task({ retry: { allowed: false } }));
  fleet.scheduleNext();
  d.advance(1001);
  fleet.recoverExpired();
  assert.equal(fleet.snapshot().tasks[0].state, 'failed');
});

test('drain, quarantine, activation, and cancellation update availability', () => {
  const fleet = createWorkerFleet({ workers: [worker()] });
  fleet.drain('worker-a');
  assert.ok(fleet.classify(task()).mismatches[0].reasons.includes('worker_draining'));
  fleet.quarantine('worker-a', 'bad attestation');
  assert.equal(fleet.workers()[0].state, 'quarantined');
  fleet.activate('worker-a');
  fleet.enqueue(task());
  fleet.cancel('task-a', 'operator stop');
  assert.equal(fleet.snapshot().tasks[0].state, 'cancelled');
});

test('owner/repository/backend quotas fail closed', () => {
  const fleet = createWorkerFleet({
    workers: [worker()],
    quotas: { 'Pokitomas|Pokitomas/theawesomehexapp|auto': { concurrency: 1, cost_usd: 2 } }
  });
  fleet.place(task({ id: 'one' }));
  assert.throws(() => fleet.place(task({ id: 'two' })), error => error.code === 'quota_exhausted');
});

test('fair scheduling prevents one owner from monopolizing the queue', () => {
  const d = deterministic();
  const fleet = createWorkerFleet({ workers: [worker({ resources: { ...worker().resources, concurrency: 3 } })], ...d });
  fleet.enqueue(task({ id: 'a1', owner: 'A', repository: 'A/repo', priority: 50 }));
  fleet.enqueue(task({ id: 'a2', owner: 'A', repository: 'A/repo', priority: 50 }));
  fleet.enqueue(task({ id: 'b1', owner: 'B', repository: 'B/repo', priority: 50 }));
  const first = fleet.scheduleNext();
  const second = fleet.scheduleNext();
  assert.notEqual(first.task_id[0], second.task_id[0]);
});

test('starvation boost elevates old low-priority work', () => {
  const d = deterministic();
  const fleet = createWorkerFleet({ workers: [worker({ resources: { ...worker().resources, concurrency: 2 } })], starvation_ms: 1000, ...d });
  fleet.enqueue(task({ id: 'old', priority: 1, created_at: new Date(d.clock()).toISOString() }));
  d.advance(5000);
  fleet.enqueue(task({ id: 'new', priority: 80, created_at: new Date(d.clock()).toISOString() }));
  assert.equal(fleet.scheduleNext().task_id, 'old');
});

test('repair and recovery reservations are preferred near capacity', () => {
  const fleet = createWorkerFleet({ workers: [worker({ resources: { ...worker().resources, concurrency: 1 } })], repair_reserve: 1 });
  fleet.enqueue(task({ id: 'normal', reservation: 'normal', priority: 90 }));
  fleet.enqueue(task({ id: 'repair', reservation: 'repair', priority: 10 }));
  assert.equal(fleet.scheduleNext().task_id, 'repair');
});

test('artifact references require digest, size, retention, provenance, and workspace', () => {
  const artifact = normalizeArtifactReference({
    kind: 'log', name: 'run.log', uri: 'artifact://run', digest: `sha256:${'a'.repeat(64)}`,
    size_bytes: 42, retention: '7d', provenance: 'worker-a', workspace_id: 'workspace:1'
  });
  assert.equal(artifact.kind, 'log');
  assert.equal(artifact.size_bytes, 42);
  assert.throws(() => normalizeArtifactReference({ name: 'bad' }), error => error.code === 'invalid_artifact_digest');
});

test('adapter contracts cover GitHub, self-hosted, remote, local, and in-process truthfully', async () => {
  const d = deterministic();
  const registry = createFleetAdapterRegistry(d);
  registerDefaultFleetAdapters(registry, { local: async (_placement, payload) => ({ ok: true, token: payload.token }) });
  const descriptors = registry.describe();
  assert.equal(descriptors.length, 5);
  assert.equal(descriptors.find(item => item.id === 'local-worker').available, true);
  assert.equal(descriptors.find(item => item.id === 'github-actions').available, false);
  const placement = { placement_id: 'p1' };
  const receipt = await registry.dispatch('local-worker', placement, { token: 'secret' });
  assert.equal(receipt.output.token, '[redacted]');
  await assert.rejects(registry.dispatch('github-actions', placement), error => error.code === 'adapter_unavailable');
});

test('fleet dispatch chooses adapter from worker execution mode', async () => {
  const d = deterministic();
  const registry = createFleetAdapterRegistry(d);
  registerDefaultFleetAdapters(registry, { self_hosted: async placement => ({ task_id: placement.task_id }) });
  const fleet = createWorkerFleet({ workers: [worker()], adapters: registry, ...d });
  const placement = fleet.place(task());
  const receipt = await fleet.dispatch(placement);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.adapter.id, 'self-hosted-runner');
});

test('finish releases concurrency, records cost, and rejects stale fencing', () => {
  const d = deterministic();
  const fleet = createWorkerFleet({ workers: [worker({ resources: { ...worker().resources, concurrency: 1 } })], ...d });
  fleet.enqueue(task());
  const placement = fleet.scheduleNext();
  assert.throws(() => fleet.finish('task-a', 'stale'), error => error.code === 'fencing_mismatch');
  const result = fleet.finish('task-a', placement.lease.fencing_token, { cost_usd: 1, authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' });
  assert.equal(result.state, 'completed');
  assert.equal(result.result.authorization, '[redacted]');
  assert.doesNotThrow(() => fleet.place(task({ id: 'next' })));
});

test('fleet snapshots are deterministic, redacted, and integrity-bound', () => {
  const d = deterministic();
  const fleet = createWorkerFleet({ workers: [worker({ metadata: { api_key: 'secret-value' } })], ...d });
  fleet.enqueue(task());
  const snapshot = fleet.snapshot();
  assert.ok(!JSON.stringify(snapshot).includes('secret-value'));
  assert.equal(snapshot.receipt_digest, fleetDigest({ ...snapshot, receipt_digest: undefined }));
});
