import test from 'node:test';
import assert from 'node:assert/strict';
import { createMakerRuntimePlatform, MakerRuntimePlatformError, platformDigest } from '../maker-runtime-platform.mjs';

const clock = () => Date.parse('2026-07-15T12:00:00.000Z');
const baseInput = {
  control_repository: 'Pokitomas/theawesomehexapp', target_repository: 'Pokitomas/theawesomehexapp', head_repository: 'Pokitomas/theawesomehexapp',
  base_revision: 'cde52b39d41a2910047f92bfb6f873c912a6e553', mode: 'build', backend: 'auto', request: 'compose runtime',
  budgets: { requests: 5, tokens: 1000, cost_usd: 5, wall_time_ms: 1000 },
  authority: { branch: true, draft_pr: true, merge: false, deploy: false, settings: false, capabilities: { git: 'manage' } },
  runtime_requirements: { capabilities: ['coding'], execution_roles: ['implementer'], recoverable: true },
  fleet_requirements: { providers: [], sandbox: true }, required_plugin_capabilities: ['repository.write']
};

function harness(options = {}) {
  let state = 'queued';
  const job = { id: 'job-1', request_digest: 'control-digest', lease: null };
  const control = {
    async submit(input) { job.request = input; return structuredClone(job); },
    async claim({ worker_id, runtime }) { state = 'running'; job.lease = { token: 'control-token', worker_id }; job.runtime = runtime; return structuredClone(job); },
    async complete(_id, token, result) { assert.equal(token, 'control-token'); state = 'completed'; job.result = result; job.lease = null; return structuredClone(job); },
    async fail(_id, token, error) { assert.equal(token, 'control-token'); state = 'failed'; job.error = error; job.lease = null; return structuredClone(job); },
    async cancel(_id, reason) { state = 'cancelled'; job.error = { reason }; job.lease = null; return structuredClone(job); },
    async view() { return { schema: 'sideways-maker-public-job/v1', id: job.id, state }; },
    async exportReceipt() { return { schema: 'sideways-maker-export/v1', digest: 'export-digest', job: structuredClone(job) }; }
  };
  const route = options.route || { schema: 'sideways-maker-model-route-receipt/v1', receipt_digest: 'route-digest', provider: { id: 'provider-a', display_name: 'Provider A', kind: 'configured', engine_label: 'model-a', admission: { admitted: true } }, output: {}, attempts: [{ provider_id: 'provider-b', outcome: 'failed' }, { provider_id: 'provider-a', outcome: 'success' }] };
  const models = { async execute() { if (options.modelError) throw options.modelError; return structuredClone(route); } };
  const placement = options.placement || { schema: 'sideways-maker-placement/v1', placement_id: 'place-1', receipt_digest: 'placement-digest', worker_id: 'worker-1', lease: { fencing_token: 'fence-1' }, worker: { mode: 'in_process', identity: { state: 'verified', subject: 'worker-1' }, placement: { locality: 'local' } } };
  let cancelled = 0; let finished = 0;
  const fleet = {
    async enqueue() {},
    async place() { if (options.fleetError) throw options.fleetError; return structuredClone(placement); },
    async dispatch() { return structuredClone(options.dispatch || { schema: 'sideways-maker-fleet-dispatch/v1', ok: true, output: { result: { commit: 'abc' } } }); },
    async finish(_id, fence) { assert.equal(fence, 'fence-1'); finished += 1; },
    async cancel() { cancelled += 1; }
  };
  const pluginSnapshot = options.pluginSnapshot || { schema: 'sideways-maker-plugin-registry-snapshot/v1', receipt_digest: 'plugin-digest', enabled: ['repo'], admitted: [{ plugin_id: 'repo', state: 'enabled', manifest: { version: '1.0.0', manifest_digest: 'manifest-digest', declared_capabilities: ['repository.write'] }, admission: { admitted: true, execution: 'sandbox' } }] };
  const plugins = { async snapshot() { if (options.pluginError) throw options.pluginError; return structuredClone(pluginSnapshot); } };
  return { platform: createMakerRuntimePlatform({ controlPlane: control, modelRouter: models, workerFleet: fleet, pluginRegistry: plugins, clock, id: () => 'id-1' }), counters: () => ({ cancelled, finished }), state: () => state };
}

