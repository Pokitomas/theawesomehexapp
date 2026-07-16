#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const finite = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const unique = (values, limit = 200) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 200)).filter(Boolean))].slice(0, limit);
const HEALTH = ['healthy', 'degraded', 'offline', 'unknown'];
const PRIVACY = ['public', 'provider', 'contractual', 'private', 'local'];
const PRIVACY_RANK = Object.freeze({ public: 0, provider: 1, contractual: 2, private: 3, local: 4 });
const EXECUTION_MODES = ['github_hosted', 'self_hosted', 'remote_http', 'local', 'in_process'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const fleetDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key)/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;
export function redactFleetSecrets(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 300).map(item => redactFleetSecrets(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 500).map(([key, item]) => [clean(key, 200), SECRET_KEY.test(key) ? '[redacted]' : redactFleetSecrets(item, depth + 1)]));
  }
  if (typeof value === 'string') return clean(value.replace(SECRET_TEXT, '[redacted]'), 20000);
  if (['number', 'boolean'].includes(typeof value) || value === null) return value;
  return clean(value, 2000);
}

export class MakerFleetError extends Error {
  constructor(code, message, status = 400, detail = {}) {
    super(message);
    this.name = 'MakerFleetError';
    this.code = code;
    this.status = status;
    this.detail = redactFleetSecrets(detail);
  }
}

function normalizeAttestation(input = {}) {
  const state = ['attested', 'verified', 'unverified'].includes(input.state) ? input.state : 'unverified';
  return Object.freeze({
    state,
    issuer: clean(input.issuer, 300),
    subject: clean(input.subject, 500),
    digest: clean(input.digest, 300),
    observed_at: clean(input.observed_at, 100)
  });
}

export function normalizeWorkerDescriptor(input = {}) {
  const id = clean(input.id, 300);
  if (!id) throw new MakerFleetError('invalid_worker', 'worker id is required');
  const mode = EXECUTION_MODES.includes(input.mode) ? input.mode : 'remote_http';
  const resources = input.resources || {};
  const worker = {
    schema: 'sideways-maker-worker/v1',
    id,
    display_name: clean(input.display_name || id, 300),
    mode,
    identity: normalizeAttestation(input.identity),
    platform: Object.freeze({
      os: clean(input.platform?.os || 'unknown', 100).toLowerCase(),
      arch: clean(input.platform?.arch || 'unknown', 100).toLowerCase(),
      labels: unique(input.platform?.labels),
      toolchains: unique(input.platform?.toolchains),
      providers: unique(input.platform?.providers)
    }),
    isolation: Object.freeze({
      containers: input.isolation?.containers === true,
      sandbox: input.isolation?.sandbox === true,
      ephemeral_workspace: input.isolation?.ephemeral_workspace !== false,
      network: clean(input.isolation?.network || 'restricted', 100).toLowerCase()
    }),
    resources: Object.freeze({
      cpu: finite(resources.cpu, 1, 0, 100000),
      memory_mb: Math.round(finite(resources.memory_mb, 1024, 0, 10 ** 9)),
      disk_mb: Math.round(finite(resources.disk_mb, 1024, 0, 10 ** 12)),
      time_ms: Math.round(finite(resources.time_ms, 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000)),
      concurrency: Math.round(finite(resources.concurrency, 1, 1, 100000)),
      queue_depth: Math.round(finite(resources.queue_depth, 0, 0, 10 ** 9))
    }),
    placement: Object.freeze({
      region: clean(input.placement?.region || 'unknown', 100).toLowerCase(),
      locality: clean(input.placement?.locality || (mode === 'local' || mode === 'in_process' ? 'local' : 'remote'), 40).toLowerCase(),
      privacy: PRIVACY.includes(input.placement?.privacy) ? input.placement.privacy : 'provider',
      latency_ms: finite(input.placement?.latency_ms, 1000, 0, 10 ** 9),
      cost_per_hour_usd: finite(input.placement?.cost_per_hour_usd, 0, 0, 10 ** 9),
      operator_rank: Math.round(finite(input.placement?.operator_rank, 0, -1000, 1000))
    }),
    health: HEALTH.includes(input.health?.state) ? input.health.state : 'unknown',
    reliability: Object.freeze({
      success_rate: finite(input.reliability?.success_rate, 0.5, 0, 1),
      samples: Math.round(finite(input.reliability?.samples, 0, 0, 10 ** 9)),
      lost_runs: Math.round(finite(input.reliability?.lost_runs, 0, 0, 10 ** 9))
    }),
    state: ['active', 'draining', 'quarantined', 'offline'].includes(input.state) ? input.state : 'active',
    metadata: Object.freeze(redactFleetSecrets(input.metadata || {}))
  };
  worker.verified = ['attested', 'verified'].includes(worker.identity.state);
  worker.descriptor_digest = fleetDigest({ ...worker, descriptor_digest: undefined });
  return Object.freeze(worker);
}

