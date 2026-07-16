#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const now = clock => new Date(clock()).toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = (values, limit = 100) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 200)).filter(Boolean))].slice(0, limit);
const choose = (value, allowed, fallback) => allowed.includes(clean(value, 100).toLowerCase()) ? clean(value, 100).toLowerCase() : fallback;
const finite = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

const CAPABILITY_LEVELS = Object.freeze([
  'none',
  'read',
  'write',
  'execute',
  'manage',
  'reference_only',
  'approval_required'
]);

const PRODUCT_AUTHORITY_DEFAULTS = Object.freeze({
  filesystem: 'write',
  terminal: 'execute',
  git: 'manage',
  pull_requests: 'manage',
  issues: 'manage',
  browser: 'execute',
  containers: 'execute',
  models: 'execute',
  artifacts: 'manage',
  notifications: 'manage',
  network: 'execute',
  cloud: 'approval_required',
  deployment: 'approval_required',
  settings: 'approval_required',
  secrets: 'reference_only'
});

const EMPTY_AUTHORITY_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.keys(PRODUCT_AUTHORITY_DEFAULTS).map(key => [key, 'none']))
);

export class MakerControlError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MakerControlError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeCapabilityPolicy(input = {}, defaults = PRODUCT_AUTHORITY_DEFAULTS) {
  const source = input && typeof input === 'object' ? input : {};
  const keys = new Set([...Object.keys(defaults), ...Object.keys(source)]);
  return Object.freeze(Object.fromEntries([...keys].sort().map(key => {
    const normalizedKey = clean(key, 100).toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
    const fallback = defaults[key] || 'none';
    return [normalizedKey, choose(source[key], CAPABILITY_LEVELS, fallback)];
  })));
}

export function normalizeRuntimeRequirements(input = {}) {
  return Object.freeze({
    capabilities: unique(input.capabilities),
    execution_roles: unique(input.execution_roles),
    authority: unique(input.authority),
    locality: choose(input.locality, ['any', 'local', 'remote', 'hybrid', 'private'], 'any'),
    ownership: choose(input.ownership, ['any', 'user', 'project', 'managed', 'hybrid'], 'any'),
    dedicated_capacity: input.dedicated_capacity === true,
    recoverable: input.recoverable !== false
  });
}

