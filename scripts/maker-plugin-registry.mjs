#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const finite = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const unique = (values, limit = 300) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 500)).filter(Boolean))].slice(0, limit);
const KINDS = ['scm', 'issue_review', 'ci', 'artifact_store', 'deployment', 'model_provider', 'repository_intelligence', 'editor', 'tool_runtime', 'language_framework', 'evaluator'];
const LIFECYCLE = ['install-plan', 'admit', 'enable', 'disable', 'health', 'invoke', 'drain', 'upgrade', 'rollback', 'remove-plan'];
const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key)/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const pluginDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function redactPluginSecrets(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 300).map(item => redactPluginSecrets(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 500).map(([key, item]) => [clean(key, 300), SECRET_KEY.test(key) ? '[redacted]' : redactPluginSecrets(item, depth + 1)]));
  }
  if (typeof value === 'string') return clean(value.replace(SECRET_TEXT, '[redacted]'), 20000);
  if (['number', 'boolean'].includes(typeof value) || value === null) return value;
  return clean(value, 2000);
}

export class MakerPluginError extends Error {
  constructor(code, message, status = 400, detail = {}) {
    super(message);
    this.name = 'MakerPluginError';
    this.code = code;
    this.status = status;
    this.detail = redactPluginSecrets(detail);
  }
}

function parseVersion(value) {
  const match = clean(value, 100).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new MakerPluginError('invalid_version', 'plugin version must be semantic x.y.z');
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] || '', raw: match[0] };
}
export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] - b[key];
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function normalizePermissions(input = {}) {
  return Object.freeze({
    filesystem: Object.freeze({
      read: unique(input.filesystem?.read),
      write: unique(input.filesystem?.write),
      execute: unique(input.filesystem?.execute)
    }),
    network_hosts: unique(input.network_hosts),
    commands: unique(input.commands),
    secret_references: unique(input.secret_references),
    capabilities: unique(input.capabilities),
    privileged: input.privileged === true
  });
}

function normalizeDependencies(input = {}) {
  const normalizeList = values => (Array.isArray(values) ? values : []).map(value => Object.freeze({
    id: clean(value.id || value, 300),
    range: clean(value.range || '*', 100)
  })).filter(value => value.id).slice(0, 300);
  return Object.freeze({ required: normalizeList(input.required), optional: normalizeList(input.optional) });
}

export function normalizePluginManifest(input = {}) {
  const id = clean(input.id, 300);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new MakerPluginError('invalid_plugin_id', 'plugin id must be lowercase and stable');
  const version = parseVersion(input.version);
  const kind = KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) throw new MakerPluginError('invalid_plugin_kind', 'unsupported plugin kind');
  const entrypoint = clean(input.entrypoint, 1000);
  if (!entrypoint) throw new MakerPluginError('missing_entrypoint', 'plugin entrypoint is required');
  const manifest = {
    schema: 'sideways-maker-plugin-manifest/v1',
    id,
    version: version.raw,
    api_compatibility: clean(input.api_compatibility || '1', 100),
    kind,
    entrypoint,
    execution: ['in_process', 'subprocess', 'rpc'].includes(input.execution) ? input.execution : 'subprocess',
    provenance: Object.freeze({
      source: clean(input.provenance?.source || 'unknown', 500),
      publisher: clean(input.provenance?.publisher || 'unknown', 300),
      license: clean(input.provenance?.license || 'unknown', 100),
      trusted: input.provenance?.trusted === true
    }),
    integrity: Object.freeze({
      algorithm: clean(input.integrity?.algorithm || 'sha256', 40).toLowerCase(),
      digest: clean(input.integrity?.digest, 300).toLowerCase(),
      signature: clean(input.integrity?.signature, 2000),
      signer: clean(input.integrity?.signer, 300)
    }),
    required_runtime: Object.freeze({
      api: clean(input.required_runtime?.api || input.api_compatibility || '1', 100),
      node: clean(input.required_runtime?.node, 100),
      os: unique(input.required_runtime?.os),
      arch: unique(input.required_runtime?.arch)
    }),
    declared_capabilities: unique(input.declared_capabilities),
    permissions: normalizePermissions(input.permissions),
    configuration_schema: input.configuration_schema && typeof input.configuration_schema === 'object' ? structuredClone(input.configuration_schema) : { type: 'object' },
    dependencies: normalizeDependencies(input.dependencies),
    lifecycle_hooks: Object.freeze(Object.fromEntries(LIFECYCLE.map(name => [name, clean(input.lifecycle_hooks?.[name], 500)]).filter(([, value]) => value))),
    migration: Object.freeze({
      from: unique(input.migration?.from),
      hook: clean(input.migration?.hook, 500),
      reversible: input.migration?.reversible === true
    }),
    metadata: Object.freeze(redactPluginSecrets(input.metadata || {}))
  };
  manifest.manifest_digest = pluginDigest({ ...manifest, manifest_digest: undefined });
  return Object.freeze(manifest);
}

