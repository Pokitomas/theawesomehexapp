import crypto from 'node:crypto';
import os from 'node:os';
import process from 'node:process';

export const COMPUTE_NODE_SCHEMA = 'archie-compute-node/v1';
export const COMPUTE_TASK_SCHEMA = 'archie-compute-task/v1';
export const COMPUTE_PLACEMENT_SCHEMA = 'archie-compute-placement/v1';
export const COMPUTE_RECEIPT_SCHEMA = 'archie-compute-receipt/v1';
export const COMPUTE_ATTESTATION_SCHEMA = 'archie-compute-attestation/v1';

const SECRET_RE = /(secret|token|password|passwd|credential|authorization|api[_-]?key|private[_-]?key|access[_-]?key|refresh[_-]?token|session|cookie)/i;
const SECRET_VALUE_RE = /Bearer\s+[A-Za-z0-9._~-]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+/;
const LOCAL_REGIONS = new Set(['local', 'host', 'wsl']);
const ACCEL_ORDER = new Map([['cpu', 0], ['metal', 1], ['rocm', 2], ['cuda', 3], ['burst-gpu', 4], ['gpu', 5]]);

const clean = (value, limit = 100000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const uniq = values => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 200)).filter(Boolean))].sort();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function digest(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : (typeof value === 'string' ? value : stableJSONStringify(value))).digest('hex');
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return typeof value === 'string' && SECRET_VALUE_RE.test(value) ? '[REDACTED]' : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_RE.test(key) ? '[REDACTED]' : redactSecrets(item)]));
}

function cost(value = {}) {
  const amount = num(value.amount_usd ?? value.estimate_usd ?? value.max_usd);
  const hourly = num(value.hourly_usd);
  return {
    known: value.known === true || amount !== null || hourly !== null,
    amount_usd: amount,
    hourly_usd: hourly,
    currency: clean(value.currency || 'USD', 20) || 'USD'
  };
}

function accelerator(value = {}) {
  return {
    kind: clean(value.kind || value.type || 'gpu', 80).toLowerCase(),
    observed: value.observed === true,
    available: value.available !== false,
    memory_gb: num(value.memory_gb ?? value.vram_gb ?? value.vram),
    count: Math.max(1, Number.parseInt(value.count ?? 1, 10) || 1),
    name: clean(value.name || value.kind || value.type || 'accelerator', 200)
  };
}

export function normalizeComputeNode(input = {}) {
  const caps = input.capabilities || input;
  const kind = clean(input.kind || input.type || 'remote-http', 100).toLowerCase();
  const local = caps.local === true || input.local === true || ['local-cpu', 'local-gpu', 'wsl'].includes(kind);
  const node = {
    schema: COMPUTE_NODE_SCHEMA,
    provider_id: clean(input.provider_id || input.provider || input.id || 'unknown-provider', 200),
    node_id: clean(input.node_id || input.id || input.provider_id || 'unknown-node', 200),
    kind,
    status: clean(caps.status || input.status || 'available', 80).toLowerCase(),
    observed: caps.observed === true || input.observed === true,
    local,
    capabilities: {
      memory_gb: num(caps.memory_gb ?? input.memory_gb),
      disk_gb: num(caps.disk_gb ?? input.disk_gb),
      accelerators: (Array.isArray(caps.accelerators) ? caps.accelerators : []).map(accelerator).filter(item => item.observed === true && item.available === true),
      regions: uniq(caps.regions || input.regions || [local ? 'local' : 'unknown']),
      privacy_modes: uniq(caps.privacy_modes || caps.privacy || input.privacy_modes || (local ? ['local-only', 'private', 'public'] : ['public'])),
      cost: cost(caps.cost || input.cost || {}),
      checkpoint_formats: uniq(caps.checkpoint_formats || input.checkpoint_formats || []),
      corpus_packs: uniq(caps.corpus_packs || caps.corpus_pack_support || input.corpus_packs || []),
      max_runtime_ms: num(caps.max_runtime_ms ?? input.max_runtime_ms),
      min_start_delay_ms: num(caps.min_start_delay_ms ?? input.min_start_delay_ms) ?? 0
    },
    labels: uniq(input.labels || caps.labels || [])
  };
  if (input.adapter_id) node.adapter_id = clean(input.adapter_id, 200);
  if (input.attestation) node.attestation = input.attestation;
  return Object.freeze(node);
}

