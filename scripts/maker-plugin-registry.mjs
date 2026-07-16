#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = clock => new Date(clock()).toISOString();
const unique = (values, limit = 200) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 300)).filter(Boolean))].slice(0, limit);
const finite = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key)/i;
const CREDENTIAL_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;
const KINDS = new Set(['scm', 'issue_review', 'ci', 'artifact_store', 'deployment', 'model_provider', 'repository_intelligence', 'editor', 'tool_runtime', 'language_framework', 'evaluator']);
const STATES = new Set(['discovered', 'admitted', 'enabled', 'disabled', 'draining', 'unavailable', 'removed']);
const PRIVILEGED = new Set(['deployment.production', 'repository.settings', 'repository.delete', 'secrets.write', 'network.unrestricted', 'filesystem.unrestricted', 'process.unrestricted', 'package.install']);

export class PluginRegistryError extends Error {
  constructor(code, message, status = 400, detail = {}) {
    super(message);
    this.name = 'PluginRegistryError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function redactPluginSecrets(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 300).map(item => redactPluginSecrets(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 400).map(([key, item]) => [
      clean(key, 200),
      SECRET_KEY.test(key) ? '[redacted]' : redactPluginSecrets(item, depth + 1)
    ]));
  }
  if (typeof value === 'string') return clean(value.replace(CREDENTIAL_TEXT, '[redacted]'), 20000);
  if (['number', 'boolean'].includes(typeof value) || value === null) return value;
  return clean(value, 2000);
}

function parseVersion(value) {
  const match = clean(value, 100).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new PluginRegistryError('version_invalid', `invalid semantic version: ${value}`);
  return { raw: match[0], major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] || '' };
}
function compareVersion(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch || (left.prerelease ? -1 : 1) - (right.prerelease ? -1 : 1) || left.raw.localeCompare(right.raw);
}
function apiCompatible(range, apiVersion) {
  const requested = clean(range || '*', 100);
  const current = parseVersion(apiVersion);
  if (requested === '*') return true;
  if (/^\d+\.x$/.test(requested)) return current.major === Number(requested.split('.')[0]);
  if (/^\^\d+\.\d+\.\d+$/.test(requested)) return current.major === parseVersion(requested.slice(1)).major && compareVersion(current, parseVersion(requested.slice(1))) >= 0;
  if (/^~\d+\.\d+\.\d+$/.test(requested)) {
    const base = parseVersion(requested.slice(1));
    return current.major === base.major && current.minor === base.minor && compareVersion(current, base) >= 0;
  }
  return compareVersion(current, parseVersion(requested)) === 0;
}
function normalizeDependency(value, optional = false) {
  if (typeof value === 'string') return Object.freeze({ id: clean(value, 200), range: '*', optional });
  return Object.freeze({ id: clean(value?.id, 200), range: clean(value?.range || '*', 100), optional: value?.optional === true || optional });
}
function normalizePermissionInput(input = {}) {
  return Object.freeze({
    capabilities: unique(input.capabilities),
    secret_references: unique(input.secret_references),
    network_hosts: unique(input.network_hosts),
    commands: unique(input.commands),
    filesystem: unique(input.filesystem),
    privileged: unique(input.privileged)
  });
}

