#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';

const clean = (value, limit = 20_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const clone = value => structuredClone(value);
const finite = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const unique = (values, limit = 200) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 200)).filter(Boolean))].slice(0, limit);
const now = clock => new Date(clock()).toISOString();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export const fleetDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const typedDigest = value => `sha256:${fleetDigest(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'digest')))}`;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

const SECRET_KEY = /(?:^|[_-])(?:secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential|session)(?:$|[_-])/i;
const TOKEN_COUNT_KEY = /^(?:input|output|context|prompt|completion|total)_tokens?$/i;
const PRIVATE_INFRA_KEY = /(?:^|[_-])(?:url|uri|host|hostname|endpoint|runner_label|runner_labels|model|models|provider|providers)(?:$|[_-])/i;
const CREDENTIAL_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;
const URL_TEXT = /https?:\/\/[^\s"'<>]+/gi;

export function redactFleetSecrets(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 300).map(item => redactFleetSecrets(item, depth + 1));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 500).map(([key, item]) => [
      clean(key, 200),
      SECRET_KEY.test(key) && !TOKEN_COUNT_KEY.test(key) ? '[redacted]' : redactFleetSecrets(item, depth + 1)
    ]));
  }
  if (typeof value === 'string') return clean(value.replace(CREDENTIAL_TEXT, '[redacted]'), 20_000);
  if (['number', 'boolean'].includes(typeof value) || value === null) return value;
  return clean(value, 2_000);
}

function redactInfrastructure(value, depth = 0) {
  if (depth > 10) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactInfrastructure(item, depth + 1));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 300).map(([key, item]) => [
      clean(key, 200),
      SECRET_KEY.test(key) || PRIVATE_INFRA_KEY.test(key) ? '[redacted]' : redactInfrastructure(item, depth + 1)
    ]));
  }
  if (typeof value === 'string') return clean(value.replace(CREDENTIAL_TEXT, '[redacted]').replace(URL_TEXT, '[redacted-url]'), 10_000);
  if (['number', 'boolean'].includes(typeof value) || value === null) return value;
  return clean(value, 2_000);
}

export class WorkerFleetError extends Error {
  constructor(code, message, status = 400, detail = {}) {
    super(message);
    this.name = 'WorkerFleetError';
    this.code = code;
    this.status = status;
    this.detail = redactFleetSecrets(detail);
  }
}

const WORKER_MODES = new Set(['github_actions', 'self_hosted', 'remote_http', 'in_process', 'local_control']);
const HEALTH = new Set(['healthy', 'degraded', 'offline', 'unknown']);
const OPERATOR_STATE = new Set(['active', 'draining', 'quarantined', 'offline']);
const IDENTITY = new Set(['attested', 'verified', 'unverified', 'unknown']);
const NETWORK_RANK = Object.freeze({ unknown: -1, none: 0, restricted: 1, egress: 2, full: 3 });
const PRIVACY_RANK = Object.freeze({ unknown: -1, public: 0, provider: 1, contractual: 2, private: 3, local: 4 });
const LOCALITY = new Set(['local', 'remote', 'hybrid', 'private', 'unknown']);
const CAPACITY = new Set(['dedicated', 'shared', 'burst', 'unknown']);
const THROTTLING = new Set(['none', 'bounded', 'provider', 'unknown']);

function enumValue(value, allowed, fallback = 'unknown') {
  const normalized = clean(value, 100).toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}
function optionalNumber(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : null;
}
function optionalInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = optionalNumber(value, min, max);
  return number === null ? null : Math.round(number);
}
function safeLabel(value, fallback, limit = 200) {
  const text = clean(value, limit);
  CREDENTIAL_TEXT.lastIndex = 0;
  URL_TEXT.lastIndex = 0;
  const unsafe = !text || CREDENTIAL_TEXT.test(text) || URL_TEXT.test(text);
  CREDENTIAL_TEXT.lastIndex = 0;
  URL_TEXT.lastIndex = 0;
  return unsafe ? fallback : text;
}

function validateReceipt(input, schema, bindings = {}) {
  if (!isObject(input)) return null;
  const receipt = {
    schema: clean(input.schema, 100),
    worker_id: clean(input.worker_id, 300),
    subject: clean(input.subject, 500),
    mode: clean(input.mode, 100).toLowerCase(),
    endpoint_digest: clean(input.endpoint_digest, 200).toLowerCase(),
    state: clean(input.state, 40).toLowerCase(),
    issuer: clean(input.issuer, 300),
    observed_at: clean(input.observed_at, 100),
    issued_at: clean(input.issued_at, 100),
    digest: clean(input.digest, 200).toLowerCase()
  };
  receipt.valid = receipt.schema === schema && DIGEST.test(receipt.digest) && typedDigest(input) === receipt.digest;
  for (const [key, expected] of Object.entries(bindings)) if (expected && receipt[key] !== expected) receipt.valid = false;
  return Object.freeze(receipt);
}

function endpointDigest(input = {}) {
  const explicit = clean(input.endpoint_digest, 200).toLowerCase();
  if (DIGEST.test(explicit)) return explicit;
  const material = {
    ownership: clean(input.ownership, 100).toLowerCase(),
    transport: clean(input.transport, 100).toLowerCase(),
    locality: clean(input.locality, 100).toLowerCase(),
    capacity: clean(input.capacity, 100).toLowerCase()
  };
  return `sha256:${fleetDigest(material)}`;
}