export function normalizeRuntimeProfile(input = {}, clock = Date.now) {
  const intelligence = input.intelligence || {};
  const endpoint = input.endpoint || {};
  const planning = input.planning || {};
  const execution = input.execution || {};
  const presentation = input.presentation || {};
  const authorityInput = input.authority?.capabilities || input.authority || {};
  return Object.freeze({
    schema: 'sideways-maker-runtime-profile/v1',
    runtime_id: clean(input.runtime_id || input.id || 'unreported-runtime', 300),
    display_name: clean(input.display_name || presentation.name || 'Maker runtime', 200),
    status: choose(input.status, ['healthy', 'degraded', 'offline', 'unknown'], 'unknown'),
    intelligence: Object.freeze({
      selection: choose(intelligence.selection, ['adaptive', 'locked', 'operator', 'unknown'], 'adaptive'),
      engine_label: clean(
        intelligence.engine_label || intelligence.engine || 'best available admitted engine',
        300
      ),
      architecture: choose(
        intelligence.architecture,
        ['native', 'distilled', 'ensemble', 'remote', 'hybrid', 'unknown'],
        'unknown'
      ),
      admission: choose(
        intelligence.admission,
        ['verified', 'configured', 'unverified', 'unknown'],
        'unknown'
      ),
      capabilities: unique(intelligence.capabilities, 200)
    }),
    endpoint: Object.freeze({
      ownership: choose(endpoint.ownership, ['user', 'project', 'managed', 'hybrid', 'unknown'], 'unknown'),
      transport: choose(endpoint.transport, ['local', 'remote', 'hybrid', 'relay', 'unknown'], 'unknown'),
      locality: choose(endpoint.locality, ['local', 'remote', 'hybrid', 'private', 'unknown'], 'unknown'),
      capacity: choose(endpoint.capacity, ['dedicated', 'shared', 'burst', 'unknown'], 'unknown'),
      throttling: choose(endpoint.throttling, ['none', 'bounded', 'provider', 'unknown'], 'unknown'),
      label: clean(endpoint.label || 'runtime endpoint', 200)
    }),
    planning: Object.freeze({
      strategy: choose(
        planning.strategy,
        ['adaptive', 'recursive', 'speculative', 'swarm', 'direct', 'disabled', 'unknown'],
        'adaptive'
      ),
      scheduler: choose(planning.scheduler, ['adaptive', 'priority', 'fair', 'fixed', 'unknown'], 'adaptive'),
      parallelism: Math.round(finite(planning.parallelism, 1, 1, 1024)),
      speculation: planning.speculation === true,
      recovery: choose(planning.recovery, ['lease', 'journal', 'checkpoint', 'none', 'unknown'], 'lease'),
      confidence_threshold: finite(planning.confidence_threshold, 0.8, 0, 1)
    }),
    execution: Object.freeze({
      role: clean(execution.role || 'adaptive', 100),
      modes: unique(execution.modes || ['planner', 'implementer', 'reviewer', 'verifier'], 100),
      transport: choose(execution.transport, ['weave', 'queue', 'direct', 'relay', 'hybrid', 'unknown'], 'queue'),
      workspace: choose(execution.workspace, ['isolated', 'repository', 'container', 'remote', 'unknown'], 'isolated'),
      verification: choose(execution.verification, ['continuous', 'terminal', 'final', 'none', 'unknown'], 'continuous'),
      checkpointing: choose(execution.checkpointing, ['enabled', 'bounded', 'disabled', 'unknown'], 'enabled'),
      recovery: choose(execution.recovery, ['journaled', 'lease', 'checkpoint', 'manual', 'none', 'unknown'], 'journaled')
    }),
    authority: Object.freeze({
      capabilities: normalizeCapabilityPolicy(authorityInput, EMPTY_AUTHORITY_DEFAULTS)
    }),
    presentation: Object.freeze({
      headline: clean(presentation.headline || 'Maker is preparing your build', 300),
      activity: clean(presentation.activity || 'Selecting tools and execution capacity', 500),
      tone: choose(presentation.tone, ['quiet', 'technical', 'friendly', 'minimal'], 'friendly'),
      visible: presentation.visible !== false
    }),
    observed_at: clean(input.observed_at || now(clock), 100)
  });
}

function authorityUsable(level) {
  return ['read', 'write', 'execute', 'manage', 'reference_only', 'approval_required'].includes(level);
}

export function runtimeSatisfiesRequest(runtime, request) {
  const requirements = request.runtime_requirements || normalizeRuntimeRequirements();
  const runtimeCapabilities = new Set(runtime.intelligence.capabilities);
  if (requirements.capabilities.some(capability => !runtimeCapabilities.has(capability))) return false;
  if (requirements.execution_roles.length) {
    const roles = new Set([runtime.execution.role, ...runtime.execution.modes]);
    if (requirements.execution_roles.some(role => !roles.has(role))) return false;
  }
  if (requirements.authority.some(capability => !authorityUsable(runtime.authority.capabilities[capability] || 'none'))) {
    return false;
  }
  if (requirements.locality !== 'any' && runtime.endpoint.locality !== requirements.locality) return false;
  if (requirements.ownership !== 'any' && runtime.endpoint.ownership !== requirements.ownership) return false;
  if (requirements.dedicated_capacity && runtime.endpoint.capacity !== 'dedicated') return false;
  if (requirements.recoverable) {
    if (runtime.execution.checkpointing === 'disabled') return false;
    if (runtime.execution.recovery === 'none') return false;
  }
  return runtime.status !== 'offline';
}

