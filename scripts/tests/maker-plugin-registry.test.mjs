import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  PluginRegistryError,
  createAdmissionPolicy,
  createPluginLoaderRegistry,
  createPluginRegistry,
  discoverPluginManifests,
  evaluatePluginAdmission,
  normalizePluginManifest,
  redactPluginSecrets,
  validatePluginConfiguration
} from '../maker-plugin-registry.mjs';
const digest = letter => `sha256:${letter.repeat(64)}`;
const manifest = (id = 'example.plugin', overrides = {}) => ({
  id, version: '1.0.0', api: '^1.0.0', kind: 'tool_runtime', entrypoint: './plugin.mjs',
  provenance: 'repository', license: 'MIT',
  integrity: { digest: digest('a'), algorithm: 'sha256' },
  signature: { status: 'verified', signer: 'repo-key', digest: digest('b') },
  runtime: { node: '>=20', os: ['any'], architectures: ['any'], isolation: 'in_process' },
  capabilities: ['tool.execute'],
  permissions: { capabilities: ['tool.execute'], secret_references: ['vault://api'], network_hosts: ['api.example.com'], commands: ['node'], filesystem: ['workspace:read'], privileged: [] },
  config_schema: { type: 'object', additionalProperties: false, properties: { api_ref: { type: 'string' }, mode: { type: 'string', enum: ['safe'] } }, required: ['mode'] },
  dependencies: [], optional_dependencies: [], hooks: ['health', 'invoke'], migrations: [],
  ...overrides
});
function deterministic() {
  let stamp = Date.parse('2026-07-15T00:00:00.000Z'); let serial = 0;
  return { clock: () => stamp, id: () => `id-${++serial}`, advance: ms => { stamp += ms; } };
}
function loaders(impl = async packet => ({ ok: true, capability: packet.capability })) {
  const registry = createPluginLoaderRegistry({ timeout_ms: 100 });
  registry.register('in_process', impl);
  registry.register('sandbox_rpc', impl);
  return registry;
}

test('typed manifests cover every plugin kind and deterministic integrity', () => {
  for (const kind of ['scm','issue_review','ci','artifact_store','deployment','model_provider','repository_intelligence','editor','tool_runtime','language_framework','evaluator']) {
    const value = normalizePluginManifest(manifest(`plugin.${kind}`, { kind }));
    assert.equal(value.kind, kind);
    assert.match(value.manifest_digest, /^[a-f0-9]{64}$/);
    assert.equal(value.permissions.secret_references[0], 'vault://api');
  }
  assert.throws(() => normalizePluginManifest(manifest('xx', { kind: 'unknown' })), error => error.code === 'plugin_kind_invalid');
});

test('admission accepts valid trusted plugin and selects in-process only when verified', () => {
  const value = normalizePluginManifest(manifest());
  const admission = evaluatePluginAdmission(value, { policy: createAdmissionPolicy(), evaluated_at: '2026-07-15T00:00:00.000Z' });
  assert.equal(admission.admitted, true);
  assert.equal(admission.execution, 'in_process');
  const unsigned = evaluatePluginAdmission(normalizePluginManifest(manifest('unsigned', { signature: { status: 'unverified' } })), { policy: createAdmissionPolicy() });
  assert.equal(unsigned.admitted, true);
  assert.equal(unsigned.execution, 'sandbox_rpc');
});

test('bad digest, signature metadata, API, provenance, and license are denied', () => {
  const policy = createAdmissionPolicy({ require_signature: true });
  const cases = [
    [manifest('bad.digest', { integrity: { digest: 'bad' } }), 'integrity_invalid'],
    [manifest('bad.signature', { signature: { status: 'verified', digest: 'bad' } }), 'signature_metadata_invalid'],
    [manifest('bad.api', { api: '^2.0.0' }), 'api_incompatible'],
    [manifest('bad.provenance', { provenance: 'internet-random' }), 'provenance_denied'],
    [manifest('bad.license', { license: 'AGPL-3.0' }), 'license_denied']
  ];
  for (const [input, reason] of cases) assert.ok(evaluatePluginAdmission(normalizePluginManifest(input), { policy }).reasons.includes(reason));
});