export function normalizeWorkerDescriptor(input = {}) {
  const id = clean(input.id, 300);
  const mode = clean(input.mode, 100).toLowerCase();
  if (!id) throw new WorkerFleetError('worker_id_required', 'worker id is required');
  if (!WORKER_MODES.has(mode)) throw new WorkerFleetError('worker_mode_invalid', `unsupported worker mode: ${mode}`);

  const endpointInput = input.endpoint || {};
  const endpoint = {
    ownership: clean(endpointInput.ownership || 'unknown', 100).toLowerCase(),
    transport: clean(endpointInput.transport || (mode === 'local_control' || mode === 'in_process' ? 'local' : mode === 'remote_http' ? 'remote' : 'relay'), 100).toLowerCase(),
    locality: enumValue(endpointInput.locality ?? input.locality, LOCALITY),
    capacity: enumValue(endpointInput.capacity, CAPACITY),
    throttling: enumValue(endpointInput.throttling, THROTTLING),
    label: safeLabel(endpointInput.label, endpointInput.locality === 'local' ? 'Your local Maker runtime' : 'Maker execution runtime'),
    endpoint_digest: endpointDigest(endpointInput)
  };
  const identityStatus = enumValue(input.identity?.status, IDENTITY);
  const attestation = validateReceipt(input.identity?.receipt, 'sideways-maker-worker-attestation/v1', {
    worker_id: id,
    subject: clean(input.identity?.subject, 500),
    mode,
    endpoint_digest: endpoint.endpoint_digest
  });
  const healthState = enumValue(isObject(input.health) ? input.health.state : input.health, HEALTH);
  const healthReceipt = validateReceipt(isObject(input.health) ? input.health.receipt : input.health_receipt, 'sideways-maker-worker-health/v1', {
    worker_id: id,
    endpoint_digest: endpoint.endpoint_digest,
    state: healthState
  });

  const descriptor = {
    schema: 'sideways-maker-worker/v1',
    id,
    display_name: safeLabel(input.display_name || id, 'Maker worker'),
    identity: {
      status: identityStatus,
      subject: clean(input.identity?.subject, 500),
      issuer: clean(input.identity?.issuer || attestation?.issuer, 300),
      receipt: attestation,
      trusted: ['attested', 'verified'].includes(identityStatus) && attestation?.valid === true
    },
    mode,
    platform: {
      os: clean(input.platform?.os || 'unknown', 100).toLowerCase(),
      architecture: clean(input.platform?.architecture || input.platform?.arch || 'unknown', 100).toLowerCase()
    },
    labels: unique(input.labels || input.platform?.labels),
    capabilities: unique(input.capabilities),
    toolchains: unique(input.toolchains || input.platform?.toolchains),
    providers: unique(input.providers || input.platform?.providers),
    models: unique(input.models),
    network: {
      mode: clean(input.network?.mode || 'unknown', 40).toLowerCase() in NETWORK_RANK ? clean(input.network?.mode || 'unknown', 40).toLowerCase() : 'unknown',
      allowed_hosts: unique(input.network?.allowed_hosts)
    },
    isolation: {
      container: input.isolation?.container === true || input.isolation?.containers === true,
      sandbox: input.isolation?.sandbox === true,
      ephemeral_workspace: input.isolation?.ephemeral_workspace === true
    },
    resources: {
      cpu: optionalNumber(input.resources?.cpu, 0.1, 100_000),
      memory_mb: optionalInteger(input.resources?.memory_mb, 1, 10 ** 9),
      disk_mb: optionalInteger(input.resources?.disk_mb, 1, 10 ** 12),
      time_ms: optionalInteger(input.resources?.time_ms, 1_000, 30 * 24 * 60 * 60 * 1_000)
    },
    concurrency: {
      limit: optionalInteger(input.concurrency?.limit ?? input.resources?.concurrency, 1, 100_000),
      active: Math.round(finite(input.concurrency?.active, 0, 0, 100_000)),
      queue_depth: Math.round(finite(input.concurrency?.queue_depth ?? input.resources?.queue_depth, 0, 0, 10 ** 9))
    },
    endpoint,
    region: clean(input.region || input.placement?.region || 'unknown', 100).toLowerCase(),
    privacy: clean(input.privacy || input.placement?.privacy || 'unknown', 100).toLowerCase(),
    cost: {
      per_minute_usd: optionalNumber(input.cost?.per_minute_usd, 0, 10 ** 6),
      per_job_usd: optionalNumber(input.cost?.per_job_usd, 0, 10 ** 6)
    },
    latency_ms: optionalInteger(input.latency_ms ?? input.placement?.latency_ms, 0, 10 ** 9),
    health: {
      state: healthState,
      evidence: healthReceipt?.valid === true ? 'observed' : 'unknown',
      observed_at: clean((isObject(input.health) ? input.health.observed_at : '') || healthReceipt?.observed_at, 100),
      receipt: healthReceipt
    },
    operator_state: enumValue(input.operator_state ?? input.state, OPERATOR_STATE, 'active'),
    reliability: {
      successes: Math.round(finite(input.reliability?.successes, 0, 0, 10 ** 9)),
      failures: Math.round(finite(input.reliability?.failures, 0, 0, 10 ** 9)),
      lost: Math.round(finite(input.reliability?.lost ?? input.reliability?.lost_runs, 0, 0, 10 ** 9))
    },
    recovery: {
      checkpointing: input.recovery?.checkpointing === true,
      mode: clean(input.recovery?.mode || 'none', 100).toLowerCase()
    },
    operator_weight: finite(input.operator_weight ?? input.placement?.operator_rank, 0, -1000, 1000),
    metadata: redactInfrastructure(input.metadata || {}),
    observed_at: clean(input.observed_at || healthReceipt?.observed_at || new Date(0).toISOString(), 100)
  };
  descriptor.descriptor_digest = fleetDigest({ ...descriptor, descriptor_digest: undefined });
  return Object.freeze(descriptor);
}