export function normalizeControlRequest(input = {}) {
  const repository = clean(input.repository, 500);
  const request = clean(input.request, 12000);
  const base_revision = clean(input.base_revision || 'main', 200);
  const mode = clean(input.mode || 'build', 40).toLowerCase();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new MakerControlError('invalid_repository', 'repository must be owner/name');
  }
  if (!request) throw new MakerControlError('missing_request', 'request is required');
  if (!['build', 'fix', 'explore', 'audit'].includes(mode)) {
    throw new MakerControlError('invalid_mode', 'mode must be build, fix, explore, or audit');
  }
  const requestedCapabilities = input.authority?.capabilities || input.capability_policy || {};
  const authority = {
    branch: input.authority?.branch !== false,
    draft_pr: input.authority?.draft_pr !== false,
    merge: input.authority?.merge === true,
    deploy: input.authority?.deploy === true,
    settings: input.authority?.settings === true,
    capabilities: normalizeCapabilityPolicy(requestedCapabilities)
  };
  return Object.freeze({
    schema: 'sideways-maker-control-request/v1',
    repository,
    base_revision,
    mode,
    request,
    protect: clean(input.protect, 6000),
    proof: clean(input.proof, 6000),
    backend: clean(input.backend || 'auto', 100),
    priority: finite(input.priority, 50, 0, 100),
    idempotency_key: clean(input.idempotency_key, 300),
    runtime_requirements: normalizeRuntimeRequirements(input.runtime_requirements),
    authority: Object.freeze(authority)
  });
}

function publicRuntimeSummary(runtime) {
  if (!runtime) return null;
  return {
    runtime_id: runtime.runtime_id,
    display_name: runtime.display_name,
    status: runtime.status,
    engine: runtime.intelligence.engine_label,
    architecture: runtime.intelligence.architecture,
    endpoint: runtime.endpoint.label,
    ownership: runtime.endpoint.ownership,
    locality: runtime.endpoint.locality,
    planning: runtime.planning.strategy,
    role: runtime.execution.role,
    recovery: runtime.execution.recovery
  };
}

export function projectJobForUser(job) {
  const runtime = job.runtime;
  const capabilities = runtime?.authority?.capabilities || {};
  const active = [];
  const gated = [];
  const reference_only = [];
  for (const [name, level] of Object.entries(capabilities)) {
    if (level === 'approval_required') gated.push(name);
    else if (level === 'reference_only') reference_only.push(name);
    else if (level !== 'none') active.push({ name, level });
  }
  const statusCopy = {
    queued: 'Queued and waiting for compatible compute',
    running: runtime?.presentation?.activity || 'Maker is working',
    completed: 'Your build is ready for inspection',
    failed: job.error?.recoverable ? 'Paused after a recoverable failure' : 'Stopped after a failure',
    cancelled: 'Stopped by the operator'
  };
  return Object.freeze({
    schema: 'sideways-maker-public-runtime/v1',
    job_id: job.id,
    revision: job.revision,
    state: job.state,
    headline: runtime?.presentation?.headline || 'Maker is preparing your build',
    activity: statusCopy[job.state] || 'Maker status unavailable',
    engine: runtime ? {
      label: runtime.intelligence.engine_label,
      selection: runtime.intelligence.selection,
      architecture: runtime.intelligence.architecture,
      admission: runtime.intelligence.admission,
      capabilities: runtime.intelligence.capabilities
    } : null,
    planning: runtime ? {
      strategy: runtime.planning.strategy,
      scheduler: runtime.planning.scheduler,
      parallelism: runtime.planning.parallelism,
      speculation: runtime.planning.speculation
    } : null,
    execution: runtime ? {
      role: runtime.execution.role,
      modes: runtime.execution.modes,
      workspace: runtime.execution.workspace,
      verification: runtime.execution.verification,
      transport: runtime.execution.transport
    } : null,
    authority: {
      active,
      gated,
      reference_only,
      requested: job.request.authority.capabilities
    },
    recovery: {
      recoverable: runtime
        ? runtime.execution.checkpointing !== 'disabled' && runtime.execution.recovery !== 'none'
        : true,
      mode: runtime?.execution?.recovery || 'lease',
      checkpointing: runtime?.execution?.checkpointing || 'pending',
      lease_expires_at: job.lease?.expires_at || null
    },
    links: {
      repository: job.request.repository,
      branch: clean(job.result?.branch, 300) || null,
      pull_request: clean(job.result?.pull_request, 500) || null,
      run: clean(job.result?.run, 500) || null
    },
    receipt: {
      request_digest: job.request_digest,
      runtime_id: runtime?.runtime_id || null,
      updated_at: job.updated_at
    }
  });
}

