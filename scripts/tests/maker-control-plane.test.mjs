import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MakerControlError,
  createControlHttpHandler,
  createMakerControlPlane,
  createMemoryControlStore,
  normalizeControlRequest,
  normalizeRuntimeProfile,
  projectJobForUser,
  runtimeSatisfiesRequest
} from '../maker-control-plane.mjs';

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