export function normalizePluginManifest(input = {}) {
  const id = clean(input.id, 200).toLowerCase();
  const version = parseVersion(input.version).raw;
  const kind = clean(input.kind, 100).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,199}$/.test(id)) throw new PluginRegistryError('plugin_id_invalid', 'plugin id is invalid');
  if (!KINDS.has(kind)) throw new PluginRegistryError('plugin_kind_invalid', `unsupported plugin kind: ${kind}`);
  const integrity = clean(input.integrity?.digest || input.integrity, 200).toLowerCase();
  const signature = input.signature || {};
  const manifest = {
    schema: 'sideways-maker-plugin-manifest/v1',
    id,
    version,
    api: clean(input.api || input.api_compatibility || '*', 100),
    kind,
    entrypoint: clean(input.entrypoint, 1000),
    provenance: clean(input.provenance || 'unknown', 300),
    license: clean(input.license || 'UNKNOWN', 100),
    integrity: {
      digest: integrity,
      algorithm: clean(input.integrity?.algorithm || integrity.split(':')[0], 50),
      observed_at: clean(input.integrity?.observed_at, 100)
    },
    signature: {
      status: clean(signature.status || 'unverified', 50),
      signer: clean(signature.signer, 300),
      digest: clean(signature.digest, 200),
      transparency_log: clean(signature.transparency_log, 2000)
    },
    runtime: {
      node: clean(input.runtime?.node || '>=20', 100),
      os: unique(input.runtime?.os || ['any']),
      architectures: unique(input.runtime?.architectures || ['any']),
      isolation: clean(input.runtime?.isolation || 'sandbox', 100)
    },
    capabilities: unique(input.capabilities),
    permissions: normalizePermissionInput(input.permissions),
    config_schema: input.config_schema && typeof input.config_schema === 'object' ? clone(input.config_schema) : { type: 'object', additionalProperties: false },
    dependencies: (Array.isArray(input.dependencies) ? input.dependencies : []).map(value => normalizeDependency(value, false)).filter(value => value.id),
    optional_dependencies: (Array.isArray(input.optional_dependencies) ? input.optional_dependencies : []).map(value => normalizeDependency(value, true)).filter(value => value.id),
    hooks: unique(input.hooks),
    migrations: (Array.isArray(input.migrations) ? input.migrations : []).map(value => ({ from: clean(value.from, 100), to: clean(value.to, 100), hook: clean(value.hook, 200) })).filter(value => value.from && value.to && value.hook),
    metadata: redactPluginSecrets(input.metadata || {})
  };
  manifest.manifest_digest = hash(manifest);
  return Object.freeze(manifest);
}

function validateConfigValue(value, schema, path = '$') {
  const errors = [];
  if (!schema) return errors;
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.includes(type)) errors.push(`${path}: expected ${allowed.join('|')}, received ${type}`);
  }
  if (schema.required && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required) if (!(key in value)) errors.push(`${path}.${key}: required`);
  }
  if (schema.additionalProperties === false && value && typeof value === 'object' && !Array.isArray(value)) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key}: additional property denied`);
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(schema.properties)) if (key in value) errors.push(...validateConfigValue(value[key], child, `${path}.${key}`));
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not in enum`);
  return errors;
}
export function validatePluginConfiguration(manifestInput, config = {}) {
  const manifest = manifestInput.schema ? manifestInput : normalizePluginManifest(manifestInput);
  const serialized = JSON.stringify(config);
  if (CREDENTIAL_TEXT.test(serialized) || Object.keys(config).some(key => SECRET_KEY.test(key) && !key.endsWith('_ref'))) {
    throw new PluginRegistryError('secret_value_denied', 'configuration must contain secret references, not secret values');
  }
  const errors = validateConfigValue(config, manifest.config_schema);
  if (errors.length) throw new PluginRegistryError('config_invalid', 'plugin configuration is invalid', 422, { errors });
  const references = Object.entries(config).filter(([key]) => key.endsWith('_ref')).map(([, value]) => clean(value, 500));
  for (const reference of references) {
    if (!manifest.permissions.secret_references.includes(reference)) {
      throw new PluginRegistryError('secret_reference_undeclared', `undeclared secret reference: ${reference}`);
    }
  }
  return Object.freeze(redactPluginSecrets(config));
}

