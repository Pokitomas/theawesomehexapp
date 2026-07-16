import assert from 'node:assert/strict';
import test from 'node:test';
import { createMakerControlPlane } from '../maker-control-plane.mjs';
import { createModelRouter } from '../maker-model-router.mjs';
import { createFleetAdapterRegistry, createWorkerFleet, registerDefaultFleetAdapters } from '../maker-worker-fleet.mjs';
import { createPluginRegistry } from '../maker-plugin-registry.mjs';
import {
  buildRuntimeProfile,
  createMakerRuntimePlatform,
  derivePluginAuthority,
  platformDigest,
  redactPlatformSecrets
} from '../maker-runtime-platform.mjs';

function deterministic() {
  let tick = Date.parse('2026-07-15T00:00:00.000Z');
  let serial = 0;
  return {
    clock: () => tick,
    id: () => `id-${++serial}`,
    advance: ms => { tick += ms; }
  };
}

const provider = overrides => ({
  id: 'provider-a',
  display_name: 'Admitted Engine',
  kind: 'openai_compatible',
  health: 'healthy',
  availability: { value: true, source: 'observed' },
  capabilities: {
    structured_json: { value: true, source: 'observed' },
    tool_use: { value: true, source: 'observed' },
    streaming: { value: true, source: 'configured' },
    multimodal: { value: false, source: 'observed' },
    context_tokens: { value: 128000, source: 'observed' },
    output_tokens: { value: 32000, source: 'observed' },
    latency_class: { value: 'fast', source: 'observed' },
    privacy: { value: 'private', source: 'configured' },
    region: { value: 'us-west', source: 'configured' },
    locality: { value: 'remote', source: 'observed' }
  },
  cost: { input_per_million_usd: 1, output_per_million_usd: 2, request_usd: 0 },
  reliability: { success_rate: 0.99, samples: 100, consecutive_failures: 0 },
  metadata: { engine_label: 'Admitted Engine' },
  ...overrides
});

const worker = overrides => ({
  id: 'worker-a',
  display_name: 'Worker A',
  mode: 'self_hosted',
  identity: { state: 'attested', issuer: 'maker', subject: 'worker-a', digest: 'sha256:abc' },
  platform: { os: 'linux', arch: 'x64', labels: ['coding', 'repair'], toolchains: ['node', 'git'], providers: ['native'] },
  isolation: { containers: true, sandbox: true, ephemeral_workspace: true, network: 'restricted' },
  resources: { cpu: 8, memory_mb: 16384, disk_mb: 100000, time_ms: 3600000, concurrency: 1, queue_depth: 0 },
  placement: { region: 'us-west', locality: 'local', privacy: 'local', latency_ms: 10, cost_per_hour_usd: 1 },
  health: { state: 'healthy' },
  reliability: { success_rate: 0.99, samples: 100, lost_runs: 0 },
  state: 'active',
  ...overrides
});

const pluginManifest = overrides => ({
  id: 'repo.writer',
  version: '1.0.0',
  api_compatibility: '1',
  kind: 'tool_runtime',
  entrypoint: './writer.mjs',
  execution: 'subprocess',
  provenance: { source: 'repository', publisher: 'Pokitomas', license: 'MIT', trusted: false },
  integrity: { algorithm: 'sha256', digest: `sha256:${'a'.repeat(64)}`, signature: 'sig', signer: 'maker' },
  required_runtime: { api: '1.0.0', os: ['linux'], arch: ['x64'] },
  declared_capabilities: ['repository_write'],
  permissions: { filesystem: { read: ['repo/**'], write: [], execute: [] }, network_hosts: [], commands: [], secret_references: ['GITHUB_TOKEN'], capabilities: ['repository_write'], privileged: false },
  configuration_schema: { type: 'object' },
  dependencies: { required: [], optional: [] },
  lifecycle_hooks: { invoke: 'invoke' },
  migration: { from: [], reversible: true },
  ...overrides
});

const pluginPolicy = overrides => ({
  runtime_api: '1.0.0',
  allowed_licenses: ['MIT'],
  allowed_sources: ['repository'],
  require_signature: true,
  allowed_permissions: { filesystem: { read: ['repo/**'], write: [], execute: [] }, network_hosts: [], commands: [], capabilities: ['repository_write', 'release'] },
  ...overrides
});

