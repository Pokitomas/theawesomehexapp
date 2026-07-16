import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MakerPluginError,
  compareVersions,
  createPluginRegistry,
  dependencyOrder,
  evaluatePluginAdmission,
  normalizePluginManifest,
  pluginDigest,
  redactPluginSecrets,
  resolvePluginVersions,
  validateConfiguration
} from '../maker-plugin-registry.mjs';

const manifest = overrides => ({
  id: 'example.plugin',
  version: '1.0.0',
  api_compatibility: '1',
  kind: 'tool_runtime',
  entrypoint: './plugin.mjs',
  execution: 'subprocess',
  provenance: { source: 'repository', publisher: 'Pokitomas', license: 'MIT', trusted: false },
  integrity: { algorithm: 'sha256', digest: `sha256:${'a'.repeat(64)}`, signature: 'sig', signer: 'maker' },
  required_runtime: { api: '1.0.0', node: '>=22', os: ['linux'], arch: ['x64'] },
  declared_capabilities: ['run'],
  permissions: { filesystem: { read: ['repo/**'], write: [], execute: [] }, network_hosts: [], commands: [], secret_references: ['GITHUB_TOKEN'], capabilities: ['run'], privileged: false },
  configuration_schema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['safe'] }, token: { type: 'string' } }, additionalProperties: false },
  dependencies: { required: [], optional: [] },
  lifecycle_hooks: { health: 'health', invoke: 'invoke' },
  migration: { from: [], reversible: true },
  ...overrides
});
const policy = overrides => ({
  runtime_api: '1.0.0',
  allowed_licenses: ['MIT'],
  allowed_sources: ['repository'],
  require_signature: true,
  allowed_permissions: { filesystem: { read: ['repo/**'], write: [], execute: [] }, network_hosts: [], commands: [], capabilities: ['run'] },
  ...overrides
});
function deterministic() {
  let tick = Date.parse('2026-07-15T00:00:00.000Z');
  let serial = 0;
  return { clock: () => tick, id: () => `id-${++serial}`, advance: ms => { tick += ms; } };
}

test('normalizes typed manifests and all plugin kinds', () => {
  for (const kind of ['scm', 'issue_review', 'ci', 'artifact_store', 'deployment', 'model_provider', 'repository_intelligence', 'editor', 'tool_runtime', 'language_framework', 'evaluator']) {
    const value = normalizePluginManifest(manifest({ id: `plugin.${kind}`, kind }));
    assert.equal(value.kind, kind);
    assert.match(value.manifest_digest, /^[a-f0-9]{64}$/);
    assert.equal(value.permissions.secret_references[0], 'GITHUB_TOKEN');
  }
});

test('semantic version comparison and duplicate resolution are deterministic', () => {
  assert.ok(compareVersions('1.2.0', '1.1.9') > 0);
  const selected = resolvePluginVersions([manifest({ version: '1.0.0' }), manifest({ version: '1.2.0', integrity: { digest: `sha256:${'b'.repeat(64)}` } })]);
  assert.equal(selected[0].version, '1.2.0');
});

test('admission validates integrity, signature, API, license, provenance, permissions, and approval', () => {
  assert.equal(evaluatePluginAdmission(normalizePluginManifest(manifest()), policy(), []).admitted, true);
  const bad = evaluatePluginAdmission(normalizePluginManifest(manifest({
    kind: 'deployment',
    integrity: { digest: '' },
    provenance: { source: 'internet', license: 'GPL-3.0' },
    permissions: { filesystem: { read: ['repo/**'], write: ['repo/**'] }, commands: ['rm'], privileged: true }
  })), policy(), []);
  assert.equal(bad.admitted, false);
  for (const reason of ['integrity_missing', 'signature_missing', 'license_denied', 'provenance_denied', 'permissions_excessive', 'human_approval_required']) assert.ok(bad.reasons.includes(reason));
});

test('privileged capability admission requires exact human approval', () => {
  const privileged = normalizePluginManifest(manifest({ permissions: { ...manifest().permissions, commands: ['git'], privileged: true } }));
  assert.equal(evaluatePluginAdmission(privileged, policy({ allowed_permissions: { ...policy().allowed_permissions, commands: ['git'] } }), []).admitted, false);
  assert.equal(evaluatePluginAdmission(privileged, policy({ allowed_permissions: { ...policy().allowed_permissions, commands: ['git'] } }), ['example.plugin@1.0.0']).admitted, true);
});

test('untrusted in-process plugins are forced out by admission', () => {
  const value = evaluatePluginAdmission(normalizePluginManifest(manifest({ execution: 'in_process', provenance: { ...manifest().provenance, trusted: false } })), policy(), []);
  assert.ok(value.reasons.includes('in_process_untrusted'));
});

