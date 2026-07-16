import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
MakerControlError,
createControlAuthenticator,
createControlHttpHandler,
createMakerControlPlane,
createMemoryControlStore,
createWorkerAdapterRegistry,
formatSseEvents,
hashCredential,
migrateControlSnapshot,
normalizeControlRequest,
normalizeWorkerError,
normalizeWorkerResult,
normalizeRuntimeProfile,
projectJobForUser,
redactSecrets,
registerDefaultWorkerAdapters,
runtimeSatisfiesRequest
} from '../maker-control-plane.mjs';
import { runMakerControlCli } from '../maker-control-cli.mjs';
const request = overrides => ({
repository: 'Pokitomas/theawesomehexapp',
base_revision: 'main',
mode: 'build',
request: 'Implement the leased integration lane.',
idempotency_key: 'control-plane-test',
...overrides
});
const runtime = overrides => ({
runtime_id: 'maker-native-1',
display_name: 'Maker Native',
status: 'healthy',
intelligence: {
selection: 'adaptive',
engine_label: 'best available admitted engine',
architecture: 'hybrid',
admission: 'verified',
capabilities: ['coding', 'planning', 'review', 'browser']
},
endpoint: {
ownership: 'user',
transport: 'hybrid',
locality: 'private',
capacity: 'dedicated',
throttling: 'none',
label: 'Your Maker runtime'
},
planning: {
strategy: 'adaptive',
scheduler: 'priority',
parallelism: 8,
speculation: true,
recovery: 'journal',
confidence_threshold: 0.81
},
execution: {
role: 'implementer',
modes: ['planner', 'implementer', 'reviewer', 'verifier', 'repair'],
transport: 'weave',
workspace: 'isolated',
verification: 'continuous',
checkpointing: 'enabled',
recovery: 'journaled'
},
authority: {
capabilities: {
filesystem: 'write',
terminal: 'execute',
git: 'manage',
pull_requests: 'manage',
browser: 'execute',
containers: 'execute',
deployment: 'approval_required',
settings: 'approval_required',
secrets: 'reference_only'
}
},
presentation: {
headline: 'Maker is building your thing',
activity: 'Implementing and continuously verifying the current change',
tone: 'friendly'
},
...overrides
});
function deterministic() {
let tick = Date.parse('2026-07-15T00:00:00.000Z');
let serial = 0;
return {
clock: () => tick,
id: () => `id-${++serial}`,
advance: ms => { tick += ms; }
};
}
test('normalizes product authority as broad capability policy with explicit gates', () => {
const value = normalizeControlRequest(request());
assert.equal(value.repository, 'Pokitomas/theawesomehexapp');
assert.equal(value.authority.branch, true);
assert.equal(value.authority.draft_pr, true);
assert.equal(value.authority.merge, false);
assert.equal(value.authority.capabilities.filesystem, 'write');
assert.equal(value.authority.capabilities.git, 'manage');
assert.equal(value.authority.capabilities.deployment, 'approval_required');
assert.equal(value.authority.capabilities.settings, 'approval_required');
assert.equal(value.authority.capabilities.secrets, 'reference_only');
assert.throws(() => normalizeControlRequest({ repository: 'bad', request: 'x' }), /owner\/name/);
});
test('runtime profile describes capabilities without persisting raw provider or endpoint secrets', () => {
const profile = normalizeRuntimeProfile({
...runtime(),
provider: 'openai:gpt-secret',
api_key: 'top-secret',
endpoint: {
...runtime().endpoint,
url: 'https://secret-provider.example/v1',
token: 'endpoint-secret'
}
}, () => Date.parse('2026-07-15T00:00:00.000Z'));
const serialized = JSON.stringify(profile);
assert.equal(profile.intelligence.engine_label, 'best available admitted engine');
assert.equal(profile.endpoint.label, 'Your Maker runtime');
assert.ok(!serialized.includes('gpt-secret'));
assert.ok(!serialized.includes('secret-provider.example'));
assert.ok(!serialized.includes('top-secret'));
assert.ok(!serialized.includes('endpoint-secret'));
});
test('runtime requirements select by capability, authority, ownership, and recovery', () => {
const controlRequest = normalizeControlRequest(request({
runtime_requirements: {
capabilities: ['coding', 'browser'],
execution_roles: ['implementer', 'verifier'],
authority: ['filesystem', 'deployment'],
locality: 'private',
ownership: 'user',
dedicated_capacity: true,
recoverable: true
}
}));
assert.equal(runtimeSatisfiesRequest(normalizeRuntimeProfile(runtime()), controlRequest), true);
assert.equal(runtimeSatisfiesRequest(normalizeRuntimeProfile(runtime({
endpoint: { ...runtime().endpoint, capacity: 'shared' }
})), controlRequest), false);
assert.equal(runtimeSatisfiesRequest(normalizeRuntimeProfile(runtime({
intelligence: { ...runtime().intelligence, capabilities: ['coding'] }
})), controlRequest), false);
});
test('submits idempotently and rejects conflicting reuse', async () => {
const d = deterministic();
const control = createMakerControlPlane(d);
const first = await control.submit(request());
const second = await control.submit(request());
assert.equal(first.id, second.id);
await assert.rejects(
control.submit(request({ request: 'different' })),
error => error instanceof MakerControlError && error.code === 'idempotency_conflict'
);
const events = await control.events();
assert.equal(events.length, 1);
assert.equal(events[0].type, 'job.queued');
});
test('claims highest-priority compatible work and completes only with the active lease', async () => {
const d = deterministic();
const control = createMakerControlPlane(d);
await control.submit(request({ idempotency_key: 'low', priority: 10 }));
const high = await control.submit(request({
idempotency_key: 'high',
priority: 90,
runtime_requirements: { capabilities: ['coding'], execution_roles: ['implementer'] }
}));
const claim = await control.claim({ worker_id: 'worker-a', runtime: runtime() });
assert.equal(claim.id, high.id);
assert.equal(claim.runtime.runtime_id, 'maker-native-1');
await assert.rejects(control.complete(claim.id, 'wrong', {}), error => error.code === 'lease_mismatch');
const completed = await control.complete(claim.id, claim.lease.token, {
branch: 'agent/example',
pull_request: 'https://github.com/Pokitomas/theawesomehexapp/pull/999',
commit: 'abc'
});
assert.equal(completed.state, 'completed');
assert.equal(completed.result.branch, 'agent/example');
assert.equal(completed.runtime.intelligence.engine_label, 'best available admitted engine');
});
test('incompatible compute does not steal work', async () => {
const d = deterministic();
const control = createMakerControlPlane(d);
await control.submit(request({
runtime_requirements: { capabilities: ['browser'], locality: 'private' }
}));
const claim = await control.claim({
worker_id: 'worker-a',
runtime: runtime({
intelligence: { ...runtime().intelligence, capabilities: ['coding'] },
endpoint: { ...runtime().endpoint, locality: 'remote' }
})
});
assert.equal(claim, null);
});
test('heartbeat extends lease and expired work is recoverable by another compatible runtime', async () => {
const d = deterministic();
const store = createMemoryControlStore();
const control = createMakerControlPlane({ store, clock: d.clock, id: d.id, lease_ms: 1000 });
const job = await control.submit(request({
runtime_requirements: { capabilities: ['coding'], recoverable: true }
}));
const first = await control.claim({ worker_id: 'worker-a', runtime: runtime() });
d.advance(500);
const heartbeat = await control.heartbeat(job.id, first.lease.token);
assert.equal(Date.parse(heartbeat.lease.expires_at), d.clock() + 1000);
d.advance(1001);
const recovered = await control.claim({
worker_id: 'worker-b',
runtime: runtime({ runtime_id: 'maker-native-2', display_name: 'Maker Recovery' })
});
assert.equal(recovered.id, job.id);
assert.equal(recovered.lease.worker_id, 'worker-b');
assert.equal(recovered.runtime.runtime_id, 'maker-native-2');
const events = await control.events();
assert.ok(events.some(event => event.type === 'job.recovered'));
});
test('public projection is product-facing and separates active authority from approval gates', async () => {
const d = deterministic();
const control = createMakerControlPlane(d);
const job = await control.submit(request());
const claim = await control.claim({ worker_id: 'worker-a', runtime: runtime() });
const view = projectJobForUser(claim);
assert.equal(view.schema, 'sideways-maker-public-runtime/v1');
assert.equal(view.headline, 'Maker is building your thing');
assert.equal(view.engine.label, 'best available admitted engine');
assert.equal(view.execution.verification, 'continuous');
assert.ok(view.authority.active.some(item => item.name === 'filesystem' && item.level === 'write'));
assert.deepEqual(view.authority.gated.sort(), ['deployment', 'settings']);
assert.deepEqual(view.authority.reference_only, ['secrets']);
assert.equal(view.recovery.recoverable, true);
assert.equal(view.links.repository, job.request.repository);
assert.ok(!JSON.stringify(view).includes('models.github.ai'));
});
test('snapshot restores jobs, runtime receipts, and monotonic event sequence', async () => {
const d = deterministic();
const originalStore = createMemoryControlStore();
const original = createMakerControlPlane({ store: originalStore, clock: d.clock, id: d.id });
const job = await original.submit(request());
await original.claim({ worker_id: 'worker-a', runtime: runtime() });
const snapshot = await original.snapshot();
const restoredStore = createMemoryControlStore(snapshot);
const restored = createMakerControlPlane({ store: restoredStore, clock: d.clock, id: d.id });
await restored.cancel(job.id, 'operator stop');
const events = await restored.events();
assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
assert.equal((await restored.get(job.id)).runtime.runtime_id, 'maker-native-1');
assert.equal((await restored.get(job.id)).state, 'cancelled');
});
test('HTTP contract exposes queue, claims, product presentation, completion, and events', async () => {
const d = deterministic();
const control = createMakerControlPlane(d);
const handle = createControlHttpHandler(control);
const submit = await handle(new Request('http://maker/v1/jobs', {
method: 'POST',
headers: { 'content-type': 'application/json' },
body: JSON.stringify(request())
}));
assert.equal(submit.status, 200);
const job = await submit.json();
const claimResponse = await handle(new Request('http://maker/v1/claims', {
method: 'POST',
headers: { 'content-type': 'application/json' },
body: JSON.stringify({ worker_id: 'hosted-1', runtime: runtime() })
}));
const claim = await claimResponse.json();
const presentationResponse = await handle(new Request(`http://maker/v1/jobs/${job.id}/presentation`));
assert.equal(presentationResponse.status, 200);
assert.equal((await presentationResponse.json()).headline, 'Maker is building your thing');
const completion = await handle(new Request(`http://maker/v1/jobs/${job.id}/complete`, {
method: 'POST',
headers: { 'content-type': 'application/json' },
body: JSON.stringify({ lease_token: claim.lease.token, result: { ok: true } })
}));
assert.equal(completion.status, 200);
assert.equal((await completion.json()).state, 'completed');
const events = await handle(new Request('http://maker/v1/events?after=1'));
const values = await events.json();
assert.ok(values.every(event => event.sequence > 1));
});
test('capacity limits fail closed', async () => {
const d = deterministic();
const control = createMakerControlPlane({ ...d, max_jobs: 1, max_events: 20 });
await control.submit(request());
await assert.rejects(
control.submit(request({ idempotency_key: 'two' })),
error => error.code === 'job_capacity'
);
});
test('task envelope separates control, target, and head repositories with bounded budgets and references', () => {
const value = normalizeControlRequest(request({
control_repository: 'Pokitomas/theawesomehexapp',
target_repository: 'example/target',
head_repository: 'example/fork',
budgets: { requests: 12, tokens: 5000, cost_usd: 3.5, wall_time_ms: 9000, write_bytes: 2048 },
references: {
artifacts: [{ name: 'bundle', uri: 'artifact://bundle', digest: 'sha256:' + 'a'.repeat(64), size_bytes: 100 }],
logs: [{ name: 'run', uri: 'log://run', digest: 'sha256:' + 'b'.repeat(64), size_bytes: 200 }]
}
}));
assert.equal(value.repository, 'example/target');
assert.equal(value.control_repository, 'Pokitomas/theawesomehexapp');
assert.equal(value.head_repository, 'example/fork');
assert.equal(value.budgets.tokens, 5000);
assert.equal(value.references.artifacts[0].digest, 'sha256:' + 'a'.repeat(64));
assert.equal(value.references.logs[0].kind, 'log');
});
test('queue list and max-running concurrency remain deterministic', async () => {
const d = deterministic();
const control = createMakerControlPlane({ ...d, max_running: 1 });
const first = await control.submit(request({ idempotency_key: 'concurrency-1', priority: 90 }));
await control.submit(request({ idempotency_key: 'concurrency-2', priority: 10 }));
const claimed = await control.claim({ worker_id: 'worker-a', runtime: runtime() });
assert.equal(claimed.id, first.id);
assert.equal(await control.claim({ worker_id: 'worker-b', runtime: runtime() }), null);
const running = await control.list({ state: 'running' });
const queued = await control.list({ state: 'queued' });
assert.equal(running.length, 1);
assert.equal(queued.length, 1);
});
test('recoverable failure can resume and retry creates an auditable child attempt', async () => {
const d = deterministic();
const control = createMakerControlPlane(d);
const job = await control.submit(request({ idempotency_key: 'resume-source' }));
const claim = await control.claim({ worker_id: 'worker-a', runtime: runtime() });
await control.fail(job.id, claim.lease.token, {
code: 'tool_interrupted',
message: 'recoverable transport interruption',
recoverable: true
});
const resumed = await control.resume(job.id, { reason: 'transport restored' });
assert.equal(resumed.state, 'queued');
const retry = await control.retry(job.id, { reason: 'parallel repair attempt', priority: 95 });
assert.equal(retry.parent_job_id, job.id);
assert.equal(retry.attempt, 2);
assert.equal(retry.request.priority, 95);
assert.ok(retry.request.idempotency_key.includes(':retry:2'));
});
test('rollback, temporary grants, and exported receipts remain explicit and secret-redacted', async () => {
const d = deterministic();
const control = createMakerControlPlane(d);
const job = await control.submit(request({ idempotency_key: 'governance' }));
const claim = await control.claim({ worker_id: 'worker-a', runtime: runtime() });
await control.complete(job.id, claim.lease.token, {
branch: 'agent/thing',
commit: 'abc123',
token: 'ghp_' + 'x'.repeat(30)
});
const rollback = await control.rollback(job.id, {
reason: 'operator requested',
requested_by: 'kai'
});
assert.equal(rollback.target, 'abc123');
assert.equal(rollback.execute, false);
assert.equal(rollback.authority, 'approval_required');
const grant = await control.approveTemporaryGrant(job.id, {
capability: 'deployment',
level: 'execute',
ttl_ms: 5000,
approved_by: 'kai',
justification: 'staging proof'
});
assert.equal(grant.capability, 'deployment');
assert.equal(grant.level, 'execute');
assert.match(grant.digest, /^[a-f0-9]{64}$/);
const exported = await control.exportReceipt(job.id);
assert.equal(exported.schema, 'sideways-maker-export/v1');
assert.ok(!JSON.stringify(exported).includes('ghp_'));
assert.match(exported.digest, /^[a-f0-9]{64}$/);
});
test('orphan recovery returns expired running work to the queue', async () => {
const d = deterministic();
const control = createMakerControlPlane({ ...d, lease_ms: 1000 });
const job = await control.submit(request({ idempotency_key: 'orphan' }));
await control.claim({ worker_id: 'worker-a', runtime: runtime() });
d.advance(1001);
assert.deepEqual(await control.recoverOrphans(), [job.id]);
const recovered = await control.get(job.id);
assert.equal(recovered.state, 'queued');
assert.equal(recovered.lease, null);
assert.equal(recovered.error.code, 'orphan_recovered');
});
test('adapter registry reports unavailable transports truthfully and redacts invocation receipts', async () => {
const d = deterministic();
const registry = createWorkerAdapterRegistry({ clock: d.clock, timeout_ms: 100 });
registerDefaultWorkerAdapters(registry, {
in_process: async job => ({
accepted: job.id,
authorization: 'Bearer secret-secret-secret'
})
});
const descriptors = registry.describe();
assert.equal(descriptors.find(item => item.id === 'in-process').available, true);
assert.equal(descriptors.find(item => item.id === 'remote-http').available, false);
const control = createMakerControlPlane({ ...d, adapters: registry });
const job = await control.submit(request({ idempotency_key: 'adapter' }));
const receipt = await control.dispatch(job.id, 'in-process', { api_key: 'raw-secret' });
assert.equal(receipt.ok, true);
assert.equal(receipt.output.authorization, '[redacted]');
assert.ok(!JSON.stringify(receipt).includes('raw-secret'));
await assert.rejects(
control.dispatch(job.id, 'remote-http'),
error => error.code === 'adapter_unavailable'
);
});
test('authenticator supports loopback, bearer, API key, GitHub identity, and mTLS without persisting secrets', async () => {
const authenticate = createControlAuthenticator({
allow_loopback: true,
bearer_digests: [hashCredential('bearer-secret')],
api_key_digests: [hashCredential('api-secret')],
github_subjects: ['repo:Pokitomas/theawesomehexapp:ref:refs/heads/main'],
mtls_subjects: ['CN=maker-worker']
});
assert.equal((await authenticate(new Request('http://127.0.0.1/v1/health'))).method, 'loopback');
assert.equal((await authenticate(new Request('https://maker.example/v1/health', {
headers: { authorization: 'Bearer bearer-secret' }
}))).method, 'bearer');
assert.equal((await authenticate(new Request('https://maker.example/v1/health', {
headers: { 'x-maker-api-key': 'api-secret' }
}))).method, 'api_key');
assert.equal((await authenticate(new Request('https://maker.example/v1/health', {
headers: { 'x-maker-github-subject': 'repo:Pokitomas/theawesomehexapp:ref:refs/heads/main' }
}))).method, 'github_identity');
assert.equal((await authenticate(new Request('https://maker.example/v1/health', {
headers: { 'x-maker-mtls-subject': 'CN=maker-worker' }
}))).method, 'mtls');
await assert.rejects(
authenticate(new Request('https://maker.example/v1/health')),
error => error.code === 'unauthorized'
);
});
test('secure HTTP handler enforces origin, CSRF, replay, rate, size, and SSE contracts', async () => {
const d = deterministic();
const control = createMakerControlPlane(d);
const authenticator = createControlAuthenticator({
allow_loopback: false,
bearer_digests: [hashCredential('control-secret')]
});
const handle = createControlHttpHandler(control, {
clock: d.clock,
authenticator,
enforce_scopes: true,
allowed_origins: ['https://maker.example'],
csrf_digests: [hashCredential('csrf-secret')],
require_replay_id: true,
rate_limit: 10,
max_body_bytes: 800
});
const headers = {
authorization: 'Bearer control-secret',
origin: 'https://maker.example',
'x-maker-csrf': 'csrf-secret',
'x-maker-request-id': 'request-1',
'content-type': 'application/json'
};
const created = await handle(new Request('https://api.example/v1/jobs', {
method: 'POST',
headers,
body: JSON.stringify(request({ idempotency_key: 'secure-http' }))
}));
assert.equal(created.status, 200);
const job = await created.json();
const replayed = await handle(new Request('https://api.example/v1/jobs', {
method: 'POST',
headers,
body: JSON.stringify(request({ idempotency_key: 'secure-http' }))
}));
assert.equal(replayed.status, 409);
const deniedOrigin = await handle(new Request('https://api.example/v1/health', {
headers: { authorization: 'Bearer control-secret', origin: 'https://evil.example' }
}));
assert.equal(deniedOrigin.status, 403);
const missingCsrf = await handle(new Request(`https://api.example/v1/jobs/${job.id}/cancel`, {
method: 'POST',
headers: {
authorization: 'Bearer control-secret',
origin: 'https://maker.example',
'x-maker-request-id': 'request-2',
'content-type': 'application/json'
},
body: '{}'
}));
assert.equal(missingCsrf.status, 403);
const tooLarge = await handle(new Request('https://api.example/v1/jobs', {
method: 'POST',
headers: { ...headers, 'x-maker-request-id': 'request-3' },
body: JSON.stringify({ payload: 'x'.repeat(2000) })
}));
assert.equal(tooLarge.status, 413);
const events = await handle(new Request('https://api.example/v1/events?after=0', {
headers: {
authorization: 'Bearer control-secret',
origin: 'https://maker.example',
accept: 'text/event-stream'
}
}));
assert.equal(events.status, 200);
assert.match(events.headers.get('content-type'), /text\/event-stream/);
assert.match(await events.text(), /event: job\.queued/);
});
test('rate limit and request error redaction fail closed', async () => {
const d = deterministic();
const control = createMakerControlPlane(d);
const handle = createControlHttpHandler(control, {
clock: d.clock,
rate_limit: 1,
max_body_bytes: 100
});
assert.equal((await handle(new Request('http://maker/v1/health'))).status, 200);
assert.equal((await handle(new Request('http://maker/v1/health'))).status, 429);
const safe = redactSecrets({
authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
nested: { api_key: 'sk-abcdefghijklmnop' }
});
assert.equal(safe.authorization, '[redacted]');
assert.equal(safe.nested.api_key, '[redacted]');
});
test('snapshot migration, import, health, capabilities, and clean shutdown are recoverable', async () => {
const d = deterministic();
const oldRequest = {
repository: 'Pokitomas/theawesomehexapp',
base_revision: 'main',
mode: 'build',
request: 'Old snapshot job',
protect: '',
proof: '',
backend: 'auto',
priority: 50,
idempotency_key: 'old-job',
authority: { branch: true, draft_pr: true, merge: false, deploy: false, settings: false }
};
const oldSnapshot = {
jobs: [['old-1', {
id: 'old-1',
state: 'queued',
revision: 1,
request: oldRequest,
request_digest: 'a'.repeat(64),
created_at: '2026-07-15T00:00:00.000Z',
updated_at: '2026-07-15T00:00:00.000Z'
}]],
events: []
};
const migrated = migrateControlSnapshot(oldSnapshot, d.clock);
assert.equal(migrated.schema, 'sideways-maker-control-snapshot/v2');
assert.equal(migrated.jobs[0][1].request.control_repository, 'Pokitomas/theawesomehexapp');
const store = createMemoryControlStore();
const control = createMakerControlPlane({ store, clock: d.clock, id: d.id });
const imported = await control.importSnapshot(oldSnapshot);
assert.equal(imported.queue.total, 1);
assert.ok((await control.capabilities()).commands.includes('rollback'));
const shutdown = await control.close();
assert.equal(shutdown.schema, 'sideways-maker-control-shutdown/v1');
await assert.rejects(control.submit(request({ idempotency_key: 'closed' })), error => error.code === 'control_closed');
assert.equal((await control.health()).ready, false);
});
test('SSE formatter emits cursor, event type, and redacted JSON', () => {
const output = formatSseEvents([{
sequence: 7,
type: 'job.claimed',
detail: { token: 'ghp_' + 'x'.repeat(30) }
}]);
assert.match(output, /id: 7/);
assert.match(output, /event: job\.claimed/);
assert.ok(!output.includes('ghp_'));
});
test('CLI persists extended commands through atomic state files', async () => {
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-control-cli-'));
const state = path.join(directory, 'state.json');
const env = { MAKER_CONTROL_STATE: state };
const submitted = JSON.parse((await runMakerControlCli([
'submit',
JSON.stringify(request({ idempotency_key: 'cli-extended' }))
], env)).output);
const listed = JSON.parse((await runMakerControlCli(['list', 'queued'], env)).output);
assert.equal(listed[0].id, submitted.id);
const health = JSON.parse((await runMakerControlCli(['health'], env)).output);
assert.equal(health.queue.total, 1);
const exported = JSON.parse((await runMakerControlCli(['export', submitted.id], env)).output);
assert.equal(exported.job.id, submitted.id);
await fs.rm(directory, { recursive: true, force: true });
});
test('worker receipts reject oversized payloads and redact credential-shaped result and error data', () => {
const result = normalizeWorkerResult({
branch: 'agent/runtime',
authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
note: 'token sk-abcdefghijklmnopqrstuvwxyz123456',
references: {
artifacts: [{
name: 'bundle.zip',
uri: 'artifact://bundle',
digest: `sha256:${'a'.repeat(64)}`,
size_bytes: 42,
retention: '7d',
provenance: 'worker'
}]
}
});
assert.equal(result.authorization, '[redacted]');
assert.equal(result.note, 'token [redacted]');
assert.equal(result.references.artifacts[0].digest, `sha256:${'a'.repeat(64)}`);
assert.throws(
() => normalizeWorkerResult({ payload: 'x'.repeat(1024 * 1024 + 1) }),
error => error.code === 'result_too_large' && error.status === 413
);
const error = normalizeWorkerError({
code: 'provider_failed',
message: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
recoverable: true
});
assert.ok(!error.message.includes('abcdefghijklmnopqrstuvwxyz'));
assert.equal(error.recoverable, true);
});
test('published JSON Schema covers the full durable control-plane receipt family', async () => {
const schema = JSON.parse(await fs.readFile(
new URL('../../maker/contracts/control-plane.schema.json', import.meta.url),
'utf8'
));
const refs = new Set(schema.oneOf.map(entry => entry.$ref));
for (const name of [
'request', 'runtimeProfile', 'job', 'event', 'publicRuntime', 'adapterReceipt',
'rollbackPlan', 'temporaryGrant', 'snapshot', 'exportReceipt', 'controlStatus',
'controlCapabilities', 'shutdownReceipt'
]) {
assert.ok(refs.has(`#/$defs/${name}`), `missing top-level ${name} schema`);
}
for (const field of [
'control_repository', 'target_repository', 'head_repository', 'budgets',
'references', 'runtime_requirements', 'authority'
]) {
assert.ok(schema.$defs.request.required.includes(field), `request schema missing ${field}`);
}
for (const field of [
'attempt', 'parent_job_id', 'adapter', 'rollback', 'temporary_grants', 'control_actions'
]) {
assert.ok(schema.$defs.job.required.includes(field), `job schema missing ${field}`);
}
assert.equal(schema.$defs.snapshot.properties.schema.const, 'sideways-maker-control-snapshot/v2');
});