function attestedPayload(input) {
  const node = { ...normalizeComputeNode(input), attestation: undefined };
  return {
    schema: COMPUTE_ATTESTATION_SCHEMA,
    provider_id: node.provider_id,
    node_id: node.node_id,
    kind: node.kind,
    observed: node.observed,
    local: node.local,
    capabilities: node.capabilities,
    labels: node.labels,
    adapter_id: node.adapter_id || null
  };
}

export function attestComputeNode(node, { attested_by = 'archie-compute-ladder', issued_at = null } = {}) {
  const payload = attestedPayload(node);
  return Object.freeze({ schema: COMPUTE_ATTESTATION_SCHEMA, attested_by: clean(attested_by, 200), issued_at, subject: `${payload.provider_id}/${payload.node_id}`, digest: digest(payload) });
}

export function sealComputeNode(node, options = {}) {
  const normalized = normalizeComputeNode(node);
  return Object.freeze({ ...normalized, attestation: attestComputeNode(normalized, options) });
}

export function verifyComputeAttestation(node) {
  const normalized = normalizeComputeNode(node);
  const expected = attestComputeNode(normalized).digest;
  const actual = normalized.attestation?.digest;
  if (normalized.attestation?.schema !== COMPUTE_ATTESTATION_SCHEMA || actual !== expected) {
    throw Object.assign(new Error(`Compute node attestation mismatch for ${normalized.provider_id}/${normalized.node_id}.`), { code: 'ATTESTATION_MISMATCH', expected_digest: expected, actual_digest: actual || null });
  }
  return expected;
}

export function discoverLocalCompute({ memory_gb = Math.max(1, Math.round((os.totalmem?.() || 0) / 1024 / 1024 / 1024)), disk_gb = 1, accelerators = [], wsl = process.env.WSL_DISTRO_NAME ? { observed: true } : null, region = 'local', checkpoint_formats = ['gguf', 'onnx', 'safetensors'], corpus_packs = ['local-fs'], clock = null } = {}) {
  const issued_at = typeof clock === 'function' ? new Date(clock()).toISOString() : null;
  const common = { memory_gb, disk_gb, privacy_modes: ['local-only', 'private', 'public'], cost: { known: true, amount_usd: 0 }, checkpoint_formats, corpus_packs };
  const cpuCount = os.cpus?.().length || 1;
  const nodes = [sealComputeNode({ provider_id: 'local', node_id: 'local-cpu', kind: 'local-cpu', observed: true, local: true, capabilities: { ...common, regions: [region], accelerators: [{ kind: 'cpu', observed: true, available: true, memory_gb: 0, count: cpuCount, name: 'local-cpu' }] } }, { issued_at })];
  if (wsl?.observed === true) nodes.push(sealComputeNode({ provider_id: 'local', node_id: 'wsl-cpu', kind: 'wsl', observed: true, local: true, capabilities: { ...common, regions: ['wsl', region], accelerators: [{ kind: 'cpu', observed: true, available: true, memory_gb: 0, count: cpuCount, name: 'wsl-cpu' }] } }, { issued_at }));
  for (const gpu of accelerators.map(accelerator)) {
    if (gpu.kind === 'cpu' || gpu.observed !== true || gpu.available !== true) continue;
    nodes.push(sealComputeNode({ provider_id: 'local', node_id: `local-${gpu.kind}-${digest(gpu).slice(0, 8)}`, kind: 'local-gpu', observed: true, local: true, capabilities: { ...common, regions: [region], accelerators: [gpu] } }, { issued_at }));
  }
  return Object.freeze(nodes);
}

export function makeComputeNode(options = {}) {
  return sealComputeNode(options, options);
}