test('dependency ordering supports required and optional dependencies', () => {
  const base = manifest({ id: 'base.plugin' });
  const child = manifest({ id: 'child.plugin', dependencies: { required: [{ id: 'base.plugin', range: '^1.0.0' }], optional: [{ id: 'optional.plugin', range: '*' }] } });
  assert.deepEqual(dependencyOrder([child, base]).map(item => item.id), ['base.plugin', 'child.plugin']);
});

test('dependency cycles and missing/version mismatches fail closed', () => {
  const a = manifest({ id: 'a.plugin', dependencies: { required: [{ id: 'b.plugin', range: '*' }] } });
  const b = manifest({ id: 'b.plugin', dependencies: { required: [{ id: 'a.plugin', range: '*' }] } });
  assert.throws(() => dependencyOrder([a, b]), error => error.code === 'dependency_cycle');
  assert.throws(() => dependencyOrder([manifest({ id: 'x.plugin', dependencies: { required: [{ id: 'missing.plugin', range: '*' }] } })]), error => error.code === 'dependency_missing');
  assert.throws(() => dependencyOrder([manifest({ id: 'base.plugin', version: '1.0.0' }), manifest({ id: 'child.plugin', dependencies: { required: [{ id: 'base.plugin', range: '^2.0.0' }] } })]), error => error.code === 'dependency_version');
});

test('configuration validation and raw-secret rejection preserve references', () => {
  assert.equal(validateConfiguration({ mode: 'safe', token: 'secret://GITHUB_TOKEN' }, manifest().configuration_schema).valid, true);
  assert.equal(validateConfiguration({ mode: 'bad' }, manifest().configuration_schema).valid, false);
  const registry = createPluginRegistry({ manifests: [manifest()], policy: policy() });
  registry.admit('example.plugin');
  assert.throws(() => registry.configure('example.plugin', { mode: 'safe', token: 'GITHUB_TOKEN=raw' }), error => error.code === 'raw_secret_denied');
  assert.deepEqual(registry.configure('example.plugin', { mode: 'safe', token: 'secret://GITHUB_TOKEN' }), { mode: 'safe', token: '[redacted]' });
});

test('install plans never perform unrestricted package installation', () => {
  const registry = createPluginRegistry({ manifests: [manifest()], policy: policy() });
  const plan = registry.installPlan();
  assert.equal(plan.package_installation, false);
  assert.equal(plan.operations[0].type, 'admit');
  assert.equal(plan.receipt_digest, pluginDigest({ ...plan, receipt_digest: undefined }));
});

test('trusted plugins use in-process loader and untrusted plugins use sandbox', async () => {
  const d = deterministic();
  const calls = [];
  const trusted = manifest({ id: 'trusted.plugin', execution: 'in_process', provenance: { ...manifest().provenance, trusted: true } });
  const untrusted = manifest({ id: 'sandbox.plugin', execution: 'subprocess' });
  const registry = createPluginRegistry({
    manifests: [trusted, untrusted], policy: policy(), approvals: [], ...d,
    loader: { invoke: async () => { calls.push('loader'); return { ok: true }; } },
    sandbox: { invoke: async () => { calls.push('sandbox'); return { ok: true }; } }
  });
  registry.admit('trusted.plugin'); registry.enable('trusted.plugin');
  registry.admit('sandbox.plugin'); registry.enable('sandbox.plugin');
  assert.equal((await registry.invoke('trusted.plugin', 'run')).execution, 'in_process');
  assert.equal((await registry.invoke('sandbox.plugin', 'run')).execution, 'sandbox');
  assert.deepEqual(calls, ['loader', 'sandbox']);
});

test('enable requires admitted dependencies to be enabled first', () => {
  const registry = createPluginRegistry({ manifests: [manifest({ id: 'base.plugin' }), manifest({ id: 'child.plugin', dependencies: { required: [{ id: 'base.plugin', range: '*' }] } })], policy: policy() });
  registry.admit('base.plugin'); registry.admit('child.plugin');
  assert.throws(() => registry.enable('child.plugin'), error => error.code === 'dependency_not_enabled');
  registry.enable('base.plugin');
  assert.equal(registry.enable('child.plugin').state, 'enabled');
});

test('disable and drain remove plugins from invocation availability', async () => {
  const registry = createPluginRegistry({ manifests: [manifest()], policy: policy(), sandbox: { invoke: async () => ({ ok: true }) } });
  registry.admit('example.plugin'); registry.enable('example.plugin');
  registry.disable('example.plugin');
  await assert.rejects(registry.invoke('example.plugin', 'run'), error => error.code === 'plugin_not_enabled');
  registry.enable('example.plugin'); registry.drain('example.plugin');
  await assert.rejects(registry.invoke('example.plugin', 'run'), error => error.code === 'plugin_not_enabled');
});

