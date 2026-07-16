import crypto from 'node:crypto';

const WORKER_SCHEMA = 'archie-compute-worker/v1';
const TASK_SCHEMA = 'archie-compute-task/v1';
const PLACEMENT_SCHEMA = 'archie-compute-placement/v1';
const RECEIPT_SCHEMA = 'archie-compute-receipt/v1';
const WORKER_TYPES = new Set(['local-cpu', 'local-cuda', 'local-rocm', 'local-metal', 'wsl-cpu', 'github-hosted-cpu', 'self-hosted', 'remote-http', 'burst-gpu']);
const ACCELERATORS = new Set(['none', 'cuda', 'rocm', 'metal']);
const PRIVACY = Object.freeze({ public: 0, personal: 1, private: 2, restricted: 3 });
const LOCALITY = Object.freeze({ remote: 0, regional: 1, 'same-country': 2, 'local-network': 3, 'local-device': 4 });
const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential|endpoint|url)/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|https?:\/\/[^\s"'<>]+)\b/gi;

const clean = (value, limit = 100000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const nowISO = () => new Date().toISOString();
const sortedUnique = values => [...new Set(values)].sort();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

export function redact(value, depth = 0) {
  if (depth > 18) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 10000).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 10000).map(([key, child]) => [
      clean(key, 500),
      SECRET_KEY.test(key) ? '[redacted]' : redact(child, depth + 1)
    ]));
  }
  if (typeof value === 'string') return clean(value.replace(SECRET_TEXT, '[redacted]'));
  return value;
}