export function normalizeFleetTask(input = {}, clock = Date.now, id = randomUUID) {
  const repository = clean(input.repository, 500);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new WorkerFleetError('repository_invalid', 'repository must be owner/name');
  const requirements = input.requirements || input;
  const network = clean(requirements.network || 'none', 40).toLowerCase();
  return Object.freeze({
    schema: 'sideways-maker-fleet-task/v1',
    id: clean(input.id || id(), 300),
    owner: clean(input.owner || repository.split('/')[0], 300),
    repository,
    backend: clean(input.backend || 'auto', 100),
    priority: finite(input.priority, 50, 0, 100),
    reservation: ['normal', 'repair', 'recovery'].includes(input.reservation) ? input.reservation : input.recovery === true ? 'recovery' : 'normal',
    created_at: clean(input.created_at || now(clock), 100),
    capabilities: unique(requirements.capabilities),
    labels: unique(requirements.labels),
    toolchains: unique(requirements.toolchains),
    providers: unique(requirements.providers),
    models: unique(requirements.models),
    modes: unique(requirements.modes),
    platform: {
      os: clean(requirements.platform?.os || requirements.os || 'any', 100).toLowerCase(),
      architecture: clean(requirements.platform?.architecture || requirements.arch || 'any', 100).toLowerCase()
    },
    network: network in NETWORK_RANK ? network : 'none',
    allowed_hosts: unique(requirements.allowed_hosts),
    isolation: {
      container: requirements.isolation?.container === true || requirements.containers === true,
      sandbox: requirements.isolation?.sandbox === true || requirements.sandbox === true,
      ephemeral_workspace: requirements.isolation?.ephemeral_workspace !== false && requirements.ephemeral_workspace !== false
    },
    resources: {
      cpu: finite(requirements.resources?.cpu ?? requirements.cpu, 1, 0.1, 100_000),
      memory_mb: Math.round(finite(requirements.resources?.memory_mb ?? requirements.memory_mb, 512, 1, 10 ** 9)),
      disk_mb: Math.round(finite(requirements.resources?.disk_mb ?? requirements.disk_mb, 512, 1, 10 ** 12)),
      time_ms: Math.round(finite(requirements.resources?.time_ms ?? requirements.time_ms, 30 * 60 * 1_000, 1_000, 30 * 24 * 60 * 60 * 1_000))
    },
    region: clean(requirements.region || 'any', 100).toLowerCase(),
    locality: clean(requirements.locality || 'any', 100).toLowerCase(),
    privacy: clean(requirements.privacy || requirements.privacy_minimum || 'public', 100).toLowerCase(),
    capacity: clean(requirements.capacity || 'any', 100).toLowerCase(),
    dedicated_capacity: requirements.dedicated_capacity === true,
    recoverable: requirements.recoverable === true,
    max_latency_ms: finite(requirements.max_latency_ms, Number.MAX_SAFE_INTEGER, 0, 10 ** 9),
    max_cost_usd: finite(requirements.max_cost_usd, 10 ** 9, 0, 10 ** 9),
    allow_unverified: input.allow_unverified === true,
    allow_unknown_cost: input.allow_unknown_cost === true,
    retry_lost: input.retry_lost !== false,
    max_attempts: Math.round(finite(input.max_attempts ?? input.retry?.max_attempts, 3, 1, 100)),
    attempt: Math.round(finite(input.attempt, 1, 1, 100)),
    state: redactFleetSecrets(input.state || {})
  });
}

function includesAll(haystack, needles) {
  const set = new Set(haystack);
  return needles.every(value => set.has(value));
}
function reliabilityScore(worker) {
  const total = worker.reliability.successes + worker.reliability.failures + worker.reliability.lost;
  const ratio = total ? worker.reliability.successes / total : 0.5;
  return Math.round((ratio * 300) - (worker.reliability.lost * 25));
}
function estimatedCost(worker, task) {
  if (!Number.isFinite(worker.cost.per_minute_usd) || !Number.isFinite(worker.cost.per_job_usd)) return null;
  return worker.cost.per_job_usd + ((task.resources.time_ms / 60_000) * worker.cost.per_minute_usd);
}

export function scoreWorker(worker, taskInput, options = {}) {
  const task = taskInput.schema ? taskInput : normalizeFleetTask(taskInput);
  const reasons = [];
  if (!worker.identity.trusted && !task.allow_unverified) reasons.push('identity_unverified');
  if (worker.health.evidence !== 'observed') reasons.push('health_unobserved');
  if (['offline', 'unknown'].includes(worker.health.state)) reasons.push(`worker_${worker.health.state}`);
  if (['draining', 'quarantined', 'offline'].includes(worker.operator_state)) reasons.push(`worker_${worker.operator_state}`);
  if (task.modes.length && !task.modes.includes(worker.mode)) reasons.push('mode_mismatch');
  if (task.platform.os !== 'any' && worker.platform.os !== task.platform.os) reasons.push('os_mismatch');
  if (task.platform.architecture !== 'any' && worker.platform.architecture !== task.platform.architecture) reasons.push('architecture_mismatch');
  if (!includesAll(worker.capabilities, task.capabilities)) reasons.push('capability_mismatch');
  if (!includesAll(worker.labels, task.labels)) reasons.push('label_mismatch');
  if (!includesAll(worker.toolchains, task.toolchains)) reasons.push('toolchain_mismatch');
  if (!includesAll(worker.providers, task.providers)) reasons.push('provider_mismatch');
  if (!includesAll(worker.models, task.models)) reasons.push('model_mismatch');
  if ((NETWORK_RANK[worker.network.mode] ?? -1) < (NETWORK_RANK[task.network] ?? 0)) reasons.push('network_mismatch');
  if (task.allowed_hosts.some(host => !worker.network.allowed_hosts.includes(host) && worker.network.mode !== 'full')) reasons.push('network_host_mismatch');
  if (task.isolation.container && !worker.isolation.container) reasons.push('container_required');
  if (task.isolation.sandbox && !worker.isolation.sandbox) reasons.push('sandbox_required');
  if (task.isolation.ephemeral_workspace && !worker.isolation.ephemeral_workspace) reasons.push('ephemeral_workspace_required');
  for (const key of ['cpu', 'memory_mb', 'disk_mb', 'time_ms']) {
    if (!Number.isFinite(worker.resources[key])) reasons.push(`${key}_unknown`);
    else if (worker.resources[key] < task.resources[key]) reasons.push(`${key}_insufficient`);
  }
  if (!Number.isFinite(worker.concurrency.limit)) reasons.push('concurrency_unknown');
  else if (worker.concurrency.active >= worker.concurrency.limit) reasons.push('worker_capacity_exhausted');
  if (task.region !== 'any' && worker.region !== task.region) reasons.push('region_mismatch');
  if (task.locality !== 'any' && worker.endpoint.locality !== task.locality) reasons.push('locality_mismatch');
  if ((PRIVACY_RANK[worker.privacy] ?? -1) < (PRIVACY_RANK[task.privacy] ?? 0)) reasons.push('privacy_mismatch');
  if (task.capacity !== 'any' && worker.endpoint.capacity !== task.capacity) reasons.push('capacity_mismatch');
  if (task.dedicated_capacity && worker.endpoint.capacity !== 'dedicated') reasons.push('dedicated_capacity_required');
  if (task.recoverable && (!worker.recovery.checkpointing || worker.recovery.mode === 'none')) reasons.push('recovery_required');
  if (!Number.isFinite(worker.latency_ms)) reasons.push('latency_unknown');
  else if (worker.latency_ms > task.max_latency_ms) reasons.push('latency_ceiling');
  const cost = estimatedCost(worker, task);
  if (cost === null && !task.allow_unknown_cost) reasons.push('cost_unknown');
  else if (cost !== null && cost > task.max_cost_usd) reasons.push('cost_ceiling');
  if (options.quota_exhausted) reasons.push('quota_exhausted');
  if (options.duplicate_active) reasons.push('duplicate_execution');
  if (options.adapter_unavailable) reasons.push('adapter_unavailable');
  if (reasons.length) return Object.freeze({ worker_id: worker.id, eligible: false, score: -Infinity, reasons: unique(reasons), estimated_cost_usd: cost });

  let score = 1000;
  score += reliabilityScore(worker);
  score -= worker.concurrency.queue_depth * 20;
  score -= worker.concurrency.active * 30;
  score -= Math.round(worker.latency_ms / 10);
  if (cost !== null) score -= Math.round(cost * 100);
  score += (PRIVACY_RANK[worker.privacy] || 0) * 40;
  score += worker.endpoint.locality === 'local' ? 80 : 0;
  score += worker.health.state === 'healthy' ? 50 : -100;
  score += worker.operator_weight;
  if (task.reservation !== 'normal' && worker.labels.includes(task.reservation)) score += 100;
  return Object.freeze({ worker_id: worker.id, eligible: true, score, reasons: [], estimated_cost_usd: cost });
}