export function createAdmissionPolicy(input = {}) {
  return Object.freeze({
    api_version: clean(input.api_version || '1.0.0', 100),
    allowed_provenance: new Set(unique(input.allowed_provenance || ['repository', 'builtin', 'signed-registry'])),
    allowed_licenses: new Set(unique(input.allowed_licenses || ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'UNLICENSED-INTERNAL'])),
    denied_commands: new Set(unique(input.denied_commands || ['sudo', 'su', 'curl | sh', 'wget | sh'])),
    denied_hosts: new Set(unique(input.denied_hosts || ['*'])),
    allowed_filesystem_prefixes: unique(input.allowed_filesystem_prefixes || ['workspace:', 'artifact:', 'temp:']),
    require_signature: input.require_signature === true,
    allow_in_process_provenance: new Set(unique(input.allow_in_process_provenance || ['builtin', 'repository'])),
    privileged_capabilities: new Set(unique(input.privileged_capabilities || [...PRIVILEGED]))
  });
}

export function evaluatePluginAdmission(manifestInput, options = {}) {
  const manifest = manifestInput.schema ? manifestInput : normalizePluginManifest(manifestInput);
  const policy = options.policy || createAdmissionPolicy();
  const approvals = new Set(unique(options.approvals));
  const reasons = [];
  if (!/^[a-z0-9]+:[a-f0-9]{32,128}$/.test(manifest.integrity.digest)) reasons.push('integrity_invalid');
  if (policy.require_signature && manifest.signature.status !== 'verified') reasons.push('signature_required');
  if (manifest.signature.status === 'verified' && !/^[a-z0-9]+:[a-f0-9]{32,128}$/.test(manifest.signature.digest)) reasons.push('signature_metadata_invalid');
  if (!apiCompatible(manifest.api, policy.api_version)) reasons.push('api_incompatible');
  if (!policy.allowed_provenance.has(manifest.provenance)) reasons.push('provenance_denied');
  if (!policy.allowed_licenses.has(manifest.license)) reasons.push('license_denied');
  if (manifest.permissions.commands.some(command => policy.denied_commands.has(command))) reasons.push('command_denied');
  if (manifest.permissions.network_hosts.includes('*') || manifest.permissions.network_hosts.some(host => policy.denied_hosts.has(host))) reasons.push('network_scope_excessive');
  if (manifest.permissions.filesystem.some(scope => !policy.allowed_filesystem_prefixes.some(prefix => scope.startsWith(prefix)))) reasons.push('filesystem_scope_excessive');
  const privileged = unique([...manifest.permissions.privileged, ...manifest.capabilities.filter(value => policy.privileged_capabilities.has(value))]);
  const missingApprovals = privileged.filter(value => !approvals.has(value));
  if (missingApprovals.length) reasons.push('privileged_approval_required');
  const trustedInProcess = reasons.length === 0 && manifest.signature.status === 'verified' && policy.allow_in_process_provenance.has(manifest.provenance) && manifest.runtime.isolation === 'in_process';
  return Object.freeze({
    schema: 'sideways-maker-plugin-admission/v1',
    plugin_id: manifest.id,
    version: manifest.version,
    admitted: reasons.length === 0,
    reasons,
    privileged,
    missing_approvals: missingApprovals,
    execution: trustedInProcess ? 'in_process' : 'sandbox_rpc',
    manifest_digest: manifest.manifest_digest,
    evaluated_at: clean(options.evaluated_at || new Date(0).toISOString(), 100),
    receipt_digest: hash({ plugin_id: manifest.id, version: manifest.version, reasons, missingApprovals, manifest_digest: manifest.manifest_digest })
  });
}

