#!/usr/bin/env node
import crypto from 'node:crypto';

export const ARCHIE_COMPUTE_RECEIPT_SCHEMA = 'archie-compute-receipt/v1';
export const ARCHIE_WORKER_ATTESTATION_SCHEMA = 'archie-worker-attestation/v1';

const clean = (v, n = 4000) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, n);
const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const nowISO = clock => new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString();

const KINDS = Object.freeze([
  'local_cpu', 'wsl_workstation', 'github_hosted_cpu', 'self_hosted', 'remote_http', 'burst_gpu'
]);
const PRIVACY = Object.freeze({ local: 5, private: 4, contractual: 3, provider: 2, unknown: 0 });

export function workerDigestBody(worker) {
  const { worker_digest, ...body } = worker;
  return body;
}

export function normalizeWorker(input = {}, { clock = Date.now } = {}) {
  const kind = KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) throw new Error('Unknown Archie compute worker kind.');
  const id = clean(input.id, 200);
  if (!id) throw new Error('Worker id is required.');
  const observed = input.observed === true;
  const available = observed && input.available === true;
  const observedAt = input.observed_at ? new Date(input.observed_at).toISOString() : nowISO(clock);
  const worker = {
    schema: ARCHIE_WORKER_ATTESTATION_SCHEMA,
    id,
    kind,
    observed,
    available,
    observed_at: observedAt,
    expires_at: input.expires_at ? new Date(input.expires_at).toISOString() : null,
    identity: clean(input.identity || '', 300) || null,
    adapter: clean(input.adapter || '', 200) || null,
    endpoint_digest: clean(input.endpoint_digest || '', 64) || null,
    capabilities: [...new Set((input.capabilities || []).map(x => clean(x, 100)).filter(Boolean))].sort(),
    limits: {
      max_seconds: Math.max(0, finite(input.limits?.max_seconds, 0)),
      max_memory_mb: Math.max(0, finite(input.limits?.max_memory_mb, 0)),
      max_payload_bytes: Math.max(0, finite(input.limits?.max_payload_bytes, 0)),
      max_cost_usd: input.limits?.max_cost_usd === null ? null : Math.max(0, finite(input.limits?.max_cost_usd, 0))
    },
    privacy: clean(input.privacy || 'unknown', 40).toLowerCase(),
    locality: clean(input.locality || 'unknown', 100).toLowerCase(),
    pack_versions: [...new Set((input.pack_versions || []).map(x => clean(x, 100)).filter(Boolean))].sort(),
    neural_distillation: input.neural_distillation === true,
    evidence: canonical(input.evidence || null),
    attestation_nonce: clean(input.attestation_nonce || '', 200) || null
  };
  if (kind !== 'local_cpu' && (!worker.identity || !worker.adapter)) worker.available = false;
  if (kind === 'remote_http' || kind === 'burst_gpu') {
    if (!worker.endpoint_digest || !/^[a-f0-9]{64}$/.test(worker.endpoint_digest)) worker.available = false;
  }
  if (kind === 'burst_gpu' && (!worker.evidence || worker.limits.max_cost_usd === null || worker.privacy === 'unknown')) worker.available = false;
  worker.worker_digest = digest(workerDigestBody(worker));
  return Object.freeze(worker);
}

export function verifyWorker(worker, { clock = Date.now, max_age_ms = 10 * 60_000 } = {}) {
  if (!worker || worker.schema !== ARCHIE_WORKER_ATTESTATION_SCHEMA) throw new Error('Invalid worker attestation schema.');
  if (digest(workerDigestBody(worker)) !== worker.worker_digest) throw new Error('Worker attestation digest mismatch.');
  const age = (typeof clock === 'function' ? clock() : Date.now()) - Date.parse(worker.observed_at);
  if (!worker.observed || age < 0 || age > max_age_ms) throw new Error('Worker attestation is stale or unobserved.');
  if (worker.expires_at && Date.parse(worker.expires_at) <= (typeof clock === 'function' ? clock() : Date.now())) throw new Error('Worker attestation expired.');
  return true;
}