export function rankWorkers(workers, task, options = {}) {
  return workers.map(worker => ({ worker, ...scoreWorker(worker, task, options[worker.id] || {}) }))
    .filter(value => value.eligible)
    .sort((a, b) => b.score - a.score || a.worker.id.localeCompare(b.worker.id));
}

export function normalizeArtifactReferences(input = {}) {
  const normalize = (value, kind) => {
    if (!isObject(value)) return null;
    if (['content', 'data', 'bytes', 'payload', 'base64'].some(key => key in value)) throw new WorkerFleetError('artifact_payload_denied', `${kind} receipts must reference payloads, not embed them`);
    const digest = clean(value.digest, 200).toLowerCase();
    const uri = clean(value.uri || value.url, 2_000);
    const size = optionalInteger(value.size_bytes, 0, 10 ** 12);
    if (!DIGEST.test(digest)) throw new WorkerFleetError('artifact_digest_invalid', `${kind} digest is required`);
    if (!uri) throw new WorkerFleetError('artifact_uri_required', `${kind} URI is required`);
    if (size === null) throw new WorkerFleetError('artifact_size_required', `${kind} size is required`);
    return Object.freeze({
      schema: 'sideways-maker-artifact-reference/v1',
      kind,
      name: clean(value.name || kind, 300),
      uri,
      digest,
      size_bytes: size,
      retention: clean(value.retention || 'bounded', 100),
      provenance: clean(value.provenance || 'worker-reported', 300),
      workspace_id: clean(value.workspace_id, 300)
    });
  };
  return Object.freeze({
    artifacts: (Array.isArray(input.artifacts) ? input.artifacts : []).map(value => normalize(value, 'artifact')).filter(Boolean).slice(0, 200),
    logs: (Array.isArray(input.logs) ? input.logs : []).map(value => normalize(value, 'log')).filter(Boolean).slice(0, 200)
  });
}

export function createWorkerAdapterRegistry({ clock = Date.now, timeout_ms = 120_000 } = {}) {
  const adapters = new Map();
  return Object.freeze({
    register(input = {}) {
      const mode = clean(input.mode, 100).toLowerCase();
      if (!WORKER_MODES.has(mode)) throw new WorkerFleetError('adapter_mode_invalid', `unsupported adapter mode: ${mode}`);
      if (adapters.has(mode)) throw new WorkerFleetError('adapter_duplicate', `adapter already registered: ${mode}`, 409);
      const value = Object.freeze({ mode, available: input.available === true && typeof input.dispatch === 'function', reason: clean(input.reason, 1_000), dispatch: input.dispatch });
      adapters.set(mode, value);
      return { mode, available: value.available, reason: value.available ? '' : value.reason || 'transport unavailable' };
    },
    describe() {
      return [...adapters.values()].map(value => ({ mode: value.mode, available: value.available, reason: value.available ? '' : value.reason || 'transport unavailable' })).sort((a, b) => a.mode.localeCompare(b.mode));
    },
    async dispatch(mode, packet, options = {}) {
      const adapter = adapters.get(clean(mode, 100).toLowerCase());
      if (!adapter) throw new WorkerFleetError('adapter_not_found', `adapter not found: ${mode}`, 404);
      if (!adapter.available) throw new WorkerFleetError('adapter_unavailable', adapter.reason || 'adapter unavailable', 503);
      const controller = new AbortController();
      const timeout = Math.round(finite(options.timeout_ms, timeout_ms, 1, 30 * 60 * 1_000));
      let timer;
      const startedAt = now(clock);
      try {
        const output = await Promise.race([
          Promise.resolve().then(() => adapter.dispatch({ ...clone(packet), signal: controller.signal })),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort(new Error('worker dispatch timed out'));
              reject(new WorkerFleetError('dispatch_timeout', 'worker dispatch timed out; transport completion is indeterminate unless AbortSignal is honored', 504));
            }, timeout);
            timer.unref?.();
          })
        ]);
        return Object.freeze({ schema: 'sideways-maker-fleet-dispatch/v1', mode, ok: true, output: redactFleetSecrets(output), started_at: startedAt, finished_at: now(clock) });
      } finally {
        clearTimeout(timer);
      }
    }
  });
}

export function registerDefaultWorkerAdapters(registry, transports = {}) {
  return [...WORKER_MODES].map(mode => registry.register({ mode, available: typeof transports[mode] === 'function', dispatch: transports[mode], reason: `${mode} transport not configured` }));
}

