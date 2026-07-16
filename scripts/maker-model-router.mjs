#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';

const clean = (value, limit = 20_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const clone = value => structuredClone(value);
const unique = (values, limit = 200) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 200)).filter(Boolean))].slice(0, limit);
const finite = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const now = clock => new Date(clock()).toISOString();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}
const hash = value => createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
const digestEnvelope = value => `sha256:${hash(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'digest')))}`;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const SECRET_KEY = /(?:^|[_-])(?:secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential|session)(?:$|[_-])/i;
const PRIVATE_PROVIDER_KEY = /(?:^|[_-])(?:endpoint(?:_url)?|base_url|url|uri|host|hostname|model(?:_id)?|provider(?:_id)?|vendor)(?:$|[_-])/i;
const CREDENTIAL_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;
const URL_TEXT = /https?:\/\/[^\s"'<>]+/gi;

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
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 300).map(([key, item]) => [
      clean(key, 200),
      SECRET_KEY.test(key) ? '[redacted]' : redactProviderSecrets(item, depth + 1)
    ]));
  }
  if (typeof value === 'string') return clean(value.replace(CREDENTIAL_TEXT, '[redacted]'), 20_000);
  if (['number', 'boolean'].includes(typeof value) || value === null) return value;
  return clean(value, 2_000);
}

function redactProviderMetadata(value, depth = 0) {
  if (depth > 10) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactProviderMetadata(item, depth + 1));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [
      clean(key, 200),
      SECRET_KEY.test(key) || PRIVATE_PROVIDER_KEY.test(key) ? '[redacted]' : redactProviderMetadata(item, depth + 1)
    ]));
  }
  if (typeof value === 'string') return clean(value.replace(CREDENTIAL_TEXT, '[redacted]').replace(URL_TEXT, '[redacted-url]'), 10_000);
  if (['number', 'boolean'].includes(typeof value) || value === null) return value;
  return clean(value, 2_000);
}

const EVIDENCE = new Set(['observed', 'configured', 'unknown']);
const PROVIDER_KINDS = new Set(['native_checkpoint', 'github_models', 'openai_compatible', 'ollama', 'anthropic_compatible', 'generic']);
const AVAILABILITY = new Set(['healthy', 'degraded', 'offline', 'unknown']);
const LATENCY = ['unknown', 'slow', 'batch', 'standard', 'interactive', 'realtime'];
const LATENCY_RANK = Object.freeze(Object.fromEntries(LATENCY.map((value, index) => [value, index])));
const PRIVACY_RANK = Object.freeze({ unknown: 0, provider_policy: 1, no_training: 2, private: 3, local: 4 });
const LOCALITIES = new Set(['local', 'remote', 'hybrid', 'private', 'unknown']);
const ADMISSION = new Set(['verified', 'configured', 'unverified', 'unknown']);

function evidenceValue(input, normalize, fallbackEvidence = 'unknown') {
  if (isObject(input) && ('value' in input || 'evidence' in input || 'source' in input)) {
    const claimedEvidence = clean(input.evidence || input.source, 30).toLowerCase();
    const evidence = EVIDENCE.has(claimedEvidence) ? claimedEvidence : fallbackEvidence;
    return Object.freeze({ value: normalize(input.value), evidence });
  }
  if (input === undefined || input === null || input === '') return Object.freeze({ value: null, evidence: 'unknown' });
  return Object.freeze({ value: normalize(input), evidence: fallbackEvidence === 'unknown' ? 'configured' : fallbackEvidence });
}

const boolValue = value => value === true ? true : value === false ? false : null;
const integerValue = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
};
const moneyValue = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const enumValue = (value, allowed, fallback = 'unknown') => allowed.has(clean(value, 100).toLowerCase()) ? clean(value, 100).toLowerCase() : fallback;

function normalizePublicLabel(value, fallback, limit = 200) {
  const text = clean(value, limit);
  CREDENTIAL_TEXT.lastIndex = 0;
  URL_TEXT.lastIndex = 0;
  const unsafe = !text || CREDENTIAL_TEXT.test(text) || URL_TEXT.test(text);
  CREDENTIAL_TEXT.lastIndex = 0;
  URL_TEXT.lastIndex = 0;
  return unsafe ? fallback : text;
}