export function makeGithubHostedCpuNode(options = {}) {
  return sealComputeNode({ provider_id: options.provider_id || 'github-hosted', node_id: options.node_id || 'github-hosted-cpu', kind: 'github-hosted-cpu', observed: options.observed === true, local: false, capabilities: { memory_gb: options.memory_gb, disk_gb: options.disk_gb, accelerators: [{ kind: 'cpu', observed: options.observed === true, available: true, memory_gb: 0, count: 2, name: 'github-hosted-cpu' }], privacy_modes: options.privacy_modes || ['public'], regions: options.regions || ['github-hosted'], cost: options.cost || { known: true, amount_usd: 0 }, checkpoint_formats: options.checkpoint_formats || ['gguf', 'onnx'], corpus_packs: options.corpus_packs || [] } }, options);
}

export function normalizeComputeTask(input = {}) {
  const req = input.requirements || input;
  const accel = req.accelerator === undefined ? 'cpu' : req.accelerator;
  const accelReq = typeof accel === 'string' ? { kind: accel.toLowerCase(), min_vram_gb: 0 } : { kind: clean(accel.kind || accel.type || 'cpu', 80).toLowerCase(), min_vram_gb: num(accel.min_vram_gb ?? accel.vram_gb) ?? 0 };
  return Object.freeze({
    schema: COMPUTE_TASK_SCHEMA,
    task_id: clean(input.task_id || input.id || `task_${digest(input).slice(0, 16)}`, 200),
    operation: clean(input.operation || input.kind || 'compute', 200),
    input: input.input || null,
    requirements: {
      min_memory_gb: num(req.min_memory_gb ?? req.memory_gb) ?? 0,
      min_disk_gb: num(req.min_disk_gb ?? req.disk_gb) ?? 0,
      accelerator: accelReq,
      privacy: clean(req.privacy || 'public', 80).toLowerCase(),
      regions: uniq(req.regions || req.allowed_regions || (req.region ? [req.region] : [])),
      max_cost_usd: num(req.max_cost_usd ?? req.cost_usd),
      max_runtime_ms: num(req.max_runtime_ms ?? req.timeout_ms),
      deadline_ms: num(req.deadline_ms),
      checkpoint_formats: uniq(req.checkpoint_formats || (req.checkpoint_format ? [req.checkpoint_format] : [])),
      corpus_packs: uniq(req.corpus_packs || req.corpus_pack_support || (req.corpus_pack ? [req.corpus_pack] : [])),
      require_known_cost: req.require_known_cost !== false
    },
    metadata: input.metadata || {}
  });
}

function matchAccelerator(node, requirement) {
  if (requirement.kind === 'none') return { ok: true, value: null };
  const accelerators = node.capabilities.accelerators || [];
  if (requirement.kind === 'cpu') {
    const cpu = accelerators.find(item => item.kind === 'cpu');
    return cpu ? { ok: true, value: cpu } : { ok: false, reason: 'accelerator_cpu_unavailable' };
  }
  const matched = accelerators.filter(item => requirement.kind === 'gpu' ? ['cuda', 'rocm', 'metal', 'burst-gpu', 'gpu'].includes(item.kind) : item.kind === requirement.kind).sort((a, b) => (b.memory_gb || 0) - (a.memory_gb || 0))[0];
  if (!matched) return { ok: false, reason: `accelerator_${requirement.kind}_unavailable` };
  if (matched.memory_gb === null && requirement.min_vram_gb > 0) return { ok: false, reason: 'accelerator_vram_unknown' };
  if ((matched.memory_gb || 0) < requirement.min_vram_gb) return { ok: false, reason: 'accelerator_vram_too_small' };
  return { ok: true, value: matched };
}

const reject = (reason, node, extra = {}) => ({ provider_id: node.provider_id, node_id: node.node_id, reason, ...extra });
const includesAll = (available, required) => required.every(item => available.includes(item));

function estimateCost(node, task) {
  const nodeCost = node.capabilities.cost || {};
  if (nodeCost.known !== true) return null;
  if (num(nodeCost.amount_usd) !== null) return nodeCost.amount_usd;
  if (num(nodeCost.hourly_usd) !== null) return nodeCost.hourly_usd * ((task.requirements.max_runtime_ms || 0) / 3600000);
  return null;
}