function publicRuntime(worker, placement, clock) {
  return Object.freeze({
    schema: 'sideways-maker-runtime-profile/v1',
    runtime_id: `maker-worker-${fleetDigest({ worker: worker.id, endpoint: worker.endpoint.endpoint_digest }).slice(0, 16)}`,
    display_name: 'Maker execution runtime',
    status: worker.health.state,
    intelligence: { selection: 'adaptive', engine_label: 'Admitted Maker intelligence', architecture: 'unknown', admission: 'unknown', capabilities: worker.capabilities },
    endpoint: {
      ownership: ['user', 'project', 'managed', 'hybrid'].includes(worker.endpoint.ownership) ? worker.endpoint.ownership : 'unknown',
      transport: ['local', 'remote', 'hybrid', 'relay'].includes(worker.endpoint.transport) ? worker.endpoint.transport : 'unknown',
      locality: worker.endpoint.locality,
      capacity: worker.endpoint.capacity,
      throttling: worker.endpoint.throttling,
      label: worker.endpoint.label
    },
    planning: { strategy: 'adaptive', scheduler: 'priority', parallelism: Math.max(1, worker.concurrency.limit || 1), speculation: false, recovery: worker.recovery.checkpointing ? 'checkpoint' : 'lease', confidence_threshold: 0.8 },
    execution: {
      role: placement.reservation === 'normal' ? 'implementer' : placement.reservation,
      modes: [worker.mode],
      transport: worker.endpoint.transport === 'local' ? 'direct' : worker.endpoint.transport === 'relay' ? 'relay' : 'queue',
      workspace: worker.isolation.sandbox ? 'container' : worker.isolation.ephemeral_workspace ? 'isolated' : 'repository',
      verification: 'continuous',
      checkpointing: worker.recovery.checkpointing ? 'enabled' : 'bounded',
      recovery: worker.recovery.mode === 'none' ? 'lease' : worker.recovery.mode
    },
    authority: { capabilities: {} },
    presentation: { headline: 'Maker is building your thing', activity: 'Running on admitted compute', tone: 'friendly', visible: true },
    observed_at: now(clock)
  });
}