function baseInput(overrides = {}) {
  return {
    control_request: {
      control_repository: 'Pokitomas/theawesomehexapp',
      target_repository: 'Pokitomas/theawesomehexapp',
      head_repository: 'Pokitomas/theawesomehexapp',
      repository: 'Pokitomas/theawesomehexapp',
      base_revision: 'main',
      mode: 'build',
      backend: 'auto',
      request: 'Build the integrated Maker runtime.',
      protect: 'Do not merge or deploy.',
      proof: 'Return exact component receipts.',
      priority: 80,
      idempotency_key: 'platform-happy',
      runtime_requirements: { authority: ['repository_write'], recoverable: true },
      authority: { capabilities: { repository_write: 'execute' } }
    },
    model_task: { type: 'coding', id: 'model-task' },
    fleet_task: {
      id: 'fleet-task',
      requirements: {
        modes: ['self_hosted'], os: 'linux', arch: 'x64', labels: ['coding'], toolchains: ['node'], providers: ['native'],
        network: 'restricted', containers: true, sandbox: true, ephemeral_workspace: true,
        cpu: 4, memory_mb: 4096, disk_mb: 10000, time_ms: 60000,
        locality: 'local', privacy_minimum: 'private', verified_identity: true, max_cost_per_hour_usd: 5
      }
    },
    plugin_capabilities: ['repository_write'],
    required_authority: ['repository_write'],
    ...overrides
  };
}

function makeRuntime(options = {}) {
  const d = options.d || deterministic();
  const providers = options.providers || [provider()];
  const transports = options.transports || {
    'provider-a': async () => ({ output: { plan: 'implement' }, usage: { input_tokens: 100, output_tokens: 10, cost_usd: 0.01 } })
  };
  const modelRouter = createModelRouter({ providers, transports, clock: d.clock, id: d.id, sleep: async ms => d.advance(ms), retries: options.model_retries ?? 0 });
  const adapters = createFleetAdapterRegistry({ clock: d.clock });
  registerDefaultFleetAdapters(adapters, {
    self_hosted: options.dispatch || (async () => ({ result: { branch: 'agent/integrated', pull_request: 'https://github.com/Pokitomas/theawesomehexapp/pull/999' }, cost_usd: 0.2 }))
  });
  const fleet = createWorkerFleet({ workers: options.workers || [worker()], adapters, clock: d.clock, id: d.id, lease_ms: options.lease_ms || 1000 });
  const manifests = options.manifests || [pluginManifest()];
  const plugins = createPluginRegistry({
    manifests,
    policy: options.policy || pluginPolicy(),
    approvals: options.approvals || [],
    sandbox: { invoke: async () => ({ ok: true }) },
    clock: d.clock,
    id: d.id
  });
  for (const manifest of manifests) {
    if (options.skip_plugin_admission) continue;
    plugins.admit(manifest.id, manifest.version);
    plugins.enable(manifest.id);
  }
  const control = createMakerControlPlane({ clock: d.clock, id: d.id, lease_ms: options.lease_ms || 1000 });
  const platform = createMakerRuntimePlatform({ control, modelRouter, fleet, plugins, clock: d.clock, id: d.id });
  return { d, control, modelRouter, fleet, plugins, platform };
}

test('happy path composes route, placement, authority, durable claim, dispatch, completion, and presentation', async () => {
  const runtime = makeRuntime();
  const receipt = await runtime.platform.run(baseInput());
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.components.model_route.provider.id, 'provider-a');
  assert.equal(receipt.components.fleet_placement.worker_id, 'worker-a');
  assert.equal(receipt.components.plugin_authority.authority.repository_write, 'execute');
  assert.equal(receipt.components.control_job.state, 'completed');
  assert.equal(receipt.components.presentation.state, 'completed');
  assert.equal(receipt.components.presentation.engine.label, 'Admitted Engine');
  assert.equal(receipt.components.presentation.links.branch, 'agent/integrated');
  assert.equal(receipt.receipt_digest, platformDigest({ ...receipt, receipt_digest: undefined }));
});

