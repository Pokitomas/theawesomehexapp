import assert from 'node:assert/strict';
import test from 'node:test';
import { ArchieComputeLadder, digest, normalizeComputeTask, normalizeWorker } from '../maker-archie-compute.mjs';

const CLOCK = () => '2026-07-16T02:00:00.000Z';
const ARTIFACT = 'a'.repeat(64);

function ids() {
  let value = 0;
  return () => `id-${++value}`;
}

function worker(overrides = {}) {
  return {
    worker_id: overrides.worker_id || 'local-cpu',
    type: overrides.type || 'local-cpu',
    os: overrides.os || 'linux',
    architecture: overrides.architecture || 'x64',
    accelerator: overrides.accelerator ?? 'none',
    accelerator_count: overrides.accelerator_count ?? 0,
    vram_mb: overrides.vram_mb ?? 0,
    memory_mb: overrides.memory_mb ?? 8192,
    disk_mb: overrides.disk_mb ?? 50000,
    max_duration_ms: overrides.max_duration_ms ?? 600000,
    concurrency: overrides.concurrency ?? 1,
    active: overrides.active ?? 0,
    capabilities: overrides.capabilities || ['sparse-infer', 'sparse-train', 'pack-transfer'],
    checkpoint_formats: overrides.checkpoint_formats || ['archie-sparse-v1'],
    corpus_pack_versions: overrides.corpus_pack_versions || [1],
    privacy: overrides.privacy || 'private',
    locality: overrides.locality || 'local-device',
    region: overrides.region || 'us-west',
    cost_per_hour_usd: Object.hasOwn(overrides, 'cost_per_hour_usd') ? overrides.cost_per_hour_usd : 0,
    latency_ms: overrides.latency_ms ?? 5,
    reliability: overrides.reliability ?? 0.99,
    health: overrides.health || { state: 'observed', value: 'healthy', evidence: 'probe:ok' },
    availability: overrides.availability || { state: 'observed', value: true, evidence: 'process:ready' },
    adapter: overrides.adapter || 'local',
    endpoint_digest: overrides.endpoint_digest || null,
    observed_at: '2026-07-16T01:59:00.000Z',
    attestation: overrides.attestation || { state: 'human-approved', issued_by: 'kai', observed_at: '2026-07-16T01:59:00.000Z' }
  };
}

function task(overrides = {}) {
  return {
    task_id: overrides.task_id || 'task-one',
    kind: overrides.kind || 'sparse-infer',
    required_capabilities: overrides.required_capabilities || [overrides.kind || 'sparse-infer'],
    architecture: overrides.architecture || 'x64',
    accelerator: overrides.accelerator ?? 'any',
    minimum_vram_mb: overrides.minimum_vram_mb ?? 0,
    minimum_memory_mb: overrides.minimum_memory_mb ?? 1024,
    minimum_disk_mb: overrides.minimum_disk_mb ?? 100,
    max_duration_ms: overrides.max_duration_ms ?? 60000,
    privacy: overrides.privacy || 'personal',
    minimum_locality: overrides.minimum_locality || 'remote',
    allowed_regions: overrides.allowed_regions || [],
    checkpoint_format: overrides.checkpoint_format || 'archie-sparse-v1',
    corpus_pack_version: overrides.corpus_pack_version || 1,
    max_cost_usd: overrides.max_cost_usd,
    allow_unknown_cost: overrides.allow_unknown_cost || false,
    prefer_local: overrides.prefer_local ?? true,
    retries: overrides.retries ?? 1,
    timeout_ms: overrides.timeout_ms ?? 1000,
    payload_digest: overrides.payload_digest || digest('payload'),
    requested_at: '2026-07-16T02:00:00.000Z'
  };
}

function localAdapter(output = {}) {
  return {
    async execute() {
      return {
        output: { plan: ['run locally'], ...output.output },
        usage: { wall_ms: 8, cost_usd: 0, evidence: 'adapter-reported', ...output.usage },
        artifacts: output.artifacts || [{ name: 'model.json', kind: 'sparse-model', sha256: ARTIFACT, verified_sha256: ARTIFACT, bytes: 1200 }]
      };
    }
  };
}

test('local CPU is the preferred truthful baseline for current sparse specialists', () => {
  const ladder = new ArchieComputeLadder({
    workers: [
      worker(),
      worker({ worker_id: 'remote-cpu', type: 'remote-http', locality: 'remote', privacy: 'private', cost_per_hour_usd: 1, latency_ms: 100, adapter: 'remote' })
    ],
    adapters: { local: localAdapter(), remote: localAdapter() },
    clock: CLOCK,
    id_factory: ids()
  });
  const placement = ladder.place(task());
  assert.equal(placement.state, 'placed');
  assert.equal(placement.selected_worker_id, 'local-cpu');
  assert.equal(ladder.capabilities().permanent_gpu_required, false);
  assert.equal(ladder.capabilities().baseline, 'local-cpu sparse specialists');
});