export function createWorkerFleet({
  workers = [],
  clock = Date.now,
  id = randomUUID,
  lease_ms = 5 * 60 * 1_000,
  starvation_ms = 10 * 60 * 1_000,
  recovery_reserve = 1,
  quotas = {},
  adapters = createWorkerAdapterRegistry({ clock }),
  dispatch_timeout_ms = 120_000
} = {}) {
  const registry = new Map();
  const queue = new Map();
  const executions = new Map();
  const history = [];
  const fences = new Map();
  const usage = new Map();
  const ownerTurns = new Map();
  for (const input of workers) {
    const worker = input.schema ? input : normalizeWorkerDescriptor(input);
    if (registry.has(worker.id)) throw new WorkerFleetError('worker_duplicate', `worker already registered: ${worker.id}`, 409);
    registry.set(worker.id, worker);
  }

  function record(type, detail = {}) {
    const event = Object.freeze({ schema: 'sideways-maker-fleet-event/v1', sequence: history.length + 1, event_id: id(), type, at: now(clock), detail: redactFleetSecrets(detail) });
    history.push(event);
    return event;
  }
  function scopeKeys(task) { return [`owner:${task.owner}`, `repository:${task.repository}`, `backend:${task.backend}`]; }
  function quotaFor(key) {
    const configured = quotas[key] || {};
    return { concurrency: Math.round(finite(configured.concurrency, 10 ** 9, 0, 10 ** 9)), cost_usd: finite(configured.cost_usd, 10 ** 9, 0, 10 ** 9) };
  }
  function usageFor(key) {
    if (!usage.has(key)) usage.set(key, { active: 0, reserved_cost_usd: 0, cost_usd: 0, completed: 0 });
    return usage.get(key);
  }
  function quotaState(task, estimate = 0) {
    const exhausted = [];
    for (const key of scopeKeys(task)) {
      const limit = quotaFor(key);
      const current = usageFor(key);
      if (current.active >= limit.concurrency) exhausted.push({ key, dimension: 'concurrency' });
      if (current.cost_usd + current.reserved_cost_usd + finite(estimate, 0, 0) > limit.cost_usd) exhausted.push({ key, dimension: 'cost_usd' });
    }
    return exhausted;
  }
  function adapterState() { return Object.fromEntries(adapters.describe().map(value => [value.mode, value.available])); }
  function placementOptions(task) {
    const duplicate = executions.get(task.id)?.state === 'running';
    const states = adapterState();
    return Object.fromEntries([...registry.values()].map(worker => {
      const estimate = estimatedCost(worker, task) || 0;
      return [worker.id, { quota_exhausted: quotaState(task, estimate).length > 0, duplicate_active: duplicate, adapter_unavailable: states[worker.mode] !== true }];
    }));
  }
  function classifyNoPlacement(task) {
    const workersList = [...registry.values()];
    if (!workersList.length) return { code: 'capacity_unavailable', blockers: [] };
    const options = placementOptions(task);
    const reasons = workersList.map(worker => ({ worker_id: worker.id, reasons: scoreWorker(worker, task, options[worker.id] || {}).reasons }));
    if (reasons.every(item => item.reasons.includes('identity_unverified'))) return { code: 'unverified_identity', blockers: reasons };
    if (reasons.every(item => item.reasons.includes('health_unobserved') || item.reasons.some(reason => reason.startsWith('worker_')))) return { code: 'unhealthy_worker', blockers: reasons };
    if (reasons.every(item => item.reasons.includes('quota_exhausted'))) return { code: 'quota_exhausted', blockers: reasons };
    if (reasons.every(item => item.reasons.includes('adapter_unavailable'))) return { code: 'external_infrastructure_blocker', blockers: reasons };
    if (reasons.every(item => item.reasons.includes('cost_unknown'))) return { code: 'cost_unknown', blockers: reasons };
    return { code: 'capability_mismatch', blockers: reasons };
  }

  function register(input) {
    const worker = normalizeWorkerDescriptor(input);
    if (registry.has(worker.id)) throw new WorkerFleetError('worker_duplicate', `worker already registered: ${worker.id}`, 409);
    registry.set(worker.id, worker);
    record('worker.registered', { worker_id: worker.id, digest: worker.descriptor_digest, trusted: worker.identity.trusted, health: worker.health });
    return worker;
  }
  function replace(input) {
    const worker = normalizeWorkerDescriptor(input);
    registry.set(worker.id, worker);
    record('worker.updated', { worker_id: worker.id, digest: worker.descriptor_digest, trusted: worker.identity.trusted, health: worker.health });
    return worker;
  }
  function setOperatorState(workerId, state, reason = '') {
    const current = registry.get(clean(workerId, 300));
    if (!current) throw new WorkerFleetError('worker_not_found', 'worker not found', 404);
    const next = normalizeWorkerDescriptor({ ...clone(current), operator_state: state, metadata: { ...clone(current.metadata || {}), operator_reason: clean(reason, 1_000) } });
    registry.set(next.id, next);
    record(`worker.${state}`, { worker_id: next.id, reason });
    return next;
  }
  function observeHealth(workerId, health) {
    const current = registry.get(clean(workerId, 300));
    if (!current) throw new WorkerFleetError('worker_not_found', 'worker not found', 404);
    const next = normalizeWorkerDescriptor({ ...clone(current), health, observed_at: isObject(health) ? health.observed_at : current.observed_at });
    if (next.health.evidence !== 'observed') throw new WorkerFleetError('health_receipt_invalid', 'digest-bound observed health receipt required');
    registry.set(next.id, next);
    record('worker.health_observed', { worker_id: next.id, state: next.health.state });
    return next;
  }
  function recoverWorker(workerId, health, reason = '') {
    const observed = observeHealth(workerId, health);
    const active = normalizeWorkerDescriptor({ ...clone(observed), operator_state: 'active', metadata: { ...clone(observed.metadata || {}), recovery_reason: clean(reason, 1_000) } });
    registry.set(active.id, active);
    record('worker.recovered', { worker_id: active.id, reason });
    return active;
  }

  function submit(input) {
    const task = input.schema ? input : normalizeFleetTask(input, clock, id);
    if (queue.has(task.id) || executions.has(task.id)) throw new WorkerFleetError('task_duplicate', `task already exists: ${task.id}`, 409);
    const item = { task, state: 'queued', revision: 1, enqueued_at: now(clock), updated_at: now(clock), last_error: null };
    queue.set(task.id, item);
    record('task.queued', { task_id: task.id, owner: task.owner, priority: task.priority, reservation: task.reservation });
    return clone(item);
  }
  function effectivePriority(item) {
    const age = Math.max(0, clock() - Date.parse(item.enqueued_at));
    const starvation = Math.floor(age / Math.max(1, starvation_ms));
    const reserve = item.task.reservation === 'recovery' ? 100 : item.task.reservation === 'repair' ? 75 : 0;
    return item.task.priority + Math.min(1_000, starvation * 10) + reserve;
  }
  function queuedTasks() {
    return [...queue.values()].filter(item => item.state === 'queued').sort((a, b) => {
      const priority = effectivePriority(b) - effectivePriority(a);
      if (priority) return priority;
      const activeA = usageFor(`owner:${a.task.owner}`).active;
      const activeB = usageFor(`owner:${b.task.owner}`).active;
      if (activeA !== activeB) return activeA - activeB;
      const turnsA = ownerTurns.get(a.task.owner) || 0;
      const turnsB = ownerTurns.get(b.task.owner) || 0;
      if (turnsA !== turnsB) return turnsA - turnsB;
      return a.enqueued_at.localeCompare(b.enqueued_at) || a.task.id.localeCompare(b.task.id);
    });
  }
  function place(taskInput) {
    const task = taskInput.schema ? taskInput : normalizeFleetTask(taskInput, clock, id);
    const ranked = rankWorkers([...registry.values()], task, placementOptions(task));
    if (!ranked.length) {
      const failure = classifyNoPlacement(task);
      throw new WorkerFleetError(failure.code, 'no eligible worker', 503, failure);
    }
    const selected = ranked[0];
    const placement = {
      schema: 'sideways-maker-placement/v1',
      placement_id: id(),
      task_id: task.id,
      worker_id: selected.worker.id,
      worker_mode: selected.worker.mode,
      reservation: task.reservation,
      score: selected.score,
      estimated_cost_usd: selected.estimated_cost_usd,
      worker_digest: selected.worker.descriptor_digest,
      task_digest: fleetDigest(task),
      endpoint: clone(selected.worker.endpoint),
      workspace: {
        schema: 'sideways-maker-workspace-placement/v1',
        workspace_id: `workspace:${task.id}:${task.attempt}`,
        ephemeral: selected.worker.isolation.ephemeral_workspace,
        isolation: selected.worker.isolation.sandbox ? 'sandbox' : selected.worker.isolation.container ? 'container' : 'process'
      },
      considered: ranked.map(value => ({ worker_id: value.worker.id, score: value.score })),
      placed_at: now(clock),
      receipt_digest: ''
    };
    placement.runtime_profile = publicRuntime(selected.worker, placement, clock);
    placement.receipt_digest = fleetDigest({ ...placement, receipt_digest: undefined });
    return Object.freeze(placement);
  }

  function reserve(execution) {
    for (const key of scopeKeys(execution.task)) {
      const current = usageFor(key);
      current.active += 1;
      current.reserved_cost_usd += finite(execution.placement.estimated_cost_usd, 0, 0);
    }
    const worker = registry.get(execution.placement.worker_id);
    registry.set(worker.id, normalizeWorkerDescriptor({ ...clone(worker), concurrency: { ...worker.concurrency, active: worker.concurrency.active + 1 } }));
  }
  function release(execution, actualCost = null) {
    for (const key of scopeKeys(execution.task)) {
      const current = usageFor(key);
      current.active = Math.max(0, current.active - 1);
      current.reserved_cost_usd = Math.max(0, current.reserved_cost_usd - finite(execution.placement.estimated_cost_usd, 0, 0));
      if (actualCost !== null) { current.cost_usd += actualCost; current.completed += 1; }
    }
    const worker = registry.get(execution.placement.worker_id);
    if (worker) registry.set(worker.id, normalizeWorkerDescriptor({ ...clone(worker), concurrency: { ...worker.concurrency, active: Math.max(0, worker.concurrency.active - 1) } }));
  }
  function expireLease(execution) { execution.lease = { ...execution.lease, token: '[expired]' }; }

  async function schedule() {
    const ordered = queuedTasks();
    if (!ordered.length) return null;
    const recoveryWaiting = ordered.some(item => item.task.reservation !== 'normal');
    const runningReserved = [...executions.values()].filter(value => value.state === 'running' && value.task.reservation !== 'normal').length;
    const totalCapacity = [...registry.values()].reduce((sum, worker) => sum + (worker.concurrency.limit || 0), 0);
    const active = [...executions.values()].filter(value => value.state === 'running').length;
    const candidates = ordered.filter(item => item.task.reservation !== 'normal' || !recoveryWaiting || totalCapacity - active > Math.max(0, recovery_reserve - runningReserved));
    for (const item of candidates) {
      let placement;
      try { placement = place(item.task); } catch (error) {
        item.last_error = { code: error.code, detail: redactFleetSecrets(error.detail) };
        item.updated_at = now(clock);
        queue.set(item.task.id, item);
        continue;
      }
      const worker = registry.get(placement.worker_id);
      const fence = (fences.get(item.task.id) || 0) + 1;
      fences.set(item.task.id, fence);
      const lease = { schema: 'sideways-maker-worker-lease/v1', lease_id: id(), task_id: item.task.id, worker_id: worker.id, token: id(), fence, claimed_at: now(clock), expires_at: new Date(clock() + lease_ms).toISOString() };
      lease.digest = fleetDigest({ ...lease, token: '[redacted]', digest: undefined });
      const execution = { schema: 'sideways-maker-fleet-execution/v1', task: item.task, placement, lease, state: 'dispatching', revision: 1, started_at: now(clock), updated_at: now(clock), result: null, error: null, dispatch: null };
      executions.set(item.task.id, execution);
      item.state = 'dispatching';
      item.updated_at = now(clock);
      queue.set(item.task.id, item);
      reserve(execution);
      ownerTurns.set(item.task.owner, (ownerTurns.get(item.task.owner) || 0) + 1);
      const packet = { schema: 'sideways-maker-worker-dispatch/v1', task: item.task, placement, lease: clone(lease) };
      try {
        execution.dispatch = await adapters.dispatch(worker.mode, packet, { timeout_ms: Math.min(dispatch_timeout_ms, item.task.resources.time_ms) });
        execution.state = 'running';
        execution.revision += 1;
        execution.updated_at = now(clock);
        item.state = 'running';
        item.revision += 1;
        item.updated_at = now(clock);
        executions.set(item.task.id, execution);
        queue.set(item.task.id, item);
        record('task.scheduled', { task_id: item.task.id, worker_id: worker.id, fence, placement_id: placement.placement_id });
        return clone(execution);
      } catch (error) {
        release(execution);
        execution.state = 'dispatch_failed';
        execution.revision += 1;
        execution.updated_at = now(clock);
        execution.error = { code: clean(error.code || 'dispatch_failed', 100), message: clean(redactFleetSecrets(error.message), 2_000), recoverable: true, indeterminate: error.code === 'dispatch_timeout', references: normalizeArtifactReferences() };
        expireLease(execution);
        executions.set(item.task.id, execution);
        item.state = 'queued';
        item.revision += 1;
        item.updated_at = now(clock);
        item.last_error = execution.error;
        queue.set(item.task.id, item);
        record('task.dispatch_failed', { task_id: item.task.id, worker_id: worker.id, error: execution.error });
        return clone(execution);
      }
    }
    return null;
  }

  function assertLease(taskId, token, fence) {
    const execution = executions.get(clean(taskId, 300));
    if (!execution) throw new WorkerFleetError('execution_not_found', 'execution not found', 404);
    if (execution.state !== 'running') throw new WorkerFleetError('execution_not_running', 'execution is not running', 409);
    if (execution.lease.token !== clean(token, 300)) throw new WorkerFleetError('lease_token_mismatch', 'active lease token required', 409);
    if (Number(fence) !== execution.lease.fence) throw new WorkerFleetError('fence_mismatch', 'current fencing token required', 409);
    if (Date.parse(execution.lease.expires_at) <= clock()) throw new WorkerFleetError('lease_expired', 'worker lease expired', 409);
    return execution;
  }
  function heartbeat(taskId, token, fence) {
    const execution = assertLease(taskId, token, fence);
    execution.lease.expires_at = new Date(clock() + lease_ms).toISOString();
    execution.revision += 1;
    execution.updated_at = now(clock);
    executions.set(execution.task.id, execution);
    record('task.heartbeat', { task_id: execution.task.id, worker_id: execution.lease.worker_id, fence });
    return clone(execution);
  }
  function checkActualCost(execution, cost) {
    if (cost > execution.task.max_cost_usd) throw new WorkerFleetError('task_budget_exhausted', 'actual worker cost exceeds task ceiling', 429, { cost, limit: execution.task.max_cost_usd });
    for (const key of scopeKeys(execution.task)) {
      const current = usageFor(key);
      const limit = quotaFor(key);
      const withoutReservation = current.cost_usd + Math.max(0, current.reserved_cost_usd - finite(execution.placement.estimated_cost_usd, 0, 0));
      if (withoutReservation + cost > limit.cost_usd) throw new WorkerFleetError('quota_exhausted', 'actual worker cost exceeds quota', 429, { key, cost, limit: limit.cost_usd });
    }
  }
  function complete(taskId, token, fence, input = {}) {
    const execution = assertLease(taskId, token, fence);
    const references = normalizeArtifactReferences(input.references || input);
    const cost = finite(input.cost_usd, execution.placement.estimated_cost_usd ?? 0, 0, 10 ** 9);
    checkActualCost(execution, cost);
    execution.state = 'completed';
    execution.revision += 1;
    execution.updated_at = now(clock);
    execution.result = { schema: 'sideways-maker-fleet-usage/v1', task_id: execution.task.id, worker_id: execution.placement.worker_id, cost_usd: cost, duration_ms: Math.max(0, clock() - Date.parse(execution.started_at)), references, detail: redactFleetSecrets(input.detail || {}) };
    release(execution, cost);
    expireLease(execution);
    const item = queue.get(execution.task.id);
    if (item) { item.state = 'completed'; item.revision += 1; item.updated_at = now(clock); queue.set(execution.task.id, item); }
    executions.set(execution.task.id, execution);
    record('task.completed', { task_id: execution.task.id, worker_id: execution.placement.worker_id, cost_usd: cost });
    return clone(execution);
  }
  function fail(taskId, token, fence, input = {}) {
    const execution = assertLease(taskId, token, fence);
    const cost = finite(input.cost_usd, 0, 0, 10 ** 9);
    if (cost) checkActualCost(execution, cost);
    execution.state = 'failed';
    execution.revision += 1;
    execution.updated_at = now(clock);
    execution.error = { code: clean(input.code || 'worker_failed', 100), message: clean(redactFleetSecrets(input.message || 'worker failed'), 2_000), recoverable: input.recoverable === true, references: normalizeArtifactReferences(input.references || {}) };
    release(execution, cost || null);
    expireLease(execution);
    executions.set(execution.task.id, execution);
    const item = queue.get(execution.task.id);
    if (item) {
      if (execution.error.recoverable && execution.task.attempt < execution.task.max_attempts) {
        item.task = normalizeFleetTask({ ...execution.task, attempt: execution.task.attempt + 1, reservation: 'recovery' }, clock, id);
        item.state = 'queued';
      } else item.state = 'failed';
      item.revision += 1;
      item.updated_at = now(clock);
      item.last_error = execution.error;
      queue.set(item.task.id, item);
    }
    record('task.failed', { task_id: execution.task.id, worker_id: execution.placement.worker_id, error: execution.error });
    return clone(execution);
  }
  function cancel(taskId, reason = '') {
    const key = clean(taskId, 300);
    const execution = executions.get(key);
    const item = queue.get(key);
    if (!execution && !item) throw new WorkerFleetError('task_not_found', 'task not found', 404);
    if (execution?.state === 'running' || execution?.state === 'dispatching') {
      release(execution);
      execution.state = 'cancelled';
      execution.revision += 1;
      execution.updated_at = now(clock);
      execution.error = { code: 'cancelled', message: clean(reason || 'cancelled by operator', 1_000), recoverable: false, references: normalizeArtifactReferences() };
      expireLease(execution);
      executions.set(key, execution);
    }
    if (item) { item.state = 'cancelled'; item.revision += 1; item.updated_at = now(clock); queue.set(key, item); }
    record('task.cancelled', { task_id: key, reason });
    return redactExecution(execution || item);
  }
  function recoverExpired() {
    const recovered = [];
    for (const execution of executions.values()) {
      if (execution.state !== 'running' || Date.parse(execution.lease.expires_at) > clock()) continue;
      release(execution);
      execution.state = 'lost';
      execution.revision += 1;
      execution.updated_at = now(clock);
      execution.error = { code: 'worker_lost', message: 'worker heartbeat expired', recoverable: execution.task.retry_lost, references: normalizeArtifactReferences() };
      expireLease(execution);
      executions.set(execution.task.id, execution);
      const worker = registry.get(execution.placement.worker_id);
      if (worker) registry.set(worker.id, normalizeWorkerDescriptor({ ...clone(worker), operator_state: 'offline', reliability: { ...worker.reliability, lost: worker.reliability.lost + 1 } }));
      const item = queue.get(execution.task.id);
      if (item && execution.task.retry_lost && execution.task.attempt < execution.task.max_attempts) {
        item.task = normalizeFleetTask({ ...execution.task, attempt: execution.task.attempt + 1, reservation: 'recovery' }, clock, id);
        item.state = 'queued';
        item.revision += 1;
        item.updated_at = now(clock);
        item.last_error = execution.error;
        queue.set(item.task.id, item);
        recovered.push(item.task.id);
      } else if (item) {
        item.state = 'failed'; item.revision += 1; item.updated_at = now(clock); item.last_error = execution.error; queue.set(item.task.id, item);
      }
      record('task.worker_lost', { task_id: execution.task.id, worker_id: execution.placement.worker_id, retried: recovered.includes(execution.task.id) });
    }
    return recovered;
  }

  function redactExecution(value) {
    if (!value) return null;
    const copy = clone(value);
    if (copy.lease?.token) copy.lease.token = '[redacted]';
    return redactFleetSecrets(copy);
  }
  function snapshot() {
    const value = {
      schema: 'sideways-maker-fleet-snapshot/v1',
      workers: [...registry.values()].sort((a, b) => a.id.localeCompare(b.id)),
      queue: [...queue.values()].sort((a, b) => a.task.id.localeCompare(b.task.id)),
      executions: [...executions.values()].sort((a, b) => a.task.id.localeCompare(b.task.id)).map(redactExecution),
      quotas: redactFleetSecrets(quotas),
      usage: [...usage.entries()].sort(([a], [b]) => a.localeCompare(b)),
      adapters: adapters.describe(),
      events: clone(history),
      observed_at: now(clock),
      snapshot_digest: ''
    };
    value.snapshot_digest = fleetDigest({ ...value, snapshot_digest: undefined });
    return Object.freeze(value);
  }

  return Object.freeze({
    register,
    replace,
    getWorker: workerId => registry.get(clean(workerId, 300)) || null,
    listWorkers: () => [...registry.values()].sort((a, b) => a.id.localeCompare(b.id)),
    observeHealth,
    drain: (workerId, reason) => setOperatorState(workerId, 'draining', reason),
    quarantine: (workerId, reason) => setOperatorState(workerId, 'quarantined', reason),
    recoverWorker,
    submit,
    enqueue: submit,
    place,
    schedule,
    heartbeat,
    complete,
    fail,
    cancel,
    recoverExpired,
    getExecution: taskId => redactExecution(executions.get(clean(taskId, 300))),
    getTask: taskId => queue.has(clean(taskId, 300)) ? clone(queue.get(clean(taskId, 300))) : null,
    listQueue: () => queuedTasks().map(clone),
    snapshot,
    usage: () => Object.fromEntries([...usage.entries()].map(([key, value]) => [key, clone(value)])),
    events: after => history.filter(event => event.sequence > (Number(after) || 0)).map(clone)
  });
}