test('provider fallback preserves the selected fallback route in the platform receipt', async () => {
  const runtime = makeRuntime({
    providers: [provider({ id: 'primary', preferences: { operator_rank: 10 } }), provider({ id: 'fallback' })],
    transports: {
      primary: async () => { throw new Error('primary unavailable'); },
      fallback: async () => ({ output: { plan: 'fallback' }, usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0 } })
    }
  });
  const receipt = await runtime.platform.run(baseInput());
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.components.model_route.provider.id, 'fallback');
  assert.equal(receipt.components.model_route.attempts[0].provider_id, 'primary');
});

test('incompatible fleet capacity blocks before durable claim', async () => {
  const runtime = makeRuntime({ workers: [worker({ resources: { ...worker().resources, memory_mb: 1000 } })] });
  const receipt = await runtime.platform.run(baseInput());
  assert.equal(receipt.state, 'blocked');
  assert.equal(receipt.error.code, 'capability_mismatch');
  assert.equal(receipt.components.control_job, null);
});

test('unverified workers are rejected as unverified capacity', async () => {
  const runtime = makeRuntime({ workers: [worker({ identity: { state: 'unverified' } })] });
  const receipt = await runtime.platform.run(baseInput());
  assert.equal(receipt.state, 'blocked');
  assert.equal(receipt.error.code, 'unverified_capacity');
});

test('missing admitted plugin capability blocks and releases fleet placement', async () => {
  const runtime = makeRuntime({ manifests: [pluginManifest({ declared_capabilities: ['read_only'], permissions: { ...pluginManifest().permissions, capabilities: ['read_only'] } })], policy: pluginPolicy({ allowed_permissions: { ...pluginPolicy().allowed_permissions, capabilities: ['read_only'] } }) });
  const receipt = await runtime.platform.run(baseInput());
  assert.equal(receipt.state, 'blocked');
  assert.equal(receipt.error.code, 'plugin_capability_missing');
  assert.equal(runtime.fleet.snapshot().tasks[0].state, 'cancelled');
});

test('approval-gated deployment authority blocks until the capability is explicitly approved', async () => {
  const deployment = pluginManifest({
    id: 'release.plugin', kind: 'deployment', declared_capabilities: ['release'],
    permissions: { ...pluginManifest().permissions, capabilities: ['release'], privileged: true }
  });
  const runtime = makeRuntime({ manifests: [deployment], approvals: ['release.plugin@1.0.0'] });
  const input = baseInput({
    plugin_capabilities: ['release'], required_authority: ['deployment'],
    control_request: { ...baseInput().control_request, idempotency_key: 'approval-gate', runtime_requirements: { authority: ['deployment'], recoverable: true } }
  });
  const blocked = await runtime.platform.run(input);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.error.code, 'authority_approval_required');

  const approvedRuntime = makeRuntime({ manifests: [deployment], approvals: ['release.plugin@1.0.0'] });
  const approved = await approvedRuntime.platform.run({ ...input, approved_capabilities: ['deployment'], control_request: { ...input.control_request, idempotency_key: 'approval-granted' } });
  assert.equal(approved.state, 'completed');
  assert.equal(approved.components.plugin_authority.authority.deployment, 'execute');
});

test('dispatch failure becomes a recoverable failed control job and public receipt', async () => {
  const runtime = makeRuntime({ dispatch: async () => { throw new Error('worker transport down'); } });
  const receipt = await runtime.platform.run(baseInput());
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.error.recoverable, true);
  assert.equal(receipt.components.control_job.state, 'failed');
  assert.equal(receipt.components.presentation.state, 'failed');
  assert.equal(runtime.fleet.snapshot().tasks[0].state, 'cancelled');
});

test('stale control lease is surfaced as recoverable after a worker returns late', async () => {
  const d = deterministic();
  const runtime = makeRuntime({ d, lease_ms: 100, dispatch: async () => { d.advance(101); return { result: { branch: 'late' } }; } });
  const receipt = await runtime.platform.run(baseInput());
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.error.code, 'lease_expired');
  assert.equal(receipt.error.recoverable, true);
});