function dependencyOrder(records, rootIds = null) {
  const selected = new Map(records.map(record => [record.manifest.id, record]));
  const roots = rootIds ? unique(rootIds) : [...selected.keys()];
  const visiting = new Set();
  const visited = new Set();
  const order = [];
  function visit(id, chain = []) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new PluginRegistryError('dependency_cycle', `dependency cycle: ${[...chain, id].join(' -> ')}`, 409);
    const record = selected.get(id);
    if (!record) throw new PluginRegistryError('dependency_missing', `required dependency missing: ${id}`, 409);
    visiting.add(id);
    for (const dependency of record.manifest.dependencies) {
      const dependencyRecord = selected.get(dependency.id);
      if (!dependencyRecord) throw new PluginRegistryError('dependency_missing', `required dependency missing: ${dependency.id}`, 409);
      if (dependency.range !== '*' && !apiCompatible(dependency.range, dependencyRecord.manifest.version)) throw new PluginRegistryError('dependency_version_mismatch', `dependency version mismatch: ${dependency.id}`, 409);
      visit(dependency.id, [...chain, id]);
    }
    for (const dependency of record.manifest.optional_dependencies) if (selected.has(dependency.id)) visit(dependency.id, [...chain, id]);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const id of roots) visit(id);
  return order;
}

export function discoverPluginManifests(sources = [], options = {}) {
  const pins = options.pins || {};
  const normalized = sources.map(source => ({ source: clean(source.source || source.registry || 'configured', 300), manifest: normalizePluginManifest(source.manifest || source) }));
  const grouped = new Map();
  for (const item of normalized) {
    if (!grouped.has(item.manifest.id)) grouped.set(item.manifest.id, []);
    grouped.get(item.manifest.id).push(item);
  }
  const selected = [];
  const conflicts = [];
  for (const [id, values] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    values.sort((a, b) => compareVersion(b.manifest.version, a.manifest.version) || a.source.localeCompare(b.source));
    const pin = clean(pins[id], 100);
    const chosen = pin ? values.find(value => value.manifest.version === pin) : values[0];
    if (!chosen) throw new PluginRegistryError('pinned_version_missing', `pinned version unavailable: ${id}@${pin}`, 409);
    const sameVersion = values.filter(value => value.manifest.version === chosen.manifest.version);
    const digests = new Set(sameVersion.map(value => value.manifest.manifest_digest));
    if (digests.size > 1) {
      conflicts.push({ id, version: chosen.manifest.version, sources: sameVersion.map(value => value.source), digests: [...digests] });
      continue;
    }
    selected.push(chosen);
  }
  if (conflicts.length && options.allow_conflicts !== true) throw new PluginRegistryError('discovery_conflict', 'conflicting plugin manifests discovered', 409, { conflicts });
  return Object.freeze({ schema: 'sideways-maker-plugin-discovery/v1', selected, conflicts, receipt_digest: hash({ selected, conflicts }) });
}

export function createPluginLoaderRegistry({ clock = Date.now, timeout_ms = 30_000 } = {}) {
  const loaders = new Map();
  return Object.freeze({
    register(mode, loader) {
      const key = clean(mode, 100);
      if (!['in_process', 'sandbox_rpc'].includes(key)) throw new PluginRegistryError('loader_mode_invalid', `unsupported loader mode: ${key}`);
      if (loaders.has(key)) throw new PluginRegistryError('loader_duplicate', `loader already registered: ${key}`, 409);
      loaders.set(key, loader);
    },
    describe() {
      return ['in_process', 'sandbox_rpc'].map(mode => ({ mode, available: typeof loaders.get(mode) === 'function' }));
    },
    async invoke(mode, packet, signal) {
      const loader = loaders.get(mode);
      if (typeof loader !== 'function') throw new PluginRegistryError('loader_unavailable', `${mode} loader unavailable`, 503);
      const startedAt = now(clock);
      let timer;
      try {
        const output = await Promise.race([
          Promise.resolve(loader(clone(packet), { signal })),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new PluginRegistryError('plugin_timeout', 'plugin invocation timed out', 504)), timeout_ms);
          })
        ]);
        return { started_at: startedAt, finished_at: now(clock), output: redactPluginSecrets(output) };
      } finally {
        clearTimeout(timer);
      }
    }
  });
}