export function normalizeFleetTask(input = {}) {
  const repository = clean(input.repository, 500);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new MakerFleetError('invalid_repository', 'repository must be owner/name');
  const requirements = input.requirements || {};
  return Object.freeze({
    schema: 'sideways-maker-fleet-task/v1',
    id: clean(input.id || randomUUID(), 300),
    owner: clean(input.owner || repository.split('/')[0], 300),
    repository,
    backend: clean(input.backend || 'auto', 100),
    priority: Math.round(finite(input.priority, 50, 0, 100)),
    kind: clean(input.kind || 'build', 100),
    created_at: clean(input.created_at || new Date().toISOString(), 100),
    requirements: Object.freeze({
      modes: unique(requirements.modes),
      os: clean(requirements.os, 100).toLowerCase(),
      arch: clean(requirements.arch, 100).toLowerCase(),
      labels: unique(requirements.labels),
      toolchains: unique(requirements.toolchains),
      providers: unique(requirements.providers),
      network: clean(requirements.network, 100).toLowerCase(),
      containers: requirements.containers === true,
      sandbox: requirements.sandbox === true,
      ephemeral_workspace: requirements.ephemeral_workspace !== false,
      cpu: finite(requirements.cpu, 0, 0, 100000),
      memory_mb: Math.round(finite(requirements.memory_mb, 0, 0, 10 ** 9)),
      disk_mb: Math.round(finite(requirements.disk_mb, 0, 0, 10 ** 12)),
      time_ms: Math.round(finite(requirements.time_ms, 0, 0, 30 * 24 * 60 * 60 * 1000)),
      region: clean(requirements.region, 100).toLowerCase(),
      locality: clean(requirements.locality || 'any', 40).toLowerCase(),
      privacy_minimum: PRIVACY.includes(requirements.privacy_minimum) ? requirements.privacy_minimum : 'public',
      verified_identity: requirements.verified_identity !== false,
      max_cost_per_hour_usd: finite(requirements.max_cost_per_hour_usd, Number.MAX_SAFE_INTEGER, 0, 10 ** 9)
    }),
    preferences: Object.freeze({
      worker_ids: unique(input.preferences?.worker_ids),
      locality: clean(input.preferences?.locality || 'any', 40).toLowerCase(),
      region: clean(input.preferences?.region, 100).toLowerCase(),
      privacy: PRIVACY.includes(input.preferences?.privacy) ? input.preferences.privacy : '',
      max_latency_ms: finite(input.preferences?.max_latency_ms, Number.MAX_SAFE_INTEGER, 0, 10 ** 9)
    }),
    retry: Object.freeze({
      allowed: input.retry?.allowed !== false,
      max_attempts: Math.round(finite(input.retry?.max_attempts, 2, 0, 100)),
      lost_worker: clean(input.retry?.lost_worker || 'retry', 40)
    }),
    reservation: ['normal', 'repair', 'recovery'].includes(input.reservation) ? input.reservation : 'normal'
  });
}

function includesAll(actual, required) {
  const values = new Set(actual);
  return required.every(item => values.has(item));
}