function rangeAllows(version, range) {
  if (!range || range === '*') return true;
  const current = parseVersion(version);
  if (range.startsWith('^')) {
    const base = parseVersion(range.slice(1));
    return current.major === base.major && compareVersions(current, base) >= 0;
  }
  if (range.startsWith('~')) {
    const base = parseVersion(range.slice(1));
    return current.major === base.major && current.minor === base.minor && compareVersions(current, base) >= 0;
  }
  if (range.startsWith('>=')) return compareVersions(current, parseVersion(range.slice(2))) >= 0;
  return compareVersions(current, parseVersion(range)) === 0;
}

export function validateConfiguration(value, schema = {}, path = '$') {
  const errors = [];
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: [`${path} must be object`] };
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) errors.push(...validateConfiguration(value[key], child, `${path}.${key}`).errors);
    }
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key)) errors.push(`${path}.${key} is not allowed`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) errors.push(`${path} must be array`);
    else if (schema.items) value.forEach((item, index) => errors.push(...validateConfiguration(item, schema.items, `${path}[${index}]`).errors));
  } else if (schema.type && typeof value !== schema.type) errors.push(`${path} must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must match enum`);
  return { valid: errors.length === 0, errors };
}

function permissionSubset(requested, allowed) {
  const includes = (actual, permitted) => actual.every(value => permitted.includes(value) || permitted.includes('*'));
  return includes(requested.filesystem.read, allowed.filesystem.read) &&
    includes(requested.filesystem.write, allowed.filesystem.write) &&
    includes(requested.filesystem.execute, allowed.filesystem.execute) &&
    includes(requested.network_hosts, allowed.network_hosts) &&
    includes(requested.commands, allowed.commands) &&
    includes(requested.capabilities, allowed.capabilities);
}