export function normalizeTask(input = {}) {
  const task = {
    schema: 'archie-compute-task/v1',
    task_id: clean(input.task_id || '', 200) || `task_${digest(stable(input)).slice(0, 20)}`,
    operation: clean(input.operation || '', 200),
    payload_digest: clean(input.payload_digest || '', 64),
    payload_bytes: Math.max(0, Math.floor(finite(input.payload_bytes, 0))),
    pack_version: clean(input.pack_version || '', 100) || null,
    hard_requirements: [...new Set((input.hard_requirements || []).map(x => clean(x, 100)).filter(Boolean))].sort(),
    max_seconds: Math.max(0, finite(input.max_seconds, 60)),
    max_memory_mb: Math.max(0, finite(input.max_memory_mb, 512)),
    max_cost_usd: Math.max(0, finite(input.max_cost_usd, 0)),
    privacy_minimum: clean(input.privacy_minimum || 'local', 40).toLowerCase(),
    locality: clean(input.locality || 'any', 100).toLowerCase(),
    neural_distillation: input.neural_distillation === true
  };
  if (!task.operation) throw new Error('Compute task operation is required.');
  if (!/^[a-f0-9]{64}$/.test(task.payload_digest)) throw new Error('Compute task payload_digest is required.');
  task.task_digest = digest(task);
  return Object.freeze(task);
}

function rejectionReasons(worker, task, options = {}) {
  const reasons = [];
  try { verifyWorker(worker, options); } catch (error) { reasons.push(clean(error.message, 200)); return reasons; }
  if (!worker.available) reasons.push('worker_unavailable');
  for (const requirement of task.hard_requirements) if (!worker.capabilities.includes(requirement)) reasons.push(`missing:${requirement}`);
  if (worker.limits.max_seconds && worker.limits.max_seconds < task.max_seconds) reasons.push('time_limit');
  if (worker.limits.max_memory_mb && worker.limits.max_memory_mb < task.max_memory_mb) reasons.push('memory_limit');
  if (worker.limits.max_payload_bytes && worker.limits.max_payload_bytes < task.payload_bytes) reasons.push('payload_limit');
  if (worker.limits.max_cost_usd === null || worker.limits.max_cost_usd > task.max_cost_usd) reasons.push('cost_unknown_or_exceeds');
  if ((PRIVACY[worker.privacy] ?? 0) < (PRIVACY[task.privacy_minimum] ?? 0)) reasons.push('privacy');
  if (task.locality !== 'any' && worker.locality !== task.locality) reasons.push('locality');
  if (task.pack_version && !worker.pack_versions.includes(task.pack_version)) reasons.push('pack_version');
  if (task.neural_distillation && !worker.neural_distillation) reasons.push('neural_distillation_unavailable');
  return reasons;
}

export function selectComputeWorker(workers, taskInput, options = {}) {
  const task = taskInput?.task_digest ? taskInput : normalizeTask(taskInput);
  const evaluated = (workers || []).map(raw => {
    let worker;
    try { worker = raw.worker_digest ? raw : normalizeWorker(raw, options); }
    catch (error) { return { worker_id: clean(raw?.id || 'unknown'), eligible: false, reasons: [clean(error.message)] }; }
    const reasons = rejectionReasons(worker, task, options);
    const rank = KINDS.indexOf(worker.kind);
    return { worker, worker_id: worker.id, eligible: reasons.length === 0, reasons, rank };
  }).sort((a, b) => (a.eligible === b.eligible ? (a.rank ?? 99) - (b.rank ?? 99) || a.worker_id.localeCompare(b.worker_id) : a.eligible ? -1 : 1));
  return Object.freeze({ task, selected: evaluated.find(x => x.eligible)?.worker || null, evaluated: evaluated.map(({ worker, ...x }) => ({ ...x, kind: worker?.kind || null, worker_digest: worker?.worker_digest || null })) });
}

function receiptBody(receipt) { const { receipt_digest, ...body } = receipt; return body; }