test('unavailable worker adapter is explicit and does not fabricate dispatch success', async () => {
  const d = deterministic();
  const modelRouter = createModelRouter({ providers: [provider()], transports: { 'provider-a': async () => ({ output: { plan: 'x' } }) }, clock: d.clock, id: d.id });
  const adapters = createFleetAdapterRegistry({ clock: d.clock });
  registerDefaultFleetAdapters(adapters, {});
  const fleet = createWorkerFleet({ workers: [worker()], adapters, clock: d.clock, id: d.id, lease_ms: 1000 });
  const plugins = createPluginRegistry({ manifests: [pluginManifest()], policy: pluginPolicy(), clock: d.clock, id: d.id });
  plugins.admit('repo.writer'); plugins.enable('repo.writer');
  const control = createMakerControlPlane({ clock: d.clock, id: d.id, lease_ms: 1000 });
  const platform = createMakerRuntimePlatform({ control, modelRouter, fleet, plugins, clock: d.clock, id: d.id });
  const receipt = await platform.run(baseInput());
  assert.equal(receipt.state, 'blocked');
  assert.equal(receipt.error.code, 'adapter_unavailable');
  assert.notEqual(receipt.components.control_job?.state, 'completed');
});

test('platform receipts preserve every component receipt and redact credentials end to end', async () => {
  const runtime = makeRuntime({
    dispatch: async () => ({ result: { branch: 'agent/secure', authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456', api_key: 'sk-abcdefghijklmnopqrstuvwxyz123456' } })
  });
  const receipt = await runtime.platform.run(baseInput({ model_state: { context: { token: 'top-secret' } } }));
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.state, 'completed');
  assert.ok(receipt.components.model_route.receipt_digest);
  assert.ok(receipt.components.fleet_placement.receipt_digest);
  assert.ok(receipt.components.plugin_registry.receipt_digest);
  assert.ok(receipt.components.control_job.request_digest);
  assert.ok(receipt.components.dispatch);
  assert.ok(receipt.components.presentation);
  assert.ok(!serialized.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!serialized.includes('top-secret'));
});

test('fresh deterministic runtimes produce identical platform receipt integrity', async () => {
  const first = await makeRuntime().platform.run(baseInput());
  const second = await makeRuntime().platform.run(baseInput());
  assert.equal(first.receipt_digest, second.receipt_digest);
  assert.deepEqual(first, second);
});


test('endpoint and credential-shaped fields are removed from platform receipts', () => {
  const safe = redactPlatformSecrets({
    endpoint: 'https://provider.example/v1',
    credential: 'opaque-value',
    nested: { runner_secret: 'runner-value', ordinary_url: 'https://example.test/path' }
  });
  assert.equal(safe.endpoint, '[redacted]');
  assert.equal(safe.credential, '[redacted]');
  assert.equal(safe.nested.runner_secret, '[redacted]');
  assert.equal(safe.nested.ordinary_url, 'https://example.test/path');
});

test('runtime profile derives provider, worker, and plugin truth without endpoint or secret metadata', () => {
  const authority = derivePluginAuthority({
    enabled: ['repo.writer'],
    admitted: [{ plugin_id: 'repo.writer', state: 'enabled', manifest: pluginManifest({ metadata: { api_key: 'hidden' } }) }]
  }, { required_capabilities: ['repository_write'] });
  const profile = buildRuntimeProfile({
    route: {
      provider: { id: 'provider-a', kind: 'openai_compatible', engine_label: 'Engine', admission: { admitted: true } },
      provider_descriptor: provider({ metadata: { api_key: 'hidden' } })
    },
    placement: {
      worker_id: 'worker-a',
      worker: { mode: 'self_hosted', platform: { labels: [] }, placement: { locality: 'local', privacy: 'local' } },
      workspace: { isolation: 'container' }
    },
    pluginAuthority: authority,
    modelTask: { role: 'implementer', required: ['structured_json'], preferred: ['tool_use'] },
    clock: () => Date.parse('2026-07-15T00:00:00Z')
  });
  assert.equal(profile.intelligence.engine_label, 'Engine');
  assert.equal(profile.endpoint.ownership, 'user');
  assert.equal(profile.endpoint.transport, 'relay');
  assert.equal(profile.authority.capabilities.repository_write, 'execute');
  assert.ok(!JSON.stringify(redactPlatformSecrets(profile)).includes('hidden'));
});