test('health checks are isolated and truthfully degraded on errors', async () => {
  const registry = createPluginRegistry({ manifests: [manifest()], policy: policy(), sandbox: { health: async () => { throw new Error('down'); } } });
  registry.admit('example.plugin');
  assert.equal((await registry.health('example.plugin')).status, 'degraded');
});

test('invocation timeout and errors return bounded receipts without throwing secrets', async () => {
  const d = deterministic();
  const registry = createPluginRegistry({
    manifests: [manifest()], policy: policy(), timeout_ms: 10, ...d,
    sandbox: { invoke: async () => new Promise(() => {}) }
  });
  registry.admit('example.plugin'); registry.enable('example.plugin');
  const timed = await registry.invoke('example.plugin', 'run');
  assert.equal(timed.ok, false);
  assert.equal(timed.error.code, 'plugin_timeout');
  assert.match(timed.receipt_digest, /^[a-f0-9]{64}$/);
});

test('circuit breaker isolates repeated plugin failure and recovers after cooldown', async () => {
  const d = deterministic();
  let calls = 0;
  const registry = createPluginRegistry({
    manifests: [manifest()], policy: policy(), circuit_failures: 1, circuit_cooldown_ms: 1000, ...d,
    sandbox: { invoke: async () => { calls += 1; throw new Error('boom'); } }
  });
  registry.admit('example.plugin'); registry.enable('example.plugin');
  assert.equal((await registry.invoke('example.plugin', 'run')).ok, false);
  await assert.rejects(registry.invoke('example.plugin', 'run'), error => error.code === 'plugin_circuit_open');
  d.advance(1001);
  assert.equal((await registry.invoke('example.plugin', 'run')).ok, false);
  assert.equal(calls, 2);
});

test('upgrades require newer admitted versions and supported migrations', () => {
  const v1 = manifest();
  const v2 = manifest({ version: '2.0.0', integrity: { digest: `sha256:${'b'.repeat(64)}`, signature: 'sig' }, migration: { from: ['1.0.0'], hook: 'migrate', reversible: true } });
  const registry = createPluginRegistry({ manifests: [v1, v2], policy: policy() });
  registry.admit('example.plugin', '1.0.0');
  const upgraded = registry.upgrade('example.plugin', '2.0.0');
  assert.equal(upgraded.manifest.version, '2.0.0');
  assert.equal(upgraded.migration.from, '1.0.0');
});

test('rollback restores previous version when migration is reversible', () => {
  const v1 = manifest();
  const v2 = manifest({ version: '2.0.0', integrity: { digest: `sha256:${'b'.repeat(64)}`, signature: 'sig' }, migration: { from: ['1.0.0'], hook: 'migrate', reversible: true } });
  const registry = createPluginRegistry({ manifests: [v1, v2], policy: policy() });
  registry.admit('example.plugin', '1.0.0'); registry.upgrade('example.plugin', '2.0.0');
  assert.equal(registry.rollback('example.plugin').manifest.version, '1.0.0');
});

test('remove plans expose dependent blockers and never uninstall packages', () => {
  const registry = createPluginRegistry({ manifests: [manifest({ id: 'base.plugin' }), manifest({ id: 'child.plugin', dependencies: { required: [{ id: 'base.plugin', range: '*' }] } })], policy: policy() });
  registry.admit('base.plugin'); registry.admit('child.plugin');
  const plan = registry.removePlan('base.plugin');
  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.dependents, ['child.plugin']);
  assert.equal(plan.package_removal, false);
});

test('secret redaction covers config, invocation inputs, outputs, and errors', async () => {
  const seen = [];
  const registry = createPluginRegistry({
    manifests: [manifest()], policy: policy(),
    sandbox: { invoke: async (_manifest, _capability, input) => { seen.push(input); return { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }; } }
  });
  registry.admit('example.plugin'); registry.enable('example.plugin');
  const receipt = await registry.invoke('example.plugin', 'run', { api_key: 'sk-abcdefghijklmnopqrstuvwxyz' });
  assert.equal(seen[0].api_key, '[redacted]');
  assert.equal(receipt.output.authorization, '[redacted]');
  assert.ok(!JSON.stringify(receipt).includes('abcdefghijklmnopqrstuvwxyz'));
  assert.equal(redactPluginSecrets({ token: 'raw' }).token, '[redacted]');
});

test('registry snapshots are deterministic, redacted, and integrity-bound', () => {
  const d = deterministic();
  const registry = createPluginRegistry({ manifests: [manifest({ metadata: { api_key: 'top-secret-value' } })], policy: policy(), ...d });
  registry.admit('example.plugin');
  const snapshot = registry.snapshot();
  assert.ok(!JSON.stringify(snapshot).includes('top-secret-value'));
  assert.equal(snapshot.discovered[0].metadata.api_key, '[redacted]');
  assert.equal(snapshot.receipt_digest, pluginDigest({ ...snapshot, receipt_digest: undefined }));
});