test('excessive commands, network, filesystem, and privileged permissions require denial or approval', () => {
  const policy = createAdmissionPolicy();
  assert.ok(evaluatePluginAdmission(normalizePluginManifest(manifest('cmd', { permissions: { ...manifest().permissions, commands: ['sudo'] } })), { policy }).reasons.includes('command_denied'));
  assert.ok(evaluatePluginAdmission(normalizePluginManifest(manifest('net', { permissions: { ...manifest().permissions, network_hosts: ['*'] } })), { policy }).reasons.includes('network_scope_excessive'));
  assert.ok(evaluatePluginAdmission(normalizePluginManifest(manifest('fs', { permissions: { ...manifest().permissions, filesystem: ['/etc'] } })), { policy }).reasons.includes('filesystem_scope_excessive'));
  const privilegedManifest = normalizePluginManifest(manifest('deploy', { capabilities: ['deployment.production'], permissions: { ...manifest().permissions, privileged: ['deployment.production'] } }));
  assert.ok(evaluatePluginAdmission(privilegedManifest, { policy }).reasons.includes('privileged_approval_required'));
  assert.equal(evaluatePluginAdmission(privilegedManifest, { policy, approvals: ['deployment.production'] }).admitted, true);
});

test('configuration validates schema, persists references, and rejects secret values', () => {
  const value = normalizePluginManifest(manifest());
  assert.deepEqual(validatePluginConfiguration(value, { mode: 'safe', api_ref: 'vault://api' }), { mode: 'safe', api_ref: 'vault://api' });
  assert.throws(() => validatePluginConfiguration(value, { mode: 'unsafe' }), error => error.code === 'config_invalid');
  assert.throws(() => validatePluginConfiguration(value, { mode: 'safe', api_key: 'sk-abcdefghijklmnop' }), error => error.code === 'secret_value_denied');
  assert.throws(() => validatePluginConfiguration(value, { mode: 'safe', api_ref: 'vault://other' }), error => error.code === 'secret_reference_undeclared');
});

test('discovery deterministically resolves newest or pinned versions and detects same-version conflicts', () => {
  const discovery = discoverPluginManifests([
    { source: 'a', manifest: manifest('multi', { version: '1.0.0' }) },
    { source: 'b', manifest: manifest('multi', { version: '1.2.0' }) }
  ]);
  assert.equal(discovery.selected[0].manifest.version, '1.2.0');
  const pinned = discoverPluginManifests([
    { manifest: manifest('multi', { version: '1.0.0' }) },
    { manifest: manifest('multi', { version: '1.2.0' }) }
  ], { pins: { multi: '1.0.0' } });
  assert.equal(pinned.selected[0].manifest.version, '1.0.0');
  assert.throws(() => discoverPluginManifests([
    { source: 'a', manifest: manifest('conflict') },
    { source: 'b', manifest: manifest('conflict', { capabilities: ['different'] }) }
  ]), error => error.code === 'discovery_conflict');
});

test('dependency ordering includes optional dependencies and rejects missing, mismatched, and cyclic graphs', () => {
  const registry = createPluginRegistry({ loaders: loaders() });
  registry.admit(manifest('base'), { config: { mode: 'safe' } });
  registry.admit(manifest('child', { dependencies: [{ id: 'base', range: '^1.0.0' }] }), { config: { mode: 'safe' } });
  assert.deepEqual(registry.order(['child']), ['base', 'child']);
  assert.throws(() => registry.admit(manifest('missing', { dependencies: ['nope'] }), { config: { mode: 'safe' } }), error => error.code === 'dependency_missing');
  const mismatch = createPluginRegistry({ loaders: loaders() });
  mismatch.admit(manifest('base', { version: '1.0.0' }), { config: { mode: 'safe' } });
  assert.throws(() => mismatch.admit(manifest('bad-child', { dependencies: [{ id: 'base', range: '^2.0.0' }] }), { config: { mode: 'safe' } }), error => error.code === 'dependency_version_mismatch');
  const cyclic = createPluginRegistry({ loaders: loaders() });
  cyclic.admit(manifest('aa', { dependencies: [] }), { config: { mode: 'safe' } });
  cyclic.admit(manifest('bb', { dependencies: ['aa'] }), { config: { mode: 'safe' } });
  assert.throws(() => cyclic.admit(manifest('aa', { version: '2.0.0', dependencies: ['bb'] }), { config: { mode: 'safe' } }), error => error.code === 'dependency_cycle');
});