test('GPU absence is reported as unavailable rather than a product blocker for sparse work', () => {
  const ladder = new ArchieComputeLadder({ workers: [worker()], adapters: { local: localAdapter() }, clock: CLOCK });
  const sparse = ladder.place(task());
  assert.equal(sparse.state, 'placed');
  const neural = ladder.place(task({ task_id: 'neural', kind: 'neural-distill', required_capabilities: ['neural-distill'], minimum_vram_mb: 12000, checkpoint_format: 'safetensors' }));
  assert.equal(neural.state, 'unavailable');
  assert.equal(neural.selected_worker_id, null);
  assert.match(neural.rejected.flatMap(value => value.reasons).join('\n'), /accelerator|VRAM|capability|checkpoint/);
});

test('an admitted burst GPU is selected only when its observed VRAM, privacy, cost, and pack support fit', () => {
  const gpu = worker({
    worker_id: 'burst-a100', type: 'burst-gpu', accelerator: 'cuda', accelerator_count: 1, vram_mb: 40960,
    memory_mb: 65536, disk_mb: 200000, capabilities: ['neural-distill', 'pack-transfer'], checkpoint_formats: ['safetensors'],
    locality: 'regional', privacy: 'private', cost_per_hour_usd: 2.5, latency_ms: 40, adapter: 'burst'
  });
  const ladder = new ArchieComputeLadder({ workers: [worker(), gpu], adapters: { local: localAdapter(), burst: localAdapter() }, clock: CLOCK, id_factory: ids() });
  const placement = ladder.place(task({ kind: 'neural-distill', required_capabilities: ['neural-distill'], minimum_vram_mb: 24000, checkpoint_format: 'safetensors', minimum_locality: 'regional', max_cost_usd: 1, max_duration_ms: 600000 }));
  assert.equal(placement.state, 'placed');
  assert.equal(placement.selected_worker_id, 'burst-a100');
  assert.equal(placement.selected_worker.accelerator, 'cuda');
});

test('unknown cost, insufficient VRAM, privacy, locality, region, and pack mismatches fail closed', () => {
  const gpu = worker({
    worker_id: 'mystery-gpu', type: 'burst-gpu', accelerator: 'cuda', accelerator_count: 1, vram_mb: 8000,
    capabilities: ['neural-distill'], checkpoint_formats: ['safetensors'], corpus_pack_versions: [2],
    privacy: 'public', locality: 'remote', region: 'eu-central', cost_per_hour_usd: null, adapter: 'burst'
  });
  const ladder = new ArchieComputeLadder({ workers: [gpu], adapters: { burst: localAdapter() }, clock: CLOCK });
  const placement = ladder.place(task({
    kind: 'neural-distill', required_capabilities: ['neural-distill'], minimum_vram_mb: 16000,
    checkpoint_format: 'safetensors', corpus_pack_version: 1, privacy: 'private', minimum_locality: 'regional', allowed_regions: ['us-west']
  }));
  assert.equal(placement.state, 'unavailable');
  const reasons = placement.rejected[0].reasons.join('\n');
  assert.match(reasons, /insufficient VRAM/);
  assert.match(reasons, /privacy/);
  assert.match(reasons, /locality/);
  assert.match(reasons, /region/);
  assert.match(reasons, /pack version/);
  assert.match(reasons, /cost is unknown/);
});

test('unverified identity, unknown health, unavailable adapter, and exhausted capacity are never placed', () => {
  const candidates = [
    worker({ worker_id: 'unverified', attestation: { state: 'unverified' } }),
    worker({ worker_id: 'unknown-health', health: { state: 'unknown' } }),
    worker({ worker_id: 'no-adapter', adapter: 'missing' }),
    worker({ worker_id: 'full', active: 1, concurrency: 1 })
  ];
  const ladder = new ArchieComputeLadder({ workers: candidates, adapters: { local: localAdapter() }, clock: CLOCK });
  const placement = ladder.place(task());
  assert.equal(placement.state, 'unavailable');
  const reasons = placement.rejected.flatMap(value => value.reasons).join('\n');
  assert.match(reasons, /unverified/);
  assert.match(reasons, /health/);
  assert.match(reasons, /adapter is unavailable/);
  assert.match(reasons, /concurrency/);
});

test('dispatch returns exact lease, fencing, artifacts, usage, and no infrastructure authority', async () => {
  const ladder = new ArchieComputeLadder({ workers: [worker()], adapters: { local: localAdapter() }, clock: CLOCK, id_factory: ids() });
  const receipt = await ladder.dispatch(task(), { corpus_pack_manifest: 'b'.repeat(64) });
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.selected_worker_id, 'local-cpu');
  assert.equal(receipt.fencing_token, 1);
  assert.equal(receipt.artifacts[0].sha256, ARTIFACT);
  assert.equal(receipt.usage.cost_usd, 0);
  assert.equal(receipt.authority.infrastructure, 'adapter-only');
  assert.equal(receipt.authority.merge, 'human');
  assert.match(receipt.receipt_digest, /^[0-9a-f]{64}$/);
});