export function evaluateComputeNode(taskInput, nodeInput) {
  const task = normalizeComputeTask(taskInput);
  const node = normalizeComputeNode(nodeInput);
  const rejections = [];
  if (node.observed !== true) rejections.push(reject('capability_unobserved', node));
  if (node.status !== 'available') rejections.push(reject('node_unavailable', node, { status: node.status }));
  if (node.capabilities.memory_gb === null) rejections.push(reject('memory_unknown', node));
  else if (node.capabilities.memory_gb < task.requirements.min_memory_gb) rejections.push(reject('memory_too_small', node));
  if (node.capabilities.disk_gb === null) rejections.push(reject('disk_unknown', node));
  else if (node.capabilities.disk_gb < task.requirements.min_disk_gb) rejections.push(reject('disk_too_small', node));
  const matchedAccelerator = matchAccelerator(node, task.requirements.accelerator);
  if (!matchedAccelerator.ok) rejections.push(reject(matchedAccelerator.reason, node));
  if (!node.capabilities.privacy_modes.includes(task.requirements.privacy)) rejections.push(reject('privacy_rejected', node));
  if (task.requirements.privacy === 'local-only' && node.local !== true) rejections.push(reject('locality_rejected', node));
  if (!node.capabilities.regions.length || node.capabilities.regions.includes('unknown')) rejections.push(reject('region_unknown', node));
  else if (task.requirements.regions.length && !task.requirements.regions.some(region => node.capabilities.regions.includes(region))) rejections.push(reject('region_rejected', node, { required: task.requirements.regions, available: node.capabilities.regions }));
  if (task.requirements.privacy === 'local-only' && !node.capabilities.regions.some(region => LOCAL_REGIONS.has(region))) rejections.push(reject('local_region_rejected', node));
  const estimated_cost_usd = estimateCost(node, task);
  if (task.requirements.require_known_cost && estimated_cost_usd === null) rejections.push(reject('cost_unknown', node));
  if (estimated_cost_usd !== null && task.requirements.max_cost_usd !== null && estimated_cost_usd > task.requirements.max_cost_usd) rejections.push(reject('cost_too_high', node, { estimated_cost_usd }));
  if (node.capabilities.max_runtime_ms !== null && task.requirements.max_runtime_ms !== null && node.capabilities.max_runtime_ms < task.requirements.max_runtime_ms) rejections.push(reject('runtime_too_short', node));
  if (task.requirements.deadline_ms !== null && node.capabilities.min_start_delay_ms > task.requirements.deadline_ms) rejections.push(reject('deadline_missed', node));
  if (task.requirements.checkpoint_formats.length && !includesAll(node.capabilities.checkpoint_formats, task.requirements.checkpoint_formats)) rejections.push(reject('checkpoint_format_rejected', node));
  if (task.requirements.corpus_packs.length && !includesAll(node.capabilities.corpus_packs, task.requirements.corpus_packs)) rejections.push(reject('corpus_pack_rejected', node));
  let attestation_digest = null;
  try { attestation_digest = verifyComputeAttestation(node); } catch (error) { rejections.push(reject('attestation_rejected', node, { code: error.code })); }
  return Object.freeze({
    ok: rejections.length === 0,
    task,
    node,
    accelerator: matchedAccelerator.value || null,
    estimated_cost_usd,
    attestation_digest,
    rejections,
    score: {
      cost_usd: estimated_cost_usd ?? Number.POSITIVE_INFINITY,
      local_bonus: node.local ? 0 : 1,
      accelerator_rank: ACCEL_ORDER.get(matchedAccelerator.value?.kind || task.requirements.accelerator.kind || 'cpu') ?? 99,
      start_delay_ms: node.capabilities.min_start_delay_ms,
      memory_headroom_gb: Math.max(0, (node.capabilities.memory_gb ?? Number.POSITIVE_INFINITY) - task.requirements.min_memory_gb),
      key: `${node.provider_id}/${node.node_id}`
    }
  });
}

function compareEval(a, b) {
  for (const key of ['cost_usd', 'local_bonus', 'accelerator_rank', 'start_delay_ms', 'memory_headroom_gb']) if (a.score[key] !== b.score[key]) return a.score[key] - b.score[key];
  return a.score.key.localeCompare(b.score.key);
}