function observedNumber(value, name, { minimum = 0, allowNull = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new Error(`Observed ${name} is required.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new Error(`Observed ${name} is invalid.`);
  return number;
}

function normalizeEvidence(input, name) {
  if (!input || typeof input !== 'object') return Object.freeze({ state: 'unknown', value: null, evidence: null });
  const state = clean(input.state || 'unknown', 40).toLowerCase();
  if (!['observed', 'configured', 'unknown', 'unavailable'].includes(state)) throw new Error(`Invalid ${name} evidence state.`);
  return Object.freeze({ state, value: input.value ?? null, evidence: clean(redact(input.evidence), 1000) || null });
}

function normalizeAttestation(input = {}, publicDescriptor) {
  const state = clean(input.state || 'unverified', 40).toLowerCase();
  if (!['verified', 'human-approved', 'unverified'].includes(state)) throw new Error('Invalid compute attestation state.');
  const issuedBy = clean(input.issued_by, 300) || null;
  const observedAt = clean(input.observed_at, 100) || null;
  const body = { worker_id: publicDescriptor.worker_id, type: publicDescriptor.type, state, issued_by: issuedBy, observed_at: observedAt, descriptor_digest: digest(publicDescriptor) };
  const expected = digest(body);
  if (state !== 'unverified' && (!issuedBy || !observedAt)) throw new Error('Verified compute attestation requires issuer and observation time.');
  if (state !== 'unverified' && input.attestation_digest && input.attestation_digest !== expected) throw new Error('Compute worker attestation digest mismatch.');
  return Object.freeze({ ...body, attestation_digest: expected });
}

export function normalizeWorker(input = {}) {
  const workerId = clean(input.worker_id || input.id, 200);
  const type = clean(input.type, 100).toLowerCase();
  if (!workerId || !/^[A-Za-z0-9._:-]+$/.test(workerId)) throw new Error('Compute worker ID is invalid.');
  if (!WORKER_TYPES.has(type)) throw new Error(`Unsupported compute worker type: ${type || '(empty)'}.`);
  const accelerator = clean(input.accelerator || (type.includes('cuda') || type === 'burst-gpu' ? 'cuda' : type.includes('rocm') ? 'rocm' : type.includes('metal') ? 'metal' : 'none'), 40).toLowerCase();
  if (!ACCELERATORS.has(accelerator)) throw new Error('Unsupported compute accelerator.');
  const publicDescriptor = {
    schema: WORKER_SCHEMA,
    worker_id: workerId,
    type,
    os: clean(input.os || (type.startsWith('local-') || type === 'self-hosted' ? 'unknown' : type.startsWith('wsl') ? 'linux-wsl' : 'linux'), 100),
    architecture: clean(input.architecture || 'unknown', 100),
    accelerator,
    accelerator_count: observedNumber(input.accelerator_count ?? (accelerator === 'none' ? 0 : null), 'accelerator_count'),
    vram_mb: observedNumber(input.vram_mb, 'vram_mb'),
    memory_mb: observedNumber(input.memory_mb, 'memory_mb'),
    disk_mb: observedNumber(input.disk_mb, 'disk_mb'),
    max_duration_ms: observedNumber(input.max_duration_ms, 'max_duration_ms'),
    concurrency: Math.max(1, Math.min(1000, Number(input.concurrency || 1))),
    active: Math.max(0, Number(input.active || 0)),
    capabilities: sortedUnique((input.capabilities || []).map(value => clean(value, 160)).filter(Boolean)),
    checkpoint_formats: sortedUnique((input.checkpoint_formats || []).map(value => clean(value, 100)).filter(Boolean)),
    corpus_pack_versions: sortedUnique((input.corpus_pack_versions || [1]).map(Number).filter(value => Number.isInteger(value) && value > 0)),
    privacy: clean(input.privacy || 'public', 40).toLowerCase(),
    locality: clean(input.locality || 'remote', 40).toLowerCase(),
    region: clean(input.region || 'unknown', 100).toLowerCase(),
    cost_per_hour_usd: observedNumber(input.cost_per_hour_usd, 'cost_per_hour_usd'),
    latency_ms: observedNumber(input.latency_ms, 'latency_ms'),
    reliability: input.reliability === undefined ? null : Math.max(0, Math.min(1, Number(input.reliability))),
    health: normalizeEvidence(input.health, 'health'),
    availability: normalizeEvidence(input.availability, 'availability'),
    adapter: clean(input.adapter || type, 120),
    endpoint_digest: clean(input.endpoint_digest, 64) || null,
    observed_at: clean(input.observed_at, 100) || null
  };
  if (!Object.hasOwn(PRIVACY, publicDescriptor.privacy)) throw new Error('Invalid compute privacy class.');
  if (!Object.hasOwn(LOCALITY, publicDescriptor.locality)) throw new Error('Invalid compute locality class.');
  if (publicDescriptor.accelerator === 'none' && publicDescriptor.vram_mb !== null && publicDescriptor.vram_mb !== 0) throw new Error('CPU-only worker cannot claim accelerator VRAM.');
  const attestation = normalizeAttestation(input.attestation || {}, publicDescriptor);
  const body = { ...publicDescriptor, attestation };
  return Object.freeze({ ...body, worker_digest: digest(body) });
}

export function normalizeComputeTask(input = {}) {
  const taskId = clean(input.task_id || `task_${digest(input).slice(0, 20)}`, 200);
  const kind = clean(input.kind || 'sparse-infer', 100).toLowerCase();
  if (!['sparse-infer', 'sparse-train', 'neural-distill', 'evaluate', 'pack-transfer'].includes(kind)) throw new Error(`Unsupported compute task kind: ${kind}.`);
  const accelerator = clean(input.accelerator || 'any', 40).toLowerCase();
  if (!['any', ...ACCELERATORS].includes(accelerator)) throw new Error('Invalid task accelerator requirement.');
  const privacy = clean(input.privacy || 'personal', 40).toLowerCase();
  const minimumLocality = clean(input.minimum_locality || 'remote', 40).toLowerCase();
  if (!Object.hasOwn(PRIVACY, privacy) || !Object.hasOwn(LOCALITY, minimumLocality)) throw new Error('Invalid task privacy or locality requirement.');
  const body = {
    schema: TASK_SCHEMA,
    task_id: taskId,
    kind,
    required_capabilities: sortedUnique((input.required_capabilities || []).map(value => clean(value, 160)).filter(Boolean)),
    architecture: clean(input.architecture || 'any', 100),
    accelerator,
    minimum_vram_mb: Math.max(0, Number(input.minimum_vram_mb || 0)),
    minimum_memory_mb: Math.max(0, Number(input.minimum_memory_mb || 0)),
    minimum_disk_mb: Math.max(0, Number(input.minimum_disk_mb || 0)),
    max_duration_ms: input.max_duration_ms === undefined ? null : Math.max(1, Number(input.max_duration_ms)),
    privacy,
    minimum_locality: minimumLocality,
    allowed_regions: sortedUnique((input.allowed_regions || []).map(value => clean(value, 100).toLowerCase()).filter(Boolean)),
    checkpoint_format: clean(input.checkpoint_format, 100) || null,
    corpus_pack_version: Math.max(1, Number(input.corpus_pack_version || 1)),
    max_cost_usd: input.max_cost_usd === undefined ? null : Math.max(0, Number(input.max_cost_usd)),
    allow_unknown_cost: input.allow_unknown_cost === true,
    prefer_local: input.prefer_local !== false,
    retries: Math.max(0, Math.min(8, Number(input.retries ?? 1))),
    timeout_ms: Math.max(100, Math.min(24 * 60 * 60 * 1000, Number(input.timeout_ms || 120000))),
    payload_digest: clean(input.payload_digest, 64) || null,
    requested_at: clean(input.requested_at, 100) || null
  };
  return Object.freeze({ ...body, task_digest: digest(body) });
}

function hardMatch(worker, task) {
  const reasons = [];
  if (!['verified', 'human-approved'].includes(worker.attestation.state)) reasons.push('worker identity is unverified');
  if (worker.availability.state !== 'observed' || worker.availability.value !== true) reasons.push('worker availability is not observed true');
  if (worker.health.state !== 'observed' || worker.health.value !== 'healthy') reasons.push('worker health is not observed healthy');
  if (worker.active >= worker.concurrency) reasons.push('worker concurrency is exhausted');
  if (task.architecture !== 'any' && worker.architecture !== task.architecture) reasons.push('architecture mismatch');
  if (task.accelerator !== 'any' && worker.accelerator !== task.accelerator) reasons.push('accelerator mismatch');
  if (task.kind === 'neural-distill' && worker.accelerator === 'none') reasons.push('neural distillation requires an admitted accelerator');
  if (worker.vram_mb === null && task.minimum_vram_mb > 0) reasons.push('worker VRAM is unknown');
  else if ((worker.vram_mb || 0) < task.minimum_vram_mb) reasons.push('insufficient VRAM');
  if (worker.memory_mb === null && task.minimum_memory_mb > 0) reasons.push('worker memory is unknown');
  else if ((worker.memory_mb || 0) < task.minimum_memory_mb) reasons.push('insufficient memory');
  if (worker.disk_mb === null && task.minimum_disk_mb > 0) reasons.push('worker disk is unknown');
  else if ((worker.disk_mb || 0) < task.minimum_disk_mb) reasons.push('insufficient disk');
  if (task.max_duration_ms !== null && worker.max_duration_ms !== null && worker.max_duration_ms < task.max_duration_ms) reasons.push('worker duration ceiling is too low');
  if (task.max_duration_ms !== null && worker.max_duration_ms === null) reasons.push('worker duration ceiling is unknown');
  if (PRIVACY[worker.privacy] < PRIVACY[task.privacy]) reasons.push('privacy class is insufficient');
  if (LOCALITY[worker.locality] < LOCALITY[task.minimum_locality]) reasons.push('locality class is insufficient');
  if (task.allowed_regions.length && !task.allowed_regions.includes(worker.region)) reasons.push('region is not admitted');
  if (task.checkpoint_format && !worker.checkpoint_formats.includes(task.checkpoint_format)) reasons.push('checkpoint format is unsupported');
  if (!worker.corpus_pack_versions.includes(task.corpus_pack_version)) reasons.push('corpus pack version is unsupported');
  for (const capability of task.required_capabilities) if (!worker.capabilities.includes(capability)) reasons.push(`missing capability ${capability}`);
  if (worker.cost_per_hour_usd === null && !task.allow_unknown_cost) reasons.push('worker cost is unknown');
  if (task.max_cost_usd !== null && worker.cost_per_hour_usd !== null && task.max_duration_ms !== null) {
    const estimated = worker.cost_per_hour_usd * task.max_duration_ms / 3600000;
    if (estimated > task.max_cost_usd) reasons.push('estimated cost exceeds ceiling');
  }
  return reasons;
}

function scoreWorker(worker, task) {
  let score = 0;
  score += (worker.reliability ?? 0.5) * 40;
  score += Math.max(0, 15 - (worker.active / worker.concurrency) * 15);
  score += task.prefer_local ? LOCALITY[worker.locality] * 5 : 0;
  score += PRIVACY[worker.privacy] * 2;
  if (worker.cost_per_hour_usd !== null) score += Math.max(0, 15 - worker.cost_per_hour_usd * 3);
  if (worker.latency_ms !== null) score += Math.max(0, 10 - worker.latency_ms / 100);
  if (worker.type === 'local-cpu' && ['sparse-infer', 'sparse-train'].includes(task.kind)) score += 20;
  if (worker.accelerator !== 'none' && task.kind === 'neural-distill') score += 20;
  return Number(score.toFixed(6));
}

function placementBody(task, eligible, rejected, selected, createdAt) {
  return {
    schema: PLACEMENT_SCHEMA,
    task_id: task.task_id,
    task_digest: task.task_digest,
    selected_worker_id: selected?.worker_id || null,
    selected_worker_digest: selected?.worker_digest || null,
    candidates: eligible.map(item => ({ worker_id: item.worker.worker_id, worker_digest: item.worker.worker_digest, score: item.score })),
    rejected,
    state: selected ? 'placed' : 'unavailable',
    created_at: createdAt
  };
}

function validateArtifacts(artifacts = []) {
  return artifacts.map((artifact, index) => {
    const sha256 = clean(artifact.sha256 || artifact.digest, 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Artifact ${index} lacks a SHA-256 digest.`);
    if (artifact.verified_sha256 && clean(artifact.verified_sha256, 64).toLowerCase() !== sha256) throw new Error(`Artifact ${index} digest verification failed.`);
    const bytes = Number(artifact.bytes);
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`Artifact ${index} has invalid size.`);
    return Object.freeze({
      name: clean(artifact.name || `artifact-${index + 1}`, 500),
      kind: clean(artifact.kind || 'artifact', 100),
      sha256,
      bytes,
      uri_digest: artifact.uri ? digest(clean(artifact.uri, 4000)) : null,
      provenance: clean(redact(artifact.provenance), 1000) || null
    });
  });
}