export async function dispatchComputeTask({ workers, task: taskInput, adapters = {}, clock = Date.now, signal, max_retries = 1, fence_token = '', expected_artifact_digest = null } = {}) {
  const selection = selectComputeWorker(workers, taskInput, { clock });
  const task = selection.task;
  if (!selection.selected) {
    const receipt = {
      schema: ARCHIE_COMPUTE_RECEIPT_SCHEMA, state: 'blocked', observed_at: nowISO(clock), task_digest: task.task_digest,
      worker_id: null, worker_digest: null, attempts: [], artifact_digest: null, cost_usd: null,
      blocker: task.neural_distillation ? 'neural_distillation_requires_separately_admitted_hardware_adapter_identity_limits_cost_privacy_and_evaluation' : 'no_admitted_worker',
      selection: selection.evaluated
    };
    receipt.receipt_digest = digest(receiptBody(receipt));
    return Object.freeze(receipt);
  }
  const worker = selection.selected;
  const adapter = adapters[worker.adapter || worker.kind];
  if (typeof adapter !== 'function') throw new Error('Selected worker adapter is not configured.');
  const attempts = [];
  const fence = clean(fence_token || `fence_${crypto.randomBytes(12).toString('hex')}`, 200);
  for (let attempt = 0; attempt <= Math.max(0, Math.min(5, max_retries)); attempt += 1) {
    if (signal?.aborted) {
      attempts.push({ attempt, status: 'cancelled' });
      break;
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(task.max_seconds, worker.limits.max_seconds || task.max_seconds) * 1000);
    const timer = setTimeout(() => controller.abort(new Error('compute timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal.reason || new Error('cancelled'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const result = await adapter({ task, worker, fence_token: fence, signal: controller.signal, attempt });
      if (!result || result.fence_token !== fence) throw new Error('stale or mismatched fence token');
      if (result.task_digest !== task.task_digest || result.worker_digest !== worker.worker_digest) throw new Error('task or worker digest mismatch');
      const artifactDigest = clean(result.artifact_digest || '', 64);
      if (!/^[a-f0-9]{64}$/.test(artifactDigest)) throw new Error('artifact digest missing');
      if (expected_artifact_digest && artifactDigest !== expected_artifact_digest) throw new Error('artifact integrity mismatch');
      attempts.push({ attempt, status: 'completed', artifact_digest: artifactDigest });
      const receipt = {
        schema: ARCHIE_COMPUTE_RECEIPT_SCHEMA, state: 'completed', observed_at: nowISO(clock), task_digest: task.task_digest,
        worker_id: worker.id, worker_digest: worker.worker_digest, attempts, artifact_digest: artifactDigest,
        cost_usd: result.cost_usd === undefined ? null : Math.max(0, finite(result.cost_usd, 0)), blocker: null,
        selection: selection.evaluated
      };
      receipt.receipt_digest = digest(receiptBody(receipt));
      return Object.freeze(receipt);
    } catch (error) {
      attempts.push({ attempt, status: controller.signal.aborted ? (signal?.aborted ? 'cancelled' : 'timeout') : 'failed', error: clean(error.message, 300) });
      if (signal?.aborted) break;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
  const receipt = {
    schema: ARCHIE_COMPUTE_RECEIPT_SCHEMA, state: signal?.aborted ? 'cancelled' : 'failed', observed_at: nowISO(clock), task_digest: task.task_digest,
    worker_id: worker.id, worker_digest: worker.worker_digest, attempts, artifact_digest: null, cost_usd: null,
    blocker: signal?.aborted ? 'operator_cancelled' : 'worker_attempts_exhausted', selection: selection.evaluated
  };
  receipt.receipt_digest = digest(receiptBody(receipt));
  return Object.freeze(receipt);
}

export function verifyComputeReceipt(receipt) {
  if (!receipt || receipt.schema !== ARCHIE_COMPUTE_RECEIPT_SCHEMA) throw new Error('Invalid compute receipt schema.');
  if (digest(receiptBody(receipt)) !== receipt.receipt_digest) throw new Error('Compute receipt digest mismatch.');
  return true;
}