export function planComputePlacement(taskInput, nodesInput = []) {
  const task = normalizeComputeTask(taskInput);
  const evaluated = (Array.isArray(nodesInput) ? nodesInput : []).map(node => evaluateComputeNode(task, node));
  const admitted = evaluated.filter(item => item.ok).sort(compareEval);
  const selected = admitted[0] || null;
  const body = {
    schema: COMPUTE_PLACEMENT_SCHEMA,
    task_id: task.task_id,
    state: selected ? 'placed' : 'rejected',
    selected: selected ? { provider_id: selected.node.provider_id, node_id: selected.node.node_id, kind: selected.node.kind, adapter_id: selected.node.adapter_id || selected.node.provider_id, estimated_cost_usd: selected.estimated_cost_usd, attestation_digest: selected.attestation_digest, accelerator: selected.accelerator } : null,
    ranked: admitted.map(item => ({ provider_id: item.node.provider_id, node_id: item.node.node_id, kind: item.node.kind, estimated_cost_usd: item.estimated_cost_usd, attestation_digest: item.attestation_digest })),
    rejections: evaluated.flatMap(item => item.rejections),
    task: redactSecrets(task)
  };
  return Object.freeze({ ...body, placement_digest: digest(body) });
}

function verifyArtifactDigest(artifact = {}) {
  const expected = clean(artifact.digest || artifact.sha256 || artifact.content_digest, 200).replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw Object.assign(new Error('Artifact digest is missing or invalid.'), { code: 'ARTIFACT_DIGEST_REQUIRED' });
  const payload = artifact.bytes ?? artifact.content ?? artifact.text ?? artifact.payload;
  if (payload !== undefined) {
    const actual = digest(Buffer.isBuffer(payload) ? payload : String(payload));
    if (actual !== expected) throw Object.assign(new Error(`Artifact digest mismatch for ${clean(artifact.name || 'artifact', 200)}.`), { code: 'ARTIFACT_TAMPERED', expected_digest: expected, actual_digest: actual });
  }
  return expected;
}

function costReceipt(value = {}, task) {
  const actual = num(value.actual_usd ?? value.amount_usd ?? value.estimated_usd);
  if ((value.known !== true && actual === null) || actual === null) throw Object.assign(new Error('Provider returned an unknown cost receipt.'), { code: 'COST_RECEIPT_UNKNOWN' });
  if (task.requirements.max_cost_usd !== null && actual > task.requirements.max_cost_usd) throw Object.assign(new Error('Provider cost receipt exceeds task maximum.'), { code: 'COST_RECEIPT_TOO_HIGH' });
  return { known: true, actual_usd: actual, currency: clean(value.currency || 'USD', 20) || 'USD' };
}

export class ArchieComputeLadder {
  constructor({ adapters = {}, nodes = [], clock = Date.now, default_timeout_ms = 30000 } = {}) {
    this.adapters = new Map(Object.entries(adapters));
    this.nodes = [...nodes];
    this.clock = clock;
    this.defaultTimeoutMs = default_timeout_ms;
  }

  registerAdapter(id, adapter) {
    if (!id || !adapter || typeof adapter.run !== 'function') throw new Error('A compute adapter with a run() function is required.');
    this.adapters.set(clean(id, 200), adapter);
    return this;
  }

  registerNode(node) {
    this.nodes.push(node);
    return this;
  }

  plan(task, nodes = this.nodes) {
    return planComputePlacement(task, nodes);
  }

