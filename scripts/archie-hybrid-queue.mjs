import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ARCHIE_HYBRID_QUEUE_SCHEMA = 'archie-hybrid-queue/v1';
export const ARCHIE_HYBRID_EVENT_SCHEMA = 'archie-hybrid-event/v1';

function clean(value, limit = 20_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function identifier(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function iso(value) {
  return new Date(value).toISOString();
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HybridQueueError('invalid_argument', `${label} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function capabilityList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => clean(item, 100).toLowerCase()).filter(Boolean))].sort().slice(0, 64);
}

function clone(value) {
  return structuredClone(value);
}

export class HybridQueueError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'HybridQueueError';
    this.code = code;
    this.status = status;
  }
}

function unsignedEvent(event) {
  const { event_digest: _eventDigest, ...value } = event;
  return value;
}

export function verifyHybridEvents(events) {
  if (!Array.isArray(events)) throw new HybridQueueError('event_stream_invalid', 'Hybrid event stream must be an array.');
  let previous = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.schema !== ARCHIE_HYBRID_EVENT_SCHEMA) throw new HybridQueueError('event_schema_invalid', 'Hybrid event schema is invalid.');
    if (event.sequence !== index + 1) throw new HybridQueueError('event_sequence_invalid', 'Hybrid event sequence is invalid.');
    if (event.previous_event_digest !== previous) throw new HybridQueueError('event_chain_invalid', 'Hybrid event chain is broken.');
    if (event.event_digest !== digest(unsignedEvent(event))) throw new HybridQueueError('event_digest_invalid', 'Hybrid event digest is invalid.');
    previous = event.event_digest;
  }
  return Object.freeze({ event_count: events.length, head_digest: previous });
}

function initialState() {
  return { schema: ARCHIE_HYBRID_QUEUE_SCHEMA, jobs: {}, event_count: 0, head_digest: null };
}

function reduceEvents(events) {
  const state = initialState();
  for (const event of events) {
    const payload = event.payload || {};
    const jobId = payload.job_id;
    if (event.type === 'job.submitted') {
      state.jobs[jobId] = {
        schema: 'archie-hybrid-job/v1',
        job_id: jobId,
        kind: payload.kind,
        objective: payload.objective,
        requested_change: payload.requested_change,
        approve: payload.approve,
        visibility: payload.visibility,
        required_capabilities: payload.required_capabilities,
        max_attempts: payload.max_attempts,
        state: 'pending',
        attempt: 0,
        fencing_token: 0,
        lease: null,
        result: null,
        failure: null,
        submitted_at: event.occurred_at,
        updated_at: event.occurred_at
      };
    } else if (event.type === 'lease.claimed') {
      const job = state.jobs[jobId];
      if (!job) continue;
      job.state = 'leased';
      job.attempt = payload.attempt;
      job.fencing_token = payload.fencing_token;
      job.lease = {
        lease_id: payload.lease_id,
        runner_id: payload.runner_id,
        fencing_token: payload.fencing_token,
        claimed_at: event.occurred_at,
        expires_at: payload.expires_at
      };
      job.failure = null;
      job.updated_at = event.occurred_at;
    } else if (event.type === 'lease.heartbeat') {
      const job = state.jobs[jobId];
      if (!job?.lease) continue;
      job.lease.expires_at = payload.expires_at;
      job.updated_at = event.occurred_at;
    } else if (event.type === 'lease.expired') {
      const job = state.jobs[jobId];
      if (!job) continue;
      job.state = job.attempt >= job.max_attempts ? 'failed' : 'pending';
      job.failure = { code: 'lease_expired', message: 'The runner lease expired before terminal completion.', retryable: job.state === 'pending' };
      job.lease = null;
      job.updated_at = event.occurred_at;
    } else if (event.type === 'job.completed') {
      const job = state.jobs[jobId];
      if (!job) continue;
      job.state = 'completed';
      job.result = payload.result;
      job.failure = null;
      job.lease = null;
      job.updated_at = event.occurred_at;
    } else if (event.type === 'job.failed') {
      const job = state.jobs[jobId];
      if (!job) continue;
      job.state = payload.requeue ? 'pending' : 'failed';
      job.failure = payload.failure;
      job.lease = null;
      job.updated_at = event.occurred_at;
    } else if (event.type === 'job.cancelled') {
      const job = state.jobs[jobId];
      if (!job) continue;
      job.state = 'cancelled';
      job.failure = { code: 'cancelled', message: payload.reason || 'Cancelled by founder.', retryable: false };
      job.lease = null;
      job.updated_at = event.occurred_at;
    }
    state.event_count = event.sequence;
    state.head_digest = event.event_digest;
  }
  return state;
}

function publicJob(job) {
  return clone(job);
}

export class HybridQueue {
  constructor({ root, clock = () => new Date(), randomId = identifier } = {}) {
    this.root = path.resolve(root);
    this.eventsFile = path.join(this.root, 'events.jsonl');
    this.clock = clock;
    this.randomId = randomId;
    this.events = [];
    this.state = initialState();
    this.serial = Promise.resolve();
  }

  static async open(options = {}) {
    const queue = new HybridQueue(options);
    await fs.mkdir(queue.root, { recursive: true, mode: 0o700 });
    let source = '';
    try {
      source = await fs.readFile(queue.eventsFile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    queue.events = source.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    verifyHybridEvents(queue.events);
    queue.state = reduceEvents(queue.events);
    return queue;
  }

  async mutate(operation) {
    const next = this.serial.then(operation, operation);
    this.serial = next.catch(() => {});
    return next;
  }

  async append(type, payload) {
    const occurredAt = iso(this.clock());
    const body = {
      schema: ARCHIE_HYBRID_EVENT_SCHEMA,
      sequence: this.events.length + 1,
      previous_event_digest: this.events.at(-1)?.event_digest || null,
      type,
      occurred_at: occurredAt,
      payload: clone(payload)
    };
    const event = Object.freeze({ ...body, event_digest: digest(body) });
    await fs.appendFile(this.eventsFile, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.events.push(event);
    this.state = reduceEvents(this.events);
    return event;
  }

  async reapExpired() {
    const now = new Date(this.clock()).getTime();
    const expired = Object.values(this.state.jobs)
      .filter(job => job.state === 'leased' && Date.parse(job.lease?.expires_at || 0) <= now)
      .sort((left, right) => left.job_id.localeCompare(right.job_id));
    for (const job of expired) {
      await this.append('lease.expired', {
        job_id: job.job_id,
        lease_id: job.lease.lease_id,
        runner_id: job.lease.runner_id,
        fencing_token: job.lease.fencing_token
      });
    }
  }

  async submit(input = {}) {
    return this.mutate(async () => {
      const objective = clean(input.objective, 8_000);
      const requestedChange = clean(input.requested_change, 4_000);
      if (!objective) throw new HybridQueueError('objective_required', 'Hybrid job requires an objective.');
      if (!requestedChange) throw new HybridQueueError('requested_change_required', 'Hybrid job requires an explicit requested change.');
      if (input.approve !== true) throw new HybridQueueError('approval_required', 'Hybrid job requires explicit approval before execution.');
      const visibility = clean(input.visibility || 'private', 40);
      if (!['public', 'private', 'locally_sealed'].includes(visibility)) throw new HybridQueueError('visibility_invalid', 'Hybrid job visibility is invalid.');
      const jobId = this.randomId('hybrid_job');
      await this.append('job.submitted', {
        job_id: jobId,
        kind: 'standalone_product_journey',
        objective,
        requested_change: requestedChange,
        approve: true,
        visibility,
        required_capabilities: capabilityList(input.required_capabilities?.length ? input.required_capabilities : ['maker', 'portable_workspace']),
        max_attempts: integer(input.max_attempts ?? 3, 'max_attempts', { min: 1, max: 10 })
      });
      return publicJob(this.state.jobs[jobId]);
    });
  }

  async lease({ runner_id, capabilities = [], ttl_ms = 120_000 } = {}) {
    return this.mutate(async () => {
      await this.reapExpired();
      const runnerId = clean(runner_id, 160);
      if (!/^[a-zA-Z0-9_.-]{3,160}$/.test(runnerId)) throw new HybridQueueError('runner_id_invalid', 'runner_id is invalid.');
      const provided = new Set(capabilityList(capabilities));
      const job = Object.values(this.state.jobs)
        .filter(candidate => candidate.state === 'pending' && candidate.required_capabilities.every(item => provided.has(item)))
        .sort((left, right) => left.submitted_at.localeCompare(right.submitted_at) || left.job_id.localeCompare(right.job_id))[0];
      if (!job) return null;
      const ttl = integer(ttl_ms, 'ttl_ms', { min: 5_000, max: 30 * 60_000 });
      const fencingToken = job.fencing_token + 1;
      const leaseId = this.randomId('hybrid_lease');
      await this.append('lease.claimed', {
        job_id: job.job_id,
        lease_id: leaseId,
        runner_id: runnerId,
        fencing_token: fencingToken,
        attempt: job.attempt + 1,
        expires_at: iso(new Date(this.clock()).getTime() + ttl)
      });
      return publicJob(this.state.jobs[job.job_id]);
    });
  }

  assertLease(jobId, lease = {}) {
    const job = this.state.jobs[jobId];
    if (!job) throw new HybridQueueError('job_not_found', 'Hybrid job was not found.', 404);
    if (job.state !== 'leased' || !job.lease) throw new HybridQueueError('lease_not_active', 'Hybrid job does not have an active lease.', 409);
    if (
      job.lease.lease_id !== clean(lease.lease_id, 160)
      || job.lease.runner_id !== clean(lease.runner_id, 160)
      || job.lease.fencing_token !== integer(lease.fencing_token, 'fencing_token', { min: 1 })
    ) throw new HybridQueueError('stale_lease', 'Hybrid lease is stale or does not match the current fencing token.', 409);
    if (Date.parse(job.lease.expires_at) <= new Date(this.clock()).getTime()) throw new HybridQueueError('lease_expired', 'Hybrid lease has expired.', 409);
    return job;
  }

  async heartbeat(jobId, lease = {}, ttlMs = 120_000) {
    return this.mutate(async () => {
      this.assertLease(jobId, lease);
      const ttl = integer(ttlMs, 'ttl_ms', { min: 5_000, max: 30 * 60_000 });
      await this.append('lease.heartbeat', {
        job_id: jobId,
        lease_id: lease.lease_id,
        runner_id: lease.runner_id,
        fencing_token: lease.fencing_token,
        expires_at: iso(new Date(this.clock()).getTime() + ttl)
      });
      return publicJob(this.state.jobs[jobId]);
    });
  }

  async complete(jobId, lease = {}, result = {}) {
    return this.mutate(async () => {
      this.assertLease(jobId, lease);
      const normalized = {
        schema: 'archie-hybrid-result/v1',
        workspace_id: clean(result.workspace_id, 160),
        bundle_digest: clean(result.bundle_digest, 80).toLowerCase(),
        head_digest: clean(result.head_digest, 80).toLowerCase(),
        event_count: integer(result.event_count, 'event_count', { min: 1 }),
        artifact_count: integer(result.artifact_count ?? 0, 'artifact_count', { min: 0 }),
        completed_by_runner: clean(lease.runner_id, 160),
        claim_boundary: clean(result.claim_boundary || 'The hybrid runner completed a bounded local Archie journey and returned an integrity-checked portable workspace. No model, device, deployment, or customer-value claim is implied.', 2_000)
      };
      if (!normalized.workspace_id || !/^[a-f0-9]{64}$/.test(normalized.bundle_digest) || !/^[a-f0-9]{64}$/.test(normalized.head_digest)) {
        throw new HybridQueueError('result_invalid', 'Hybrid completion result has invalid workspace or digest identity.');
      }
      await this.append('job.completed', {
        job_id: jobId,
        lease_id: lease.lease_id,
        runner_id: lease.runner_id,
        fencing_token: lease.fencing_token,
        result: normalized
      });
      return publicJob(this.state.jobs[jobId]);
    });
  }

  async fail(jobId, lease = {}, failure = {}) {
    return this.mutate(async () => {
      const job = this.assertLease(jobId, lease);
      const retryable = failure.retryable !== false && job.attempt < job.max_attempts;
      await this.append('job.failed', {
        job_id: jobId,
        lease_id: lease.lease_id,
        runner_id: lease.runner_id,
        fencing_token: lease.fencing_token,
        requeue: retryable,
        failure: {
          code: clean(failure.code || 'runner_failed', 100),
          message: clean(failure.message || 'Hybrid runner failed.', 2_000),
          retryable
        }
      });
      return publicJob(this.state.jobs[jobId]);
    });
  }

  async cancel(jobId, reason = '') {
    return this.mutate(async () => {
      const job = this.state.jobs[jobId];
      if (!job) throw new HybridQueueError('job_not_found', 'Hybrid job was not found.', 404);
      if (['completed', 'cancelled'].includes(job.state)) throw new HybridQueueError('job_terminal', 'Hybrid job is already terminal.', 409);
      await this.append('job.cancelled', { job_id: jobId, reason: clean(reason || 'Cancelled by founder.', 2_000) });
      return publicJob(this.state.jobs[jobId]);
    });
  }

  async inspect(jobId) {
    return this.mutate(async () => {
      await this.reapExpired();
      const job = this.state.jobs[jobId];
      if (!job) throw new HybridQueueError('job_not_found', 'Hybrid job was not found.', 404);
      return publicJob(job);
    });
  }

  async snapshot() {
    return this.mutate(async () => {
      await this.reapExpired();
      const jobs = Object.values(this.state.jobs).sort((left, right) => right.submitted_at.localeCompare(left.submitted_at));
      return Object.freeze({
        schema: ARCHIE_HYBRID_QUEUE_SCHEMA,
        event_count: this.state.event_count,
        head_digest: this.state.head_digest,
        job_count: jobs.length,
        counts: Object.fromEntries(['pending', 'leased', 'completed', 'failed', 'cancelled'].map(state => [state, jobs.filter(job => job.state === state).length])),
        jobs: jobs.map(publicJob)
      });
    });
  }
}