export function createMemoryControlStore(seed = {}) {
  const jobs = new Map(seed.jobs || []);
  const events = Array.isArray(seed.events) ? [...seed.events] : [];
  return {
    async getJob(id) { return jobs.get(id) || null; },
    async putJob(job) { jobs.set(job.id, structuredClone(job)); return job; },
    async listJobs() { return [...jobs.values()].map(value => structuredClone(value)); },
    async appendEvent(event) { events.push(structuredClone(event)); return event; },
    async listEvents(after = 0) { return events.filter(event => event.sequence > after).map(value => structuredClone(value)); },
    async snapshot() { return { jobs: [...jobs.entries()], events: structuredClone(events) }; }
  };
}

export function createMakerControlPlane({
  store = createMemoryControlStore(),
  clock = Date.now,
  id = randomUUID,
  lease_ms = 5 * 60 * 1000,
  max_jobs = 1000,
  max_events = 10000
} = {}) {
  let sequence = 0;
  let initialized = false;

  async function initialize() {
    if (initialized) return;
    const events = await store.listEvents(0);
    sequence = events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), 0);
    initialized = true;
  }

  async function emit(type, job, detail = {}) {
    await initialize();
    const event = Object.freeze({
      schema: 'sideways-maker-control-event/v1',
      sequence: ++sequence,
      event_id: id(),
      job_id: job.id,
      type,
      at: now(clock),
      state: job.state,
      revision: job.revision,
      detail
    });
    const all = await store.listEvents(0);
    if (all.length >= max_events) throw new MakerControlError('event_capacity', 'event capacity reached', 503);
    await store.appendEvent(event);
    return event;
  }

  async function submit(input) {
    await initialize();
    const request = normalizeControlRequest(input);
    const jobs = await store.listJobs();
    if (jobs.length >= max_jobs) throw new MakerControlError('job_capacity', 'job capacity reached', 503);
    if (request.idempotency_key) {
      const existing = jobs.find(job => job.request.idempotency_key === request.idempotency_key);
      if (existing) {
        if (existing.request_digest !== digest(request)) {
          throw new MakerControlError('idempotency_conflict', 'idempotency key already represents another request', 409);
        }
        return existing;
      }
    }
    const stamp = now(clock);
    const job = {
      schema: 'sideways-maker-control-job/v1',
      id: id(),
      state: 'queued',
      revision: 1,
      request,
      request_digest: digest(request),
      created_at: stamp,
      updated_at: stamp,
      lease: null,
      runtime: null,
      result: null,
      error: null
    };
    await store.putJob(job);
    await emit('job.queued', job, {
      priority: request.priority,
      runtime_requirements: request.runtime_requirements
    });
    return structuredClone(job);
  }

  async function get(jobId) {
    const job = await store.getJob(clean(jobId, 200));
    if (!job) throw new MakerControlError('job_not_found', 'job not found', 404);
    return structuredClone(job);
  }

  async function view(jobId) {
    return projectJobForUser(await get(jobId));
  }

  async function claim(worker = {}) {
    await initialize();
    const worker_id = clean(worker.worker_id, 300);
    if (!worker_id) throw new MakerControlError('missing_worker', 'worker_id is required');
    const runtime = normalizeRuntimeProfile(
      worker.runtime || {
        runtime_id: worker_id,
        display_name: 'Unreported runtime',
        status: 'unknown',
        intelligence: { engine_label: 'unreported engine', admission: 'unknown' },
        presentation: { activity: 'A compatible legacy worker is active' }
      },
      clock
    );
    const stamp = clock();
    const jobs = (await store.listJobs())
      .filter(job => job.state === 'queued' || (job.state === 'running' && Date.parse(job.lease?.expires_at || 0) <= stamp))
      .filter(job => !worker.repository || job.request.repository === worker.repository)
      .filter(job => runtimeSatisfiesRequest(runtime, job.request))
      .sort((a, b) => b.request.priority - a.request.priority || a.created_at.localeCompare(b.created_at));
    const job = jobs[0];
    if (!job) return null;
    const recovered = job.state === 'running';
    job.state = 'running';
    job.revision += 1;
    job.updated_at = now(clock);
    job.runtime = runtime;
    job.lease = {
      worker_id,
      token: id(),
      claimed_at: now(clock),
      expires_at: new Date(clock() + lease_ms).toISOString(),
      runtime_id: runtime.runtime_id
    };
    await store.putJob(job);
    await emit(recovered ? 'job.recovered' : 'job.claimed', job, {
      worker_id,
      runtime: publicRuntimeSummary(runtime)
    });
    return structuredClone(job);
  }

  async function mutate(jobId, leaseToken, transition, payload = {}) {
    const job = await get(jobId);
    if (job.state !== 'running') throw new MakerControlError('invalid_state', 'job is not running', 409);
    if (!job.lease || job.lease.token !== clean(leaseToken, 300)) {
      throw new MakerControlError('lease_mismatch', 'active lease token is required', 409);
    }
    if (Date.parse(job.lease.expires_at) <= clock()) {
      throw new MakerControlError('lease_expired', 'lease expired', 409);
    }
    if (transition === 'heartbeat') {
      job.lease.expires_at = new Date(clock() + lease_ms).toISOString();
    } else if (transition === 'complete') {
      job.state = 'completed';
      job.result = structuredClone(payload);
      job.lease = null;
    } else if (transition === 'fail') {
      job.state = 'failed';
      job.error = {
        code: clean(payload.code || 'worker_failed', 100),
        message: clean(payload.message, 4000),
        recoverable: payload.recoverable === true
      };
      job.lease = null;
    } else {
      throw new MakerControlError('invalid_transition', 'unsupported transition');
    }
    job.revision += 1;
    job.updated_at = now(clock);
    await store.putJob(job);
    await emit(
      `job.${transition === 'heartbeat' ? 'heartbeat' : job.state}`,
      job,
      transition === 'heartbeat'
        ? { worker_id: job.lease.worker_id, runtime_id: job.runtime?.runtime_id || null }
        : payload
    );
    return structuredClone(job);
  }

  async function cancel(jobId, reason = '') {
    const job = await get(jobId);
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return job;
    job.state = 'cancelled';
    job.revision += 1;
    job.updated_at = now(clock);
    job.lease = null;
    job.error = {
      code: 'cancelled',
      message: clean(reason || 'cancelled by operator', 2000),
      recoverable: false
    };
    await store.putJob(job);
    await emit('job.cancelled', job, { reason: job.error.message });
    return structuredClone(job);
  }

  return Object.freeze({
    submit,
    get,
    view,
    claim,
    heartbeat: (jobId, token) => mutate(jobId, token, 'heartbeat'),
    complete: (jobId, token, result) => mutate(jobId, token, 'complete', result),
    fail: (jobId, token, error) => mutate(jobId, token, 'fail', error),
    cancel,
    events: after => store.listEvents(Number(after) || 0),
    snapshot: () => store.snapshot()
  });
}

