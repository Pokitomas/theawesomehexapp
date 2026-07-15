#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const now = clock => new Date(clock()).toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class MakerControlError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MakerControlError';
    this.code = code;
    this.status = status;
  }
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
  const authority = {
    branch: input.authority?.branch !== false,
    draft_pr: input.authority?.draft_pr !== false,
    merge: input.authority?.merge === true,
    deploy: input.authority?.deploy === true,
    settings: input.authority?.settings === true
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
    priority: Math.max(0, Math.min(100, Number(input.priority ?? 50))),
    idempotency_key: clean(input.idempotency_key, 300),
    authority
  });
}

export function createMemoryControlStore(seed = {}) {
  const jobs = new Map(seed.jobs || []);
  const events = Array.isArray(seed.events) ? [...seed.events] : [];
  return {
    async getJob(id) { return jobs.get(id) || null; },
    async putJob(job) { jobs.set(job.id, structuredClone(job)); return job; },
    async listJobs() { return [...jobs.values()].map(structuredClone); },
    async appendEvent(event) { events.push(structuredClone(event)); return event; },
    async listEvents(after = 0) { return events.filter(event => event.sequence > after).map(structuredClone); },
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
      result: null,
      error: null
    };
    await store.putJob(job);
    await emit('job.queued', job, { priority: request.priority });
    return structuredClone(job);
  }

  async function get(jobId) {
    const job = await store.getJob(clean(jobId, 200));
    if (!job) throw new MakerControlError('job_not_found', 'job not found', 404);
    return structuredClone(job);
  }

  async function claim(worker = {}) {
    await initialize();
    const worker_id = clean(worker.worker_id, 300);
    if (!worker_id) throw new MakerControlError('missing_worker', 'worker_id is required');
    const stamp = clock();
    const jobs = (await store.listJobs())
      .filter(job => job.state === 'queued' || (job.state === 'running' && Date.parse(job.lease?.expires_at || 0) <= stamp))
      .filter(job => !worker.repository || job.request.repository === worker.repository)
      .sort((a, b) => b.request.priority - a.request.priority || a.created_at.localeCompare(b.created_at));
    const job = jobs[0];
    if (!job) return null;
    const recovered = job.state === 'running';
    job.state = 'running';
    job.revision += 1;
    job.updated_at = now(clock);
    job.lease = {
      worker_id,
      token: id(),
      claimed_at: now(clock),
      expires_at: new Date(clock() + lease_ms).toISOString()
    };
    await store.putJob(job);
    await emit(recovered ? 'job.recovered' : 'job.claimed', job, { worker_id });
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
      job.error = { code: clean(payload.code || 'worker_failed', 100), message: clean(payload.message, 4000), recoverable: payload.recoverable === true };
      job.lease = null;
    } else {
      throw new MakerControlError('invalid_transition', 'unsupported transition');
    }
    job.revision += 1;
    job.updated_at = now(clock);
    await store.putJob(job);
    await emit(`job.${transition === 'heartbeat' ? 'heartbeat' : job.state}`, job, transition === 'heartbeat' ? { worker_id: job.lease.worker_id } : payload);
    return structuredClone(job);
  }

  async function cancel(jobId, reason = '') {
    const job = await get(jobId);
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return job;
    job.state = 'cancelled';
    job.revision += 1;
    job.updated_at = now(clock);
    job.lease = null;
    job.error = { code: 'cancelled', message: clean(reason || 'cancelled by operator', 2000), recoverable: false };
    await store.putJob(job);
    await emit('job.cancelled', job, { reason: job.error.message });
    return structuredClone(job);
  }

  return Object.freeze({
    submit,
    get,
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
      const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await request.json().catch(() => ({})) : {};
      let value;
      if (request.method === 'POST' && url.pathname === '/v1/jobs') value = await control.submit(body);
      else if (request.method === 'POST' && url.pathname === '/v1/claims') value = await control.claim(body);
      else if (request.method === 'GET' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[2]) value = await control.get(parts[2]);
      else if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'heartbeat') value = await control.heartbeat(parts[2], body.lease_token);
      else if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'complete') value = await control.complete(parts[2], body.lease_token, body.result || {});
      else if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'fail') value = await control.fail(parts[2], body.lease_token, body.error || {});
      else if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'cancel') value = await control.cancel(parts[2], body.reason);
      else if (request.method === 'GET' && url.pathname === '/v1/events') value = await control.events(url.searchParams.get('after'));
      else throw new MakerControlError('not_found', 'route not found', 404);
      return Response.json(value, { status: 200 });
    } catch (error) {
      const status = error instanceof MakerControlError ? error.status : 500;
      return Response.json({ error: { code: error.code || 'internal_error', message: clean(error.message, 2000) } }, { status });
    }
  };
}