function normalizeNativeEnvelope(input, schema) {
  if (!isObject(input)) return null;
  return Object.freeze({
    schema: clean(input.schema, 100),
    checkpoint_digest: clean(input.checkpoint_digest, 200).toLowerCase(),
    runtime_id: clean(input.runtime_id, 200),
    registry_digest: clean(input.registry_digest, 200).toLowerCase(),
    endpoint_digest: clean(input.endpoint_digest, 200).toLowerCase(),
    issued_at: clean(input.issued_at, 100),
    digest: clean(input.digest, 200).toLowerCase(),
    valid: clean(input.schema, 100) === schema && DIGEST_PATTERN.test(clean(input.digest, 200).toLowerCase()) && digestEnvelope(input) === clean(input.digest, 200).toLowerCase()
  });
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
  const admissionInput = input.admission || {};
  const legacyAvailability = isObject(input.availability)
    ? (input.availability.value === true ? 'healthy' : input.availability.value === false ? 'offline' : 'unknown')
    : input.availability;
  const availability = clean(legacyAvailability || input.health || 'unknown', 100).toLowerCase();
  const reliabilitySamples = Math.round(finite(input.reliability?.samples, 0, 0, 10 ** 9));
  const reliabilityRate = finite(input.reliability?.success_rate, 0.5, 0, 1);
  const receipt = normalizeNativeEnvelope(admissionInput.receipt, 'sideways-maker-native-admission/v1');
  const registryReceipt = normalizeNativeEnvelope(admissionInput.registry, 'sideways-maker-native-registry/v1');
  const locality = evidenceValue(input.locality ?? capabilities.locality, value => enumValue(value, LOCALITIES));
  const privacy = evidenceValue(input.privacy ?? capabilities.privacy, value => clean(value || 'unknown', 100).toLowerCase());
  const latency = evidenceValue(input.latency_class ?? capabilities.latency_class, value => {
    const normalized = clean(value, 50).toLowerCase();
    const compatible = normalized === 'fast' ? 'interactive' : normalized;
    return LATENCY_RANK[compatible] === undefined ? 'unknown' : compatible;
  });

  const descriptor = {
    schema: 'sideways-maker-provider/v1',
    id,
    display_name: normalizePublicLabel(input.display_name || id, 'Maker intelligence'),
    kind,
    availability: enumValue(availability, AVAILABILITY),
    availability_evidence: EVIDENCE.has(clean(input.availability_evidence || input.availability?.evidence || input.availability?.source, 30).toLowerCase())
      ? clean(input.availability_evidence || input.availability?.evidence || input.availability?.source, 30).toLowerCase()
      : (availability === 'unknown' ? 'unknown' : 'configured'),
    capabilities: {
      structured_json: evidenceValue(capabilities.structured_json, boolValue),
      tool_use: evidenceValue(capabilities.tool_use, boolValue),
      streaming: evidenceValue(capabilities.streaming, boolValue),
      multimodal: evidenceValue(capabilities.multimodal, boolValue),
      reasoning: evidenceValue(capabilities.reasoning, boolValue),
      coding: evidenceValue(capabilities.coding, boolValue),
      browser_interpretation: evidenceValue(capabilities.browser_interpretation, boolValue)
    },
    limits: {
      context_tokens: evidenceValue(limits.context_tokens ?? capabilities.context_tokens, integerValue),
      output_tokens: evidenceValue(limits.output_tokens ?? capabilities.output_tokens, integerValue)
    },
    latency_class: latency,
    privacy,
    locality,
    region: evidenceValue(input.region ?? capabilities.region, value => clean(value || 'unknown', 100).toLowerCase()),
    cost: {
      input_per_million: evidenceValue(cost.input_per_million ?? cost.input_per_million_usd, moneyValue),
      output_per_million: evidenceValue(cost.output_per_million ?? cost.output_per_million_usd, moneyValue)
    },
    admission: {
      status: ADMISSION.has(clean(admissionInput.status, 50).toLowerCase()) ? clean(admissionInput.status, 50).toLowerCase() : 'unverified',
      receipt_digest: clean(admissionInput.receipt_digest || receipt?.digest, 200).toLowerCase(),
      registry_digest: clean(admissionInput.registry_digest || registryReceipt?.digest, 200).toLowerCase(),
      observed_at: clean(admissionInput.observed_at, 100),
      receipt,
      registry: registryReceipt
    },
    native: {
      checkpoint_digest: clean(native.checkpoint_digest, 200).toLowerCase(),
      runtime_checkpoint_digest: clean(native.runtime_checkpoint_digest, 200).toLowerCase(),
      endpoint_digest: clean(native.endpoint_digest, 200).toLowerCase(),
      runtime_endpoint_digest: clean(native.runtime_endpoint_digest, 200).toLowerCase(),
      runtime_id: clean(native.runtime_id, 200),
      admitted: false
    },
    reliability: {
      successes: Math.round(finite(input.reliability?.successes, reliabilitySamples * reliabilityRate, 0, 10 ** 9)),
      failures: Math.round(finite(input.reliability?.failures, reliabilitySamples * (1 - reliabilityRate), 0, 10 ** 9)),
      consecutive_failures: Math.round(finite(input.reliability?.consecutive_failures, 0, 0, 10 ** 6))
    },
    operator_weight: finite(input.operator_weight ?? input.preferences?.operator_rank, 0, -1000, 1000),
    roles: unique(input.roles),
    tags: unique(input.tags),
    public: {
      engine_label: normalizePublicLabel(input.public?.engine_label || input.metadata?.engine_label, kind === 'native_checkpoint' ? 'Local Maker intelligence' : 'Adaptive Maker intelligence'),
      endpoint_label: normalizePublicLabel(input.public?.endpoint_label, locality.value === 'local' ? 'Your local Maker runtime' : 'Managed Maker runtime')
    },
    metadata: redactProviderMetadata(input.metadata || {})
  };

  if (kind === 'native_checkpoint') {
    const checkpoint = descriptor.native.checkpoint_digest;
    const runtimeCheckpoint = descriptor.native.runtime_checkpoint_digest;
    const endpoint = descriptor.native.endpoint_digest;
    const runtimeEndpoint = descriptor.native.runtime_endpoint_digest;
    const runtimeId = descriptor.native.runtime_id;
    const bound = descriptor.admission.status === 'verified' &&
      DIGEST_PATTERN.test(checkpoint) && checkpoint === runtimeCheckpoint &&
      DIGEST_PATTERN.test(endpoint) && endpoint === runtimeEndpoint && Boolean(runtimeId) &&
      receipt?.valid === true && registryReceipt?.valid === true &&
      receipt.checkpoint_digest === checkpoint && registryReceipt.checkpoint_digest === checkpoint &&
      receipt.endpoint_digest === endpoint && registryReceipt.endpoint_digest === endpoint &&
      receipt.runtime_id === runtimeId && registryReceipt.runtime_id === runtimeId &&
      receipt.registry_digest === registryReceipt.digest &&
      descriptor.admission.receipt_digest === receipt.digest &&
      descriptor.admission.registry_digest === registryReceipt.digest;
    descriptor.native.admitted = bound;
  }

  descriptor.descriptor_digest = hash({ ...descriptor, descriptor_digest: undefined });
  return Object.freeze(descriptor);
}