export function createControlHttpHandler(control) {
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);
      const body = ['POST', 'PUT', 'PATCH'].includes(request.method)
        ? await request.json().catch(() => ({}))
        : {};
      let value;
      if (request.method === 'POST' && url.pathname === '/v1/jobs') value = await control.submit(body);
      else if (request.method === 'POST' && url.pathname === '/v1/claims') value = await control.claim(body);
      else if (request.method === 'GET' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[2] && parts[3] === 'presentation') {
        value = await control.view(parts[2]);
      } else if (request.method === 'GET' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[2]) {
        value = await control.get(parts[2]);
      } else if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'heartbeat') {
        value = await control.heartbeat(parts[2], body.lease_token);
      } else if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'complete') {
        value = await control.complete(parts[2], body.lease_token, body.result || {});
      } else if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'fail') {
        value = await control.fail(parts[2], body.lease_token, body.error || {});
      } else if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'cancel') {
        value = await control.cancel(parts[2], body.reason);
      } else if (request.method === 'GET' && url.pathname === '/v1/events') {
        value = await control.events(url.searchParams.get('after'));
      } else {
        throw new MakerControlError('not_found', 'route not found', 404);
      }
      return Response.json(value, { status: 200 });
    } catch (error) {
      const status = error instanceof MakerControlError ? error.status : 500;
      return Response.json({
        error: {
          code: error.code || 'internal_error',
          message: clean(error.message, 2000)
        }
      }, { status });
    }
  };
}