test('lost or failing worker is fenced and the task falls back to the next admitted worker', async () => {
  const calls = [];
  const ladder = new ArchieComputeLadder({
    workers: [
      worker({ worker_id: 'local-fast', reliability: 1, adapter: 'lost' }),
      worker({ worker_id: 'local-backup', reliability: 0.9, latency_ms: 10, adapter: 'backup' })
    ],
    adapters: {
      lost: { async execute() { calls.push('lost'); throw new Error('worker disappeared'); } },
      backup: { async execute() { calls.push('backup'); return localAdapter().execute(); } }
    },
    clock: CLOCK,
    id_factory: ids()
  });
  const receipt = await ladder.dispatch(task({ retries: 2 }));
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.selected_worker_id, 'local-backup');
  assert.deepEqual(calls, ['lost', 'backup']);
  assert.equal(receipt.attempts[0].state, 'failed');
  assert.equal(receipt.attempts[1].state, 'completed');
});

test('timeout aborts one worker and can fall back without claiming the timed-out work succeeded', async () => {
  let aborted = false;
  const ladder = new ArchieComputeLadder({
    workers: [
      worker({ worker_id: 'slow', reliability: 1, adapter: 'slow' }),
      worker({ worker_id: 'backup', reliability: 0.8, adapter: 'backup' })
    ],
    adapters: {
      slow: { execute({ signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })); } },
      backup: localAdapter()
    },
    clock: CLOCK,
    id_factory: ids()
  });
  const receipt = await ladder.dispatch(task({ retries: 1, timeout_ms: 100 }));
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.selected_worker_id, 'backup');
  assert.equal(receipt.attempts[0].state, 'timed_out');
  assert.equal(aborted, true);
});

test('artifact digest mismatch rejects the worker result and preserves failure evidence', async () => {
  const bad = localAdapter({ artifacts: [{ name: 'bad', sha256: ARTIFACT, verified_sha256: 'b'.repeat(64), bytes: 10 }] });
  const ladder = new ArchieComputeLadder({ workers: [worker()], adapters: { local: bad }, clock: CLOCK, id_factory: ids() });
  const receipt = await ladder.dispatch(task({ retries: 0 }));
  assert.equal(receipt.state, 'unavailable');
  assert.equal(receipt.attempts[0].state, 'failed');
  assert.match(receipt.attempts[0].error, /digest verification failed/);
});

test('cancellation changes lease state and stale completion cannot be admitted', () => {
  const ladder = new ArchieComputeLadder({ workers: [worker()], adapters: { local: localAdapter() }, clock: CLOCK, id_factory: ids() });
  const placement = ladder.place(task());
  const lease = ladder.acquire(placement);
  assert.equal(ladder.cancel(lease.lease_id, 'operator stop').cancelled, true);
  assert.equal(ladder.cancel(lease.lease_id).cancelled, false);
  const replacement = ladder.acquire(placement);
  assert.equal(replacement.fencing_token, 2);
  assert.notEqual(replacement.lease_id, lease.lease_id);
});

test('secret-like endpoints, credentials, payloads, and outputs are redacted from public receipts', async () => {
  const secret = 'github_pat_123456789012345678901234567890';
  const ladder = new ArchieComputeLadder({
    workers: [worker({ endpoint_digest: digest('https://secret.example'), credential: secret })],
    adapters: { local: localAdapter({ output: { endpoint: 'https://secret.example', token: secret, text: `Bearer ${secret}` } }) },
    clock: CLOCK,
    id_factory: ids()
  });
  const receipt = await ladder.dispatch(task(), { token: secret, endpoint: 'https://secret.example' });
  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('https://secret.example'));
  assert.match(serialized, /redacted/);
});

test('placement is deterministic for identical observed inputs', () => {
  const workers = [
    worker({ worker_id: 'b', reliability: 0.9, latency_ms: 10, adapter: 'local' }),
    worker({ worker_id: 'a', reliability: 0.9, latency_ms: 10, adapter: 'local' })
  ];
  const first = new ArchieComputeLadder({ workers, adapters: { local: localAdapter() }, clock: CLOCK }).place(task());
  const second = new ArchieComputeLadder({ workers: [...workers].reverse(), adapters: { local: localAdapter() }, clock: CLOCK }).place(task());
  assert.equal(first.selected_worker_id, 'a');
  assert.equal(first.placement_digest, second.placement_digest);
  assert.equal(normalizeComputeTask(task()).task_digest, normalizeComputeTask(task()).task_digest);
  assert.equal(normalizeWorker(worker()).worker_digest, normalizeWorker(worker()).worker_digest);
});