export const TASK_PROFILES = Object.freeze({
  planning: { required: ['reasoning'], preferred: ['structured_json'], context_tokens: 32_000, output_tokens: 4_000, latency: 'interactive' },
  repository_mapping: { required: ['structured_json'], preferred: ['reasoning', 'coding'], context_tokens: 64_000, output_tokens: 8_000, latency: 'standard' },
  coding: { required: ['coding'], preferred: ['tool_use', 'structured_json', 'reasoning'], context_tokens: 64_000, output_tokens: 16_000, latency: 'standard' },
  debugging: { required: ['coding', 'reasoning'], preferred: ['tool_use', 'structured_json'], context_tokens: 64_000, output_tokens: 12_000, latency: 'interactive' },
  review: { required: ['reasoning'], preferred: ['coding', 'structured_json'], context_tokens: 48_000, output_tokens: 8_000, latency: 'standard' },
  summarization: { required: [], preferred: ['structured_json'], context_tokens: 32_000, output_tokens: 4_000, latency: 'interactive' },
  browser_interpretation: { required: ['browser_interpretation'], preferred: ['multimodal', 'structured_json'], context_tokens: 32_000, output_tokens: 6_000, latency: 'interactive' },
  grading: { required: ['reasoning', 'structured_json'], preferred: [], context_tokens: 32_000, output_tokens: 4_000, latency: 'standard', independent: true }
});

const LEGACY_TASK_PROFILES = Object.freeze({
  planning: { required: ['structured_json'], preferred: ['tool_use'], context_tokens: 32_000, output_tokens: 8_000, latency: 'standard', role: 'planner' },
  repository_mapping: { required: ['structured_json'], preferred: ['tool_use'], context_tokens: 64_000, output_tokens: 12_000, latency: 'standard', role: 'mapper' },
  coding: { required: ['structured_json', 'tool_use'], preferred: ['streaming'], context_tokens: 64_000, output_tokens: 16_000, latency: 'standard', role: 'implementer' },
  debugging: { required: ['structured_json', 'tool_use'], preferred: ['streaming'], context_tokens: 48_000, output_tokens: 12_000, latency: 'interactive', role: 'debugger' },
  review: { required: ['structured_json'], preferred: ['tool_use'], context_tokens: 48_000, output_tokens: 8_000, latency: 'standard', role: 'reviewer' },
  summarization: { required: [], preferred: ['structured_json'], context_tokens: 32_000, output_tokens: 4_000, latency: 'interactive', role: 'summarizer' },
  browser_interpretation: { required: ['multimodal'], preferred: ['structured_json'], context_tokens: 24_000, output_tokens: 8_000, latency: 'interactive', role: 'browser' },
  grading: { required: ['structured_json'], preferred: [], context_tokens: 32_000, output_tokens: 6_000, latency: 'standard', role: 'grader' }
});

function normalizeTaskBudget(input = {}, base = {}) {
  const source = input.budget || {};
  return Object.freeze({
    requests: Math.round(finite(source.requests ?? input.max_requests, 20, 1, 10 ** 6)),
    input_tokens: Math.round(finite(source.input_tokens ?? input.max_input_tokens, Math.max(base.context_tokens || 0, 1) * 20, 1, 10 ** 12)),
    output_tokens: Math.round(finite(source.output_tokens ?? input.max_output_tokens, Math.max(base.output_tokens || 1, 1) * 20, 1, 10 ** 12)),
    cost_usd: finite(source.cost_usd ?? input.max_cost_usd, 10 ** 9, 0, 10 ** 9),
    wall_time_ms: Math.round(finite(source.wall_time_ms ?? input.max_wall_time_ms, 30 * 60 * 1000, 1, 30 * 24 * 60 * 60 * 1000))
  });
}

export function normalizeTask(input = {}) {
  const profileName = clean(input.profile || input.task || 'coding', 100).toLowerCase();
  const base = TASK_PROFILES[profileName];
  if (!base) throw new ModelRouterError('task_profile_invalid', `unsupported task profile: ${profileName}`);
  const latency = clean(input.max_latency_class || base.latency || 'unknown', 50).toLowerCase();
  return Object.freeze({
    schema: 'sideways-maker-model-task/v1',
    id: clean(input.id || randomUUID(), 200),
    profile: profileName,
    role: clean(input.role || profileName, 100),
    messages: redactProviderSecrets(Array.isArray(input.messages) ? input.messages : []),
    state: redactProviderSecrets(input.state || {}),
    required: unique([...(base.required || []), ...(input.required_capabilities || [])]),
    preferred: unique([...(base.preferred || []), ...(input.preferred_capabilities || [])]),
    context_tokens: Math.round(finite(input.context_tokens, base.context_tokens, 1, 10 ** 9)),
    output_tokens: Math.round(finite(input.output_tokens, base.output_tokens, 1, 10 ** 9)),
    max_cost_usd: finite(input.max_cost_usd, 10 ** 9, 0, 10 ** 9),
    max_latency_class: LATENCY_RANK[latency] === undefined ? 'unknown' : latency,
    privacy: clean(input.privacy || 'unknown', 100).toLowerCase(),
    locality: clean(input.locality || 'any', 100).toLowerCase(),
    region: clean(input.region || 'any', 100).toLowerCase(),
    provider_preference: unique(input.provider_preference),
    output_schema: isObject(input.output_schema) ? clone(input.output_schema) : null,
    independent_from_provider: clean(input.independent_from_provider, 200),
    grader: input.grader === true || base.independent === true,
    budget: normalizeTaskBudget(input, base)
  });
}