export function classifyWorkerMismatch(worker, taskInput) {
  const task = taskInput.schema ? taskInput : normalizeFleetTask(taskInput);
  const required = task.requirements;
  const reasons = [];
  if (required.verified_identity && !worker.verified) reasons.push('unverified_identity');
  if (worker.state === 'draining') reasons.push('worker_draining');
  if (worker.state === 'quarantined') reasons.push('worker_quarantined');
  if (worker.state === 'offline' || worker.health === 'offline') reasons.push('worker_offline');
  if (worker.health === 'unknown') reasons.push('health_unknown');
  if (required.modes.length && !required.modes.includes(worker.mode)) reasons.push('execution_mode');
  if (required.os && worker.platform.os !== required.os) reasons.push('os');
  if (required.arch && worker.platform.arch !== required.arch) reasons.push('arch');
  if (!includesAll(worker.platform.labels, required.labels)) reasons.push('labels');
  if (!includesAll(worker.platform.toolchains, required.toolchains)) reasons.push('toolchains');
  if (!includesAll(worker.platform.providers, required.providers)) reasons.push('providers');
  if (required.network && worker.isolation.network !== required.network) reasons.push('network');
  if (required.containers && !worker.isolation.containers) reasons.push('containers');
  if (required.sandbox && !worker.isolation.sandbox) reasons.push('sandbox');
  if (required.ephemeral_workspace && !worker.isolation.ephemeral_workspace) reasons.push('ephemeral_workspace');
  if (worker.resources.cpu < required.cpu) reasons.push('cpu');
  if (worker.resources.memory_mb < required.memory_mb) reasons.push('memory');
  if (worker.resources.disk_mb < required.disk_mb) reasons.push('disk');
  if (worker.resources.time_ms < required.time_ms) reasons.push('time');
  if (required.region && worker.placement.region !== required.region) reasons.push('region');
  if (required.locality !== 'any' && worker.placement.locality !== required.locality) reasons.push('locality');
  if (PRIVACY_RANK[worker.placement.privacy] < PRIVACY_RANK[required.privacy_minimum]) reasons.push('privacy');
  if (worker.placement.cost_per_hour_usd > required.max_cost_per_hour_usd) reasons.push('cost');
  return Object.freeze(reasons);
}

export function scoreWorker(worker, taskInput, runtime = {}) {
  const task = taskInput.schema ? taskInput : normalizeFleetTask(taskInput);
  const reasons = [...classifyWorkerMismatch(worker, task)];
  const active = finite(runtime.active, 0, 0, 10 ** 9);
  const queued = finite(runtime.queued, worker.resources.queue_depth, 0, 10 ** 9);
  if (active >= worker.resources.concurrency) reasons.push('concurrency_exhausted');
  if (reasons.length) return Object.freeze({ worker_id: worker.id, eligible: false, reasons, score: -Infinity });
  let score = 0;
  score += worker.reliability.success_rate * 100;
  score += Math.min(15, Math.log10(worker.reliability.samples + 1) * 4);
  score -= worker.reliability.lost_runs * 5;
  score += worker.health === 'healthy' ? 20 : 5;
  score -= active * 15;
  score -= queued * 3;
  score -= Math.min(40, worker.placement.latency_ms / 100);
  score -= Math.min(40, worker.placement.cost_per_hour_usd * 5);
  score += worker.placement.operator_rank;
  if (task.preferences.worker_ids.includes(worker.id)) score += 50 - task.preferences.worker_ids.indexOf(worker.id);
  if (task.preferences.locality !== 'any' && worker.placement.locality === task.preferences.locality) score += 18;
  if (task.preferences.region && worker.placement.region === task.preferences.region) score += 10;
  if (task.preferences.privacy && worker.placement.privacy === task.preferences.privacy) score += 10;
  if (worker.placement.latency_ms <= task.preferences.max_latency_ms) score += 5;
  if (task.reservation === 'recovery' || task.reservation === 'repair') score += worker.platform.labels.includes(task.reservation) ? 30 : 0;
  return Object.freeze({ worker_id: worker.id, eligible: true, reasons: [], score: Number(score.toFixed(6)) });
}

