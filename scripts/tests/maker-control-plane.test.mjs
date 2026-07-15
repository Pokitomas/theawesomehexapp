import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MakerControlError,
  createControlHttpHandler,
  createMakerControlPlane,
  createMemoryControlStore,
  normalizeControlRequest
} from '../maker-control-plane.mjs';

const request = overrides => ({
  repository: 'Pokitomas/theawesomehexapp',
  base_revision: 'main',
  mode: 'build',
  request: 'Implement the leased integration lane.',
  idempotency_key: 'control-plane-test',
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

test('normalizes requests and keeps merge/deploy denied by default', () => {
  const value = normalizeControlRequest(request());
  assert.equal(value.repository, 'Pokitomas/theawesomehexapp');
  assert.equal(value.authority.branch, true);
  assert.equal(value.authority.draft_pr, true);
  assert.equal(value.authority.merge, false);
  assert.equal(value.authority.deploy, false);
  assert.throws(() => normalizeControlRequest({ repository: 'bad', request: 'x' }), /owner\/name/);
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

test('claims by priority and completes only with the active lease', async () => {
  const d = deterministic();
  const control = createMakerControlPlane(d);
  await control.submit(request({ idempotency_key: 'low', priority: 10 }));
  const high = await control.submit(request({ idempotency_key: 'high', priority: 90 }));
  const claim = await control.claim({ worker_id: 'worker-a' });
  assert.equal(claim.id, high.id);
  await assert.rejects(control.complete(claim.id, 'wrong', {}), error => error.code === 'lease_mismatch');
  const completed = await control.complete(claim.id, claim.lease.token, { branch: 'agent/example', commit: 'abc' });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result.branch, 'agent/example');
});

test('heartbeat extends lease and expired work is recoverable by another worker', async () => {
  const d = deterministic();
  const store = createMemoryControlStore();
  const control = createMakerControlPlane({ store, clock: d.clock, id: d.id, lease_ms: 1000 });
  const job = await control.submit(request());
  const first = await control.claim({ worker_id: 'worker-a' });
  d.advance(500);
  const heartbeat = await control.heartbeat(job.id, first.lease.token);
  assert.equal(Date.parse(heartbeat.lease.expires_at), d.clock() + 1000);
  d.advance(1001);
  const recovered = await control.claim({ worker_id: 'worker-b' });
  assert.equal(recovered.id, job.id);
  assert.equal(recovered.lease.worker_id, 'worker-b');
  const events = await control.events();
  assert.ok(events.some(event => event.type === 'job.recovered'));
});

test('snapshot restores jobs and monotonic event sequence', async () => {
  const d = deterministic();
  const originalStore = createMemoryControlStore();
  const original = createMakerControlPlane({ store: originalStore, clock: d.clock, id: d.id });
  const job = await original.submit(request());
  const snapshot = await original.snapshot();
  const restoredStore = createMemoryControlStore(snapshot);
  const restored = createMakerControlPlane({ store: restoredStore, clock: d.clock, id: d.id });
  await restored.cancel(job.id, 'operator stop');
  const events = await restored.events();
  assert.deepEqual(events.map(event => event.sequence), [1, 2]);
  assert.equal((await restored.get(job.id)).state, 'cancelled');
});

test('HTTP contract exposes queue, claims, status, completion, and events', async () => {
  const d = deterministic();
  const control = createMakerControlPlane(d);
  const handle = createControlHttpHandler(control);
  const submit = await handle(new Request('http://maker/v1/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request())
  }));
  assert.equal(submit.status, 200);
  const job = await submit.json();
  const claimResponse = await handle(new Request('http://maker/v1/claims', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worker_id: 'hosted-1' })
  }));
  const claim = await claimResponse.json();
  const completion = await handle(new Request(`http://maker/v1/jobs/${job.id}/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lease_token: claim.lease.token, result: { ok: true } })
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
  await assert.rejects(control.submit(request({ idempotency_key: 'two' })), error => error.code === 'job_capacity');
});