function capabilityTrue(provider, name) {
  return provider.capabilities[name]?.value === true && provider.capabilities[name]?.evidence !== 'unknown';
}

function usageEstimate(provider, task) {
  const inputRate = provider.cost.input_per_million.value;
  const outputRate = provider.cost.output_per_million.value;
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null;
  return {
    requests: 1,
    input_tokens: Math.max(1, task.context_tokens),
    output_tokens: Math.max(1, task.output_tokens),
    cost_usd: ((task.context_tokens / 1_000_000) * inputRate) + ((task.output_tokens / 1_000_000) * outputRate),
    wall_time_ms: 0,
    evidence: 'estimated',
    field_evidence: { input_tokens: 'estimated', output_tokens: 'estimated', cost_usd: 'estimated' }
  };
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
  if (provider.availability === 'unknown' && options.allow_unknown_availability !== true) return { eligible: false, score: -Infinity, reasons: ['availability_unknown'] };
  if (provider.kind === 'native_checkpoint' && !provider.native.admitted) return { eligible: false, score: -Infinity, reasons: ['native_not_admitted'] };
  if (provider.roles.length && !provider.roles.includes(task.role) && !provider.roles.includes(task.profile)) return { eligible: false, score: -Infinity, reasons: ['role_mismatch'] };

  for (const capability of task.required) if (!capabilityTrue(provider, capability)) reasons.push(`missing:${capability}`);
  if (reasons.length) return { eligible: false, score: -Infinity, reasons };

  const contextLimit = provider.limits.context_tokens.value;
  const outputLimit = provider.limits.output_tokens.value;
  if (!Number.isFinite(contextLimit) || provider.limits.context_tokens.evidence === 'unknown') return { eligible: false, score: -Infinity, reasons: ['context_limit_unknown'] };
  if (!Number.isFinite(outputLimit) || provider.limits.output_tokens.evidence === 'unknown') return { eligible: false, score: -Infinity, reasons: ['output_limit_unknown'] };
  if (task.context_tokens > contextLimit) return { eligible: false, score: -Infinity, reasons: ['context_overflow'] };
  if (task.output_tokens > outputLimit) return { eligible: false, score: -Infinity, reasons: ['output_overflow'] };

  if (task.locality !== 'any' && provider.locality.value !== task.locality) return { eligible: false, score: -Infinity, reasons: ['locality_mismatch'] };
  if (task.region !== 'any' && provider.region.value !== task.region) return { eligible: false, score: -Infinity, reasons: ['region_mismatch'] };
  if (task.privacy !== 'unknown' && (PRIVACY_RANK[provider.privacy.value] || 0) < (PRIVACY_RANK[task.privacy] || 0)) return { eligible: false, score: -Infinity, reasons: ['privacy_mismatch'] };
  if (task.max_latency_class !== 'unknown') {
    const providerLatency = LATENCY_RANK[provider.latency_class.value];
    const requiredLatency = LATENCY_RANK[task.max_latency_class];
    if (!providerLatency || provider.latency_class.evidence === 'unknown') return { eligible: false, score: -Infinity, reasons: ['latency_unknown'] };
    if (providerLatency < requiredLatency) return { eligible: false, score: -Infinity, reasons: ['latency_too_slow'] };
  }
  if (task.grader && task.independent_from_provider === provider.id) return { eligible: false, score: -Infinity, reasons: ['grader_not_independent'] };
  if (options.circuit_open) return { eligible: false, score: -Infinity, reasons: ['circuit_open'] };

  const estimated = usageEstimate(provider, task);
  if (!estimated && options.allow_unknown_cost !== true) return { eligible: false, score: -Infinity, reasons: ['cost_unknown'] };
  if (estimated && estimated.cost_usd > Math.min(task.max_cost_usd, task.budget.cost_usd)) return { eligible: false, score: -Infinity, reasons: ['cost_ceiling'] };

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
  return { eligible: true, score, reasons: [], estimated_usage: estimated };
}

export function rankProviders(providers, task, options = {}) {
  return providers
    .map(provider => ({ provider, ...scoreProvider(provider, task, options[provider.id] || options.default || {}) }))
    .filter(value => value.eligible)
    .sort((a, b) => b.score - a.score || a.provider.id.localeCompare(b.provider.id));
}

export function createProviderRegistry(seed = []) {
  const providers = new Map();
  for (const value of seed) {
    const provider = normalizeProviderDescriptor(value);
    if (providers.has(provider.id)) throw new ModelRouterError('provider_duplicate', `provider already registered: ${provider.id}`, 409);
    providers.set(provider.id, provider);
  }
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
      const next = {
        ...clone(current),
        availability: enumValue(availability, AVAILABILITY),
        availability_evidence: 'observed',
        metadata: { ...clone(current.metadata || {}), health: redactProviderMetadata(evidence) },
        descriptor_digest: ''
      };
      next.descriptor_digest = hash({ ...next, descriptor_digest: undefined });
      providers.set(key, Object.freeze(next));
      return providers.get(key);
    },
    health() {
      const values = [...providers.values()];
      return Object.freeze({
        schema: 'sideways-maker-provider-health/v1',
        total: values.length,
        healthy: values.filter(value => value.availability === 'healthy').length,
        degraded: values.filter(value => value.availability === 'degraded').length,
        offline: values.filter(value => value.availability === 'offline').length,
        unknown: values.filter(value => value.availability === 'unknown').length,
        providers: values.map(value => ({ id: value.id, availability: value.availability, digest: value.descriptor_digest }))
      });
    }
  });
}