export function normalizeArtifactReference(input = {}) {
  const digest = clean(input.digest, 300).toLowerCase();
  if (!/^[a-z0-9]+:[a-f0-9]{32,128}$/.test(digest)) throw new MakerFleetError('invalid_artifact_digest', 'artifact digest is required');
  return Object.freeze({
    schema: 'sideways-maker-artifact-reference/v1',
    kind: clean(input.kind || 'artifact', 100),
    name: clean(input.name || 'artifact', 300),
    uri: clean(input.uri, 2000),
    digest,
    size_bytes: Math.round(finite(input.size_bytes, 0, 0, 10 ** 12)),
    retention: clean(input.retention || 'bounded', 100),
    provenance: clean(input.provenance || 'worker', 500),
    workspace_id: clean(input.workspace_id, 300)
  });
}

export function createFleetAdapterRegistry({ clock = Date.now } = {}) {
  const adapters = new Map();
  function register(input = {}) {
    const id = clean(input.id, 200);
    if (!id) throw new MakerFleetError('invalid_adapter', 'adapter id is required');
    if (adapters.has(id)) throw new MakerFleetError('duplicate_adapter', `adapter ${id} already exists`, 409);
    const descriptor = Object.freeze({
      id,
      kind: clean(input.kind || 'custom', 100),
      available: input.available === true && typeof input.dispatch === 'function',
      reason: clean(input.reason, 1000),
      dispatch: input.dispatch
    });
    adapters.set(id, descriptor);
    return describeOne(descriptor);
  }
  const describeOne = adapter => Object.freeze({ id: adapter.id, kind: adapter.kind, available: adapter.available, reason: adapter.available ? '' : adapter.reason || 'transport unavailable' });
  const describe = () => [...adapters.values()].map(describeOne).sort((a, b) => a.id.localeCompare(b.id));
  async function dispatch(adapterId, placement, payload = {}) {
    const adapter = adapters.get(clean(adapterId, 200));
    if (!adapter) throw new MakerFleetError('adapter_not_found', 'fleet adapter not found', 404);
    if (!adapter.available) throw new MakerFleetError('adapter_unavailable', adapter.reason || 'fleet adapter unavailable', 503);
    const started = new Date(clock()).toISOString();
    try {
      const output = await adapter.dispatch(structuredClone(placement), redactFleetSecrets(payload));
      return Object.freeze({ schema: 'sideways-maker-fleet-dispatch/v1', adapter: describeOne(adapter), placement_id: placement.placement_id, ok: true, output: redactFleetSecrets(output), started_at: started, finished_at: new Date(clock()).toISOString() });
    } catch (error) {
      return Object.freeze({ schema: 'sideways-maker-fleet-dispatch/v1', adapter: describeOne(adapter), placement_id: placement.placement_id, ok: false, error: { code: clean(error.code || 'dispatch_failed', 100), message: clean(redactFleetSecrets(error.message), 2000) }, started_at: started, finished_at: new Date(clock()).toISOString() });
    }
  }
  return Object.freeze({ register, describe, dispatch });
}

export function registerDefaultFleetAdapters(registry, dependencies = {}) {
  const definitions = [
    ['github-actions', 'github_hosted', dependencies.github_actions, 'GitHub Actions dispatch unavailable'],
    ['self-hosted-runner', 'self_hosted', dependencies.self_hosted, 'self-hosted runner dispatch unavailable'],
    ['remote-http', 'remote_http', dependencies.remote_http, 'remote HTTP dispatch unavailable'],
    ['local-worker', 'local', dependencies.local, 'local worker dispatch unavailable'],
    ['in-process', 'in_process', dependencies.in_process, 'in-process dispatch unavailable']
  ];
  return definitions.map(([id, kind, dispatch, reason]) => registry.register({ id, kind, dispatch, reason, available: typeof dispatch === 'function' }));
}