export function evaluatePluginAdmission(manifestInput, policy = {}, approvals = []) {
  const manifest = manifestInput.schema ? manifestInput : normalizePluginManifest(manifestInput);
  const reasons = [];
  const allowedLicenses = unique(policy.allowed_licenses || ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']);
  const allowedSources = unique(policy.allowed_sources || ['repository', 'registry', 'builtin']);
  const allowedPermissions = normalizePermissions(policy.allowed_permissions || {
    filesystem: { read: ['*'], write: [], execute: [] },
    network_hosts: [], commands: [], capabilities: manifest.declared_capabilities
  });
  if (!manifest.integrity.digest || !/^[a-z0-9]+:[a-f0-9]{32,128}$/.test(manifest.integrity.digest)) reasons.push('integrity_missing');
  if (policy.require_signature === true && !manifest.integrity.signature) reasons.push('signature_missing');
  if (!allowedLicenses.includes(manifest.provenance.license)) reasons.push('license_denied');
  if (!allowedSources.includes(manifest.provenance.source)) reasons.push('provenance_denied');
  if (!rangeAllows(policy.runtime_api || '1.0.0', manifest.required_runtime.api.includes('.') ? manifest.required_runtime.api : `${manifest.required_runtime.api}.0.0`)) reasons.push('api_incompatible');
  if (!permissionSubset(manifest.permissions, allowedPermissions)) reasons.push('permissions_excessive');
  const approvalSet = new Set(unique(approvals));
  if ((manifest.permissions.privileged || manifest.kind === 'deployment' || manifest.permissions.filesystem.write.length || manifest.permissions.commands.length) && !approvalSet.has(`${manifest.id}@${manifest.version}`)) reasons.push('human_approval_required');
  if (manifest.execution === 'in_process' && !manifest.provenance.trusted) reasons.push('in_process_untrusted');
  return Object.freeze({
    schema: 'sideways-maker-plugin-admission/v1',
    plugin_id: manifest.id,
    version: manifest.version,
    admitted: reasons.length === 0,
    reasons,
    execution: manifest.execution === 'in_process' && manifest.provenance.trusted ? 'in_process' : 'sandbox',
    manifest_digest: manifest.manifest_digest,
    policy_digest: pluginDigest(redactPluginSecrets(policy))
  });
}

export function resolvePluginVersions(manifests) {
  const groups = new Map();
  for (const input of manifests) {
    const manifest = input.schema ? input : normalizePluginManifest(input);
    if (!groups.has(manifest.id)) groups.set(manifest.id, []);
    groups.get(manifest.id).push(manifest);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, versions]) => versions.sort((a, b) => compareVersions(b.version, a.version) || a.manifest_digest.localeCompare(b.manifest_digest))[0]);
}

export function dependencyOrder(manifests) {
  const selected = new Map(resolvePluginVersions(manifests).map(manifest => [manifest.id, manifest]));
  const visiting = new Set();
  const visited = new Set();
  const result = [];
  function visit(id, path = []) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new MakerPluginError('dependency_cycle', 'plugin dependency cycle', 409, { cycle: [...path, id] });
    const manifest = selected.get(id);
    if (!manifest) throw new MakerPluginError('dependency_missing', `required plugin ${id} is missing`, 409);
    visiting.add(id);
    for (const dependency of manifest.dependencies.required) {
      const target = selected.get(dependency.id);
      if (!target) throw new MakerPluginError('dependency_missing', `required plugin ${dependency.id} is missing`, 409);
      if (!rangeAllows(target.version, dependency.range)) throw new MakerPluginError('dependency_version', `plugin ${dependency.id} does not satisfy ${dependency.range}`, 409);
      visit(dependency.id, [...path, id]);
    }
    for (const dependency of manifest.dependencies.optional) if (selected.has(dependency.id) && rangeAllows(selected.get(dependency.id).version, dependency.range)) visit(dependency.id, [...path, id]);
    visiting.delete(id);
    visited.add(id);
    result.push(manifest);
  }
  for (const id of [...selected.keys()].sort()) visit(id);
  return result;
}