export function createBudgetLedger(input = {}) {
  const limits = Object.freeze({
    requests: Math.round(finite(input.requests, 100, 0, 10 ** 9)),
    input_tokens: Math.round(finite(input.input_tokens, 10 ** 9, 0, 10 ** 12)),
    output_tokens: Math.round(finite(input.output_tokens, 10 ** 9, 0, 10 ** 12)),
    cost_usd: finite(input.cost_usd, 10 ** 9, 0, 10 ** 9),
    wall_time_ms: Math.round(finite(input.wall_time_ms, 24 * 60 * 60 * 1000, 0, 30 * 24 * 60 * 60 * 1000))
  });
  const used = { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, wall_time_ms: 0 };
  function normalized(usage = {}) {
    return {
      requests: Math.round(finite(usage.requests, 0, 0)),
      input_tokens: Math.round(finite(usage.input_tokens, 0, 0)),
      output_tokens: Math.round(finite(usage.output_tokens, 0, 0)),
      cost_usd: finite(usage.cost_usd, 0, 0),
      wall_time_ms: Math.round(finite(usage.wall_time_ms, 0, 0))
    };
  }
  function check(usage = {}) {
    const addition = normalized(usage);
    for (const key of Object.keys(limits)) {
      if (used[key] + addition[key] > limits[key]) {
        throw new ModelRouterError('budget_exhausted', `budget exceeded: ${key}`, 429, { key, used: used[key], requested: addition[key], limit: limits[key] });
      }
    }
    return addition;
  }
  function admit(usage = {}) {
    const addition = check(usage);
    for (const key of Object.keys(used)) used[key] += addition[key];
    return snapshot();
  }
  function snapshot() {
    return Object.freeze({
      schema: 'sideways-maker-model-budget/v1',
      limits: clone(limits),
      used: clone(used),
      remaining: Object.fromEntries(Object.keys(limits).map(key => [key, Math.max(0, limits[key] - used[key])]))
    });
  }
  return Object.freeze({ check, admit, snapshot });
}