  async dispatch(taskInput, { nodes = this.nodes, signal = null, timeout_ms = this.defaultTimeoutMs } = {}) {
    const task = normalizeComputeTask(taskInput);
    const placement = planComputePlacement(task, nodes);
    if (placement.state !== 'placed') throw Object.assign(new Error('No compute provider satisfied the task requirements.'), { code: 'NO_COMPUTE_PLACEMENT', placement });
    const node = normalizeComputeNode(nodes.find(item => {
      const candidate = normalizeComputeNode(item);
      return candidate.provider_id === placement.selected.provider_id && candidate.node_id === placement.selected.node_id;
    }));
    verifyComputeAttestation(node);
    const adapterId = node.adapter_id || node.provider_id || node.kind;
    const adapter = this.adapters.get(adapterId) || this.adapters.get(node.kind);
    if (!adapter || typeof adapter.run !== 'function') throw Object.assign(new Error(`No injected adapter is registered for ${adapterId}.`), { code: 'ADAPTER_REQUIRED', adapter_id: adapterId });
    const aborter = new AbortController();
    if (signal) signal.aborted ? aborter.abort() : signal.addEventListener?.('abort', () => aborter.abort(), { once: true });
    const startedAt = new Date(this.clock()).toISOString();
    const redactedTask = redactSecrets(task);
    let lease = null;
    let cancelReason = null;
    let timeoutId = null;
    try {
      lease = typeof adapter.acquireLease === 'function'
        ? await adapter.acquireLease({ task: redactedTask, node, placement, attestation: node.attestation, signal: aborter.signal })
        : { lease_id: `lease_${digest({ task, node, startedAt }).slice(0, 16)}`, provider_id: node.provider_id, node_id: node.node_id, attestation_digest: node.attestation.digest };
      if (!lease?.lease_id || lease.node_id !== node.node_id || lease.attestation_digest !== node.attestation.digest) throw Object.assign(new Error('Provider lease does not match the selected attested node.'), { code: 'LEASE_ATTESTATION_MISMATCH' });
      const timeout = new Promise((_, reject) => {
        if (!timeout_ms || timeout_ms <= 0) return;
        timeoutId = setTimeout(() => {
          aborter.abort();
          reject(Object.assign(new Error('Compute dispatch timed out.'), { code: 'COMPUTE_TIMEOUT' }));
        }, timeout_ms);
        timeoutId?.unref?.();
      });
      const result = await Promise.race([adapter.run({ task: redactedTask, node, placement, lease, attestation: node.attestation, signal: aborter.signal }), timeout]);
      const body = this.#receipt({ status: result?.status || 'completed', task, node, adapterId, lease, placement, startedAt, artifacts: result?.artifacts, cost: result?.cost, result: result?.result });
      return Object.freeze({ ...body, receipt_digest: digest(body) });
    } catch (error) {
      cancelReason = error?.code || 'COMPUTE_DISPATCH_FAILED';
      if (error?.code === 'WORKER_LOST' && typeof adapter.recover === 'function') {
        const recovered = await adapter.recover({ task: redactedTask, node, placement, lease, attestation: node.attestation, error });
        const body = this.#receipt({ status: 'recovered', task, node, adapterId, lease, placement, startedAt, artifacts: recovered?.artifacts, cost: recovered?.cost, result: recovered?.result, recovery: { from: 'lost-worker', message: clean(error.message, 500) } });
        return Object.freeze({ ...body, receipt_digest: digest(body) });
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (lease && cancelReason && typeof adapter.cancelLease === 'function') await adapter.cancelLease({ lease, node, reason: cancelReason });
      if (lease && typeof adapter.releaseLease === 'function') await adapter.releaseLease({ lease, node });
    }
  }

  #receipt({ status, task, node, adapterId, lease, placement, startedAt, artifacts = [], cost, result = null, recovery = undefined }) {
    const body = {
      schema: COMPUTE_RECEIPT_SCHEMA,
      status,
      task_id: task.task_id,
      provider_id: node.provider_id,
      node_id: node.node_id,
      adapter_id: adapterId,
      lease_id: lease?.lease_id || null,
      placement_digest: placement.placement_digest,
      attestation_digest: node.attestation.digest,
      started_at: startedAt,
      finished_at: new Date(this.clock()).toISOString(),
      artifacts: (Array.isArray(artifacts) ? artifacts : []).map(artifact => ({ name: clean(artifact.name || 'artifact', 200), digest: verifyArtifactDigest(artifact) })).sort((a, b) => a.name.localeCompare(b.name)),
      cost: costReceipt(cost || {}, task),
      result: redactSecrets(result)
    };
    if (recovery) body.recovery = recovery;
    return body;
  }
}

export function createArchieComputeLadder(options = {}) {
  return new ArchieComputeLadder(options);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({ schema: 'archie-compute-discovery/v1', nodes: discoverLocalCompute().map(redactSecrets) }, null, 2));
}