export function createPluginRegistry({
  manifests = [],
  policy = {},
  approvals = [],
  loader = {},
  sandbox = {},
  clock = Date.now,
  id = randomUUID,
  timeout_ms = 30_000,
  circuit_failures = 3,
  circuit_cooldown_ms = 60_000
} = {}) {
  const discovered = new Map();
  const admitted = new Map();
  const enabled = new Map();
  const history = new Map();
  const healthState = new Map();
  const circuit = new Map();
  const events = [];
  let sequence = 0;
  const emit = (type, detail = {}) => {
    const event = Object.freeze({ schema: 'sideways-maker-plugin-event/v1', sequence: ++sequence, event_id: id(), type, at: new Date(clock()).toISOString(), detail: redactPluginSecrets(detail) });
    events.push(event);
    return event;
  };
  const circuitState = pluginId => {
    if (!circuit.has(pluginId)) circuit.set(pluginId, { failures: 0, opened_at: 0 });
    return circuit.get(pluginId);
  };

  function discover(values = manifests) {
    const normalized = values.map(value => value.schema ? value : normalizePluginManifest(value));
    for (const manifest of normalized) {
      const key = `${manifest.id}@${manifest.version}`;
      const existing = discovered.get(key);
      if (existing && existing.manifest_digest !== manifest.manifest_digest) throw new MakerPluginError('manifest_conflict', `conflicting manifest ${key}`, 409);
      discovered.set(key, manifest);
      emit('plugin.discovered', { plugin_id: manifest.id, version: manifest.version });
    }
    return resolvePluginVersions([...discovered.values()]);
  }

  function installPlan(values = [...discovered.values()]) {
    const order = dependencyOrder(values);
    const plan = {
      schema: 'sideways-maker-plugin-install-plan/v1',
      operations: order.map(manifest => ({ type: 'admit', plugin_id: manifest.id, version: manifest.version, manifest_digest: manifest.manifest_digest })),
      package_installation: false,
      generated_at: new Date(clock()).toISOString()
    };
    plan.receipt_digest = pluginDigest({ ...plan, receipt_digest: undefined });
    return Object.freeze(plan);
  }

  function admit(pluginId, version) {
    const candidates = [...discovered.values()].filter(manifest => manifest.id === pluginId && (!version || manifest.version === version));
    if (!candidates.length) throw new MakerPluginError('plugin_not_found', 'plugin manifest not discovered', 404);
    const manifest = candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
    const admission = evaluatePluginAdmission(manifest, policy, approvals);
    if (!admission.admitted) throw new MakerPluginError('plugin_denied', 'plugin admission denied', 403, admission);
    if (!history.has(pluginId)) history.set(pluginId, []);
    const current = admitted.get(pluginId);
    if (current && current.manifest.version !== manifest.version) history.get(pluginId).push(current);
    const record = { manifest, admission, state: 'admitted', configuration: {}, admitted_at: new Date(clock()).toISOString() };
    admitted.set(pluginId, record);
    healthState.set(pluginId, { status: 'unknown', checked_at: '' });
    emit('plugin.admitted', { plugin_id: pluginId, version: manifest.version, execution: admission.execution });
    return structuredClone(record);
  }

  function configure(pluginId, configuration = {}) {
    const record = admitted.get(pluginId);
    if (!record) throw new MakerPluginError('plugin_not_admitted', 'plugin is not admitted', 409);
    const validation = validateConfiguration(configuration, record.manifest.configuration_schema);
    if (!validation.valid) throw new MakerPluginError('configuration_invalid', 'plugin configuration is invalid', 422, validation);
    const serialized = JSON.stringify(configuration);
    for (const reference of record.manifest.permissions.secret_references) {
      if (serialized.includes(reference) && !serialized.includes(`secret://${reference}`)) throw new MakerPluginError('raw_secret_denied', 'secret values must remain references', 403);
    }
    record.configuration = redactPluginSecrets(configuration);
    emit('plugin.configured', { plugin_id: pluginId });
    return structuredClone(record.configuration);
  }

  function enable(pluginId) {
    const record = admitted.get(pluginId);
    if (!record) throw new MakerPluginError('plugin_not_admitted', 'plugin is not admitted', 409);
    for (const dependency of record.manifest.dependencies.required) if (!enabled.has(dependency.id)) throw new MakerPluginError('dependency_not_enabled', `dependency ${dependency.id} is not enabled`, 409);
    record.state = 'enabled';
    enabled.set(pluginId, record);
    emit('plugin.enabled', { plugin_id: pluginId, version: record.manifest.version });
    return structuredClone(record);
  }

  function disable(pluginId) {
    const record = admitted.get(pluginId);
    if (!record) throw new MakerPluginError('plugin_not_admitted', 'plugin is not admitted', 409);
    record.state = 'disabled';
    enabled.delete(pluginId);
    emit('plugin.disabled', { plugin_id: pluginId });
    return structuredClone(record);
  }

  function drain(pluginId) {
    const record = admitted.get(pluginId);
    if (!record) throw new MakerPluginError('plugin_not_admitted', 'plugin is not admitted', 409);
    record.state = 'draining';
    enabled.delete(pluginId);
    emit('plugin.draining', { plugin_id: pluginId });
    return structuredClone(record);
  }

  async function health(pluginId) {
    const record = admitted.get(pluginId);
    if (!record) throw new MakerPluginError('plugin_not_admitted', 'plugin is not admitted', 409);
    const runner = record.admission.execution === 'in_process' ? loader.health : sandbox.health;
    let status = 'unknown';
    if (typeof runner === 'function') {
      try { status = clean((await runner(record.manifest)).status || 'healthy', 40); } catch { status = 'degraded'; }
    }
    healthState.set(pluginId, { status, checked_at: new Date(clock()).toISOString() });
    emit('plugin.health', { plugin_id: pluginId, status });
    return Object.freeze({ schema: 'sideways-maker-plugin-health/v1', plugin_id: pluginId, version: record.manifest.version, status, checked_at: healthState.get(pluginId).checked_at });
  }

  async function invoke(pluginId, capability, input = {}, options = {}) {
    const record = enabled.get(pluginId);
    if (!record) throw new MakerPluginError('plugin_not_enabled', 'plugin is not enabled', 409);
    if (!record.manifest.declared_capabilities.includes(capability)) throw new MakerPluginError('capability_not_declared', 'plugin capability is not declared', 403);
    const state = circuitState(pluginId);
    if (state.failures >= circuit_failures && clock() - state.opened_at < circuit_cooldown_ms) throw new MakerPluginError('plugin_circuit_open', 'plugin circuit is open', 503);
    const runner = record.admission.execution === 'in_process' ? loader.invoke : sandbox.invoke;
    if (typeof runner !== 'function') throw new MakerPluginError('plugin_runtime_unavailable', 'plugin runtime is unavailable', 503);
    const started = new Date(clock()).toISOString();
    let timer;
    try {
      const output = await Promise.race([
        Promise.resolve(runner(record.manifest, capability, redactPluginSecrets(input), { configuration: record.configuration, signal: options.signal })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new MakerPluginError('plugin_timeout', 'plugin invocation timed out', 504)), finite(options.timeout_ms, timeout_ms, 1, 30 * 60 * 1000));
          
        })
      ]);
      state.failures = 0;
      state.opened_at = 0;
      const receipt = {
        schema: 'sideways-maker-plugin-invocation/v1',
        invocation_id: id(),
        plugin_id: pluginId,
        version: record.manifest.version,
        capability,
        execution: record.admission.execution,
        ok: true,
        output: redactPluginSecrets(output),
        started_at: started,
        finished_at: new Date(clock()).toISOString()
      };
      receipt.receipt_digest = pluginDigest({ ...receipt, receipt_digest: undefined });
      emit('plugin.invoked', { plugin_id: pluginId, capability, ok: true });
      return Object.freeze(receipt);
    } catch (error) {
      state.failures += 1;
      if (state.failures >= circuit_failures) state.opened_at = clock();
      const receipt = {
        schema: 'sideways-maker-plugin-invocation/v1',
        invocation_id: id(),
        plugin_id: pluginId,
        version: record.manifest.version,
        capability,
        execution: record.admission.execution,
        ok: false,
        error: { code: clean(error.code || 'plugin_failed', 100), message: clean(redactPluginSecrets(error.message), 2000) },
        started_at: started,
        finished_at: new Date(clock()).toISOString()
      };
      receipt.receipt_digest = pluginDigest({ ...receipt, receipt_digest: undefined });
      emit('plugin.invoked', { plugin_id: pluginId, capability, ok: false, code: receipt.error.code });
      return Object.freeze(receipt);
    } finally {
      clearTimeout(timer);
    }
  }

  function upgrade(pluginId, version) {
    const current = admitted.get(pluginId);
    if (!current) throw new MakerPluginError('plugin_not_admitted', 'plugin is not admitted', 409);
    const target = [...discovered.values()].find(manifest => manifest.id === pluginId && manifest.version === version);
    if (!target) throw new MakerPluginError('upgrade_target_missing', 'upgrade target is not discovered', 404);
    if (compareVersions(target.version, current.manifest.version) <= 0) throw new MakerPluginError('upgrade_not_newer', 'upgrade target must be newer', 409);
    const admission = evaluatePluginAdmission(target, policy, approvals);
    if (!admission.admitted) throw new MakerPluginError('plugin_denied', 'upgrade admission denied', 403, admission);
    if (!target.migration.from.includes(current.manifest.version) && target.migration.from.length) throw new MakerPluginError('migration_unsupported', 'upgrade migration does not support current version', 409);
    history.get(pluginId)?.push(current);
    const next = { manifest: target, admission, state: current.state === 'enabled' ? 'enabled' : 'admitted', configuration: current.configuration, admitted_at: new Date(clock()).toISOString(), migration: { from: current.manifest.version, hook: target.migration.hook, reversible: target.migration.reversible } };
    admitted.set(pluginId, next);
    if (next.state === 'enabled') enabled.set(pluginId, next);
    emit('plugin.upgraded', { plugin_id: pluginId, from: current.manifest.version, to: target.version });
    return structuredClone(next);
  }

  function rollback(pluginId) {
    const prior = history.get(pluginId)?.pop();
    if (!prior) throw new MakerPluginError('rollback_unavailable', 'no prior plugin version available', 409);
    const current = admitted.get(pluginId);
    if (current?.migration && current.migration.reversible === false) throw new MakerPluginError('rollback_denied', 'current migration is not reversible', 409);
    admitted.set(pluginId, prior);
    if (prior.state === 'enabled') enabled.set(pluginId, prior); else enabled.delete(pluginId);
    emit('plugin.rolled_back', { plugin_id: pluginId, from: current?.manifest.version, to: prior.manifest.version });
    return structuredClone(prior);
  }

  function removePlan(pluginId) {
    const dependents = [...admitted.values()].filter(record => record.manifest.dependencies.required.some(dependency => dependency.id === pluginId)).map(record => record.manifest.id).sort();
    const plan = { schema: 'sideways-maker-plugin-remove-plan/v1', plugin_id: pluginId, blocked: dependents.length > 0, dependents, package_removal: false, generated_at: new Date(clock()).toISOString() };
    plan.receipt_digest = pluginDigest({ ...plan, receipt_digest: undefined });
    return Object.freeze(plan);
  }

  function snapshot() {
    const value = {
      schema: 'sideways-maker-plugin-registry-snapshot/v1',
      discovered: resolvePluginVersions([...discovered.values()]),
      admitted: [...admitted.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([plugin_id, record]) => ({ plugin_id, manifest: record.manifest, admission: record.admission, state: record.state, configuration: redactPluginSecrets(record.configuration), health: healthState.get(plugin_id) || { status: 'unknown', checked_at: '' } })),
      enabled: [...enabled.keys()].sort(),
      events: structuredClone(events),
      at: new Date(clock()).toISOString()
    };
    value.receipt_digest = pluginDigest({ ...value, receipt_digest: undefined });
    return Object.freeze(value);
  }

  discover(manifests);
  return Object.freeze({ discover, installPlan, admit, configure, enable, disable, drain, health, invoke, upgrade, rollback, removePlan, snapshot, events: after => events.filter(event => event.sequence > Number(after || 0)) });
}