export function createWorkerFleet({
  workers = [],
  clock = Date.now,
  id = randomUUID,
  lease_ms = 5 * 60 * 1000,
  quotas = {},
  starvation_ms = 10 * 60 * 1000,
  repair_reserve = 1,
  adapters = createFleetAdapterRegistry({ clock })
} = {}) {
  const registry = new Map(workers.map(value => {
    const worker = value.schema ? value : normalizeWorkerDescriptor(value);
    return [worker.id, worker];
  }));
  const tasks = new Map();
  const leases = new Map();
  const runtime = new Map();
  const ownerCursor = new Map();
  const usage = new Map();
  const events = [];
  let sequence = 0;

  const emit = (type, detail = {}) => {
    const event = Object.freeze({ schema: 'sideways-maker-fleet-event/v1', sequence: ++sequence, event_id: id(), type, at: new Date(clock()).toISOString(), detail: redactFleetSecrets(detail) });
    events.push(event);
    return event;
  };
  const runtimeState = workerId => {
    if (!runtime.has(workerId)) runtime.set(workerId, { active: 0, queued: 0, last_heartbeat: 0 });
    return runtime.get(workerId);
  };
  const quotaKey = task => `${task.owner}|${task.repository}|${task.backend}`;
  const quotaLimit = task => {
    const exact = quotas[quotaKey(task)] || {};
    const owner = quotas[`owner:${task.owner}`] || {};
    const repository = quotas[`repository:${task.repository}`] || {};
    const backend = quotas[`backend:${task.backend}`] || {};
    return {
      concurrency: Math.round(finite(exact.concurrency ?? repository.concurrency ?? owner.concurrency ?? backend.concurrency, Number.MAX_SAFE_INTEGER, 0, 10 ** 9)),
      cost_usd: finite(exact.cost_usd ?? repository.cost_usd ?? owner.cost_usd ?? backend.cost_usd, Number.MAX_SAFE_INTEGER, 0, 10 ** 9)
    };
  };
  const quotaUsage = task => {
    const key = quotaKey(task);
    if (!usage.has(key)) usage.set(key, { active: 0, cost_usd: 0 });
    return usage.get(key);
  };
  function ensureQuota(task) {
    const limit = quotaLimit(task);
    const current = quotaUsage(task);
    if (current.active >= limit.concurrency) throw new MakerFleetError('quota_exhausted', 'task concurrency quota exhausted', 429, { repository: task.repository, backend: task.backend });
    if (current.cost_usd >= limit.cost_usd) throw new MakerFleetError('budget_exhausted', 'task cost budget exhausted', 429, { repository: task.repository, backend: task.backend });
  }

  function register(workerInput) {
    const worker = workerInput.schema ? workerInput : normalizeWorkerDescriptor(workerInput);
    if (registry.has(worker.id)) throw new MakerFleetError('duplicate_worker', 'worker already registered', 409);
    registry.set(worker.id, worker);
    emit('worker.registered', { worker_id: worker.id, verified: worker.verified });
    return worker;
  }

  function updateWorker(workerId, patch = {}) {
    const current = registry.get(clean(workerId, 300));
    if (!current) throw new MakerFleetError('worker_not_found', 'worker not found', 404);
    const merged = normalizeWorkerDescriptor({
      ...current,
      ...patch,
      platform: { ...current.platform, ...(patch.platform || {}) },
      isolation: { ...current.isolation, ...(patch.isolation || {}) },
      resources: { ...current.resources, ...(patch.resources || {}) },
      placement: { ...current.placement, ...(patch.placement || {}) },
      reliability: { ...current.reliability, ...(patch.reliability || {}) },
      identity: patch.identity || current.identity,
      health: typeof patch.health === 'string' ? { state: patch.health } : { state: patch.health?.state || current.health }
    });
    registry.set(merged.id, merged);
    emit('worker.updated', { worker_id: merged.id, state: merged.state, health: merged.health });
    return merged;
  }

  function enqueue(taskInput) {
    const task = taskInput.schema ? taskInput : normalizeFleetTask(taskInput);
    if (tasks.has(task.id)) throw new MakerFleetError('duplicate_task', 'fleet task already exists', 409);
    tasks.set(task.id, { task, state: 'queued', attempt: 1, enqueued_at: clock(), placement: null, error: null });
    emit('task.queued', { task_id: task.id, owner: task.owner, priority: task.priority, reservation: task.reservation });
    return task;
  }

  function eligibleWorkers(task, options = {}) {
    return [...registry.values()].map(worker => ({ worker, score: scoreWorker(worker, task, runtimeState(worker.id)) }))
      .filter(entry => entry.score.eligible)
      .filter(entry => !options.exclude_worker_ids?.includes(entry.worker.id))
      .sort((a, b) => b.score.score - a.score.score || a.worker.id.localeCompare(b.worker.id));
  }

  function classifyNoCapacity(task) {
    const mismatches = [...registry.values()].map(worker => ({ worker_id: worker.id, reasons: classifyWorkerMismatch(worker, task) }));
    if (!registry.size) return Object.freeze({ code: 'capacity_unavailable', message: 'no workers registered', mismatches });
    if (mismatches.every(item => item.reasons.includes('unverified_identity'))) return Object.freeze({ code: 'unverified_capacity', message: 'all matching workers are unverified', mismatches });
    if (mismatches.every(item => item.reasons.some(reason => ['worker_offline', 'worker_quarantined', 'worker_draining', 'health_unknown'].includes(reason)))) return Object.freeze({ code: 'unhealthy_capacity', message: 'workers are unavailable or unhealthy', mismatches });
    return Object.freeze({ code: 'capability_mismatch', message: 'no worker satisfies hard requirements', mismatches });
  }

  function createPlacement(task, worker, score, recovered = false) {
    ensureQuota(task);
    const stamp = clock();
    const lease = {
      schema: 'sideways-maker-worker-lease/v1',
      lease_id: id(),
      fencing_token: `${worker.id}:${id()}`,
      task_id: task.id,
      worker_id: worker.id,
      claimed_at: new Date(stamp).toISOString(),
      expires_at: new Date(stamp + lease_ms).toISOString(),
      generation: (leases.get(task.id)?.generation || 0) + 1
    };
    lease.digest = fleetDigest({ ...lease, digest: undefined });
    leases.set(task.id, lease);
    runtimeState(worker.id).active += 1;
    quotaUsage(task).active += 1;
    const placement = {
      schema: 'sideways-maker-placement/v1',
      placement_id: id(),
      task_id: task.id,
      worker_id: worker.id,
      score: score.score,
      lease,
      recovered,
      workspace: {
        ephemeral: worker.isolation.ephemeral_workspace,
        workspace_id: `workspace:${task.id}:${lease.generation}`,
        isolation: worker.isolation.sandbox ? 'sandbox' : worker.isolation.containers ? 'container' : 'process'
      },
      worker: {
        mode: worker.mode,
        platform: worker.platform,
        placement: worker.placement,
        identity: worker.identity
      },
      created_at: new Date(stamp).toISOString()
    };
    placement.receipt_digest = fleetDigest({ ...placement, receipt_digest: undefined });
    return Object.freeze(placement);
  }

  function place(taskInput, options = {}) {
    const task = taskInput.schema ? taskInput : normalizeFleetTask(taskInput);
    ensureQuota(task);
    const selected = eligibleWorkers(task, options);
    if (!selected.length) {
      const classification = classifyNoCapacity(task);
      throw new MakerFleetError(classification.code, classification.message, 503, classification);
    }
    const placement = createPlacement(task, selected[0].worker, selected[0].score, options.recovered === true);
    emit(options.recovered ? 'task.recovered' : 'task.placed', { task_id: task.id, worker_id: placement.worker_id, placement_id: placement.placement_id });
    return placement;
  }

  function effectivePriority(entry) {
    const waited = Math.max(0, clock() - entry.enqueued_at);
    const starvationBoost = Math.floor(waited / starvation_ms) * 20;
    const reservationBoost = entry.task.reservation === 'recovery' ? 40 : entry.task.reservation === 'repair' ? 30 : 0;
    return entry.task.priority + starvationBoost + reservationBoost;
  }

  function nextQueuedTask() {
    const queued = [...tasks.values()].filter(entry => entry.state === 'queued');
    if (!queued.length) return null;
    const owners = [...new Set(queued.map(entry => entry.task.owner))].sort();
    const ownerScores = owners.map(owner => {
      const last = ownerCursor.get(owner) || 0;
      const best = Math.max(...queued.filter(entry => entry.task.owner === owner).map(effectivePriority));
      return { owner, score: best - last };
    }).sort((a, b) => b.score - a.score || a.owner.localeCompare(b.owner));
    const owner = ownerScores[0].owner;
    const selected = queued.filter(entry => entry.task.owner === owner).sort((a, b) => effectivePriority(b) - effectivePriority(a) || a.enqueued_at - b.enqueued_at || a.task.id.localeCompare(b.task.id))[0];
    ownerCursor.set(owner, (ownerCursor.get(owner) || 0) + 1);
    return selected;
  }

  function scheduleNext(options = {}) {
    const entry = nextQueuedTask();
    if (!entry) return null;
    const activeNormal = [...leases.values()].filter(lease => Date.parse(lease.expires_at) > clock()).length;
    if (entry.task.reservation === 'normal' && repair_reserve > 0) {
      const capacity = [...registry.values()].reduce((sum, worker) => sum + worker.resources.concurrency, 0);
      if (capacity - activeNormal <= repair_reserve && [...tasks.values()].some(item => item.state === 'queued' && item.task.reservation !== 'normal')) {
        const reserved = [...tasks.values()].filter(item => item.state === 'queued' && item.task.reservation !== 'normal').sort((a, b) => effectivePriority(b) - effectivePriority(a))[0];
        if (reserved) return scheduleEntry(reserved, options);
      }
    }
    return scheduleEntry(entry, options);
  }

  function scheduleEntry(entry, options = {}) {
    const placement = place(entry.task, options);
    entry.state = 'running';
    entry.placement = placement;
    return placement;
  }

  function heartbeat(taskId, fencingToken) {
    const lease = leases.get(clean(taskId, 300));
    if (!lease) throw new MakerFleetError('lease_not_found', 'worker lease not found', 404);
    if (lease.fencing_token !== clean(fencingToken, 500)) throw new MakerFleetError('fencing_mismatch', 'active fencing token required', 409);
    if (Date.parse(lease.expires_at) <= clock()) throw new MakerFleetError('lease_expired', 'worker lease expired', 409);
    lease.expires_at = new Date(clock() + lease_ms).toISOString();
    lease.digest = fleetDigest({ ...lease, digest: undefined });
    runtimeState(lease.worker_id).last_heartbeat = clock();
    emit('lease.heartbeat', { task_id: taskId, worker_id: lease.worker_id, expires_at: lease.expires_at });
    return structuredClone(lease);
  }

  function finish(taskId, fencingToken, result = {}) {
    const taskEntry = tasks.get(clean(taskId, 300));
    const lease = leases.get(clean(taskId, 300));
    if (!taskEntry || !lease) throw new MakerFleetError('lease_not_found', 'active task lease required', 404);
    if (lease.fencing_token !== clean(fencingToken, 500)) throw new MakerFleetError('fencing_mismatch', 'active fencing token required', 409);
    taskEntry.state = 'completed';
    taskEntry.result = redactFleetSecrets(result);
    runtimeState(lease.worker_id).active = Math.max(0, runtimeState(lease.worker_id).active - 1);
    quotaUsage(taskEntry.task).active = Math.max(0, quotaUsage(taskEntry.task).active - 1);
    quotaUsage(taskEntry.task).cost_usd += finite(result.cost_usd, 0, 0, 10 ** 9);
    leases.delete(taskId);
    emit('task.completed', { task_id: taskId, worker_id: lease.worker_id });
    return structuredClone(taskEntry);
  }

  function cancel(taskId, reason = '') {
    const entry = tasks.get(clean(taskId, 300));
    if (!entry) throw new MakerFleetError('task_not_found', 'fleet task not found', 404);
    const lease = leases.get(taskId);
    if (lease) {
      runtimeState(lease.worker_id).active = Math.max(0, runtimeState(lease.worker_id).active - 1);
      quotaUsage(entry.task).active = Math.max(0, quotaUsage(entry.task).active - 1);
      leases.delete(taskId);
    }
    entry.state = 'cancelled';
    entry.error = { code: 'cancelled', message: clean(reason || 'cancelled by operator', 2000), recoverable: false };
    emit('task.cancelled', { task_id: taskId, reason: entry.error.message });
    return structuredClone(entry);
  }

  function drain(workerId) { return updateWorker(workerId, { state: 'draining' }); }
  function quarantine(workerId, reason = '') {
    const worker = updateWorker(workerId, { state: 'quarantined', metadata: { quarantine_reason: clean(reason, 1000) } });
    emit('worker.quarantined', { worker_id: worker.id, reason });
    return worker;
  }
  function activate(workerId) { return updateWorker(workerId, { state: 'active' }); }

  function recoverExpired() {
    const recovered = [];
    for (const [taskId, lease] of [...leases.entries()]) {
      if (Date.parse(lease.expires_at) > clock()) continue;
      const entry = tasks.get(taskId);
      runtimeState(lease.worker_id).active = Math.max(0, runtimeState(lease.worker_id).active - 1);
      quotaUsage(entry.task).active = Math.max(0, quotaUsage(entry.task).active - 1);
      leases.delete(taskId);
      if (entry.task.retry.allowed && entry.attempt < entry.task.retry.max_attempts && entry.task.retry.lost_worker === 'retry') {
        entry.state = 'queued';
        entry.attempt += 1;
        entry.error = { code: 'lost_worker', message: 'worker lease expired; task returned to queue', recoverable: true };
        recovered.push(taskId);
        emit('task.lost_worker_requeued', { task_id: taskId, previous_worker: lease.worker_id, attempt: entry.attempt });
      } else {
        entry.state = 'failed';
        entry.error = { code: 'lost_worker', message: 'worker lease expired', recoverable: false };
        emit('task.lost_worker_failed', { task_id: taskId, previous_worker: lease.worker_id });
      }
    }
    return recovered;
  }

  async function dispatch(placement, payload = {}) {
    const adapterId = {
      github_hosted: 'github-actions', self_hosted: 'self-hosted-runner', remote_http: 'remote-http', local: 'local-worker', in_process: 'in-process'
    }[placement.worker.mode];
    return adapters.dispatch(adapterId, placement, payload);
  }

  function snapshot() {
    const value = {
      schema: 'sideways-maker-worker-fleet-snapshot/v1',
      workers: [...registry.values()].sort((a, b) => a.id.localeCompare(b.id)),
      tasks: [...tasks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([task_id, entry]) => ({ task_id, ...redactFleetSecrets(entry) })),
      leases: [...leases.values()].sort((a, b) => a.task_id.localeCompare(b.task_id)),
      usage: [...usage.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, ...value })),
      adapters: adapters.describe(),
      events: structuredClone(events),
      at: new Date(clock()).toISOString()
    };
    value.receipt_digest = fleetDigest({ ...value, receipt_digest: undefined });
    return Object.freeze(value);
  }

  return Object.freeze({
    register,
    updateWorker,
    drain,
    quarantine,
    activate,
    enqueue,
    place,
    scheduleNext,
    heartbeat,
    finish,
    cancel,
    recoverExpired,
    dispatch,
    artifact: normalizeArtifactReference,
    classify: task => classifyNoCapacity(task.schema ? task : normalizeFleetTask(task)),
    workers: () => [...registry.values()].sort((a, b) => a.id.localeCompare(b.id)),
    events: after => events.filter(event => event.sequence > Number(after || 0)),
    snapshot
  });
}
