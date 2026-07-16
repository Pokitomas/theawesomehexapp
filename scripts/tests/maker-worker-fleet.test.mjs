import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
WorkerFleetError,
createWorkerAdapterRegistry,
createWorkerFleet,
normalizeArtifactReferences,
normalizeFleetTask,
normalizeWorkerDescriptor,
rankWorkers,
redactFleetSecrets,
registerDefaultWorkerAdapters,
scoreWorker
} from '../maker-worker-fleet.mjs';
const attestation = letter => `sha256:${letter.repeat(64)}`;
const worker = (id, overrides = {}) => ({
id,
display_name: id,
identity: { status: 'attested', subject: `worker:${id}`, attestation_digest: attestation('a') },
mode: 'in_process',
platform: { os: 'linux', architecture: 'x64' },
labels: ['node22'],
capabilities: ['coding', 'git', 'browser'],
toolchains: ['node', 'git'],
providers: ['adaptive'],
models: ['maker-engine'],
network: { mode: 'egress', allowed_hosts: ['github.com'] },
isolation: { container: true, sandbox: true, ephemeral_workspace: true },
resources: { cpu: 8, memory_mb: 16384, disk_mb: 100000, time_ms: 7200000 },
concurrency: { limit: 2, active: 0, queue_depth: 0 },
region: 'us-west',
locality: 'local',
privacy: 'local',
cost: { per_minute_usd: 0.01, per_job_usd: 0.1 },
latency_ms: 20,
health: 'healthy',
reliability: { successes: 9, failures: 1, lost: 0 },
...overrides
});
const task = (overrides = {}) => ({
id: 'task-1',
owner: 'Pokitomas',
repository: 'Pokitomas/theawesomehexapp',
backend: 'auto',
priority: 50,
capabilities: ['coding', 'git'],
labels: ['node22'],
toolchains: ['node', 'git'],
providers: ['adaptive'],
models: ['maker-engine'],
modes: ['in_process'],
platform: { os: 'linux', architecture: 'x64' },
network: 'egress',
allowed_hosts: ['github.com'],
isolation: { container: true, sandbox: true, ephemeral_workspace: true },
resources: { cpu: 2, memory_mb: 2048, disk_mb: 2048, time_ms: 60000 },
region: 'us-west',
locality: 'local',
privacy: 'local',
max_cost_usd: 10,
...overrides
});
function deterministic() {
let stamp = Date.parse('2026-07-15T00:00:00.000Z');
let serial = 0;
return {
clock: () => stamp,
id: () => `id-${++serial}`,
advance: ms => { stamp += ms; }
};
}
function adapters(transports = { in_process: async packet => ({ accepted: packet.task.id }) }) {
const registry = createWorkerAdapterRegistry();
registerDefaultWorkerAdapters(registry, transports);
return registry;
}
test('worker descriptors cover all modes and trust only verified or digest-attested identities', () => {
for (const mode of ['github_actions', 'self_hosted', 'remote_http', 'in_process', 'local_control']) {
const value = normalizeWorkerDescriptor(worker(mode, { mode }));
assert.equal(value.mode, mode);
assert.equal(value.identity.trusted, true);
assert.match(value.descriptor_digest, /^[a-f0-9]{64}$/);
}
const unverified = normalizeWorkerDescriptor(worker('unverified', { identity: { status: 'unverified' } }));
const badAttestation = normalizeWorkerDescriptor(worker('bad', { identity: { status: 'attested', attestation_digest: 'nope' } }));
assert.equal(unverified.identity.trusted, false);
assert.equal(badAttestation.identity.trusted, false);
assert.throws(() => normalizeWorkerDescriptor({ id: 'x', mode: 'pretend' }), /unsupported worker mode/);
});
test('hard capability, platform, network, isolation, and resource constraints fail closed', () => {
const value = normalizeWorkerDescriptor(worker('hard'));
assert.equal(scoreWorker(value, normalizeFleetTask(task())).eligible, true);
const failures = [
task({ capabilities: ['gpu'] }),
task({ platform: { os: 'windows', architecture: 'x64' } }),
task({ network: 'full' }),
task({ allowed_hosts: ['example.com'] }),
task({ resources: { cpu: 100, memory_mb: 2048, disk_mb: 2048, time_ms: 60000 } }),
task({ isolation: { container: true, sandbox: true, ephemeral_workspace: true }, resources: { cpu: 2, memory_mb: 999999, disk_mb: 2048, time_ms: 60000 } })
];
const expected = ['capability_mismatch', 'os_mismatch', 'network_mismatch', 'network_host_mismatch', 'cpu_insufficient', 'memory_insufficient'];
assert.deepEqual(failures.map((input, index) => {
const result = scoreWorker(value, normalizeFleetTask(input));
assert.equal(result.eligible, false);
return result.reasons.find(reason => reason === expected[index]);
}), expected);
});
test('unverified workers are rejected unless the task explicitly permits them', () => {
const unverified = normalizeWorkerDescriptor(worker('unverified', { identity: { status: 'unverified' } }));
assert.deepEqual(scoreWorker(unverified, normalizeFleetTask(task())).reasons, ['identity_unverified']);
assert.equal(scoreWorker(unverified, normalizeFleetTask(task({ allow_unverified: true }))).eligible, true);
});
test('deterministic placement scores reliability, queue, privacy, locality, latency, cost, and operator preference', () => {
const first = normalizeWorkerDescriptor(worker('a-fast', { operator_weight: 10 }));
const second = normalizeWorkerDescriptor(worker('z-queued', {
locality: 'remote', privacy: 'provider', latency_ms: 500,
concurrency: { limit: 4, active: 1, queue_depth: 5 },
cost: { per_minute_usd: 2, per_job_usd: 3 },
reliability: { successes: 1, failures: 5, lost: 1 }
}));
const normalizedTask = normalizeFleetTask(task({ locality: 'any', privacy: 'provider' }));
const forward = rankWorkers([second, first], normalizedTask);
const reverse = rankWorkers([first, second], normalizedTask);
assert.equal(forward[0].worker.id, 'a-fast');
assert.deepEqual(forward.map(value => [value.worker.id, value.score]), reverse.map(value => [value.worker.id, value.score]));
});
test('no eligible worker classifications distinguish capacity, mismatch, trust, health, quota, and infrastructure', () => {
const d = deterministic();
const empty = createWorkerFleet({ clock: d.clock, id: d.id, adapters: adapters() });
assert.throws(() => empty.place(task()), error => error.code === 'capacity_unavailable');
const mismatch = createWorkerFleet({ workers: [worker('m')], clock: d.clock, id: d.id, adapters: adapters() });
assert.throws(() => mismatch.place(task({ capabilities: ['gpu'] })), error => error.code === 'capability_mismatch');
const trust = createWorkerFleet({ workers: [worker('u', { identity: { status: 'unverified' } })], clock: d.clock, id: d.id, adapters: adapters() });
assert.throws(() => trust.place(task()), error => error.code === 'unverified_identity');
const unhealthy = createWorkerFleet({ workers: [worker('off', { health: 'offline' })], clock: d.clock, id: d.id, adapters: adapters() });
assert.throws(() => unhealthy.place(task()), error => error.code === 'unhealthy_worker');
const quota = createWorkerFleet({
workers: [worker('q')], clock: d.clock, id: d.id, adapters: adapters(),
quotas: { 'repository:Pokitomas/theawesomehexapp': { concurrency: 0 } }
});
assert.throws(() => quota.place(task()), error => error.code === 'quota_exhausted');
const unavailableAdapters = createWorkerAdapterRegistry();
registerDefaultWorkerAdapters(unavailableAdapters, {});
const infra = createWorkerFleet({ workers: [worker('infra')], clock: d.clock, id: d.id, adapters: unavailableAdapters });
assert.throws(() => infra.place(task()), error => error.code === 'external_infrastructure_blocker');
});
test('priority, fair owner scheduling, starvation boost, and recovery reservation are deterministic', async () => {
const d = deterministic();
const fleet = createWorkerFleet({ workers: [worker('one', { concurrency: { limit: 2 } })], clock: d.clock, id: d.id, adapters: adapters(), starvation_ms: 1000, recovery_reserve: 1 });
fleet.submit(task({ id: 'normal-old', owner: 'owner-a', priority: 1, created_at: nowString(d.clock()) }));
d.advance(15000);
fleet.submit(task({ id: 'normal-new', owner: 'owner-b', priority: 90 }));
fleet.submit(task({ id: 'repair', owner: 'owner-c', priority: 10, recovery: true }));
const first = await fleet.schedule();
assert.equal(first.task.id, 'repair');
const second = await fleet.schedule();
assert.equal(second.task.id, 'normal-old');
const queued = fleet.listQueue();
assert.equal(queued[0].task.id, 'normal-new');
});
function nowString(value) { return new Date(value).toISOString(); }
test('leases use fencing tokens, prevent duplicate execution, and heartbeat extends expiry', async () => {
const d = deterministic();
const fleet = createWorkerFleet({ workers: [worker('lease')], clock: d.clock, id: d.id, adapters: adapters(), lease_ms: 1000 });
fleet.submit(task());
const execution = await fleet.schedule();
assert.equal(execution.lease.fence, 1);
assert.throws(() => fleet.place(execution.task), error => error.code === 'capability_mismatch' || error.code === 'duplicate_execution');
assert.throws(() => fleet.heartbeat(execution.task.id, 'wrong', execution.lease.fence), error => error.code === 'lease_token_mismatch');
assert.throws(() => fleet.heartbeat(execution.task.id, execution.lease.token, 99), error => error.code === 'fence_mismatch');
d.advance(500);
const heartbeat = fleet.heartbeat(execution.task.id, execution.lease.token, execution.lease.fence);
assert.equal(Date.parse(heartbeat.lease.expires_at), d.clock() + 1000);
});
test('completion releases quotas and returns digest-bound artifact and usage references', async () => {
const d = deterministic();
const fleet = createWorkerFleet({ workers: [worker('complete')], clock: d.clock, id: d.id, adapters: adapters() });
fleet.submit(task());
const execution = await fleet.schedule();
d.advance(500);
const complete = fleet.complete(execution.task.id, execution.lease.token, execution.lease.fence, {
cost_usd: 0.4,
references: {
artifacts: [{ name: 'bundle', uri: 'artifact://bundle', digest: attestation('b'), size_bytes: 12, retention: '7d', provenance: 'worker' }],
logs: [{ name: 'run', uri: 'log://run', digest: attestation('c'), size_bytes: 8 }]
},
detail: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }
});
assert.equal(complete.state, 'completed');
assert.equal(complete.result.references.artifacts[0].digest, attestation('b'));
assert.equal(complete.result.detail.authorization, '[redacted]');
assert.equal(fleet.getWorker('complete').concurrency.active, 0);
assert.equal(fleet.usage()['repository:Pokitomas/theawesomehexapp'].cost_usd, 0.4);
});
test('artifact references reject invalid integrity and embedded payloads', () => {
assert.throws(() => normalizeArtifactReferences({ artifacts: [{ digest: 'bad' }] }), error => error.code === 'artifact_digest_invalid');
assert.throws(() => normalizeArtifactReferences({ artifacts: [{ digest: attestation('a'), content: 'raw' }] }), error => error.code === 'artifact_payload_denied');
const safe = normalizeArtifactReferences({ logs: [{ uri: 'log://x', digest: attestation('d'), size_bytes: 4 }] });
assert.equal(safe.logs[0].kind, 'log');
});
test('recoverable failure requeues with incremented attempt and non-recoverable failure stops', async () => {
const d = deterministic();
const fleet = createWorkerFleet({ workers: [worker('fail')], clock: d.clock, id: d.id, adapters: adapters() });
fleet.submit(task({ max_attempts: 2 }));
const execution = await fleet.schedule();
const failed = fleet.fail(execution.task.id, execution.lease.token, execution.lease.fence, { code: 'transient', message: 'retry', recoverable: true });
assert.equal(failed.state, 'failed');
assert.equal(fleet.getTask(execution.task.id).state, 'queued');
assert.equal(fleet.getTask(execution.task.id).task.attempt, 2);
const retry = await fleet.schedule();
const final = fleet.fail(retry.task.id, retry.lease.token, retry.lease.fence, { code: 'fatal', message: 'stop', recoverable: false });
assert.equal(final.state, 'failed');
assert.equal(fleet.getTask(retry.task.id).state, 'failed');
});
test('expired heartbeats classify lost workers, quarantine capacity, and retry recovery work', async () => {
const d = deterministic();
const fleet = createWorkerFleet({ workers: [worker('lost')], clock: d.clock, id: d.id, adapters: adapters(), lease_ms: 1000 });
fleet.submit(task({ retry_lost: true, max_attempts: 2 }));
await fleet.schedule();
d.advance(1001);
assert.deepEqual(fleet.recoverExpired(), ['task-1']);
assert.equal(fleet.getWorker('lost').health, 'offline');
assert.equal(fleet.getTask('task-1').state, 'queued');
assert.equal(fleet.getTask('task-1').task.recovery, true);
});
test('drain, quarantine, recovery, and cancellation are explicit and reversible', async () => {
const d = deterministic();
const fleet = createWorkerFleet({ workers: [worker('ops')], clock: d.clock, id: d.id, adapters: adapters() });
assert.equal(fleet.drain('ops', 'maintenance').health, 'draining');
assert.throws(() => fleet.place(task()), error => error.code === 'unhealthy_worker');
assert.equal(fleet.quarantine('ops', 'suspicious').health, 'quarantined');
assert.equal(fleet.recoverWorker('ops', 'verified').health, 'healthy');
fleet.submit(task());
const execution = await fleet.schedule();
const cancelled = fleet.cancel(execution.task.id, 'operator stop');
assert.equal(cancelled.state, 'cancelled');
assert.equal(fleet.getWorker('ops').concurrency.active, 0);
});
test('all worker adapter contracts report availability truthfully and redact dispatch receipts', async () => {
const registry = createWorkerAdapterRegistry();
const seen = [];
registerDefaultWorkerAdapters(registry, {
github_actions: async packet => { seen.push(packet); return { run: 1, token: 'secret' }; },
self_hosted: async () => ({ ok: true }),
remote_http: async () => ({ ok: true }),
in_process: async () => ({ ok: true }),
local_control: async () => ({ ok: true })
});
assert.equal(registry.describe().filter(value => value.available).length, 5);
const result = await registry.dispatch('github_actions', { task: { id: 'x' } });
assert.equal(result.token, '[redacted]');
assert.equal(seen[0].task.id, 'x');
const unavailable = createWorkerAdapterRegistry();
registerDefaultWorkerAdapters(unavailable, {});
await assert.rejects(unavailable.dispatch('remote_http', {}), error => error.code === 'adapter_unavailable');
});
test('repository, owner, and backend concurrency/cost quotas are enforced and released', async () => {
const d = deterministic();
const fleet = createWorkerFleet({
workers: [worker('quota', { concurrency: { limit: 3 } })], clock: d.clock, id: d.id, adapters: adapters(),
quotas: {
'owner:Pokitomas': { concurrency: 1, cost_usd: 1 },
'repository:Pokitomas/theawesomehexapp': { concurrency: 2, cost_usd: 2 },
'backend:auto': { concurrency: 2, cost_usd: 2 }
}
});
fleet.submit(task({ id: 'q1' }));
fleet.submit(task({ id: 'q2' }));
const first = await fleet.schedule();
assert.equal(first.task.id, 'q1');
assert.equal(await fleet.schedule(), null);
fleet.complete(first.task.id, first.lease.token, first.lease.fence, { cost_usd: 0.8 });
const second = await fleet.schedule();
assert.equal(second.task.id, 'q2');
fleet.complete(second.task.id, second.lease.token, second.lease.fence, { cost_usd: 0.3 });
fleet.submit(task({ id: 'q3' }));
assert.equal(await fleet.schedule(), null);
assert.equal(fleet.getTask('q3').last_error.code, 'quota_exhausted');
});
test('fleet snapshots and placement receipts are deterministic and secret-safe', () => {
const d1 = deterministic();
const d2 = deterministic();
const input = worker('snapshot', { metadata: { api_key: 'sk-abcdefghijklmnop' } });
const first = createWorkerFleet({ workers: [input], clock: d1.clock, id: d1.id, adapters: adapters() });
const second = createWorkerFleet({ workers: [input], clock: d2.clock, id: d2.id, adapters: adapters() });
const placement1 = first.place(task());
const placement2 = second.place(task());
assert.deepEqual(placement1, placement2);
const snapshot1 = first.snapshot();
const snapshot2 = second.snapshot();
assert.equal(snapshot1.snapshot_digest, snapshot2.snapshot_digest);
assert.ok(!JSON.stringify(snapshot1).includes('sk-'));
});
test('redaction preserves fencing and usage fields while removing credentials', () => {
const value = redactFleetSecrets({ lease_token: 'secret', input_tokens: 10, authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' });
assert.equal(value.lease_token, '[redacted]');
assert.equal(value.input_tokens, 10);
assert.equal(value.authorization, '[redacted]');
});
test('published fleet schema covers worker, task, placement, lease, execution, usage, event, and snapshot receipts', async () => {
const schema = JSON.parse(await fs.readFile(new URL('../../maker/contracts/worker-fleet.schema.json', import.meta.url), 'utf8'));
const refs = new Set(schema.oneOf.map(value => value.$ref));
for (const name of ['worker', 'task', 'placement', 'lease', 'execution', 'usage', 'event', 'snapshot']) {
assert.ok(refs.has(`#/$defs/${name}`), `missing ${name}`);
}
assert.equal(schema.$defs.worker.properties.schema.const, 'sideways-maker-worker/v1');
assert.equal(schema.$defs.snapshot.properties.schema.const, 'sideways-maker-fleet-snapshot/v1');
});