test('happy-path full composition preserves component receipts and completes', async () => {
  const h = harness(); const receipt = await h.platform.run(baseInput);
  assert.equal(receipt.outcome, 'completed'); assert.equal(receipt.links.model_route, 'route-digest'); assert.equal(receipt.links.fleet_placement, 'placement-digest'); assert.equal(receipt.links.plugin_state, 'plugin-digest');
  assert.equal(receipt.components.control_export.digest, 'export-digest'); assert.equal(h.counters().finished, 1);
});

test('provider fallback receipt is preserved', async () => { const receipt = await harness().platform.run(baseInput); assert.equal(receipt.components.model_route.attempts.length, 2); assert.equal(receipt.components.model_route.provider.id, 'provider-a'); });

test('no admitted provider and fallback exhaustion are explicit', async () => {
  for (const code of ['no_provider', 'fallback_exhausted']) await assert.rejects(() => harness({ modelError: Object.assign(new Error(code), { code }) }).platform.run(baseInput), error => error instanceof MakerRuntimePlatformError && ['no_admitted_provider', 'provider_fallback_exhausted'].includes(error.code));
});

test('incompatible and unverified capacity are blocked', async () => {
  await assert.rejects(() => harness({ fleetError: Object.assign(new Error('none'), { code: 'capability_mismatch' }) }).platform.run(baseInput), error => error.code === 'no_compatible_fleet_capacity');
  const placement = { schema: 'sideways-maker-placement/v1', receipt_digest: 'p', worker_id: 'bad', lease: { fencing_token: 'f' }, worker: { mode: 'in_process', identity: { state: 'unverified' }, placement: {} } };
  await assert.rejects(() => harness({ placement }).platform.run(baseInput), error => error.code === 'unverified_worker');
});

test('missing plugin capability is blocked', async () => { const pluginSnapshot = { receipt_digest: 'x', enabled: [], admitted: [] }; await assert.rejects(() => harness({ pluginSnapshot }).platform.run(baseInput), error => error.code === 'missing_plugin_capability'); });

test('approval-required authority is blocked', async () => { const input = structuredClone(baseInput); input.authority.capabilities.cloud = 'approval_required'; await assert.rejects(() => harness().platform.run(input), error => error.code === 'approval_gated_authority'); });

test('dispatch failure propagates and cleans fleet lease', async () => { const h = harness({ dispatch: { ok: false, error: { code: 'dispatch_failed', message: 'boom' } } }); await assert.rejects(() => h.platform.run(baseInput), error => error.code === 'dispatch_failed'); assert.equal(h.counters().cancelled, 1); assert.equal(h.state(), 'failed'); });

test('recoverable worker failure is recorded and lease is cleaned', async () => { const h = harness({ dispatch: { ok: true, output: { state: 'interrupted', recoverable: true, message: 'lost worker' } } }); const receipt = await h.platform.run(baseInput); assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.components.control_export.job.error.recoverable, true); assert.equal(h.counters().cancelled, 1); });

test('cancellation propagates', async () => { const h = harness({ dispatch: { ok: true, output: { state: 'cancelled', reason: 'operator' } } }); const receipt = await h.platform.run(baseInput); assert.equal(receipt.outcome, 'cancelled'); assert.equal(h.counters().cancelled, 1); });

test('secrets and raw endpoints are redacted', async () => { const input = structuredClone(baseInput); input.model_state = { api_token: 'sk-abcdefghijklmnopqrstuvwxyz', endpoint: 'https://provider.example/v1', nested: { password: 'nope' } }; const receipt = await harness().platform.run(input); const text = JSON.stringify(receipt); assert.equal(text.includes('sk-abcdefghijklmnopqrstuvwxyz'), false); assert.equal(text.includes('https://provider.example/v1'), false); assert.match(text, /\[redacted\]/); });

test('receipt integrity is deterministic', async () => { const a = await harness().platform.run(baseInput); const b = await harness().platform.run(baseInput); assert.equal(a.integrity_digest, b.integrity_digest); assert.equal(a.integrity_digest, platformDigest({ ...a, integrity_digest: undefined })); });

test('stale fencing and plugin admission errors are normalized', async () => {
  await assert.rejects(() => harness({ pluginError: Object.assign(new Error('denied'), { code: 'plugin_denied' }) }).platform.run(baseInput), error => error.code === 'plugin_admission_failure');
  const h = harness(); h.platform.fleet.finish = async () => { throw Object.assign(new Error('stale'), { code: 'fencing_mismatch' }); };
  await assert.rejects(() => h.platform.run(baseInput), error => error.code === 'stale_lease_or_fencing_token');
});