function jsonType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function validateSchema(value, schema, path = '$') {
  if (!isObject(schema)) return [];
  const errors = [];
  if (Array.isArray(schema.allOf)) for (const child of schema.allOf) errors.push(...validateSchema(value, child, path));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(child => validateSchema(value, child, path).length === 0)) errors.push(`${path}: did not satisfy anyOf`);
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(child => validateSchema(value, child, path).length === 0).length !== 1) errors.push(`${path}: did not satisfy exactly one oneOf branch`);
  if ('const' in schema && !Object.is(value, schema.const)) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) errors.push(`${path}: not in enum`);
  if (schema.type) {
    const actual = jsonType(value);
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const typeMatches = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!typeMatches) errors.push(`${path}: expected ${allowed.join('|')}, received ${actual}`);
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(`${path}: shorter than minLength`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength`);
    if (schema.pattern) {
      try { if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern mismatch`); } catch { errors.push(`${path}: invalid schema pattern`); }
    }
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${path}: fewer than minItems`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path}: more than maxItems`);
    if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(canonicalize(item)))).size !== value.length) errors.push(`${path}: items not unique`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${path}[${index}]`)));
  }
  if (isObject(value)) {
    if (Array.isArray(schema.required)) for (const key of schema.required) if (!(key in value)) errors.push(`${path}.${key}: required`);
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(properties)) if (key in value) errors.push(...validateSchema(value[key], child, `${path}.${key}`));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) errors.push(`${path}.${key}: additional property denied`);
    } else if (isObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) if (!(key in properties)) errors.push(...validateSchema(value[key], schema.additionalProperties, `${path}.${key}`));
    }
  }
  return errors;
}

function parseStructuredOutput(output) {
  if (output && typeof output === 'object') return clone(output);
  const text = clean(output, 500_000);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = clean(fenced || text, 500_000);
  try { return JSON.parse(candidate); } catch {}
  const indices = ['{', '['].map(char => candidate.indexOf(char)).filter(index => index >= 0);
  if (indices.length) {
    const first = Math.min(...indices);
    const last = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (last > first) {
      try { return JSON.parse(candidate.slice(first, last + 1)); } catch {}
    }
  }
  throw new ModelRouterError('structured_output_invalid', 'provider output was not valid JSON', 422);
}

function normalizeUsage(provider, task, response = {}, elapsed = 0) {
  const raw = isObject(response.usage) ? response.usage : {};
  const estimate = usageEstimate(provider, task) || { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const inputReported = Number.isFinite(Number(raw.input_tokens ?? raw.prompt_tokens));
  const outputReported = Number.isFinite(Number(raw.output_tokens ?? raw.completion_tokens));
  const costReported = Number.isFinite(Number(raw.cost_usd));
  const fieldEvidence = {
    input_tokens: inputReported ? 'provider_reported' : 'estimated',
    output_tokens: outputReported ? 'provider_reported' : 'estimated',
    cost_usd: costReported ? 'provider_reported' : 'estimated'
  };
  const evidenceValues = new Set(Object.values(fieldEvidence));
  return {
    requests: 1,
    input_tokens: Math.round(finite(inputReported ? (raw.input_tokens ?? raw.prompt_tokens) : estimate.input_tokens, 0, 0)),
    output_tokens: Math.round(finite(outputReported ? (raw.output_tokens ?? raw.completion_tokens) : estimate.output_tokens, 0, 0)),
    cost_usd: finite(costReported ? raw.cost_usd : estimate.cost_usd, 0, 0),
    wall_time_ms: Math.round(Math.max(0, elapsed)),
    evidence: evidenceValues.size === 1 ? [...evidenceValues][0] : 'mixed',
    field_evidence: fieldEvidence
  };
}

function normalizeRuntimeEnum(value, allowed, fallback) {
  const normalized = clean(value, 100).toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function projectRuntime(provider, task, response, clock) {
  const publicRuntime = isObject(response?.public_runtime) ? response.public_runtime : {};
  const local = provider.locality.value === 'local';
  const privateRuntime = provider.locality.value === 'private';
  return Object.freeze({
    schema: 'sideways-maker-runtime-profile/v1',
    runtime_id: `maker-runtime-${hash({ provider: provider.id, kind: provider.kind }).slice(0, 16)}`,
    display_name: provider.kind === 'native_checkpoint' ? 'Local Maker runtime' : 'Adaptive Maker runtime',
    status: normalizeRuntimeEnum(provider.availability, ['healthy', 'degraded', 'offline', 'unknown'], 'unknown'),
    intelligence: {
      selection: 'adaptive',
      engine_label: normalizePublicLabel(publicRuntime.engine_label, provider.public.engine_label),
      architecture: provider.kind === 'native_checkpoint' ? 'native' : 'remote',
      admission: provider.kind === 'native_checkpoint' ? 'verified' : normalizeRuntimeEnum(provider.admission.status, ['verified', 'configured', 'unverified', 'unknown'], 'unknown'),
      capabilities: Object.entries(provider.capabilities).filter(([, value]) => value.value === true && value.evidence !== 'unknown').map(([key]) => key)
    },
    endpoint: {
      ownership: local ? 'user' : privateRuntime ? 'project' : 'managed',
      transport: local ? 'local' : privateRuntime ? 'hybrid' : 'remote',
      locality: normalizeRuntimeEnum(provider.locality.value, ['local', 'remote', 'hybrid', 'private', 'unknown'], 'unknown'),
      capacity: normalizeRuntimeEnum(publicRuntime.capacity, ['dedicated', 'shared', 'burst', 'unknown'], 'unknown'),
      throttling: normalizeRuntimeEnum(publicRuntime.throttling, ['none', 'bounded', 'provider', 'unknown'], 'unknown'),
      label: normalizePublicLabel(publicRuntime.endpoint_label, provider.public.endpoint_label)
    },
    planning: { strategy: 'adaptive', scheduler: 'priority', parallelism: 1, speculation: false, recovery: 'checkpoint', confidence_threshold: 0.8 },
    execution: { role: task.role, modes: [task.profile], transport: 'queue', workspace: 'isolated', verification: 'continuous', checkpointing: 'enabled', recovery: 'journaled' },
    authority: { capabilities: {} },
    presentation: { headline: 'Maker is building your thing', activity: `Executing the ${task.profile} stage`, tone: 'friendly', visible: true },
    observed_at: now(clock)
  });
}

async function raceWithTimeout(invoke, timeoutMs, controller) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(invoke),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('provider attempt timed out'));
          reject(new ModelRouterError('provider_timeout', 'provider attempt timed out; completion state is indeterminate unless the transport honors AbortSignal', 504));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createModelRouter({
  registry = null,
  providers = [],
  transports = {},
  health_checks = {},
  clock = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  id = randomUUID,
  global_budget = {},
  retries = 2,
  repair_attempts = 1,
  circuit_threshold = 3,
  circuit_cooldown_ms = 60_000,
  attempt_timeout_ms = 120_000
} = {}) {
  if (registry && providers.length) throw new ModelRouterError('provider_registry_conflict', 'provide registry or providers, not both');
  registry = registry || createProviderRegistry(providers);
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

  function account(usage, taskLedger) {
    ledger.check(usage);
    taskLedger.check(usage);
    ledger.admit(usage);
    taskLedger.admit(usage);
  }

  async function accountDelay(delay, taskLedger) {
    ledger.check({ wall_time_ms: delay });
    taskLedger.check({ wall_time_ms: delay });
    const started = clock();
    await sleep(delay);
    const elapsed = Math.max(delay, clock() - started);
    account({ wall_time_ms: elapsed }, taskLedger);
  }

  async function runAttempt(provider, task, attempt, repair, taskLedger) {
    const transport = transportFor(provider);
    if (typeof transport !== 'function') throw new ModelRouterError('transport_unavailable', `transport unavailable for ${provider.id}`, 503);
    const estimate = usageEstimate(provider, task);
    if (!estimate) throw new ModelRouterError('cost_unknown', `provider cost unavailable for ${provider.id}`, 409);
    ledger.check(estimate);
    taskLedger.check(estimate);
    const remainingWall = Math.min(ledger.snapshot().remaining.wall_time_ms, taskLedger.snapshot().remaining.wall_time_ms);
    const timeoutMs = Math.max(1, Math.min(attempt_timeout_ms, remainingWall));
    const controller = new AbortController();
    const started = clock();
    const packet = {
      schema: 'sideways-maker-provider-attempt/v1',
      task: clone(task),
      provider: { id: provider.id, kind: provider.kind, descriptor_digest: provider.descriptor_digest },
      attempt,
      repair: repair ? redactProviderSecrets(repair) : null,
      budget: { global: ledger.snapshot().remaining, task: taskLedger.snapshot().remaining },
      signal: controller.signal
    };
    let accounted = false;
    try {
      const response = await raceWithTimeout(() => transport(packet), timeoutMs, controller);
      const elapsed = Math.max(0, clock() - started);
      const usage = normalizeUsage(provider, task, response, elapsed);
      account(usage, taskLedger);
      accounted = true;
      if (usage.cost_usd > task.max_cost_usd) throw new ModelRouterError('task_cost_exceeded', 'provider-reported usage exceeded task cost ceiling', 429, { cost_usd: usage.cost_usd, max_cost_usd: task.max_cost_usd });
      const parsed = task.output_schema ? parseStructuredOutput(response?.output ?? response?.text ?? response) : redactProviderSecrets(response?.output ?? response?.text ?? response);
      const validation_errors = task.output_schema ? validateSchema(parsed, task.output_schema) : [];
      return { response: isObject(response) ? response : {}, parsed, usage, validation_errors };
    } catch (error) {
      if (error.code === 'budget_exhausted' || error.code === 'task_cost_exceeded') throw error;
      if (!accounted) {
        const elapsed = Math.max(1, clock() - started);
        account({ requests: 1, wall_time_ms: elapsed }, taskLedger);
      }
      throw error;
    }
  }

  async function route(taskInput, options = {}) {
    const task = normalizeTask({ ...taskInput, id: taskInput?.id || id() });
    const taskLedger = createBudgetLedger(task.budget);
    const rolePool = unique(options.provider_pool || []);
    let providers = registry.list();
    if (rolePool.length) providers = providers.filter(provider => rolePool.includes(provider.id));
    const circuitOptions = Object.fromEntries(providers.map(provider => [provider.id, {
      circuit_open: circuit(provider.id).open_until > clock(),
      allow_unknown_availability: options.allow_unknown_availability === true,
      allow_unknown_cost: options.allow_unknown_cost === true
    }]));
    const ranked = rankProviders(providers, task, circuitOptions);
    if (!ranked.length) throw new ModelRouterError('no_provider', 'no provider satisfies task requirements', 503);

    const attempts = [];
    let lastError;
    for (const candidate of ranked) {
      const provider = candidate.provider;
      const state = circuit(provider.id);
      for (let attempt = 1; attempt <= Math.max(1, retries + 1); attempt += 1) {
        let repair = null;
        let retryProvider = false;
        for (let repairIndex = 0; repairIndex <= Math.max(0, repair_attempts); repairIndex += 1) {
          const attemptId = id();
          const startedAt = now(clock);
          try {
            const result = await runAttempt(provider, task, attempt, repair, taskLedger);
            if (result.validation_errors.length) {
              attempts.push({
                schema: 'sideways-maker-route-attempt/v1', attempt_id: attemptId, provider_id: provider.id, provider_kind: provider.kind,
                descriptor_digest: provider.descriptor_digest, attempt, repair_index: repairIndex, started_at: startedAt, finished_at: now(clock),
                status: 'schema_invalid', validation_errors: result.validation_errors, usage: result.usage
              });
              lastError = new ModelRouterError('schema_validation_failed', 'structured output did not satisfy schema', 422, { errors: result.validation_errors });
              if (repairIndex < repair_attempts) {
                repair = { instruction: 'Return JSON only and repair the listed schema violations.', errors: result.validation_errors, prior_output: redactProviderSecrets(result.parsed) };
                continue;
              }
              retryProvider = true;
              break;
            }

            state.failures = 0;
            state.open_until = 0;
            attempts.push({
              schema: 'sideways-maker-route-attempt/v1', attempt_id: attemptId, provider_id: provider.id, provider_kind: provider.kind,
              descriptor_digest: provider.descriptor_digest, attempt, repair_index: repairIndex, started_at: startedAt, finished_at: now(clock),
              status: 'success', validation_errors: [], usage: result.usage
            });
            const receipt = {
              schema: 'sideways-maker-model-route/v1',
              route_id: id(),
              task_id: task.id,
              task_profile: task.profile,
              selected_provider: provider.id,
              provider_kind: provider.kind,
              runtime_profile: projectRuntime(provider, task, result.response, clock),
              output: redactProviderSecrets(result.parsed),
              attempts: redactProviderSecrets(attempts),
              budget: { global: ledger.snapshot(), task: taskLedger.snapshot() },
              state_digest: hash(task.state),
              receipt_digest: ''
            };
            receipt.receipt_digest = hash({ ...receipt, receipt_digest: undefined });
            return Object.freeze(receipt);
          } catch (error) {
            lastError = error;
            const code = clean(error.code || 'provider_failed', 100);
            attempts.push({
              schema: 'sideways-maker-route-attempt/v1', attempt_id: attemptId, provider_id: provider.id, provider_kind: provider.kind,
              descriptor_digest: provider.descriptor_digest, attempt, repair_index: repairIndex, started_at: startedAt, finished_at: now(clock),
              status: code === 'provider_timeout' ? 'timeout' : 'failed', validation_errors: [],
              error: { code, message: clean(redactProviderSecrets(error.message), 1_000), indeterminate: code === 'provider_timeout' }
            });
            if (['budget_exhausted', 'task_cost_exceeded'].includes(code)) throw new ModelRouterError(code, error.message, error.status, { ...redactProviderSecrets(error.detail), attempts: redactProviderSecrets(attempts) });
            if (repairIndex < repair_attempts && code === 'structured_output_invalid') {
              repair = { instruction: 'Return valid JSON only.', errors: [clean(error.message, 500)] };
              continue;
            }
            state.failures += 1;
            if (state.failures >= circuit_threshold) state.open_until = clock() + circuit_cooldown_ms;
            retryProvider = true;
            break;
          }
        }
        if (!retryProvider) break;
        if (attempt <= retries) await accountDelay((lastError?.status === 429 || lastError?.code === 'rate_limited' ? 1000 : 250) * attempt, taskLedger);
      }
    }
    throw new ModelRouterError('fallback_exhausted', 'all provider attempts failed', 503, {
      attempts: redactProviderSecrets(attempts),
      last_error: clean(redactProviderSecrets(lastError?.message), 1_000),
      budget: { global: ledger.snapshot(), task: taskLedger.snapshot() }
    });
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
      return Object.freeze({ schema: 'sideways-maker-provider-probe/v1', provider_id: provider.id, status: provider.availability, evidence: 'configured', checked_at: checkedAt, detail: { reason: 'health check transport not configured' } });
    }
    try {
      const raw = await check({ id: provider.id, kind: provider.kind, descriptor_digest: provider.descriptor_digest });
      const result = redactProviderMetadata(raw);
      const status = enumValue(raw?.status ?? (raw?.ok === true ? 'healthy' : 'degraded'), AVAILABILITY);
      registry.updateHealth(provider.id, status, { evidence: 'observed', result, checked_at: checkedAt });
      return Object.freeze({ schema: 'sideways-maker-provider-probe/v1', provider_id: provider.id, status, evidence: 'observed', checked_at: checkedAt, detail: result });
    } catch (error) {
      const detail = { error: clean(redactProviderSecrets(error.message), 1_000) };
      registry.updateHealth(provider.id, 'offline', { evidence: 'observed', ...detail, checked_at: checkedAt });
      return Object.freeze({ schema: 'sideways-maker-provider-probe/v1', provider_id: provider.id, status: 'offline', evidence: 'observed', checked_at: checkedAt, detail });
    }
  }

  async function probeAll() {
    const receipts = [];
    for (const provider of registry.list()) receipts.push(await probe(provider.id));
    return receipts;
  }

  function health() {
    return Object.freeze({
      schema: 'sideways-maker-model-router-health/v1',
      registry: registry.health(),
      budget: ledger.snapshot(),
      circuits: redactProviderSecrets(Object.fromEntries([...circuits.entries()].sort(([a], [b]) => a.localeCompare(b)))),
      observed_at: now(clock)
    });
  }

  function providersSnapshot() {
    return registry.list();
  }

  async function execute(taskInput = {}, state = {}, options = {}) {
    const requestedProfile = clean(taskInput.profile || taskInput.type || taskInput.task || 'coding', 100).toLowerCase();
    const legacy = LEGACY_TASK_PROFILES[requestedProfile];
    if (!legacy) throw new ModelRouterError('task_profile_invalid', `unsupported task profile: ${requestedProfile}`);
    const requestedLatency = clean(taskInput.max_latency_class || taskInput.latency || legacy.latency, 50).toLowerCase();
    const routed = await route({
      id: taskInput.id,
      // execute() is the compatibility surface for the inherited runtime-platform.
      // Use a neutral modern profile and carry the exact legacy requirements explicitly;
      // route() callers retain the stricter admitted modern task profiles.
      profile: 'summarization',
      role: taskInput.role || legacy.role,
      messages: taskInput.messages,
      state,
      required_capabilities: unique([...(legacy.required || []), ...(taskInput.required_capabilities || taskInput.required || [])]),
      preferred_capabilities: unique([...(legacy.preferred || []), ...(taskInput.preferred_capabilities || taskInput.preferred || [])]),
      context_tokens: taskInput.context_tokens ?? legacy.context_tokens,
      output_tokens: taskInput.output_tokens ?? legacy.output_tokens,
      max_cost_usd: taskInput.max_cost_usd,
      max_latency_class: requestedLatency === 'fast' ? 'interactive' : requestedLatency,
      privacy: taskInput.privacy || taskInput.privacy_minimum,
      locality: taskInput.locality || taskInput.locality_preference,
      region: taskInput.region || taskInput.region_preference,
      provider_preference: taskInput.provider_preference || taskInput.operator_preference,
      output_schema: taskInput.output_schema,
      budget: taskInput.budget
    }, options);
    const descriptor = registry.get(routed.selected_provider);
    const provider = descriptor ? {
      id: descriptor.id,
      display_name: descriptor.display_name,
      engine_label: descriptor.public.engine_label,
      kind: descriptor.kind,
      admission: { admitted: descriptor.kind !== 'native_checkpoint' || descriptor.native.admitted === true }
    } : { id: routed.selected_provider, kind: routed.provider_kind };
    const receipt = { ...routed, task_profile: requestedProfile, provider, receipt_digest: '' };
    receipt.receipt_digest = hash({ ...receipt, receipt_digest: undefined });
    return Object.freeze(receipt);
  }

  return Object.freeze({ route, execute, providers: providersSnapshot, grade, probe, probeAll, health, budget: () => ledger.snapshot() });
}
