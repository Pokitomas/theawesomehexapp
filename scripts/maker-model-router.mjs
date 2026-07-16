#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = values => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 200)).filter(Boolean))];
const finite = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
const number = Number(value);
return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const now = clock => new Date(clock()).toISOString();
const SECRET_KEY = /^(?:secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|endpoint_url)$|(?:^|[_-])(?:secret|password|authorization|cookie|private[_-]?key|api[_-]?key)(?:$|[_-])/i;
const CREDENTIAL_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;
export class ModelRouterError extends Error {
constructor(code, message, status = 400, detail = {}) {
super(message);
this.name = 'ModelRouterError';
this.code = code;
this.status = status;
this.detail = detail;
}
}
export function redactProviderSecrets(value, depth = 0) {
if (depth > 12) return '[truncated]';
if (Array.isArray(value)) return value.slice(0, 200).map(item => redactProviderSecrets(item, depth + 1));
if (value && typeof value === 'object') {
return Object.fromEntries(Object.entries(value).slice(0, 300).map(([key, item]) => [
clean(key, 200),
SECRET_KEY.test(key) ? '[redacted]' : redactProviderSecrets(item, depth + 1)
]));
}
if (typeof value === 'string') return clean(value.replace(CREDENTIAL_TEXT, '[redacted]'), 20000);
if (['number', 'boolean'].includes(typeof value) || value === null) return value;
return clean(value, 2000);
}
const EVIDENCE = new Set(['observed', 'configured', 'unknown']);
const PROVIDER_KINDS = new Set([
'native_checkpoint', 'github_models', 'openai_compatible', 'ollama',
'anthropic_compatible', 'generic'
]);
const LATENCY_RANK = Object.freeze({ realtime: 5, interactive: 4, standard: 3, batch: 2, slow: 1, unknown: 0 });
const PRIVACY_RANK = Object.freeze({ local: 5, private: 4, no_training: 3, provider_policy: 2, unknown: 0 });
const AVAILABILITY = new Set(['healthy', 'degraded', 'offline', 'unknown']);
function evidenceValue(value, fallback = 'unknown') {
if (value && typeof value === 'object' && !Array.isArray(value)) {
const evidence = EVIDENCE.has(clean(value.evidence, 30)) ? clean(value.evidence, 30) : fallback;
return Object.freeze({ value: value.value, evidence });
}
return Object.freeze({ value, evidence: fallback });
}
export function normalizeProviderDescriptor(input = {}) {
const id = clean(input.id, 200);
const kind = clean(input.kind, 100).toLowerCase();
if (!id) throw new ModelRouterError('provider_id_required', 'provider id is required');
if (!PROVIDER_KINDS.has(kind)) throw new ModelRouterError('provider_kind_invalid', `unsupported provider kind: ${kind}`);
const capabilities = input.capabilities || {};
const limits = input.limits || {};
const cost = input.cost || {};
const native = input.native || {};
const descriptor = {
schema: 'sideways-maker-provider/v1',
id,
display_name: clean(input.display_name || id, 200),
kind,
availability: AVAILABILITY.has(clean(input.availability, 30)) ? clean(input.availability, 30) : 'unknown',
capabilities: {
structured_json: evidenceValue(capabilities.structured_json, 'configured'),
tool_use: evidenceValue(capabilities.tool_use, 'configured'),
streaming: evidenceValue(capabilities.streaming, 'configured'),
multimodal: evidenceValue(capabilities.multimodal, 'configured'),
reasoning: evidenceValue(capabilities.reasoning, 'configured'),
coding: evidenceValue(capabilities.coding, 'configured'),
browser_interpretation: evidenceValue(capabilities.browser_interpretation, 'configured')
},
limits: {
context_tokens: evidenceValue(finite(limits.context_tokens, 0, 0, 10 ** 9), limits.context_tokens === undefined ? 'unknown' : 'configured'),
output_tokens: evidenceValue(finite(limits.output_tokens, 0, 0, 10 ** 9), limits.output_tokens === undefined ? 'unknown' : 'configured')
},
latency_class: evidenceValue(clean(input.latency_class || 'unknown', 50), input.latency_class ? 'configured' : 'unknown'),
privacy: evidenceValue(clean(input.privacy || 'unknown', 100), input.privacy ? 'configured' : 'unknown'),
locality: evidenceValue(clean(input.locality || 'unknown', 100), input.locality ? 'configured' : 'unknown'),
region: evidenceValue(clean(input.region || 'unknown', 100), input.region ? 'configured' : 'unknown'),
cost: {
input_per_million: evidenceValue(finite(cost.input_per_million, 0, 0, 10 ** 6), cost.input_per_million === undefined ? 'unknown' : 'configured'),
output_per_million: evidenceValue(finite(cost.output_per_million, 0, 0, 10 ** 6), cost.output_per_million === undefined ? 'unknown' : 'configured')
},
admission: {
status: clean(input.admission?.status || 'unverified', 50),
receipt_digest: clean(input.admission?.receipt_digest, 200),
registry_digest: clean(input.admission?.registry_digest, 200),
observed_at: clean(input.admission?.observed_at, 100)
},
native: {
checkpoint_digest: clean(native.checkpoint_digest, 200),
runtime_checkpoint_digest: clean(native.runtime_checkpoint_digest, 200),
runtime_id: clean(native.runtime_id, 200)
},
reliability: {
successes: Math.round(finite(input.reliability?.successes, 0, 0, 10 ** 9)),
failures: Math.round(finite(input.reliability?.failures, 0, 0, 10 ** 9)),
consecutive_failures: Math.round(finite(input.reliability?.consecutive_failures, 0, 0, 10 ** 6))
},
operator_weight: finite(input.operator_weight, 0, -1000, 1000),
roles: unique(input.roles),
tags: unique(input.tags),
metadata: redactProviderSecrets(input.metadata || {})
};
if (kind === 'native_checkpoint') {
const admitted = descriptor.admission.status === 'verified';
const receipt = /^[a-z0-9]+:[a-f0-9]{32,128}$/.test(descriptor.admission.receipt_digest);
const registry = /^[a-z0-9]+:[a-f0-9]{32,128}$/.test(descriptor.admission.registry_digest);
const checkpoint = descriptor.native.checkpoint_digest;
const runtimeCheckpoint = descriptor.native.runtime_checkpoint_digest;
descriptor.native.admitted = admitted && receipt && registry && checkpoint && checkpoint === runtimeCheckpoint;
} else {
descriptor.native.admitted = false;
}
descriptor.descriptor_digest = hash(descriptor);
return Object.freeze(descriptor);
}
export const TASK_PROFILES = Object.freeze({
planning: { required: ['reasoning'], preferred: ['structured_json'], context_tokens: 32000, output_tokens: 4000, latency: 'interactive' },
repository_mapping: { required: ['structured_json'], preferred: ['reasoning', 'coding'], context_tokens: 64000, output_tokens: 8000, latency: 'standard' },
coding: { required: ['coding'], preferred: ['tool_use', 'structured_json', 'reasoning'], context_tokens: 64000, output_tokens: 16000, latency: 'standard' },
debugging: { required: ['coding', 'reasoning'], preferred: ['tool_use', 'structured_json'], context_tokens: 64000, output_tokens: 12000, latency: 'interactive' },
review: { required: ['reasoning'], preferred: ['coding', 'structured_json'], context_tokens: 48000, output_tokens: 8000, latency: 'standard' },
summarization: { required: [], preferred: ['structured_json'], context_tokens: 32000, output_tokens: 4000, latency: 'interactive' },
browser_interpretation: { required: ['browser_interpretation'], preferred: ['multimodal', 'structured_json'], context_tokens: 32000, output_tokens: 6000, latency: 'interactive' },
grading: { required: ['reasoning', 'structured_json'], preferred: [], context_tokens: 32000, output_tokens: 4000, latency: 'standard', independent: true }
});
export function normalizeTask(input = {}) {
const profileName = clean(input.profile || input.task || 'coding', 100).toLowerCase();
const base = TASK_PROFILES[profileName];
if (!base) throw new ModelRouterError('task_profile_invalid', `unsupported task profile: ${profileName}`);
return Object.freeze({
schema: 'sideways-maker-model-task/v1',
id: clean(input.id || randomUUID(), 200),
profile: profileName,
role: clean(input.role || profileName, 100),
messages: redactProviderSecrets(Array.isArray(input.messages) ? input.messages : []),
state: redactProviderSecrets(input.state || {}),
required: unique([...(base.required || []), ...(input.required_capabilities || [])]),
preferred: unique([...(base.preferred || []), ...(input.preferred_capabilities || [])]),
context_tokens: Math.round(finite(input.context_tokens, base.context_tokens, 0, 10 ** 9)),
output_tokens: Math.round(finite(input.output_tokens, base.output_tokens, 1, 10 ** 9)),
max_cost_usd: finite(input.max_cost_usd, 10 ** 9, 0, 10 ** 9),
max_latency_class: clean(input.max_latency_class || base.latency || 'unknown', 50),
privacy: clean(input.privacy || 'unknown', 100),
locality: clean(input.locality || 'any', 100),
region: clean(input.region || 'any', 100),
provider_preference: unique(input.provider_preference),
output_schema: input.output_schema && typeof input.output_schema === 'object' ? clone(input.output_schema) : null,
independent_from_provider: clean(input.independent_from_provider, 200),
grader: input.grader === true || base.independent === true
});
}
function capabilityTrue(provider, name) {
return provider.capabilities[name]?.value === true;
}
function usageEstimate(provider, task) {
const inputTokens = Math.max(1, task.context_tokens);
const outputTokens = Math.max(1, task.output_tokens);
const cost = ((inputTokens / 1_000_000) * provider.cost.input_per_million.value) +
((outputTokens / 1_000_000) * provider.cost.output_per_million.value);
return { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost, evidence: 'estimated' };
}
function reliabilityScore(provider) {
const { successes, failures, consecutive_failures } = provider.reliability;
const total = successes + failures;
const ratio = total ? successes / total : 0.5;
return Math.round((ratio * 100) - (consecutive_failures * 15));
}
export function scoreProvider(provider, taskInput, options = {}) {
const task = taskInput.schema ? taskInput : normalizeTask(taskInput);
const reasons = [];
if (provider.availability === 'offline') return { eligible: false, score: -Infinity, reasons: ['offline'] };
if (provider.kind === 'native_checkpoint' && !provider.native.admitted) {
return { eligible: false, score: -Infinity, reasons: ['native_not_admitted'] };
}
for (const capability of task.required) {
if (!capabilityTrue(provider, capability)) reasons.push(`missing:${capability}`);
}
if (reasons.length) return { eligible: false, score: -Infinity, reasons };
const contextLimit = Number(provider.limits.context_tokens.value || 0);
const outputLimit = Number(provider.limits.output_tokens.value || 0);
if (contextLimit && task.context_tokens > contextLimit) return { eligible: false, score: -Infinity, reasons: ['context_overflow'] };
if (outputLimit && task.output_tokens > outputLimit) return { eligible: false, score: -Infinity, reasons: ['output_overflow'] };
if (task.locality !== 'any' && provider.locality.value !== task.locality) return { eligible: false, score: -Infinity, reasons: ['locality_mismatch'] };
if (task.region !== 'any' && provider.region.value !== task.region) return { eligible: false, score: -Infinity, reasons: ['region_mismatch'] };
if (task.privacy !== 'unknown' && (PRIVACY_RANK[provider.privacy.value] || 0) < (PRIVACY_RANK[task.privacy] || 0)) {
return { eligible: false, score: -Infinity, reasons: ['privacy_mismatch'] };
}
if (task.grader && task.independent_from_provider === provider.id) return { eligible: false, score: -Infinity, reasons: ['grader_not_independent'] };
const estimated = usageEstimate(provider, task);
if (estimated.cost_usd > task.max_cost_usd) return { eligible: false, score: -Infinity, reasons: ['cost_ceiling'] };
let score = 1000;
score += task.preferred.filter(capability => capabilityTrue(provider, capability)).length * 40;
score += reliabilityScore(provider) * 3;
score += (LATENCY_RANK[provider.latency_class.value] || 0) * 15;
score += (PRIVACY_RANK[provider.privacy.value] || 0) * 20;
score += provider.operator_weight;
if (provider.availability === 'degraded') score -= 200;
if (provider.admission.status === 'verified') score += 60;
const preferenceIndex = task.provider_preference.indexOf(provider.id);
if (preferenceIndex >= 0) score += Math.max(0, 100 - (preferenceIndex * 10));
if (options.circuit_open) return { eligible: false, score: -Infinity, reasons: ['circuit_open'] };
return { eligible: true, score, reasons: [], estimated_usage: estimated };
}
export function rankProviders(providers, task, options = {}) {
return providers.map(provider => ({ provider, ...scoreProvider(provider, task, options[provider.id] || {}) }))
.filter(value => value.eligible)
.sort((a, b) => b.score - a.score || a.provider.id.localeCompare(b.provider.id));
}
export function createProviderRegistry(seed = []) {
const providers = new Map();
for (const value of seed) providers.set(value.id, normalizeProviderDescriptor(value));
return Object.freeze({
register(input) {
const provider = normalizeProviderDescriptor(input);
if (providers.has(provider.id)) throw new ModelRouterError('provider_duplicate', `provider already registered: ${provider.id}`, 409);
providers.set(provider.id, provider);
return provider;
},
replace(input) {
const provider = normalizeProviderDescriptor(input);
providers.set(provider.id, provider);
return provider;
},
get(id) { return providers.get(clean(id, 200)) || null; },
list() { return [...providers.values()].sort((a, b) => a.id.localeCompare(b.id)); },
updateHealth(id, availability, evidence = {}) {
const key = clean(id, 200);
const current = providers.get(key);
if (!current) throw new ModelRouterError('provider_not_found', `provider not found: ${key}`, 404);
const status = AVAILABILITY.has(clean(availability, 30)) ? clean(availability, 30) : 'unknown';
const next = {
...clone(current),
availability: status,
metadata: { ...clone(current.metadata || {}), health: redactProviderSecrets(evidence) },
descriptor_digest: ''
};
next.descriptor_digest = hash({ ...next, descriptor_digest: undefined });
providers.set(key, Object.freeze(next));
return providers.get(key);
},
health() {
const values = [...providers.values()];
return {
schema: 'sideways-maker-provider-health/v1',
total: values.length,
healthy: values.filter(value => value.availability === 'healthy').length,
degraded: values.filter(value => value.availability === 'degraded').length,
offline: values.filter(value => value.availability === 'offline').length,
unknown: values.filter(value => value.availability === 'unknown').length,
providers: values.map(value => ({ id: value.id, availability: value.availability, digest: value.descriptor_digest }))
};
}
});
}
export function createBudgetLedger(input = {}) {
const limits = {
requests: Math.round(finite(input.requests, 100, 0, 10 ** 9)),
input_tokens: Math.round(finite(input.input_tokens, 10 ** 9, 0, 10 ** 12)),
output_tokens: Math.round(finite(input.output_tokens, 10 ** 9, 0, 10 ** 12)),
cost_usd: finite(input.cost_usd, 10 ** 9, 0, 10 ** 9),
wall_time_ms: Math.round(finite(input.wall_time_ms, 24 * 60 * 60 * 1000, 0, 30 * 24 * 60 * 60 * 1000))
};
const used = { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, wall_time_ms: 0 };
function admit(usage = {}) {
const next = {
requests: used.requests + Math.round(finite(usage.requests, 1, 0)),
input_tokens: used.input_tokens + Math.round(finite(usage.input_tokens, 0, 0)),
output_tokens: used.output_tokens + Math.round(finite(usage.output_tokens, 0, 0)),
cost_usd: used.cost_usd + finite(usage.cost_usd, 0, 0),
wall_time_ms: used.wall_time_ms + Math.round(finite(usage.wall_time_ms, 0, 0))
};
for (const key of Object.keys(limits)) {
if (next[key] > limits[key]) throw new ModelRouterError('budget_exhausted', `budget exceeded: ${key}`, 429, { key, used: used[key], requested: usage[key], limit: limits[key] });
}
Object.assign(used, next);
return snapshot();
}
function snapshot() { return { schema: 'sideways-maker-model-budget/v1', limits: clone(limits), used: clone(used), remaining: Object.fromEntries(Object.keys(limits).map(key => [key, Math.max(0, limits[key] - used[key])])) }; }
return Object.freeze({ admit, snapshot });
}
function validateSchema(value, schema, path = '$') {
if (!schema) return [];
const errors = [];
if (schema.type) {
const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
if (!allowed.includes(type)) errors.push(`${path}: expected ${allowed.join('|')}, received ${type}`);
}
if (schema.required && value && typeof value === 'object' && !Array.isArray(value)) {
for (const key of schema.required) if (!(key in value)) errors.push(`${path}.${key}: required`);
}
if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
for (const [key, child] of Object.entries(schema.properties)) {
if (key in value) errors.push(...validateSchema(value[key], child, `${path}.${key}`));
}
}
if (schema.items && Array.isArray(value)) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${path}[${index}]`)));
if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not in enum`);
return errors;
}
function parseStructuredOutput(output) {
if (output && typeof output === 'object') return clone(output);
const text = clean(output, 500000);
const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
const candidate = clean(fenced || text, 500000);
try { return JSON.parse(candidate); } catch {}
const first = Math.min(...['{', '['].map(char => candidate.indexOf(char)).filter(index => index >= 0));
const last = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
if (Number.isFinite(first) && first >= 0 && last > first) return JSON.parse(candidate.slice(first, last + 1));
throw new ModelRouterError('structured_output_invalid', 'provider output was not valid JSON', 422);
}
function normalizeUsage(provider, task, response = {}, elapsed = 0) {
const raw = response.usage || {};
const reported = Number.isFinite(Number(raw.input_tokens)) || Number.isFinite(Number(raw.prompt_tokens));
if (reported) {
return {
requests: 1,
input_tokens: Math.round(finite(raw.input_tokens ?? raw.prompt_tokens, 0, 0)),
output_tokens: Math.round(finite(raw.output_tokens ?? raw.completion_tokens, 0, 0)),
cost_usd: finite(raw.cost_usd, usageEstimate(provider, task).cost_usd, 0),
wall_time_ms: Math.round(elapsed),
evidence: 'provider_reported'
};
}
return { requests: 1, ...usageEstimate(provider, task), wall_time_ms: Math.round(elapsed) };
}
export function createModelRouter({
registry = createProviderRegistry(),
transports = {},
health_checks = {},
clock = Date.now,
sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
id = randomUUID,
global_budget = {},
retries = 2,
repair_attempts = 1,
circuit_threshold = 3,
circuit_cooldown_ms = 60_000
} = {}) {
const ledger = createBudgetLedger(global_budget);
const circuits = new Map();
function circuit(providerId) {
const value = circuits.get(providerId) || { failures: 0, open_until: 0 };
if (value.open_until && value.open_until <= clock()) {
value.failures = 0;
value.open_until = 0;
}
circuits.set(providerId, value);
return value;
}
function transportFor(provider) {
return transports[provider.id] || transports[provider.kind];
}
async function runAttempt(provider, task, attempt, repair = null) {
const transport = transportFor(provider);
if (typeof transport !== 'function') throw new ModelRouterError('transport_unavailable', `transport unavailable for ${provider.id}`, 503);
const started = clock();
const packet = {
schema: 'sideways-maker-provider-attempt/v1',
task: clone(task),
provider: { id: provider.id, kind: provider.kind, descriptor_digest: provider.descriptor_digest },
attempt,
repair: repair ? redactProviderSecrets(repair) : null
};
const response = await transport(packet);
const elapsed = Math.max(0, clock() - started);
const usage = normalizeUsage(provider, task, response, elapsed);
ledger.admit(usage);
const parsed = task.output_schema ? parseStructuredOutput(response.output ?? response.text ?? response) : redactProviderSecrets(response.output ?? response.text ?? response);
const validation_errors = task.output_schema ? validateSchema(parsed, task.output_schema) : [];
return { response, parsed, usage, validation_errors, elapsed };
}
async function route(taskInput, options = {}) {
const task = normalizeTask(taskInput);
const rolePool = unique(options.provider_pool || []);
let providers = registry.list();
if (rolePool.length) providers = providers.filter(provider => rolePool.includes(provider.id));
const circuitOptions = Object.fromEntries(providers.map(provider => [provider.id, { circuit_open: circuit(provider.id).open_until > clock() }]));
const ranked = rankProviders(providers, task, circuitOptions);
if (!ranked.length) throw new ModelRouterError('no_provider', 'no provider satisfies task requirements', 503);
const attempts = [];
let lastError;
for (const candidate of ranked) {
const provider = candidate.provider;
const state = circuit(provider.id);
for (let attempt = 1; attempt <= Math.max(1, retries + 1); attempt += 1) {
let repair = null;
for (let repairIndex = 0; repairIndex <= Math.max(0, repair_attempts); repairIndex += 1) {
const attemptId = id();
const startedAt = now(clock);
try {
const result = await runAttempt(provider, task, attempt, repair);
if (result.validation_errors.length) {
attempts.push({ attempt_id: attemptId, provider_id: provider.id, attempt, repair_index: repairIndex, started_at: startedAt, finished_at: now(clock), status: 'schema_invalid', validation_errors: result.validation_errors, usage: result.usage });
if (repairIndex >= repair_attempts) throw new ModelRouterError('schema_validation_failed', 'structured output did not satisfy schema', 422, { errors: result.validation_errors });
repair = { instruction: 'Return JSON only and repair the listed schema violations.', errors: result.validation_errors, prior_output: redactProviderSecrets(result.parsed) };
continue;
}
state.failures = 0;
state.open_until = 0;
attempts.push({ attempt_id: attemptId, provider_id: provider.id, attempt, repair_index: repairIndex, started_at: startedAt, finished_at: now(clock), status: 'success', usage: result.usage });
const receipt = {
schema: 'sideways-maker-model-route/v1',
route_id: id(),
task_id: task.id,
task_profile: task.profile,
selected_provider: provider.id,
provider_kind: provider.kind,
runtime_profile: {
schema: 'sideways-maker-runtime-profile/v1',
runtime_id: clean(result.response.runtime_id || provider.native.runtime_id || provider.id, 200),
display_name: provider.display_name,
status: provider.availability,
intelligence: {
selection: 'adaptive',
engine_label: clean(result.response.engine_label || provider.display_name, 200),
architecture: provider.kind === 'native_checkpoint' ? 'native' : 'remote',
admission: provider.kind === 'native_checkpoint' ? 'verified' : provider.admission.status,
capabilities: Object.entries(provider.capabilities).filter(([, value]) => value.value === true).map(([key]) => key)
},
endpoint: {
ownership: provider.locality.value === 'local' ? 'user' : 'managed',
transport: provider.locality.value === 'local' ? 'local' : 'remote',
locality: provider.locality.value,
capacity: clean(result.response.capacity || 'unknown', 50),
throttling: clean(result.response.throttling || 'unknown', 50),
label: clean(result.response.endpoint_label || `${provider.display_name} runtime`, 200)
},
planning: { strategy: 'adaptive', scheduler: 'priority', parallelism: 1, speculation: false, recovery: 'checkpoint', confidence_threshold: 0.8 },
execution: { role: task.role, modes: [task.profile], transport: 'queue', workspace: 'isolated', verification: 'continuous', checkpointing: 'enabled', recovery: 'journaled' },
authority: { capabilities: {} },
presentation: { headline: 'Maker is building your thing', activity: `Using ${provider.display_name} for ${task.profile}`, tone: 'friendly', visible: true },
observed_at: now(clock)
},
output: redactProviderSecrets(result.parsed),
attempts: redactProviderSecrets(attempts),
budget: ledger.snapshot(),
state_digest: hash(task.state),
receipt_digest: ''
};
receipt.receipt_digest = hash({ ...receipt, receipt_digest: undefined });
return Object.freeze(receipt);
} catch (error) {
lastError = error;
const code = clean(error.code || 'provider_failed', 100);
const rateLimited = code === 'rate_limited' || error.status === 429;
attempts.push({ attempt_id: attemptId, provider_id: provider.id, attempt, repair_index: repairIndex, started_at: startedAt, finished_at: now(clock), status: 'failed', error: { code, message: clean(redactProviderSecrets(error.message), 1000) } });
if (code === 'budget_exhausted') throw error;
if (code === 'schema_validation_failed') break;
if (repairIndex < repair_attempts && code === 'structured_output_invalid') {
repair = { instruction: 'Return valid JSON only.', errors: [error.message] };
continue;
}
state.failures += 1;
if (state.failures >= circuit_threshold) state.open_until = clock() + circuit_cooldown_ms;
if (attempt <= retries) await sleep((rateLimited ? 1000 : 250) * attempt);
break;
}
}
}
}
throw new ModelRouterError('fallback_exhausted', 'all provider attempts failed', 503, { attempts: redactProviderSecrets(attempts), last_error: clean(redactProviderSecrets(lastError?.message), 1000) });
}
async function grade(taskInput, sourceReceipt, options = {}) {
return route({ ...taskInput, profile: 'grading', grader: true, independent_from_provider: sourceReceipt.selected_provider }, options);
}
async function probe(providerId) {
const provider = registry.get(providerId);
if (!provider) throw new ModelRouterError('provider_not_found', `provider not found: ${clean(providerId, 200)}`, 404);
const check = health_checks[provider.id] || health_checks[provider.kind];
const checkedAt = now(clock);
if (typeof check !== 'function') {
return Object.freeze({
schema: 'sideways-maker-provider-probe/v1',
provider_id: provider.id,
status: provider.availability,
evidence: 'configured',
checked_at: checkedAt,
detail: { reason: 'health check transport not configured' }
});
}
try {
const result = redactProviderSecrets(await check({
id: provider.id,
kind: provider.kind,
descriptor_digest: provider.descriptor_digest
}));
const status = AVAILABILITY.has(clean(result.status, 30)) ? clean(result.status, 30) : (result.ok === true ? 'healthy' : 'degraded');
registry.updateHealth(provider.id, status, { evidence: 'observed', result, checked_at: checkedAt });
return Object.freeze({
schema: 'sideways-maker-provider-probe/v1',
provider_id: provider.id,
status,
evidence: 'observed',
checked_at: checkedAt,
detail: result
});
} catch (error) {
registry.updateHealth(provider.id, 'offline', {
evidence: 'observed',
error: clean(redactProviderSecrets(error.message), 1000),
checked_at: checkedAt
});
return Object.freeze({
schema: 'sideways-maker-provider-probe/v1',
provider_id: provider.id,
status: 'offline',
evidence: 'observed',
checked_at: checkedAt,
detail: { error: clean(redactProviderSecrets(error.message), 1000) }
});
}
}
async function probeAll() {
const receipts = [];
for (const provider of registry.list()) receipts.push(await probe(provider.id));
return receipts;
}
return Object.freeze({
route,
grade,
probe,
probeAll,
health: () => ({ registry: registry.health(), budget: ledger.snapshot(), circuits: redactProviderSecrets(Object.fromEntries(circuits)) }),
budget: () => ledger.snapshot()
});
}
