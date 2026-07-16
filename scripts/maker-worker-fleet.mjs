#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = clock => new Date(clock()).toISOString();
const unique = (values, limit = 200) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 200)).filter(Boolean))].slice(0, limit);
const finite = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
const number = Number(value);
return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const SECRET_KEY = /^(?:secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key)$|(?:^|[_-])(?:secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key)(?:$|[_-])/i;
const TOKEN_COUNT_KEY = /^(?:input|output|context|prompt|completion|total)_tokens?$/i;
const CREDENTIAL_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;
const WORKER_MODES = new Set(['github_actions', 'self_hosted', 'remote_http', 'in_process', 'local_control']);
const HEALTH = new Set(['healthy', 'degraded', 'offline', 'draining', 'quarantined', 'unknown']);
const IDENTITY = new Set(['attested', 'verified', 'unverified', 'unknown']);
const NETWORK_RANK = Object.freeze({ none: 0, restricted: 1, egress: 2, full: 3 });
const PRIVACY_RANK = Object.freeze({ public: 0, provider: 1, private: 2, local: 3 });
export class WorkerFleetError extends Error {
constructor(code, message, status = 400, detail = {}) {
super(message);
this.name = 'WorkerFleetError';
this.code = code;
this.status = status;
this.detail = detail;
}
}
export function redactFleetSecrets(value, depth = 0) {
if (depth > 12) return '[truncated]';
if (Array.isArray(value)) return value.slice(0, 300).map(item => redactFleetSecrets(item, depth + 1));
if (value && typeof value === 'object') {
return Object.fromEntries(Object.entries(value).slice(0, 400).map(([key, item]) => [
clean(key, 200),
SECRET_KEY.test(key) && !TOKEN_COUNT_KEY.test(key) ? '[redacted]' : redactFleetSecrets(item, depth + 1)
]));
}
if (typeof value === 'string') return clean(value.replace(CREDENTIAL_TEXT, '[redacted]'), 20000);
if (['number', 'boolean'].includes(typeof value) || value === null) return value;
return clean(value, 2000);
}
export function normalizeArtifactReferences(input = {}) {
const normalize = (value, kind) => {
if (!value || typeof value !== 'object') return null;
const digest = clean(value.digest, 200).toLowerCase();
if (digest && !/^[a-z0-9]+:[a-f0-9]{32,128}$/.test(digest)) {
throw new WorkerFleetError('artifact_digest_invalid', `invalid ${kind} digest`);
}
if ('content' in value || 'data' in value || 'bytes' in value) {
throw new WorkerFleetError('artifact_payload_denied', `${kind} receipts must reference payloads, not embed them`);
}
return Object.freeze({
kind,
name: clean(value.name || kind, 300),
uri: clean(value.uri || value.url, 2000),
digest,
size_bytes: Math.round(finite(value.size_bytes, 0, 0, 10 ** 12)),
retention: clean(value.retention || 'bounded', 100),
provenance: clean(value.provenance || 'worker-reported', 300)
});
};
return Object.freeze({
artifacts: (Array.isArray(input.artifacts) ? input.artifacts : []).map(value => normalize(value, 'artifact')).filter(Boolean).slice(0, 200),
logs: (Array.isArray(input.logs) ? input.logs : []).map(value => normalize(value, 'log')).filter(Boolean).slice(0, 200)
});
}
export function normalizeWorkerDescriptor(input = {}) {
const id = clean(input.id, 300);
const mode = clean(input.mode, 100).toLowerCase();
if (!id) throw new WorkerFleetError('worker_id_required', 'worker id is required');
if (!WORKER_MODES.has(mode)) throw new WorkerFleetError('worker_mode_invalid', `unsupported worker mode: ${mode}`);
const identityStatus = IDENTITY.has(clean(input.identity?.status, 40)) ? clean(input.identity.status, 40) : 'unknown';
const health = HEALTH.has(clean(input.health, 40)) ? clean(input.health, 40) : 'unknown';
const networkMode = clean(input.network?.mode || 'none', 40).toLowerCase();
const descriptor = {
schema: 'sideways-maker-worker/v1',
id,
display_name: clean(input.display_name || id, 200),
identity: {
status: identityStatus,
subject: clean(input.identity?.subject, 500),
attestation_digest: clean(input.identity?.attestation_digest, 200),
observed_at: clean(input.identity?.observed_at, 100)
},
mode,
platform: {
os: clean(input.platform?.os || 'unknown', 100).toLowerCase(),
architecture: clean(input.platform?.architecture || 'unknown', 100).toLowerCase()
},
labels: unique(input.labels),
capabilities: unique(input.capabilities),
toolchains: unique(input.toolchains),
providers: unique(input.providers),
models: unique(input.models),
network: {
mode: networkMode in NETWORK_RANK ? networkMode : 'none',
allowed_hosts: unique(input.network?.allowed_hosts)
},
isolation: {
container: input.isolation?.container === true,
sandbox: input.isolation?.sandbox === true,
ephemeral_workspace: input.isolation?.ephemeral_workspace !== false
},
resources: {
cpu: finite(input.resources?.cpu, 1, 0.1, 100000),
memory_mb: Math.round(finite(input.resources?.memory_mb, 1024, 1, 10 ** 9)),
disk_mb: Math.round(finite(input.resources?.disk_mb, 1024, 1, 10 ** 9)),
time_ms: Math.round(finite(input.resources?.time_ms, 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000))
},
concurrency: {
limit: Math.round(finite(input.concurrency?.limit, 1, 1, 100000)),
active: Math.round(finite(input.concurrency?.active, 0, 0, 100000)),
queue_depth: Math.round(finite(input.concurrency?.queue_depth, 0, 0, 10 ** 9))
},
region: clean(input.region || 'unknown', 100),
locality: clean(input.locality || 'remote', 100),
privacy: clean(input.privacy || 'provider', 100),
cost: {
per_minute_usd: finite(input.cost?.per_minute_usd, 0, 0, 10 ** 6),
per_job_usd: finite(input.cost?.per_job_usd, 0, 0, 10 ** 6)
},
latency_ms: Math.round(finite(input.latency_ms, 1000, 0, 10 ** 9)),
health,
reliability: {
successes: Math.round(finite(input.reliability?.successes, 0, 0, 10 ** 9)),
failures: Math.round(finite(input.reliability?.failures, 0, 0, 10 ** 9)),
lost: Math.round(finite(input.reliability?.lost, 0, 0, 10 ** 9))
},
operator_weight: finite(input.operator_weight, 0, -1000, 1000),
metadata: redactFleetSecrets(input.metadata || {}),
observed_at: clean(input.observed_at || new Date(0).toISOString(), 100)
};
const attestationValid = /^[a-z0-9]+:[a-f0-9]{32,128}$/.test(descriptor.identity.attestation_digest);
descriptor.identity.trusted = identityStatus === 'verified' || (identityStatus === 'attested' && attestationValid);
descriptor.descriptor_digest = hash(descriptor);
return Object.freeze(descriptor);
}
export function normalizeFleetTask(input = {}, clock = Date.now, id = randomUUID) {
const repository = clean(input.repository, 500);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
throw new WorkerFleetError('repository_invalid', 'repository must be owner/name');
}
const owner = clean(input.owner || repository.split('/')[0], 300);
const network = clean(input.network || 'none', 40).toLowerCase();
return Object.freeze({
schema: 'sideways-maker-fleet-task/v1',
id: clean(input.id || id(), 300),
owner,
repository,
backend: clean(input.backend || 'auto', 100),
priority: finite(input.priority, 50, 0, 100),
recovery: input.recovery === true,
created_at: clean(input.created_at || now(clock), 100),
capabilities: unique(input.capabilities),
labels: unique(input.labels),
toolchains: unique(input.toolchains),
providers: unique(input.providers),
models: unique(input.models),
modes: unique(input.modes),
platform: {
os: clean(input.platform?.os || 'any', 100).toLowerCase(),
architecture: clean(input.platform?.architecture || 'any', 100).toLowerCase()
},
network: network in NETWORK_RANK ? network : 'none',
allowed_hosts: unique(input.allowed_hosts),
isolation: {
container: input.isolation?.container === true,
sandbox: input.isolation?.sandbox === true,
ephemeral_workspace: input.isolation?.ephemeral_workspace !== false
},
resources: {
cpu: finite(input.resources?.cpu, 1, 0.1, 100000),
memory_mb: Math.round(finite(input.resources?.memory_mb, 512, 1, 10 ** 9)),
disk_mb: Math.round(finite(input.resources?.disk_mb, 512, 1, 10 ** 9)),
time_ms: Math.round(finite(input.resources?.time_ms, 30 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000))
},
region: clean(input.region || 'any', 100),
locality: clean(input.locality || 'any', 100),
privacy: clean(input.privacy || 'provider', 100),
max_cost_usd: finite(input.max_cost_usd, 10 ** 9, 0, 10 ** 9),
allow_unverified: input.allow_unverified === true,
retry_lost: input.retry_lost !== false,
max_attempts: Math.round(finite(input.max_attempts, 3, 1, 100)),
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
export function scoreWorker(worker, taskInput, options = {}) {
const task = taskInput.schema ? taskInput : normalizeFleetTask(taskInput);
const reasons = [];
if (!worker.identity.trusted && !task.allow_unverified) reasons.push('identity_unverified');
if (['offline', 'draining', 'quarantined', 'unknown'].includes(worker.health)) reasons.push(`worker_${worker.health}`);
if (task.modes.length && !task.modes.includes(worker.mode)) reasons.push('mode_mismatch');
if (task.platform.os !== 'any' && worker.platform.os !== task.platform.os) reasons.push('os_mismatch');
if (task.platform.architecture !== 'any' && worker.platform.architecture !== task.platform.architecture) reasons.push('architecture_mismatch');
if (!includesAll(worker.capabilities, task.capabilities)) reasons.push('capability_mismatch');
if (!includesAll(worker.labels, task.labels)) reasons.push('label_mismatch');
if (!includesAll(worker.toolchains, task.toolchains)) reasons.push('toolchain_mismatch');
if (!includesAll(worker.providers, task.providers)) reasons.push('provider_mismatch');
if (!includesAll(worker.models, task.models)) reasons.push('model_mismatch');
if ((NETWORK_RANK[worker.network.mode] || 0) < (NETWORK_RANK[task.network] || 0)) reasons.push('network_mismatch');
if (task.allowed_hosts.some(host => !worker.network.allowed_hosts.includes(host) && worker.network.mode !== 'full')) reasons.push('network_host_mismatch');
if (task.isolation.container && !worker.isolation.container) reasons.push('container_required');
if (task.isolation.sandbox && !worker.isolation.sandbox) reasons.push('sandbox_required');
if (task.isolation.ephemeral_workspace && !worker.isolation.ephemeral_workspace) reasons.push('ephemeral_workspace_required');
if (worker.resources.cpu < task.resources.cpu) reasons.push('cpu_insufficient');
if (worker.resources.memory_mb < task.resources.memory_mb) reasons.push('memory_insufficient');
if (worker.resources.disk_mb < task.resources.disk_mb) reasons.push('disk_insufficient');
if (worker.resources.time_ms < task.resources.time_ms) reasons.push('time_insufficient');
if (worker.concurrency.active >= worker.concurrency.limit) reasons.push('worker_capacity_exhausted');
if (task.region !== 'any' && worker.region !== task.region) reasons.push('region_mismatch');
if (task.locality !== 'any' && worker.locality !== task.locality) reasons.push('locality_mismatch');
if ((PRIVACY_RANK[worker.privacy] || 0) < (PRIVACY_RANK[task.privacy] || 0)) reasons.push('privacy_mismatch');
const estimatedCost = worker.cost.per_job_usd + ((task.resources.time_ms / 60000) * worker.cost.per_minute_usd);
if (estimatedCost > task.max_cost_usd) reasons.push('cost_ceiling');
if (options.quota_exhausted) reasons.push('quota_exhausted');
if (options.duplicate_active) reasons.push('duplicate_execution');
if (options.adapter_unavailable) reasons.push('adapter_unavailable');
if (reasons.length) return { eligible: false, score: -Infinity, reasons, estimated_cost_usd: estimatedCost };
let score = 1000;
score += reliabilityScore(worker);
score -= worker.concurrency.queue_depth * 20;
score -= worker.concurrency.active * 30;
score -= Math.round(worker.latency_ms / 10);
score -= Math.round(estimatedCost * 100);
score += (PRIVACY_RANK[worker.privacy] || 0) * 40;
score += worker.locality === 'local' ? 80 : 0;
score += worker.operator_weight;
if (worker.health === 'degraded') score -= 200;
if (task.recovery) score += worker.isolation.ephemeral_workspace ? 100 : 0;
return { eligible: true, score, reasons: [], estimated_cost_usd: estimatedCost };
}
export function rankWorkers(workers, task, options = {}) {
return workers.map(worker => ({ worker, ...scoreWorker(worker, task, options[worker.id] || {}) }))
.filter(value => value.eligible)
.sort((a, b) => b.score - a.score || a.worker.id.localeCompare(b.worker.id));
}
export function createWorkerAdapterRegistry() {
const adapters = new Map();
return Object.freeze({
register(input = {}) {
const mode = clean(input.mode, 100).toLowerCase();
if (!WORKER_MODES.has(mode)) throw new WorkerFleetError('adapter_mode_invalid', `unsupported adapter mode: ${mode}`);
if (adapters.has(mode)) throw new WorkerFleetError('adapter_duplicate', `adapter already registered: ${mode}`, 409);
const value = Object.freeze({
mode,
available: input.available === true && typeof input.dispatch === 'function',
reason: clean(input.reason, 1000),
dispatch: input.dispatch
});
adapters.set(mode, value);
return { mode, available: value.available, reason: value.available ? '' : (value.reason || 'transport unavailable') };
},
describe() {
return [...adapters.values()].map(value => ({
mode: value.mode,
available: value.available,
reason: value.available ? '' : (value.reason || 'transport unavailable')
})).sort((a, b) => a.mode.localeCompare(b.mode));
},
async dispatch(mode, packet) {
const adapter = adapters.get(clean(mode, 100).toLowerCase());
if (!adapter) throw new WorkerFleetError('adapter_not_found', `adapter not found: ${mode}`, 404);
if (!adapter.available) throw new WorkerFleetError('adapter_unavailable', adapter.reason || 'adapter unavailable', 503);
const output = await adapter.dispatch(clone(packet));
return redactFleetSecrets(output);
}
});
}
export function registerDefaultWorkerAdapters(registry, transports = {}) {
return [...WORKER_MODES].map(mode => registry.register({
mode,
available: typeof transports[mode] === 'function',
dispatch: transports[mode],
reason: `${mode} transport not configured`
}));
}
export function createWorkerFleet({
workers = [],
clock = Date.now,
id = randomUUID,
lease_ms = 5 * 60 * 1000,
starvation_ms = 10 * 60 * 1000,
recovery_reserve = 1,
quotas = {},
adapters = createWorkerAdapterRegistry()
} = {}) {
const registry = new Map();
const queue = new Map();
const executions = new Map();
const history = [];
const fences = new Map();
const usage = new Map();
for (const worker of workers) {
const value = normalizeWorkerDescriptor(worker);
registry.set(value.id, value);
}
function scopeKeys(task) {
return [`owner:${task.owner}`, `repository:${task.repository}`, `backend:${task.backend}`];
}
function quotaFor(key) {
const configured = quotas[key] || {};
return {
concurrency: Math.round(finite(configured.concurrency, 10 ** 9, 0, 10 ** 9)),
cost_usd: finite(configured.cost_usd, 10 ** 9, 0, 10 ** 9)
};
}
function usageFor(key) {
if (!usage.has(key)) usage.set(key, { active: 0, cost_usd: 0, completed: 0 });
return usage.get(key);
}
function quotaState(task, estimatedCost = 0) {
const exhausted = [];
for (const key of scopeKeys(task)) {
const limit = quotaFor(key);
const current = usageFor(key);
if (current.active >= limit.concurrency) exhausted.push({ key, dimension: 'concurrency' });
if (current.cost_usd + estimatedCost > limit.cost_usd) exhausted.push({ key, dimension: 'cost_usd' });
}
return exhausted;
}
function record(type, detail = {}) {
const event = Object.freeze({
schema: 'sideways-maker-fleet-event/v1',
sequence: history.length + 1,
type,
at: now(clock),
detail: redactFleetSecrets(detail)
});
history.push(event);
return event;
}
function register(input) {
const worker = normalizeWorkerDescriptor(input);
if (registry.has(worker.id)) throw new WorkerFleetError('worker_duplicate', `worker already registered: ${worker.id}`, 409);
registry.set(worker.id, worker);
record('worker.registered', { worker_id: worker.id, digest: worker.descriptor_digest });
return worker;
}
function replace(input) {
const worker = normalizeWorkerDescriptor(input);
registry.set(worker.id, worker);
record('worker.updated', { worker_id: worker.id, digest: worker.descriptor_digest });
return worker;
}
function setHealth(workerId, health, reason = '') {
const current = registry.get(clean(workerId, 300));
if (!current) throw new WorkerFleetError('worker_not_found', 'worker not found', 404);
const status = HEALTH.has(clean(health, 40)) ? clean(health, 40) : 'unknown';
const next = normalizeWorkerDescriptor({
...clone(current),
health: status,
metadata: { ...clone(current.metadata || {}), health_reason: clean(reason, 1000) },
observed_at: now(clock)
});
registry.set(next.id, next);
record(`worker.${status}`, { worker_id: next.id, reason });
return next;
}
function submit(input) {
const task = normalizeFleetTask(input, clock, id);
if (queue.has(task.id) || executions.has(task.id)) throw new WorkerFleetError('task_duplicate', `task already exists: ${task.id}`, 409);
const item = { task, state: 'queued', revision: 1, enqueued_at: now(clock), updated_at: now(clock), last_error: null };
queue.set(task.id, item);
record('task.queued', { task_id: task.id, owner: task.owner, repository: task.repository, priority: task.priority });
return clone(item);
}
function effectivePriority(item) {
const age = Math.max(0, clock() - Date.parse(item.enqueued_at));
const starvation = Math.floor(age / Math.max(1, starvation_ms));
return item.task.priority + Math.min(1000, starvation * 10) + (item.task.recovery ? 100 : 0);
}
function queuedTasks() {
return [...queue.values()].filter(item => item.state === 'queued').sort((a, b) => {
const priority = effectivePriority(b) - effectivePriority(a);
if (priority) return priority;
const ownerActiveA = usageFor(`owner:${a.task.owner}`).active;
const ownerActiveB = usageFor(`owner:${b.task.owner}`).active;
if (ownerActiveA !== ownerActiveB) return ownerActiveA - ownerActiveB;
return a.enqueued_at.localeCompare(b.enqueued_at) || a.task.id.localeCompare(b.task.id);
});
}
function placementOptions(task) {
const quota = quotaState(task);
const duplicate = executions.get(task.id)?.state === 'running';
const adapterState = Object.fromEntries(adapters.describe().map(value => [value.mode, value.available]));
return Object.fromEntries([...registry.values()].map(worker => {
const estimatedCost = worker.cost.per_job_usd + ((task.resources.time_ms / 60000) * worker.cost.per_minute_usd);
return [worker.id, {
quota_exhausted: quotaState(task, estimatedCost).length > 0,
duplicate_active: duplicate,
adapter_unavailable: adapterState[worker.mode] !== true
}];
}));
}
function classifyNoPlacement(task) {
const quota = quotaState(task);
if (quota.length) return { code: 'quota_exhausted', blockers: quota };
const workersList = [...registry.values()];
if (!workersList.length) return { code: 'capacity_unavailable', blockers: [] };
const options = placementOptions(task);
const reasons = workersList.map(worker => ({ worker_id: worker.id, reasons: scoreWorker(worker, task, options[worker.id] || {}).reasons }));
if (reasons.every(item => item.reasons.includes('identity_unverified'))) return { code: 'unverified_identity', blockers: reasons };
if (reasons.every(item => item.reasons.some(reason => reason.startsWith('worker_')))) return { code: 'unhealthy_worker', blockers: reasons };
if (reasons.every(item => item.reasons.includes('quota_exhausted'))) return { code: 'quota_exhausted', blockers: reasons };
if (reasons.every(item => item.reasons.includes('worker_capacity_exhausted'))) return { code: 'capacity_unavailable', blockers: reasons };
if (reasons.every(item => item.reasons.includes('adapter_unavailable'))) return { code: 'external_infrastructure_blocker', blockers: reasons };
return { code: 'capability_mismatch', blockers: reasons };
}
function place(taskInput) {
const task = taskInput.schema ? taskInput : normalizeFleetTask(taskInput, clock, id);
const ranked = rankWorkers([...registry.values()], task, placementOptions(task));
if (!ranked.length) {
const failure = classifyNoPlacement(task);
throw new WorkerFleetError(failure.code, 'no eligible worker', 503, failure);
}
const selected = ranked[0];
const receipt = {
schema: 'sideways-maker-placement/v1',
placement_id: id(),
task_id: task.id,
worker_id: selected.worker.id,
worker_mode: selected.worker.mode,
score: selected.score,
estimated_cost_usd: selected.estimated_cost_usd,
worker_digest: selected.worker.descriptor_digest,
task_digest: hash(task),
considered: ranked.map(value => ({ worker_id: value.worker.id, score: value.score })),
placed_at: now(clock),
receipt_digest: ''
};
receipt.receipt_digest = hash({ ...receipt, receipt_digest: undefined });
return Object.freeze(receipt);
}
async function schedule() {
const ordered = queuedTasks();
const recoveryWaiting = ordered.some(item => item.task.recovery);
const runningRecovery = [...executions.values()].filter(value => value.task.recovery && value.state === 'running').length;
const candidates = ordered.filter(item => {
if (item.task.recovery || !recoveryWaiting) return true;
const totalCapacity = [...registry.values()].reduce((sum, worker) => sum + worker.concurrency.limit, 0);
const active = [...executions.values()].filter(value => value.state === 'running').length;
return totalCapacity - active > Math.max(0, recovery_reserve - runningRecovery);
});
candidates.sort((a, b) => Number(b.task.recovery) - Number(a.task.recovery));
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
const lease = {
schema: 'sideways-maker-worker-lease/v1',
lease_id: id(),
task_id: item.task.id,
worker_id: worker.id,
token: id(),
fence,
claimed_at: now(clock),
expires_at: new Date(clock() + lease_ms).toISOString()
};
const execution = {
schema: 'sideways-maker-fleet-execution/v1',
task: item.task,
placement,
lease,
state: 'running',
revision: 1,
started_at: now(clock),
updated_at: now(clock),
result: null,
error: null,
dispatch: null
};
executions.set(item.task.id, execution);
item.state = 'running';
item.updated_at = now(clock);
queue.set(item.task.id, item);
for (const key of scopeKeys(item.task)) usageFor(key).active += 1;
const updatedWorker = normalizeWorkerDescriptor({
...clone(worker),
concurrency: { ...worker.concurrency, active: worker.concurrency.active + 1 }
});
registry.set(worker.id, updatedWorker);
const packet = {
schema: 'sideways-maker-worker-dispatch/v1',
task: item.task,
placement,
lease: { ...lease, token: '[leased-out-of-band]' }
};
try {
execution.dispatch = await adapters.dispatch(worker.mode, packet);
} catch (error) {
execution.dispatch = { ok: false, error: { code: error.code || 'dispatch_failed', message: clean(error.message, 1000) } };
}
record('task.scheduled', { task_id: item.task.id, worker_id: worker.id, fence, placement_id: placement.placement_id });
return clone(execution);
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
function releaseCapacity(execution, cost = 0) {
for (const key of scopeKeys(execution.task)) {
const current = usageFor(key);
current.active = Math.max(0, current.active - 1);
current.cost_usd += finite(cost, 0, 0, 10 ** 9);
current.completed += 1;
}
const worker = registry.get(execution.lease.worker_id);
if (worker) {
registry.set(worker.id, normalizeWorkerDescriptor({
...clone(worker),
concurrency: { ...worker.concurrency, active: Math.max(0, worker.concurrency.active - 1) }
}));
}
}
function complete(taskId, token, fence, input = {}) {
const execution = assertLease(taskId, token, fence);
const references = normalizeArtifactReferences(input.references || input);
const cost = finite(input.cost_usd, execution.placement.estimated_cost_usd, 0, 10 ** 9);
execution.state = 'completed';
execution.revision += 1;
execution.updated_at = now(clock);
execution.lease = { ...execution.lease, token: '[expired]' };
execution.result = {
schema: 'sideways-maker-fleet-usage/v1',
task_id: execution.task.id,
worker_id: execution.placement.worker_id,
cost_usd: cost,
duration_ms: Math.max(0, clock() - Date.parse(execution.started_at)),
references,
detail: redactFleetSecrets(input.detail || {})
};
releaseCapacity(execution, cost);
const queueItem = queue.get(execution.task.id);
if (queueItem) { queueItem.state = 'completed'; queueItem.revision += 1; queueItem.updated_at = now(clock); queue.set(execution.task.id, queueItem); }
executions.set(execution.task.id, execution);
record('task.completed', { task_id: execution.task.id, worker_id: execution.placement.worker_id, cost_usd: cost });
return clone(execution);
}
function fail(taskId, token, fence, input = {}) {
const execution = assertLease(taskId, token, fence);
execution.state = 'failed';
execution.revision += 1;
execution.updated_at = now(clock);
execution.lease = { ...execution.lease, token: '[expired]' };
execution.error = {
code: clean(input.code || 'worker_failed', 100),
message: clean(redactFleetSecrets(input.message || 'worker failed'), 2000),
recoverable: input.recoverable === true,
references: normalizeArtifactReferences(input.references || {})
};
releaseCapacity(execution, input.cost_usd);
executions.set(execution.task.id, execution);
record('task.failed', { task_id: execution.task.id, worker_id: execution.placement.worker_id, error: execution.error });
const item = queue.get(execution.task.id);
if (execution.error.recoverable && execution.task.attempt < execution.task.max_attempts) {
item.task = normalizeFleetTask({ ...execution.task, attempt: execution.task.attempt + 1, recovery: true }, clock, id);
item.state = 'queued';
} else {
item.state = 'failed';
}
item.revision += 1;
item.updated_at = now(clock);
item.last_error = execution.error;
queue.set(item.task.id, item);
return clone(execution);
}
function cancel(taskId, reason = '') {
const key = clean(taskId, 300);
const execution = executions.get(key);
const item = queue.get(key);
if (!execution && !item) throw new WorkerFleetError('task_not_found', 'task not found', 404);
if (execution?.state === 'running') {
releaseCapacity(execution, 0);
execution.state = 'cancelled';
execution.revision += 1;
execution.updated_at = now(clock);
execution.error = { code: 'cancelled', message: clean(reason || 'cancelled by operator', 1000), recoverable: false, references: normalizeArtifactReferences() };
execution.lease = { ...execution.lease, token: '[expired]' };
executions.set(key, execution);
}
if (item) {
item.state = 'cancelled';
item.revision += 1;
item.updated_at = now(clock);
queue.set(key, item);
}
record('task.cancelled', { task_id: key, reason });
return clone(execution || item);
}
function recoverExpired() {
const recovered = [];
for (const execution of executions.values()) {
if (execution.state !== 'running' || Date.parse(execution.lease.expires_at) > clock()) continue;
releaseCapacity(execution, 0);
execution.state = 'lost';
execution.revision += 1;
execution.updated_at = now(clock);
execution.error = { code: 'worker_lost', message: 'worker heartbeat expired', recoverable: execution.task.retry_lost, references: normalizeArtifactReferences() };
execution.lease = { ...execution.lease, token: '[expired]' };
executions.set(execution.task.id, execution);
const worker = registry.get(execution.placement.worker_id);
if (worker) registry.set(worker.id, normalizeWorkerDescriptor({ ...clone(worker), health: 'offline', reliability: { ...worker.reliability, lost: worker.reliability.lost + 1 } }));
if (execution.task.retry_lost && execution.task.attempt < execution.task.max_attempts) {
const item = queue.get(execution.task.id);
item.task = normalizeFleetTask({ ...execution.task, attempt: execution.task.attempt + 1, recovery: true }, clock, id);
item.state = 'queued';
item.revision += 1;
item.updated_at = now(clock);
item.last_error = execution.error;
queue.set(item.task.id, item);
recovered.push(item.task.id);
}
record('task.worker_lost', { task_id: execution.task.id, worker_id: execution.placement.worker_id, retried: recovered.includes(execution.task.id) });
}
return recovered;
}
function snapshot() {
const value = {
schema: 'sideways-maker-fleet-snapshot/v1',
workers: [...registry.values()].sort((a, b) => a.id.localeCompare(b.id)),
queue: [...queue.values()].sort((a, b) => a.task.id.localeCompare(b.task.id)),
executions: [...executions.values()].sort((a, b) => a.task.id.localeCompare(b.task.id)),
quotas: redactFleetSecrets(quotas),
usage: [...usage.entries()].sort(([a], [b]) => a.localeCompare(b)),
adapters: adapters.describe(),
events: clone(history),
observed_at: now(clock),
snapshot_digest: ''
};
value.snapshot_digest = hash({ ...value, snapshot_digest: undefined });
return Object.freeze(value);
}
return Object.freeze({
register,
replace,
getWorker: workerId => registry.get(clean(workerId, 300)) || null,
listWorkers: () => [...registry.values()].sort((a, b) => a.id.localeCompare(b.id)),
drain: (workerId, reason) => setHealth(workerId, 'draining', reason),
quarantine: (workerId, reason) => setHealth(workerId, 'quarantined', reason),
recoverWorker: (workerId, reason) => setHealth(workerId, 'healthy', reason),
submit,
place,
schedule,
heartbeat,
complete,
fail,
cancel,
recoverExpired,
getExecution: taskId => executions.has(clean(taskId, 300)) ? clone(executions.get(clean(taskId, 300))) : null,
getTask: taskId => queue.has(clean(taskId, 300)) ? clone(queue.get(clean(taskId, 300))) : null,
listQueue: () => queuedTasks().map(clone),
snapshot,
usage: () => Object.fromEntries([...usage.entries()].map(([key, value]) => [key, clone(value)])),
events: after => history.filter(event => event.sequence > (Number(after) || 0)).map(clone)
});
}