export class ArchieComputeLadder {
  constructor({ workers = [], adapters = {}, clock = nowISO, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), id_factory = () => crypto.randomUUID() } = {}) {
    this.clock = clock;
    this.sleep = sleep;
    this.idFactory = id_factory;
    this.adapters = { ...adapters };
    this.workers = new Map();
    this.activeLeases = new Map();
    for (const worker of workers) this.register(worker);
  }

  register(input) {
    const worker = normalizeWorker(input);
    if (this.workers.has(worker.worker_id)) throw new Error(`Duplicate compute worker: ${worker.worker_id}.`);
    this.workers.set(worker.worker_id, worker);
    return worker;
  }

  capabilities() {
    const workers = [...this.workers.values()].map(worker => ({
      worker_id: worker.worker_id,
      type: worker.type,
      accelerator: worker.accelerator,
      attestation: worker.attestation.state,
      availability: worker.availability,
      health: worker.health,
      adapter_available: Boolean(this.adapters[worker.adapter]?.execute)
    }));
    const body = { schema: 'archie-compute-capabilities/v1', workers, baseline: 'local-cpu sparse specialists', permanent_gpu_required: false };
    return Object.freeze({ ...body, capabilities_digest: digest(body) });
  }

  place(taskInput, { exclude_worker_ids = [] } = {}) {
    const task = normalizeComputeTask(taskInput);
    const excluded = new Set(exclude_worker_ids);
    const eligible = [];
    const rejected = [];
    for (const worker of [...this.workers.values()].sort((left, right) => left.worker_id.localeCompare(right.worker_id))) {
      if (excluded.has(worker.worker_id)) {
        rejected.push({ worker_id: worker.worker_id, reasons: ['excluded after prior attempt'] });
        continue;
      }
      const reasons = hardMatch(worker, task);
      if (!this.adapters[worker.adapter]?.execute) reasons.push('worker adapter is unavailable');
      if (reasons.length) rejected.push({ worker_id: worker.worker_id, reasons: sortedUnique(reasons) });
      else eligible.push({ worker, score: scoreWorker(worker, task) });
    }
    eligible.sort((left, right) => right.score - left.score || left.worker.worker_id.localeCompare(right.worker.worker_id));
    const selected = eligible[0]?.worker || null;
    const createdAt = new Date(typeof this.clock === 'function' ? this.clock() : this.clock).toISOString();
    const body = placementBody(task, eligible, rejected, selected, createdAt);
    return Object.freeze({ ...body, placement_digest: digest(body), task, selected_worker: selected });
  }

  acquire(placement) {
    if (placement?.state !== 'placed' || !placement.selected_worker) throw new Error('A placed compute worker is required.');
    const workerId = placement.selected_worker.worker_id;
    if ([...this.activeLeases.values()].some(lease => lease.worker_id === workerId && lease.state === 'active')) throw new Error(`Compute worker already has an active lease: ${workerId}.`);
    const leaseId = `lease_${clean(this.idFactory(), 100)}`;
    const fencing = 1 + Math.max(0, ...[...this.activeLeases.values()].filter(lease => lease.worker_id === workerId).map(lease => lease.fencing_token));
    const body = {
      lease_id: leaseId,
      worker_id: workerId,
      worker_digest: placement.selected_worker.worker_digest,
      task_id: placement.task.task_id,
      task_digest: placement.task.task_digest,
      fencing_token: fencing,
      state: 'active',
      acquired_at: new Date(typeof this.clock === 'function' ? this.clock() : this.clock).toISOString()
    };
    const lease = { ...body, lease_digest: digest(body) };
    this.activeLeases.set(leaseId, lease);
    return Object.freeze(lease);
  }

  cancel(leaseId, reason = 'operator cancellation') {
    const lease = this.activeLeases.get(leaseId);
    if (!lease || lease.state !== 'active') return Object.freeze({ cancelled: false, lease_id: leaseId, reason: 'lease is not active' });
    const next = { ...lease, state: 'cancelled', cancelled_at: new Date(typeof this.clock === 'function' ? this.clock() : this.clock).toISOString(), reason: clean(redact(reason), 1000) };
    next.lease_digest = digest({ ...next, lease_digest: undefined });
    this.activeLeases.set(leaseId, next);
    return Object.freeze({ cancelled: true, lease_id: leaseId, reason: next.reason });
  }

  async dispatch(taskInput, payload = {}) {
    const task = normalizeComputeTask(taskInput);
    const attempts = [];
    const excluded = [];
    let finalError = null;
    for (let attempt = 0; attempt <= task.retries; attempt += 1) {
      const placement = this.place(task, { exclude_worker_ids: excluded });
      if (placement.state !== 'placed') {
        finalError = new Error('No admitted compute worker is available.');
        attempts.push({ attempt: attempt + 1, state: 'unavailable', placement_digest: placement.placement_digest, rejected: placement.rejected });
        break;
      }
      const lease = this.acquire(placement);
      const worker = placement.selected_worker;
      const adapter = this.adapters[worker.adapter];
      const controller = new AbortController();
      let timeout;
      let timedOut = false;
      try {
        const result = await Promise.race([
          adapter.execute({
            task: redact(task),
            payload: redact(payload),
            worker: redact(worker),
            lease: { lease_id: lease.lease_id, fencing_token: lease.fencing_token, lease_digest: lease.lease_digest },
            signal: controller.signal
          }),
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              controller.abort(new Error('compute timeout'));
              const error = new Error('Compute worker timed out.');
              error.code = 'ETIMEDOUT';
              reject(error);
            }, task.timeout_ms);
          })
        ]);
        const currentLease = this.activeLeases.get(lease.lease_id);
        if (currentLease?.state !== 'active' || currentLease.fencing_token !== lease.fencing_token) throw new Error('Compute result used a stale or cancelled lease.');
        const artifacts = validateArtifacts(result?.artifacts || []);
        const usage = {
          wall_ms: Number.isFinite(Number(result?.usage?.wall_ms)) ? Number(result.usage.wall_ms) : null,
          input_tokens: Number.isFinite(Number(result?.usage?.input_tokens)) ? Number(result.usage.input_tokens) : null,
          output_tokens: Number.isFinite(Number(result?.usage?.output_tokens)) ? Number(result.usage.output_tokens) : null,
          cost_usd: Number.isFinite(Number(result?.usage?.cost_usd)) ? Number(result.usage.cost_usd) : null,
          evidence: clean(result?.usage?.evidence || (result?.usage ? 'provider-reported-or-adapter-reported' : 'unreported'), 160)
        };
        const completedLease = { ...currentLease, state: 'completed', completed_at: new Date(typeof this.clock === 'function' ? this.clock() : this.clock).toISOString() };
        completedLease.lease_digest = digest({ ...completedLease, lease_digest: undefined });
        this.activeLeases.set(lease.lease_id, completedLease);
        attempts.push({ attempt: attempt + 1, state: 'completed', worker_id: worker.worker_id, worker_digest: worker.worker_digest, lease_id: lease.lease_id, placement_digest: placement.placement_digest, artifacts, usage, result_digest: digest(redact(result?.output ?? result?.result ?? null)) });
        const body = {
          schema: RECEIPT_SCHEMA,
          task_id: task.task_id,
          task_digest: task.task_digest,
          state: 'completed',
          selected_worker_id: worker.worker_id,
          selected_worker_digest: worker.worker_digest,
          placement_digest: placement.placement_digest,
          lease_id: lease.lease_id,
          fencing_token: lease.fencing_token,
          attempts,
          artifacts,
          usage,
          output: redact(result?.output ?? result?.result ?? null),
          completed_at: completedLease.completed_at,
          authority: { merge: 'human', deploy: 'human', infrastructure: 'adapter-only' }
        };
        return Object.freeze({ ...body, receipt_digest: digest(body) });
      } catch (error) {
        finalError = error;
        excluded.push(worker.worker_id);
        const currentLease = this.activeLeases.get(lease.lease_id) || lease;
        const failedLease = { ...currentLease, state: timedOut || error?.code === 'ETIMEDOUT' ? 'timed_out' : 'failed', failed_at: new Date(typeof this.clock === 'function' ? this.clock() : this.clock).toISOString(), error: clean(redact(error?.message || error), 2000) };
        failedLease.lease_digest = digest({ ...failedLease, lease_digest: undefined });
        this.activeLeases.set(lease.lease_id, failedLease);
        attempts.push({ attempt: attempt + 1, state: failedLease.state, worker_id: worker.worker_id, worker_digest: worker.worker_digest, lease_id: lease.lease_id, placement_digest: placement.placement_digest, error: failedLease.error });
      } finally {
        clearTimeout(timeout);
      }
    }
    const body = {
      schema: RECEIPT_SCHEMA,
      task_id: task.task_id,
      task_digest: task.task_digest,
      state: 'unavailable',
      selected_worker_id: null,
      selected_worker_digest: null,
      placement_digest: attempts.at(-1)?.placement_digest || null,
      lease_id: null,
      fencing_token: null,
      attempts,
      artifacts: [],
      usage: null,
      output: null,
      error: clean(redact(finalError?.message || finalError || 'No admitted compute worker is available.'), 2000),
      completed_at: new Date(typeof this.clock === 'function' ? this.clock() : this.clock).toISOString(),
      authority: { merge: 'human', deploy: 'human', infrastructure: 'adapter-only' }
    };
    return Object.freeze({ ...body, receipt_digest: digest(body) });
  }
}

export function createArchieComputeLadder(options) {
  return new ArchieComputeLadder(options);
}