test('dependencies must be enabled before dependents and capability negotiation is ordered', () => {
  const registry = createPluginRegistry({ loaders: loaders() });
  registry.admit(manifest('base'), { config: { mode: 'safe' } });
  registry.admit(manifest('child', { dependencies: ['base'] }), { config: { mode: 'safe' } });
  assert.throws(() => registry.enable('child'), error => error.code === 'dependency_not_enabled');
  registry.enable('base'); registry.enable('child');
  assert.deepEqual(registry.negotiate('tool.execute').map(value => value.id), ['base', 'child']);
});

test('trusted plugin invokes in-process while unsigned plugin uses sandbox RPC and receipts redact secrets', async () => {
  const seen = [];
  const loaderRegistry = createPluginLoaderRegistry();
  loaderRegistry.register('in_process', async packet => { seen.push(['in_process', packet]); return { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', ok: true }; });
  loaderRegistry.register('sandbox_rpc', async packet => { seen.push(['sandbox_rpc', packet]); return { ok: true }; });
  const registry = createPluginRegistry({ loaders: loaderRegistry });
  registry.admit(manifest('trusted'), { config: { mode: 'safe' } }); registry.enable('trusted');
  registry.admit(manifest('sandboxed', { signature: { status: 'unverified' } }), { config: { mode: 'safe' } }); registry.enable('sandboxed');
  const trusted = await registry.invoke('trusted', 'tool.execute', { token: 'raw' });
  const sandboxed = await registry.invoke('sandboxed', 'tool.execute', {});
  assert.equal(trusted.mode, 'in_process'); assert.equal(sandboxed.mode, 'sandbox_rpc');
  assert.equal(trusted.output.authorization, '[redacted]');
  assert.equal(seen[0][1].input.token, '[redacted]');
});

test('invocation rejects undeclared capabilities and disabled plugins', async () => {
  const registry = createPluginRegistry({ loaders: loaders() });
  registry.admit(manifest('invoke'), { config: { mode: 'safe' } });
  await assert.rejects(registry.invoke('invoke', 'tool.execute'), error => error.code === 'plugin_not_enabled');
  registry.enable('invoke');
  await assert.rejects(registry.invoke('invoke', 'deployment.production'), error => error.code === 'capability_undeclared');
});

test('timeouts, error isolation, and circuit breaker do not crash the registry', async () => {
  const d = deterministic();
  const loaderRegistry = createPluginLoaderRegistry({ clock: d.clock, timeout_ms: 10 });
  loaderRegistry.register('in_process', async () => new Promise(() => {}));
  loaderRegistry.register('sandbox_rpc', async () => { throw new Error('Bearer abcdefghijklmnopqrstuvwxyz'); });
  const timeoutRegistry = createPluginRegistry({ loaders: loaderRegistry, clock: d.clock, id: d.id, circuit_threshold: 1 });
  timeoutRegistry.admit(manifest('timeout'), { config: { mode: 'safe' } }); timeoutRegistry.enable('timeout');
  const receipt = await timeoutRegistry.invoke('timeout', 'tool.execute');
  assert.equal(receipt.ok, false); assert.equal(receipt.error.code, 'plugin_timeout');
  await assert.rejects(timeoutRegistry.invoke('timeout', 'tool.execute'), error => error.code === 'plugin_circuit_open');
  assert.ok(!JSON.stringify(timeoutRegistry.snapshot()).includes('abcdefghijklmnopqrstuvwxyz'));
});

test('abort signals cancel sandbox invocation without exposing process state', async () => {
  const loaderRegistry = createPluginLoaderRegistry({ timeout_ms: 1000 });
  loaderRegistry.register('in_process', async () => ({ ok: true }));
  loaderRegistry.register('sandbox_rpc', async (_packet, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
  const registry = createPluginRegistry({ loaders: loaderRegistry });
  registry.admit(manifest('cancel', { signature: { status: 'unverified' } }), { config: { mode: 'safe' } }); registry.enable('cancel');
  const controller = new AbortController(); const promise = registry.invoke('cancel', 'tool.execute', {}, { signal: controller.signal }); controller.abort();
  assert.equal((await promise).ok, false);
});

test('health probes isolate errors and mark unavailable plugins', async () => {
  const registry = createPluginRegistry({ loaders: loaders() });
  registry.admit(manifest('health'), { config: { mode: 'safe' } });
  assert.equal((await registry.health('health', '', async () => ({ status: 'healthy', ok: true }))).status, 'healthy');
  assert.equal((await registry.health('health', '', async () => { throw new Error('offline'); })).status, 'unavailable');
  assert.equal(registry.get('health').state, 'unavailable');
});

test('upgrade creates migration receipt, disables old version, and rollback restores it', () => {
  const registry = createPluginRegistry({ loaders: loaders() });
  registry.admit(manifest('upgrade', { version: '1.0.0' }), { config: { mode: 'safe' } }); registry.enable('upgrade', '1.0.0');
  const next = registry.upgrade(manifest('upgrade', { version: '2.0.0', migrations: [{ from: '1.0.0', to: '2.0.0', hook: 'migrate-v2' }] }), { config: { mode: 'safe' } });
  assert.equal(next.previous_version, '1.0.0'); assert.equal(next.migration.hook, 'migrate-v2');
  assert.equal(registry.get('upgrade', '1.0.0').state, 'disabled');
  registry.enable('upgrade', '2.0.0');
  const restored = registry.rollback('upgrade', { from_version: '2.0.0', to_version: '1.0.0' });
  assert.equal(restored.version, undefined);
  assert.equal(restored.manifest.version, '1.0.0'); assert.equal(restored.state, 'enabled');
});

test('downgrade requires explicit authority and remove plan never executes package removal', () => {
  const registry = createPluginRegistry({ loaders: loaders() });
  registry.admit(manifest('versioned', { version: '2.0.0' }), { config: { mode: 'safe' } });
  assert.throws(() => registry.upgrade(manifest('versioned', { version: '1.0.0' }), { config: { mode: 'safe' } }), error => error.code === 'upgrade_version_invalid');
  const plan = registry.removePlan('versioned');
  assert.equal(plan.execute, false); assert.equal(plan.allowed, true);
  assert.equal(registry.installPlan(manifest('new')).package_install, false);
});

test('remove plan identifies dependents and blocks implicit removal', () => {
  const registry = createPluginRegistry({ loaders: loaders() });
  registry.admit(manifest('base'), { config: { mode: 'safe' } });
  registry.admit(manifest('child', { dependencies: ['base'] }), { config: { mode: 'safe' } });
  const plan = registry.removePlan('base');
  assert.deepEqual(plan.dependents, ['child']); assert.equal(plan.allowed, false); assert.equal(plan.execute, false);
});

test('disable, drain, and event receipts are explicit', () => {
  const registry = createPluginRegistry({ loaders: loaders() });
  registry.admit(manifest('lifecycle'), { config: { mode: 'safe' } }); registry.enable('lifecycle');
  assert.equal(registry.drain('lifecycle', '', 'maintenance').state, 'draining');
  assert.equal(registry.disable('lifecycle', '', 'operator').state, 'disabled');
  assert.ok(registry.events().some(event => event.type === 'plugin.draining'));
});

test('deterministic snapshots preserve loader availability, circuits, events, and no secrets', () => {
  const d1 = deterministic(); const d2 = deterministic();
  const first = createPluginRegistry({ loaders: loaders(), clock: d1.clock, id: d1.id });
  const second = createPluginRegistry({ loaders: loaders(), clock: d2.clock, id: d2.id });
  const input = manifest('snapshot', { metadata: { api_key: 'sk-abcdefghijklmnop' } });
  first.admit(input, { config: { mode: 'safe' } }); second.admit(input, { config: { mode: 'safe' } });
  assert.equal(first.snapshot().snapshot_digest, second.snapshot().snapshot_digest);
  assert.ok(!JSON.stringify(first.snapshot()).includes('sk-'));
});

test('published plugin schema covers manifest, admission, discovery, record, invocation, lifecycle, and registry receipts', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../../maker/contracts/plugin-manifest.schema.json', import.meta.url), 'utf8'));
  const refs = new Set(schema.oneOf.map(value => value.$ref));
  for (const name of ['manifest','admission','discovery','record','invocation','invocationReceipt','installPlan','removePlan','event','registry']) assert.ok(refs.has(`#/$defs/${name}`), `missing ${name}`);
  assert.equal(schema.$defs.manifest.properties.schema.const, 'sideways-maker-plugin-manifest/v1');
  assert.equal(schema.$defs.registry.properties.schema.const, 'sideways-maker-plugin-registry/v1');
});

test('redaction strips credential-shaped strings and secret keys', () => {
  const value = redactPluginSecrets({ authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', nested: { api_key: 'sk-abcdefghijklmnop' } });
  assert.equal(value.authorization, '[redacted]'); assert.equal(value.nested.api_key, '[redacted]');
});