export function createPluginRegistry({
  policy = createAdmissionPolicy(),
  loaders = createPluginLoaderRegistry(),
  clock = Date.now,
  id = randomUUID,
  circuit_threshold = 3,
  circuit_cooldown_ms = 60_000
} = {}) {
  const plugins = new Map();
  const history = [];
  const circuits = new Map();
  function key(idValue, versionValue) { return `${clean(idValue, 200).toLowerCase()}@${clean(versionValue, 100)}`; }
  function event(type, detail = {}) {
    const value = Object.freeze({ schema: 'sideways-maker-plugin-event/v1', sequence: history.length + 1, type, at: now(clock), detail: redactPluginSecrets(detail) });
    history.push(value);
    return value;
  }
  function get(idValue, versionValue = '') {
    const idClean = clean(idValue, 200).toLowerCase();
    if (versionValue) return plugins.get(key(idClean, versionValue)) || null;
    return [...plugins.values()].filter(record => record.manifest.id === idClean && record.state !== 'removed').sort((a, b) => compareVersion(b.manifest.version, a.manifest.version))[0] || null;
  }
  function installPlan(manifestInput) {
    const manifest = manifestInput.schema ? manifestInput : normalizePluginManifest(manifestInput);
    return Object.freeze({ schema: 'sideways-maker-plugin-install-plan/v1', plugin_id: manifest.id, version: manifest.version, operations: [{ type: 'verify_manifest' }, { type: 'resolve_dependencies' }, { type: 'admit' }], execute: false, package_install: false, receipt_digest: hash(manifest) });
  }
  function admit(manifestInput, options = {}) {
    const manifest = manifestInput.schema ? manifestInput : normalizePluginManifest(manifestInput);
    const admission = evaluatePluginAdmission(manifest, { policy, approvals: options.approvals, evaluated_at: now(clock) });
    if (!admission.admitted) throw new PluginRegistryError('plugin_denied', 'plugin admission denied', 403, admission);
    const record = {
      schema: 'sideways-maker-plugin-record/v1',
      manifest,
      admission,
      state: 'admitted',
      config: validatePluginConfiguration(manifest, options.config || {}),
      health: { status: 'unknown', checked_at: '', detail: {} },
      installed_at: now(clock),
      enabled_at: '',
      previous_version: clean(options.previous_version, 100),
      migration: null,
      revision: 1
    };
    plugins.set(key(manifest.id, manifest.version), record);
    dependencyOrder([...plugins.values()].filter(value => value.state !== 'removed'), [manifest.id]);
    event('plugin.admitted', { plugin_id: manifest.id, version: manifest.version, execution: admission.execution });
    return clone(record);
  }
  function enable(idValue, versionValue = '') {
    const record = get(idValue, versionValue);
    if (!record) throw new PluginRegistryError('plugin_not_found', 'plugin not found', 404);
    if (!['admitted', 'disabled'].includes(record.state)) throw new PluginRegistryError('plugin_state_invalid', `cannot enable plugin in ${record.state}`, 409);
    dependencyOrder([...plugins.values()].filter(value => value.state !== 'removed'), [record.manifest.id]);
    for (const dependency of record.manifest.dependencies) {
      const dependencyRecord = get(dependency.id);
      if (!dependencyRecord || dependencyRecord.state !== 'enabled') throw new PluginRegistryError('dependency_not_enabled', `dependency not enabled: ${dependency.id}`, 409);
    }
    record.state = 'enabled'; record.enabled_at = now(clock); record.revision += 1;
    event('plugin.enabled', { plugin_id: record.manifest.id, version: record.manifest.version });
    return clone(record);
  }
  function disable(idValue, versionValue = '', reason = '') {
    const record = get(idValue, versionValue);
    if (!record) throw new PluginRegistryError('plugin_not_found', 'plugin not found', 404);
    record.state = 'disabled'; record.revision += 1;
    event('plugin.disabled', { plugin_id: record.manifest.id, version: record.manifest.version, reason });
    return clone(record);
  }
  function drain(idValue, versionValue = '', reason = '') {
    const record = get(idValue, versionValue);
    if (!record) throw new PluginRegistryError('plugin_not_found', 'plugin not found', 404);
    record.state = 'draining'; record.revision += 1;
    event('plugin.draining', { plugin_id: record.manifest.id, version: record.manifest.version, reason });
    return clone(record);
  }
  async function health(idValue, versionValue = '', probe = null) {
    const record = get(idValue, versionValue);
    if (!record) throw new PluginRegistryError('plugin_not_found', 'plugin not found', 404);
    if (typeof probe !== 'function') return clone(record.health);
    try {
      const detail = redactPluginSecrets(await probe({ id: record.manifest.id, version: record.manifest.version, digest: record.manifest.manifest_digest }));
      record.health = { status: detail.ok === false ? 'degraded' : clean(detail.status || 'healthy', 50), checked_at: now(clock), detail };
    } catch (error) {
      record.health = { status: 'unavailable', checked_at: now(clock), detail: { error: clean(redactPluginSecrets(error.message), 1000) } };
      record.state = 'unavailable';
    }
    record.revision += 1;
    event('plugin.health', { plugin_id: record.manifest.id, version: record.manifest.version, health: record.health });
    return clone(record.health);
  }
  async function invoke(idValue, capability, input = {}, options = {}) {
    const record = get(idValue, options.version);
    if (!record) throw new PluginRegistryError('plugin_not_found', 'plugin not found', 404);
    if (record.state !== 'enabled') throw new PluginRegistryError('plugin_not_enabled', 'plugin is not enabled', 409);
    const requested = clean(capability, 200);
    if (!record.manifest.capabilities.includes(requested)) throw new PluginRegistryError('capability_undeclared', `capability not declared: ${requested}`, 403);
    const circuitKey = key(record.manifest.id, record.manifest.version);
    const circuit = circuits.get(circuitKey) || { failures: 0, open_until: 0 };
    if (circuit.open_until && circuit.open_until <= clock()) { circuit.failures = 0; circuit.open_until = 0; }
    if (circuit.open_until > clock()) throw new PluginRegistryError('plugin_circuit_open', 'plugin circuit is open', 503);
    const controller = new AbortController();
    if (options.signal) options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true });
    const invocationId = id();
    try {
      const result = await loaders.invoke(record.admission.execution, {
        schema: 'sideways-maker-plugin-invocation/v1', invocation_id: invocationId,
        plugin: { id: record.manifest.id, version: record.manifest.version, digest: record.manifest.manifest_digest },
        capability: requested, input: redactPluginSecrets(input), config: record.config
      }, controller.signal);
      circuit.failures = 0; circuit.open_until = 0; circuits.set(circuitKey, circuit);
      const receipt = { schema: 'sideways-maker-plugin-invocation-receipt/v1', invocation_id: invocationId, plugin_id: record.manifest.id, version: record.manifest.version, capability: requested, mode: record.admission.execution, ok: true, started_at: result.started_at, finished_at: result.finished_at, output: result.output, receipt_digest: '' };
      receipt.receipt_digest = hash({ ...receipt, receipt_digest: undefined });
      event('plugin.invoked', { plugin_id: record.manifest.id, version: record.manifest.version, capability: requested, invocation_id: invocationId });
      return Object.freeze(receipt);
    } catch (error) {
      circuit.failures += 1;
      if (circuit.failures >= circuit_threshold) circuit.open_until = clock() + circuit_cooldown_ms;
      circuits.set(circuitKey, circuit);
      const receipt = { schema: 'sideways-maker-plugin-invocation-receipt/v1', invocation_id: invocationId, plugin_id: record.manifest.id, version: record.manifest.version, capability: requested, mode: record.admission.execution, ok: false, started_at: now(clock), finished_at: now(clock), error: { code: clean(error.code || 'plugin_failed', 100), message: clean(redactPluginSecrets(error.message), 1000) }, receipt_digest: '' };
      receipt.receipt_digest = hash({ ...receipt, receipt_digest: undefined });
      event('plugin.invocation_failed', receipt);
      return Object.freeze(receipt);
    }
  }
  function upgrade(manifestInput, options = {}) {
    const manifest = manifestInput.schema ? manifestInput : normalizePluginManifest(manifestInput);
    const current = get(manifest.id);
    if (!current) throw new PluginRegistryError('plugin_not_found', 'current plugin not found', 404);
    if (compareVersion(manifest.version, current.manifest.version) <= 0 && options.allow_downgrade !== true) throw new PluginRegistryError('upgrade_version_invalid', 'upgrade must increase version', 409);
    const migration = manifest.migrations.find(value => value.from === current.manifest.version && value.to === manifest.version) || null;
    const next = admit(manifest, { approvals: options.approvals, config: options.config || current.config, previous_version: current.manifest.version });
    const stored = get(next.manifest.id, next.manifest.version);
    stored.migration = migration ? { ...migration, status: 'planned', receipt_digest: hash(migration) } : null;
    disable(current.manifest.id, current.manifest.version, 'superseded by upgrade');
    event('plugin.upgraded', { plugin_id: manifest.id, from: current.manifest.version, to: manifest.version, migration: stored.migration });
    return clone(stored);
  }
  function rollback(idValue, options = {}) {
    const current = get(idValue, options.from_version);
    if (!current) throw new PluginRegistryError('plugin_not_found', 'plugin not found', 404);
    const targetVersion = clean(options.to_version || current.previous_version, 100);
    const target = get(idValue, targetVersion);
    if (!target) throw new PluginRegistryError('rollback_target_missing', 'rollback target unavailable', 409);
    disable(current.manifest.id, current.manifest.version, 'rollback');
    if (target.state === 'disabled') enable(target.manifest.id, target.manifest.version);
    event('plugin.rolled_back', { plugin_id: current.manifest.id, from: current.manifest.version, to: target.manifest.version });
    return clone(target);
  }
  function removePlan(idValue, versionValue = '') {
    const record = get(idValue, versionValue);
    if (!record) throw new PluginRegistryError('plugin_not_found', 'plugin not found', 404);
    const dependents = [...plugins.values()].filter(value => value.state !== 'removed' && value.manifest.dependencies.some(dependency => dependency.id === record.manifest.id)).map(value => value.manifest.id);
    return Object.freeze({ schema: 'sideways-maker-plugin-remove-plan/v1', plugin_id: record.manifest.id, version: record.manifest.version, dependents, execute: false, allowed: dependents.length === 0, receipt_digest: hash({ id: record.manifest.id, version: record.manifest.version, dependents }) });
  }
  function snapshot() {
    const value = { schema: 'sideways-maker-plugin-registry/v1', api_version: policy.api_version, plugins: [...plugins.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id) || compareVersion(a.manifest.version, b.manifest.version)).map(record => redactPluginSecrets(record)), loaders: loaders.describe(), circuits: redactPluginSecrets(Object.fromEntries(circuits)), events: clone(history), observed_at: now(clock), snapshot_digest: '' };
    value.snapshot_digest = hash({ ...value, snapshot_digest: undefined });
    return Object.freeze(value);
  }
  return Object.freeze({
    installPlan, admit, enable, disable, drain, health, invoke, upgrade, rollback, removePlan,
    get: (idValue, versionValue) => { const value = get(idValue, versionValue); return value ? clone(value) : null; },
    list: () => [...plugins.values()].map(clone),
    order: rootIds => dependencyOrder([...plugins.values()].filter(value => value.state !== 'removed'), rootIds),
    negotiate(capability) { return [...plugins.values()].filter(record => record.state === 'enabled' && record.manifest.capabilities.includes(clean(capability, 200))).sort((a, b) => compareVersion(b.manifest.version, a.manifest.version)).map(record => ({ id: record.manifest.id, version: record.manifest.version, mode: record.admission.execution })); },
    snapshot,
    events: after => history.filter(value => value.sequence > (Number(after) || 0)).map(clone)
  });
}
