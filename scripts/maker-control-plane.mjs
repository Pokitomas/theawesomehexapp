#!/usr/bin/env node
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const now = clock => new Date(clock()).toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = (values, limit = 100) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 200)).filter(Boolean))].slice(0, limit);
const choose = (value, allowed, fallback) => allowed.includes(clean(value, 100).toLowerCase()) ? clean(value, 100).toLowerCase() : fallback;
const finite = (value, fallback, min, max) => {
const number = Number(value);
return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteLength = value => new TextEncoder().encode(String(value ?? '')).byteLength;
const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key)/i;
const CREDENTIAL_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;
export function hashCredential(value) {
return createHash('sha256').update(String(value ?? '')).digest('hex');
}
function safeEqualHex(left, right) {
if (!/^[a-f0-9]{64}$/i.test(String(left)) || !/^[a-f0-9]{64}$/i.test(String(right))) return false;
return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
export function redactSecrets(value, depth = 0) {
if (depth > 12) return '[truncated]';
if (Array.isArray(value)) return value.slice(0, 200).map(item => redactSecrets(item, depth + 1));
if (isObject(value)) {
return Object.fromEntries(Object.entries(value).slice(0, 300).map(([key, item]) => [
clean(key, 200),
SECRET_KEY.test(key) ? '[redacted]' : redactSecrets(item, depth + 1)
]));
}
if (typeof value === 'string') return clean(value.replace(CREDENTIAL_TEXT, '[redacted]'), 20000);
if (['number', 'boolean'].includes(typeof value) || value === null) return value;
return clean(value, 2000);
}
export function normalizeEvidenceReferences(input = {}) {
const normalizeReference = (value, kind) => {
if (!isObject(value)) return null;
const digestValue = clean(value.digest, 200).toLowerCase();
return Object.freeze({
kind,
name: clean(value.name || value.filename || kind, 300),
uri: clean(value.uri || value.url, 2000),
digest: /^[a-z0-9]+:[a-f0-9]{32,128}$/.test(digestValue) ? digestValue : '',
size_bytes: Math.round(finite(value.size_bytes, 0, 0, 10 ** 12)),
retention: clean(value.retention || 'bounded', 100),
provenance: clean(value.provenance || 'worker-reported', 300)
});
};
return Object.freeze({
artifacts: (Array.isArray(input.artifacts) ? input.artifacts : []).map(value => normalizeReference(value, 'artifact')).filter(Boolean).slice(0, 100),
logs: (Array.isArray(input.logs) ? input.logs : []).map(value => normalizeReference(value, 'log')).filter(Boolean).slice(0, 100)
});
}
export function normalizeBudgets(input = {}) {
return Object.freeze({
requests: Math.round(finite(input.requests, 100, 1, 1000000)),
tokens: Math.round(finite(input.tokens, 1000000, 1, 10 ** 12)),
cost_usd: finite(input.cost_usd, 100, 0, 10 ** 9),
wall_time_ms: Math.round(finite(input.wall_time_ms, 6 * 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000)),
write_bytes: Math.round(finite(input.write_bytes, 10 * 1024 * 1024, 0, 10 ** 12))
});
}
export function normalizeWorkerResult(input = {}) {
const serialized = JSON.stringify(input ?? {});
if (byteLength(serialized) > 1024 * 1024) {
throw new MakerControlError('result_too_large', 'worker result exceeds one-megabyte receipt limit', 413);
}
const safe = redactSecrets(isObject(input) ? input : { value: input });
const references = normalizeEvidenceReferences(input.references || {
artifacts: input.artifacts,
logs: input.logs
});
return Object.freeze({
...safe,
references
});
}
export function normalizeWorkerError(input = {}) {
return Object.freeze({
code: clean(input.code || 'worker_failed', 100),
message: clean(redactSecrets(input.message || 'worker failed'), 4000),
recoverable: input.recoverable === true,
references: normalizeEvidenceReferences(input.references || {
artifacts: input.artifacts,
logs: input.logs
})
});
}
export function formatSseEvents(events = []) {
return events.map(event => [
`id: ${event.sequence}`,
`event: ${event.type}`,
`data: ${JSON.stringify(redactSecrets(event))}`,
''
].join('\n')).join('\n');
}
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
const target_repository = clean(input.target_repository || input.repository, 500);
const control_repository = clean(input.control_repository || target_repository, 500);
const head_repository = clean(input.head_repository || target_repository, 500);
const request = clean(input.request, 12000);
const base_revision = clean(input.base_revision || input.base || 'main', 200);
const mode = clean(input.mode || 'build', 40).toLowerCase();
for (const [name, repository] of Object.entries({ control_repository, target_repository, head_repository })) {
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
throw new MakerControlError('invalid_repository', `${name} must be owner/name`);
}
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
control_repository,
target_repository,
head_repository,
repository: target_repository,
base_revision,
mode,
request,
protect: clean(input.protect, 6000),
proof: clean(input.proof, 6000),
backend: clean(input.backend || 'auto', 100),
priority: finite(input.priority, 50, 0, 100),
idempotency_key: clean(input.idempotency_key, 300),
budgets: normalizeBudgets(input.budgets),
references: normalizeEvidenceReferences(input.references),
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
task: {
control_repository: job.request.control_repository,
target_repository: job.request.target_repository,
head_repository: job.request.head_repository,
base_revision: job.request.base_revision,
mode: job.request.mode,
backend: job.request.backend,
budgets: job.request.budgets
},
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
temporary_grants: (job.temporary_grants || []).map(grant => ({
grant_id: grant.grant_id,
capability: grant.capability,
level: grant.level,
expires_at: grant.expires_at
})),
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
export function createControlAuthenticator(config = {}) {
const bearerDigests = new Set(unique(config.bearer_digests, 1000).map(value => value.toLowerCase()));
const apiKeyDigests = new Set(unique(config.api_key_digests, 1000).map(value => value.toLowerCase()));
const mtlsSubjects = new Set(unique(config.mtls_subjects, 1000));
const githubSubjects = new Set(unique(config.github_subjects, 1000));
const allowAnonymous = config.allow_anonymous === true;
const allowLoopback = config.allow_loopback !== false;
return async function authenticate(request) {
const url = new URL(request.url);
const hostname = url.hostname.replace(/^\[|\]$/g, '');
if (allowLoopback && ['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
return Object.freeze({ method: 'loopback', subject: hostname, scopes: ['control'] });
}
const authorization = clean(request.headers.get('authorization'), 10000);
if (authorization.toLowerCase().startsWith('bearer ')) {
const supplied = hashCredential(authorization.slice(7));
const accepted = [...bearerDigests].some(expected => safeEqualHex(supplied, expected));
if (accepted) return Object.freeze({ method: 'bearer', subject: `bearer:${supplied.slice(0, 12)}`, scopes: ['control'] });
}
const apiKey = request.headers.get('x-maker-api-key');
if (apiKey) {
const supplied = hashCredential(apiKey);
const accepted = [...apiKeyDigests].some(expected => safeEqualHex(supplied, expected));
if (accepted) return Object.freeze({ method: 'api_key', subject: `key:${supplied.slice(0, 12)}`, scopes: ['control'] });
}
const githubSubject = clean(request.headers.get('x-maker-github-subject'), 1000);
if (githubSubject && githubSubjects.has(githubSubject)) {
return Object.freeze({ method: 'github_identity', subject: githubSubject, scopes: ['control'] });
}
const mtlsSubject = clean(request.headers.get('x-maker-mtls-subject'), 1000);
if (mtlsSubject && mtlsSubjects.has(mtlsSubject)) {
return Object.freeze({ method: 'mtls', subject: mtlsSubject, scopes: ['control'] });
}
if (allowAnonymous) return Object.freeze({ method: 'anonymous', subject: 'anonymous', scopes: ['read'] });
throw new MakerControlError('unauthorized', 'valid control-plane identity required', 401);
};
}
export function createWorkerAdapterRegistry({ clock = Date.now, timeout_ms = 5 * 60 * 1000 } = {}) {
const adapters = new Map();
function register(input = {}) {
const id = clean(input.id, 200);
if (!id) throw new MakerControlError('invalid_adapter', 'adapter id is required');
if (adapters.has(id)) throw new MakerControlError('duplicate_adapter', `adapter ${id} already registered`, 409);
const descriptor = Object.freeze({
id,
kind: clean(input.kind || 'custom', 100),
available: input.available === true && typeof input.invoke === 'function',
capabilities: unique(input.capabilities, 100),
reason: clean(input.reason, 1000),
invoke: input.invoke
});
adapters.set(id, descriptor);
return describeOne(descriptor);
}
function describeOne(adapter) {
return Object.freeze({
id: adapter.id,
kind: adapter.kind,
available: adapter.available,
capabilities: adapter.capabilities,
reason: adapter.available ? '' : (adapter.reason || 'adapter transport unavailable')
});
}
function describe() {
return [...adapters.values()].map(describeOne).sort((a, b) => a.id.localeCompare(b.id));
}
async function dispatch(adapterId, job, context = {}) {
const adapter = adapters.get(clean(adapterId, 200));
if (!adapter) throw new MakerControlError('adapter_not_found', 'worker adapter not found', 404);
if (!adapter.available) throw new MakerControlError('adapter_unavailable', adapter.reason || 'worker adapter unavailable', 503);
const startedAt = now(clock);
let timer;
try {
const output = await Promise.race([
Promise.resolve(adapter.invoke(structuredClone(job), redactSecrets(context))),
new Promise((_, reject) => {
timer = setTimeout(() => reject(new MakerControlError('adapter_timeout', 'worker adapter timed out', 504)), timeout_ms);
timer.unref?.();
})
]);
return Object.freeze({
schema: 'sideways-maker-adapter-receipt/v1',
adapter: describeOne(adapter),
job_id: job.id,
started_at: startedAt,
finished_at: now(clock),
ok: true,
output: redactSecrets(output)
});
} catch (error) {
return Object.freeze({
schema: 'sideways-maker-adapter-receipt/v1',
adapter: describeOne(adapter),
job_id: job.id,
started_at: startedAt,
finished_at: now(clock),
ok: false,
error: {
code: clean(error.code || 'adapter_failed', 100),
message: clean(redactSecrets(error.message), 2000)
}
});
} finally {
clearTimeout(timer);
}
}
return Object.freeze({ register, describe, dispatch });
}
export function registerDefaultWorkerAdapters(registry, dependencies = {}) {
const definitions = [
{
id: 'in-process',
kind: 'in_process',
capabilities: ['library', 'local'],
invoke: dependencies.in_process,
reason: 'in-process executor not configured'
},
{
id: 'child-process',
kind: 'child_process',
capabilities: ['process', 'local'],
invoke: dependencies.child_process,
reason: 'child worker launcher not configured'
},
{
id: 'github-issue',
kind: 'github_issue',
capabilities: ['github', 'issue_dispatch'],
invoke: dependencies.github_issue,
reason: 'GitHub issue transport not configured'
},
{
id: 'github-workflow',
kind: 'github_workflow',
capabilities: ['github', 'workflow_dispatch'],
invoke: dependencies.github_workflow,
reason: 'GitHub workflow transport not configured'
},
{
id: 'remote-http',
kind: 'remote_http',
capabilities: ['remote', 'http'],
invoke: dependencies.remote_http,
reason: 'remote HTTP worker not configured'
}
];
return definitions.map(definition => registry.register({
...definition,
available: typeof definition.invoke === 'function'
}));
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
async replaceSnapshot(snapshot = {}) {
jobs.clear();
for (const [key, value] of snapshot.jobs || []) jobs.set(key, structuredClone(value));
events.length = 0;
for (const event of snapshot.events || []) events.push(structuredClone(event));
},
async snapshot() {
return {
schema: 'sideways-maker-control-snapshot/v2',
jobs: [...jobs.entries()].map(([key, value]) => [key, structuredClone(value)]),
events: structuredClone(events)
};
}
};
}
function migrateJob(input, clock = Date.now) {
const job = structuredClone(input || {});
job.schema = 'sideways-maker-control-job/v1';
job.attempt = Math.max(1, Number(job.attempt || 1));
job.parent_job_id = clean(job.parent_job_id, 200) || null;
job.runtime = job.runtime || null;
job.lease = job.lease || null;
if (job.lease && !job.lease.runtime_id) job.lease.runtime_id = clean(job.runtime?.runtime_id || job.lease.worker_id, 300);
job.result = job.result ?? null;
job.error = job.error ?? null;
job.adapter = job.adapter ?? null;
job.rollback = job.rollback ?? null;
job.temporary_grants = Array.isArray(job.temporary_grants) ? job.temporary_grants : [];
job.control_actions = Array.isArray(job.control_actions) ? job.control_actions : [];
job.created_at = clean(job.created_at || now(clock), 100);
job.updated_at = clean(job.updated_at || job.created_at, 100);
if (!job.request?.runtime_requirements || !job.request?.budgets || !job.request?.references) {
job.request = normalizeControlRequest(job.request || {});
}
return job;
}
export function migrateControlSnapshot(snapshot = {}, clock = Date.now) {
const jobs = (snapshot.jobs || []).map(([key, value]) => {
const job = migrateJob(value, clock);
return [clean(key || job.id, 200), job];
});
const events = (Array.isArray(snapshot.events) ? snapshot.events : []).map(event => ({
schema: 'sideways-maker-control-event/v1',
sequence: Number(event.sequence) || 0,
event_id: clean(event.event_id || `migrated-${event.sequence}`, 300),
job_id: clean(event.job_id, 200),
type: clean(event.type || 'job.migrated', 100),
at: clean(event.at || now(clock), 100),
state: clean(event.state || 'queued', 40),
revision: Math.max(1, Number(event.revision) || 1),
detail: redactSecrets(event.detail || {})
}));
return Object.freeze({
schema: 'sideways-maker-control-snapshot/v2',
jobs,
events
});
}
export function createMakerControlPlane({
store = createMemoryControlStore(),
clock = Date.now,
id = randomUUID,
lease_ms = 5 * 60 * 1000,
max_jobs = 1000,
max_events = 10000,
max_running = 8,
adapters = createWorkerAdapterRegistry({ clock }),
version = '0.2.0',
backends = ['auto']
} = {}) {
let sequence = 0;
let initialized = false;
let closed = false;
function assertOpen() {
if (closed) throw new MakerControlError('control_closed', 'control plane is shutting down', 503);
}
async function initialize() {
if (initialized) return;
if (typeof store.snapshot === 'function' && typeof store.replaceSnapshot === 'function') {
const migrated = migrateControlSnapshot(await store.snapshot(), clock);
await store.replaceSnapshot(migrated);
}
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
detail: redactSecrets(detail)
});
const all = await store.listEvents(0);
if (all.length >= max_events) throw new MakerControlError('event_capacity', 'event capacity reached', 503);
await store.appendEvent(event);
return event;
}
async function submit(input) {
assertOpen();
await initialize();
const request = normalizeControlRequest(input);
const jobs = await store.listJobs();
if (request.idempotency_key) {
const existing = jobs.find(job => job.request.idempotency_key === request.idempotency_key);
if (existing) {
if (existing.request_digest !== digest(request)) {
throw new MakerControlError('idempotency_conflict', 'idempotency key already represents another request', 409);
}
return existing;
}
}
if (jobs.length >= max_jobs) throw new MakerControlError('job_capacity', 'job capacity reached', 503);
const stamp = now(clock);
const job = {
schema: 'sideways-maker-control-job/v1',
id: id(),
state: 'queued',
revision: 1,
attempt: 1,
parent_job_id: null,
request,
request_digest: digest(request),
created_at: stamp,
updated_at: stamp,
lease: null,
runtime: null,
adapter: null,
result: null,
error: null,
rollback: null,
temporary_grants: [],
control_actions: []
};
await store.putJob(job);
await emit('job.queued', job, {
priority: request.priority,
runtime_requirements: request.runtime_requirements,
budgets: request.budgets
});
return structuredClone(job);
}
async function get(jobId) {
await initialize();
const job = await store.getJob(clean(jobId, 200));
if (!job) throw new MakerControlError('job_not_found', 'job not found', 404);
return structuredClone(job);
}
async function view(jobId) {
return projectJobForUser(await get(jobId));
}
async function claim(worker = {}) {
assertOpen();
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
const allJobs = await store.listJobs();
const activeRunning = allJobs.filter(job => job.state === 'running' && Date.parse(job.lease?.expires_at || 0) > stamp);
if (activeRunning.length >= max_running) return null;
const jobs = allJobs
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
assertOpen();
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
job.result = normalizeWorkerResult(payload);
job.lease = null;
} else if (transition === 'fail') {
job.state = 'failed';
job.error = normalizeWorkerError(payload);
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
assertOpen();
const job = await get(jobId);
if (['completed', 'failed', 'cancelled'].includes(job.state)) return job;
job.state = 'cancelled';
job.revision += 1;
job.updated_at = now(clock);
job.lease = null;
job.error = normalizeWorkerError({
code: 'cancelled',
message: reason || 'cancelled by operator',
recoverable: false
});
await store.putJob(job);
await emit('job.cancelled', job, { reason: job.error.message });
return structuredClone(job);
}
async function list(filter = {}) {
await initialize();
const state = clean(filter.state, 40);
const repository = clean(filter.repository, 500);
const values = (await store.listJobs())
.filter(job => !state || job.state === state)
.filter(job => !repository || job.request.repository === repository)
.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
return values.map(job => structuredClone(job));
}
async function resume(jobId, options = {}) {
assertOpen();
const job = await get(jobId);
if (!['failed', 'cancelled'].includes(job.state)) {
throw new MakerControlError('invalid_state', 'only failed or cancelled jobs can resume', 409);
}
if (job.state === 'failed' && job.error && !job.error.recoverable && options.force !== true) {
throw new MakerControlError('not_recoverable', 'job failure is not marked recoverable', 409);
}
job.state = 'queued';
job.revision += 1;
job.updated_at = now(clock);
job.lease = null;
job.error = null;
job.control_actions.push({
type: 'resume',
at: job.updated_at,
reason: clean(options.reason || 'operator resume', 1000)
});
await store.putJob(job);
await emit('job.resumed', job, { reason: options.reason || 'operator resume' });
return structuredClone(job);
}
async function retry(jobId, options = {}) {
assertOpen();
const source = await get(jobId);
const attempt = Math.max(1, Number(source.attempt || 1)) + 1;
const originalKey = source.request.idempotency_key || source.id;
const retried = await submit({
...source.request,
idempotency_key: `${originalKey}:retry:${attempt}`,
priority: options.priority ?? source.request.priority
});
retried.attempt = attempt;
retried.parent_job_id = source.id;
retried.control_actions.push({
type: 'retry',
at: now(clock),
reason: clean(options.reason || 'operator retry', 1000)
});
await store.putJob(retried);
await emit('job.retried', retried, { parent_job_id: source.id, attempt });
return structuredClone(retried);
}
async function requestRollback(jobId, options = {}) {
assertOpen();
const job = await get(jobId);
const target = clean(
options.target || job.result?.commit || job.result?.base_revision || job.request.base_revision,
500
);
if (!target) throw new MakerControlError('rollback_target_missing', 'rollback target unavailable', 409);
job.rollback = {
schema: 'sideways-maker-rollback-plan/v1',
requested_at: now(clock),
requested_by: clean(options.requested_by || 'operator', 300),
reason: clean(options.reason || 'operator rollback request', 2000),
target,
execute: false,
authority: 'approval_required'
};
job.revision += 1;
job.updated_at = now(clock);
job.control_actions.push({ type: 'rollback', ...job.rollback });
await store.putJob(job);
await emit('job.rollback_requested', job, job.rollback);
return structuredClone(job.rollback);
}
async function approveTemporaryGrant(jobId, input = {}) {
assertOpen();
const job = await get(jobId);
const capability = clean(input.capability, 100).toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
const level = choose(input.level, CAPABILITY_LEVELS, 'none');
if (!capability || level === 'none') {
throw new MakerControlError('invalid_grant', 'capability and non-none level are required');
}
const ttlMs = Math.round(finite(input.ttl_ms, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000));
const grant = {
schema: 'sideways-maker-temporary-grant/v1',
grant_id: id(),
capability,
level,
approved_by: clean(input.approved_by || 'operator', 300),
justification: clean(input.justification, 2000),
issued_at: now(clock),
expires_at: new Date(clock() + ttlMs).toISOString()
};
grant.digest = digest(grant);
job.temporary_grants.push(grant);
job.revision += 1;
job.updated_at = now(clock);
job.control_actions.push({ type: 'temporary_grant', grant_id: grant.grant_id, at: grant.issued_at });
await store.putJob(job);
await emit('job.grant_approved', job, {
grant_id: grant.grant_id,
capability,
level,
expires_at: grant.expires_at
});
return structuredClone(grant);
}
async function dispatch(jobId, adapterId, context = {}) {
assertOpen();
const job = await get(jobId);
const receipt = await adapters.dispatch(adapterId, job, context);
job.adapter = receipt;
job.revision += 1;
job.updated_at = now(clock);
job.control_actions.push({
type: 'dispatch',
adapter: clean(adapterId, 200),
at: job.updated_at,
ok: receipt.ok
});
await store.putJob(job);
await emit(receipt.ok ? 'job.dispatched' : 'job.dispatch_failed', job, receipt);
return structuredClone(receipt);
}
async function events(after = 0) {
await initialize();
return store.listEvents(Number(after) || 0);
}
async function exportReceipt(jobId) {
const job = await get(jobId);
const relatedEvents = (await events()).filter(event => event.job_id === job.id);
return Object.freeze({
schema: 'sideways-maker-export/v1',
exported_at: now(clock),
job: redactSecrets(job),
presentation: projectJobForUser(job),
events: redactSecrets(relatedEvents),
digest: digest({ job: redactSecrets(job), events: redactSecrets(relatedEvents) })
});
}
async function importSnapshot(snapshot, options = {}) {
assertOpen();
if (typeof store.replaceSnapshot !== 'function') {
throw new MakerControlError('import_unavailable', 'store does not support snapshot import', 501);
}
const current = await store.listJobs();
if (current.length && options.replace !== true) {
throw new MakerControlError('import_conflict', 'store is not empty; explicit replace required', 409);
}
const migrated = migrateControlSnapshot(snapshot, clock);
await store.replaceSnapshot(migrated);
initialized = false;
await initialize();
return status();
}
async function recoverOrphans() {
assertOpen();
await initialize();
const stamp = clock();
const recovered = [];
for (const job of await store.listJobs()) {
if (job.state !== 'running' || Date.parse(job.lease?.expires_at || 0) > stamp) continue;
job.state = 'queued';
job.revision += 1;
job.updated_at = now(clock);
const previous = job.lease;
job.lease = null;
job.error = normalizeWorkerError({
code: 'orphan_recovered',
message: 'expired worker lease returned to queue',
recoverable: true
});
await store.putJob(job);
await emit('job.orphan_recovered', job, {
previous_worker: previous?.worker_id || null,
previous_runtime: previous?.runtime_id || null
});
recovered.push(job.id);
}
return recovered;
}
async function status() {
await initialize();
const jobs = await store.listJobs();
const counts = Object.fromEntries(
['queued', 'running', 'completed', 'failed', 'cancelled'].map(state => [
state,
jobs.filter(job => job.state === state).length
])
);
return Object.freeze({
schema: 'sideways-maker-control-status/v1',
version,
ready: !closed,
closed,
queue: { ...counts, total: jobs.length, max_jobs, max_running },
workers: jobs
.filter(job => job.state === 'running')
.map(job => ({
job_id: job.id,
worker_id: job.lease?.worker_id || null,
runtime: publicRuntimeSummary(job.runtime),
lease_expires_at: job.lease?.expires_at || null
})),
adapters: adapters.describe(),
backends: unique(backends, 100),
capabilities: [
'submit', 'inspect', 'list', 'watch', 'resume', 'cancel', 'rollback',
'temporary_grant', 'retry', 'export', 'import', 'health', 'capabilities',
'runtime_profiles', 'public_projection', 'lease_recovery', 'sse'
],
at: now(clock)
});
}
async function capabilities() {
const value = await status();
return {
schema: 'sideways-maker-control-capabilities/v1',
version: value.version,
commands: value.capabilities,
adapters: value.adapters,
backends: value.backends,
limits: { max_jobs, max_running, max_events, lease_ms }
};
}
async function close() {
closed = true;
return {
schema: 'sideways-maker-control-shutdown/v1',
closed_at: now(clock),
snapshot: await store.snapshot()
};
}
return Object.freeze({
submit,
get,
view,
list,
claim,
dispatch,
heartbeat: (jobId, token) => mutate(jobId, token, 'heartbeat'),
complete: (jobId, token, result) => mutate(jobId, token, 'complete', result),
fail: (jobId, token, error) => mutate(jobId, token, 'fail', error),
resume,
retry,
rollback: requestRollback,
approveTemporaryGrant,
cancel,
events,
watch: events,
exportReceipt,
importSnapshot,
recoverOrphans,
status,
health: status,
capabilities,
close,
snapshot: () => store.snapshot()
});
}
export function createControlHttpHandler(control, options = {}) {
const clock = options.clock || Date.now;
const authenticator = options.authenticator || createControlAuthenticator({
allow_loopback: true,
allow_anonymous: true
});
const allowedOrigins = new Set(unique(options.allowed_origins, 1000));
const csrfDigests = new Set(unique(options.csrf_digests, 1000).map(value => value.toLowerCase()));
const maxBodyBytes = Math.round(finite(options.max_body_bytes, 1024 * 1024, 0, 100 * 1024 * 1024));
const timeoutMs = Math.round(finite(options.timeout_ms, 30 * 1000, 100, 30 * 60 * 1000));
const rateWindowMs = Math.round(finite(options.rate_window_ms, 60 * 1000, 1000, 24 * 60 * 60 * 1000));
const rateLimit = Math.round(finite(options.rate_limit, 120, 1, 1000000));
const replayWindowMs = Math.round(finite(options.replay_window_ms, 5 * 60 * 1000, 1000, 24 * 60 * 60 * 1000));
const requireReplayId = options.require_replay_id === true;
const enforceScopes = options.enforce_scopes === true;
const rate = new Map();
const replay = new Map();
function corsHeaders(origin) {
const headers = {
'cache-control': 'no-store',
'x-content-type-options': 'nosniff'
};
if (origin && allowedOrigins.has(origin)) {
headers['access-control-allow-origin'] = origin;
headers.vary = 'origin';
}
return headers;
}
function cleanWindows(map, threshold) {
for (const [key, value] of map) {
const stamp = typeof value === 'number' ? value : value.started_at;
if (stamp < threshold) map.delete(key);
}
}
function enforceRate(subject) {
const stamp = clock();
cleanWindows(rate, stamp - rateWindowMs);
const current = rate.get(subject);
if (!current || current.started_at < stamp - rateWindowMs) {
rate.set(subject, { started_at: stamp, count: 1 });
return;
}
current.count += 1;
if (current.count > rateLimit) throw new MakerControlError('rate_limited', 'control-plane rate limit exceeded', 429);
}
function enforceReplay(request) {
if (!requireReplayId || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
const stamp = clock();
cleanWindows(replay, stamp - replayWindowMs);
const requestId = clean(request.headers.get('x-maker-request-id'), 300);
if (!requestId) throw new MakerControlError('replay_id_required', 'x-maker-request-id is required', 400);
if (replay.has(requestId)) throw new MakerControlError('replay_detected', 'request id already used', 409);
replay.set(requestId, stamp);
}
function enforceOrigin(request) {
const origin = clean(request.headers.get('origin'), 2000);
if (!origin) return '';
if (!allowedOrigins.has(origin)) throw new MakerControlError('origin_denied', 'request origin is not allowed', 403);
return origin;
}
function enforceCsrf(request, origin) {
if (!origin || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) || csrfDigests.size === 0) return;
const supplied = hashCredential(request.headers.get('x-maker-csrf') || '');
const accepted = [...csrfDigests].some(expected => safeEqualHex(supplied, expected));
if (!accepted) throw new MakerControlError('csrf_denied', 'valid CSRF token required', 403);
}
async function parseBody(request) {
if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return {};
const contentType = clean(request.headers.get('content-type'), 200).toLowerCase();
if (contentType && !contentType.includes('application/json')) {
throw new MakerControlError('content_type_denied', 'application/json is required', 415);
}
const declared = Number(request.headers.get('content-length') || 0);
if (declared > maxBodyBytes) throw new MakerControlError('request_too_large', 'request body exceeds limit', 413);
const raw = await request.text();
if (byteLength(raw) > maxBodyBytes) throw new MakerControlError('request_too_large', 'request body exceeds limit', 413);
if (!raw.trim()) return {};
try {
return JSON.parse(raw);
} catch {
throw new MakerControlError('invalid_json', 'request body is not valid JSON');
}
}
async function withTimeout(promise) {
let timer;
try {
return await Promise.race([
promise,
new Promise((_, reject) => {
timer = setTimeout(() => reject(new MakerControlError('request_timeout', 'control-plane request timed out', 504)), timeoutMs);
timer.unref?.();
})
]);
} finally {
clearTimeout(timer);
}
}
async function route(request, body) {
const url = new URL(request.url);
const parts = url.pathname.split('/').filter(Boolean);
if (request.method === 'GET' && url.pathname === '/v1/health') return control.health();
if (request.method === 'GET' && url.pathname === '/v1/status') return control.status();
if (request.method === 'GET' && url.pathname === '/v1/capabilities') return control.capabilities();
if (request.method === 'GET' && url.pathname === '/v1/jobs') {
return control.list({
state: url.searchParams.get('state'),
repository: url.searchParams.get('repository')
});
}
if (request.method === 'POST' && url.pathname === '/v1/jobs') return control.submit(body);
if (request.method === 'POST' && url.pathname === '/v1/claims') return control.claim(body);
if (request.method === 'POST' && url.pathname === '/v1/import') {
return control.importSnapshot(body.snapshot || body, { replace: body.replace === true });
}
if (request.method === 'POST' && url.pathname === '/v1/recover') return control.recoverOrphans();
if (request.method === 'POST' && url.pathname === '/v1/shutdown') return control.close();
if (request.method === 'GET' && url.pathname === '/v1/events') {
return control.events(url.searchParams.get('after'));
}
if (parts[0] === 'v1' && parts[1] === 'jobs' && parts[2]) {
const jobId = parts[2];
const action = parts[3];
if (request.method === 'GET' && action === 'presentation') return control.view(jobId);
if (request.method === 'GET' && action === 'export') return control.exportReceipt(jobId);
if (request.method === 'GET' && !action) return control.get(jobId);
if (request.method === 'POST' && action === 'heartbeat') return control.heartbeat(jobId, body.lease_token);
if (request.method === 'POST' && action === 'complete') return control.complete(jobId, body.lease_token, body.result || {});
if (request.method === 'POST' && action === 'fail') return control.fail(jobId, body.lease_token, body.error || {});
if (request.method === 'POST' && action === 'cancel') return control.cancel(jobId, body.reason);
if (request.method === 'POST' && action === 'resume') return control.resume(jobId, body);
if (request.method === 'POST' && action === 'retry') return control.retry(jobId, body);
if (request.method === 'POST' && action === 'rollback') return control.rollback(jobId, body);
if (request.method === 'POST' && action === 'grants') return control.approveTemporaryGrant(jobId, body);
if (request.method === 'POST' && action === 'dispatch') return control.dispatch(jobId, body.adapter, body.context || {});
}
throw new MakerControlError('not_found', 'route not found', 404);
}
return async function handle(request) {
let origin = '';
try {
origin = enforceOrigin(request);
if (request.method === 'OPTIONS') {
return new Response(null, {
status: 204,
headers: {
...corsHeaders(origin),
'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
'access-control-allow-headers': 'authorization,content-type,x-maker-api-key,x-maker-csrf,x-maker-request-id,x-maker-github-subject,x-maker-mtls-subject'
}
});
}
const identity = await authenticator(request);
if (enforceScopes && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !identity.scopes?.includes('control')) {
throw new MakerControlError('forbidden', 'identity lacks control scope', 403);
}
enforceRate(identity.subject || identity.method || 'unknown');
enforceReplay(request);
enforceCsrf(request, origin);
const body = await parseBody(request);
const value = await withTimeout(Promise.resolve(route(request, body)));
const url = new URL(request.url);
if (
request.method === 'GET' &&
url.pathname === '/v1/events' &&
clean(request.headers.get('accept'), 300).includes('text/event-stream')
) {
return new Response(formatSseEvents(value), {
status: 200,
headers: {
...corsHeaders(origin),
'content-type': 'text/event-stream; charset=utf-8',
connection: 'keep-alive'
}
});
}
return Response.json(value, { status: 200, headers: corsHeaders(origin) });
} catch (error) {
const status = error instanceof MakerControlError ? error.status : 500;
const safe = redactSecrets({
code: error.code || 'internal_error',
message: clean(error.message, 2000)
});
return Response.json({ error: safe }, { status, headers: corsHeaders(origin) });
}
};
}
