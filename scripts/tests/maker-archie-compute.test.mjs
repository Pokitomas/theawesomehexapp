import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { dispatchComputeTask, normalizeTask, normalizeWorker, selectComputeWorker, verifyComputeReceipt, verifyWorker } from '../maker-archie-compute.mjs';

const now = Date.parse('2026-07-16T05:00:00.000Z');
const clock = () => now;
const d = s => crypto.createHash('sha256').update(s).digest('hex');
const task = (extra = {}) => normalizeTask({ operation: 'fit_sparse_planner', payload_digest: d('payload'), payload_bytes: 100, pack_version: 'pack/v1', max_seconds: 1, max_memory_mb: 64, max_cost_usd: 1, privacy_minimum: 'local', ...extra });
const local = (extra = {}) => normalizeWorker({ id: 'local', kind: 'local_cpu', observed: true, available: true, observed_at: new Date(now).toISOString(), capabilities: ['sparse_fit'], limits: { max_seconds: 5, max_memory_mb: 512, max_payload_bytes: 1000, max_cost_usd: 0 }, privacy: 'local', locality: 'device', pack_versions: ['pack/v1'], ...extra }, { clock });

test('prefers the lowest truthful available compute rung', () => {
  const remote = normalizeWorker({ id: 'remote', kind: 'remote_http', observed: true, available: true, observed_at: new Date(now).toISOString(), identity: 'worker-1', adapter: 'remote', endpoint_digest: d('endpoint'), capabilities: ['sparse_fit'], limits: { max_seconds: 5, max_memory_mb: 512, max_payload_bytes: 1000, max_cost_usd: 0.2 }, privacy: 'local', locality: 'device', pack_versions: ['pack/v1'] }, { clock });
  const chosen = selectComputeWorker([remote, local()], task({ hard_requirements: ['sparse_fit'] }), { clock });
  assert.equal(chosen.selected.kind, 'local_cpu');
});

test('unknown static descriptors fail closed', () => {
  const unknown = normalizeWorker({ id: 'gpu', kind: 'burst_gpu', observed: false, available: true, capabilities: ['gpu'], limits: { max_cost_usd: 0 }, privacy: 'unknown' }, { clock });
  assert.equal(unknown.available, false);
  const chosen = selectComputeWorker([unknown], task({ hard_requirements: ['gpu'], neural_distillation: true }), { clock });
  assert.equal(chosen.selected, null);
});

test('binds attestation, task, worker, fence and artifact digests', async () => {
  const worker = local({ adapter: 'cpu' });
  const t = task({ hard_requirements: ['sparse_fit'] });
  const artifact = d('artifact');
  const receipt = await dispatchComputeTask({ workers: [worker], task: t, clock, fence_token: 'fence-1', expected_artifact_digest: artifact, adapters: { cpu: async ({ task, worker, fence_token }) => ({ task_digest: task.task_digest, worker_digest: worker.worker_digest, fence_token, artifact_digest: artifact, cost_usd: 0 }) } });
  assert.equal(receipt.state, 'completed');
  assert.equal(verifyComputeReceipt(receipt), true);
});

test('rejects stale workers and tampered attestations', () => {
  assert.throws(() => verifyWorker(local({ observed_at: '2026-07-16T04:00:00.000Z' }), { clock, max_age_ms: 1000 }), /stale/);
  const tampered = { ...local(), privacy: 'provider' };
  assert.throws(() => verifyWorker(tampered, { clock }), /digest/);
});

test('enforces hard requirements, cost, privacy, locality and pack compatibility', () => {
  const chosen = selectComputeWorker([local({ privacy: 'provider', locality: 'cloud', pack_versions: ['old'] })], task({ hard_requirements: ['gpu'], locality: 'device' }), { clock });
  assert.equal(chosen.selected, null);
  const reasons = chosen.evaluated[0].reasons.join(' ');
  assert.match(reasons, /missing:gpu/);
  assert.match(reasons, /privacy/);
  assert.match(reasons, /locality/);
  assert.match(reasons, /pack_version/);
});

test('times out, retries and preserves attempt evidence', async () => {
  const worker = local({ adapter: 'slow', limits: { max_seconds: 0.01, max_memory_mb: 512, max_payload_bytes: 1000, max_cost_usd: 0 } });
  const receipt = await dispatchComputeTask({ workers: [worker], task: task({ max_seconds: 0.01 }), clock, max_retries: 1, adapters: { slow: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) } });
  assert.equal(receipt.state, 'failed');
  assert.deepEqual(receipt.attempts.map(x => x.status), ['timeout', 'timeout']);
});

test('supports cancellation without claiming execution', async () => {
  const controller = new AbortController(); controller.abort(new Error('stop'));
  const receipt = await dispatchComputeTask({ workers: [local({ adapter: 'cpu' })], task: task(), clock, signal: controller.signal, adapters: { cpu: async () => { throw new Error('must not run'); } } });
  assert.equal(receipt.state, 'cancelled');
  assert.equal(receipt.artifact_digest, null);
});

test('rejects stale fencing and artifact integrity failures', async () => {
  const worker = local({ adapter: 'bad' });
  const receipt = await dispatchComputeTask({ workers: [worker], task: task(), clock, fence_token: 'current', expected_artifact_digest: d('expected'), adapters: { bad: async ({ task, worker }) => ({ task_digest: task.task_digest, worker_digest: worker.worker_digest, fence_token: 'old', artifact_digest: d('wrong') }) } });
  assert.equal(receipt.state, 'failed');
  assert.match(receipt.attempts[0].error, /fence/);
});

test('reports neural distillation as an explicit external blocker', async () => {
  const receipt = await dispatchComputeTask({ workers: [local()], task: task({ neural_distillation: true, hard_requirements: ['gpu'] }), clock });
  assert.equal(receipt.state, 'blocked');
  assert.match(receipt.blocker, /separately_admitted_hardware/);
});
