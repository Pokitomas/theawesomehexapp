#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const finite = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const unique = (values, limit = 200) => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 200)).filter(Boolean))].slice(0, limit);
const SOURCE_VALUES = ['observed', 'configured', 'unknown'];
const PROVIDER_KINDS = ['native_checkpoint', 'github_models', 'openai_compatible', 'ollama', 'anthropic_compatible', 'configured'];
const HEALTH_VALUES = ['healthy', 'degraded', 'offline', 'unknown'];
const PRIVACY_VALUES = ['local', 'private', 'contractual', 'provider', 'unknown'];
const LATENCY_RANK = Object.freeze({ realtime: 5, fast: 4, standard: 3, slow: 2, batch: 1, unknown: 0 });
const PRIVACY_RANK = Object.freeze({ local: 5, private: 4, contractual: 3, provider: 2, unknown: 0 });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function receiptDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key)/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;
export function redactProviderSecrets(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 300).map(item => redactProviderSecrets(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 500).map(([key, item]) => [
      clean(key, 200),
      SECRET_KEY.test(key) ? '[redacted]' : redactProviderSecrets(item, depth + 1)
    ]));
  }
  if (typeof value === 'string') return clean(value.replace(SECRET_TEXT, '[redacted]'), 20000);
  if (['number', 'boolean'].includes(typeof value) || value === null) return value;
  return clean(value, 2000);
}

export class MakerModelRouterError extends Error {
  constructor(code, message, status = 400, detail = {}) {
    super(message);
    this.name = 'MakerModelRouterError';
    this.code = code;
    this.status = status;
    this.detail = redactProviderSecrets(detail);
  }
}

function evidence(value, source = 'unknown') {
  return Object.freeze({ value, source: SOURCE_VALUES.includes(source) ? source : 'unknown' });
}

function normalizeCapability(input, fallback, normalizer = value => value) {
  if (input && typeof input === 'object' && Object.hasOwn(input, 'value')) {
    return evidence(normalizer(input.value), input.source);
  }
  if (input !== undefined) return evidence(normalizer(input), 'configured');
  return evidence(fallback, 'unknown');
}

export function verifyNativeAdmission(provider) {
  if (provider.kind !== 'native_checkpoint') return Object.freeze({ admitted: true, reason: 'not_native' });
  const native = provider.native || {};
  const admission = native.admission || {};
  if (admission.verified !== true) return Object.freeze({ admitted: false, reason: 'admission_unverified' });
  const expected = clean(admission.checkpoint_digest, 300);
  const configured = clean(native.checkpoint_digest, 300);
  const runtime = clean(native.runtime_checkpoint_digest, 300);
  if (!expected || expected !== configured) return Object.freeze({ admitted: false, reason: 'checkpoint_digest_mismatch' });
  if (!runtime || runtime !== configured) return Object.freeze({ admitted: false, reason: 'runtime_checkpoint_mismatch' });
  if (admission.runtime_id && native.runtime_id && clean(admission.runtime_id, 300) !== clean(native.runtime_id, 300)) {
    return Object.freeze({ admitted: false, reason: 'runtime_identity_mismatch' });
  }
  return Object.freeze({ admitted: true, reason: 'verified' });
}

export function normalizeProviderDescriptor(input = {}) {
  const id = clean(input.id, 300);
  if (!id) throw new MakerModelRouterError('invalid_provider', 'provider id is required');
  const kind = PROVIDER_KINDS.includes(input.kind) ? input.kind : 'configured';
  const capabilities = input.capabilities || {};
  const limits = input.limits || {};
  const cost = input.cost || {};
  const provider = {
    schema: 'sideways-maker-provider/v1',
    id,
    display_name: clean(input.display_name || id, 300),
    kind,
    health: HEALTH_VALUES.includes(input.health) ? input.health : 'unknown',
    availability: normalizeCapability(input.availability, input.health !== 'offline', Boolean),
    admission: clean(input.admission || (kind === 'native_checkpoint' ? 'unverified' : 'configured'), 100),
    capabilities: Object.freeze({
      structured_json: normalizeCapability(capabilities.structured_json, false, Boolean),
      tool_use: normalizeCapability(capabilities.tool_use, false, Boolean),
      streaming: normalizeCapability(capabilities.streaming, false, Boolean),
      multimodal: normalizeCapability(capabilities.multimodal, false, Boolean),
      context_tokens: normalizeCapability(capabilities.context_tokens ?? limits.context_tokens, 0, value => Math.round(finite(value, 0, 0, 10 ** 9))),
      output_tokens: normalizeCapability(capabilities.output_tokens ?? limits.output_tokens, 0, value => Math.round(finite(value, 0, 0, 10 ** 8))),
      latency_class: normalizeCapability(capabilities.latency_class || 'unknown', 'unknown', value => clean(value, 40).toLowerCase()),
      privacy: normalizeCapability(capabilities.privacy || 'unknown', 'unknown', value => PRIVACY_VALUES.includes(clean(value, 40).toLowerCase()) ? clean(value, 40).toLowerCase() : 'unknown'),
      region: normalizeCapability(capabilities.region || 'unknown', 'unknown', value => clean(value, 100).toLowerCase()),
      locality: normalizeCapability(capabilities.locality || 'remote', 'remote', value => clean(value, 40).toLowerCase())
    }),
    cost: Object.freeze({
      input_per_million_usd: normalizeCapability(cost.input_per_million_usd, 0, value => finite(value, 0, 0, 10 ** 9)),
      output_per_million_usd: normalizeCapability(cost.output_per_million_usd, 0, value => finite(value, 0, 0, 10 ** 9)),
      request_usd: normalizeCapability(cost.request_usd, 0, value => finite(value, 0, 0, 10 ** 9))
    }),
    reliability: Object.freeze({
      success_rate: finite(input.reliability?.success_rate, 0.5, 0, 1),
      samples: Math.round(finite(input.reliability?.samples, 0, 0, 10 ** 9)),
      consecutive_failures: Math.round(finite(input.reliability?.consecutive_failures, 0, 0, 10 ** 6))
    }),
    preferences: Object.freeze({
      operator_rank: Math.round(finite(input.preferences?.operator_rank, 0, -1000, 1000)),
      roles: unique(input.preferences?.roles),
      tasks: unique(input.preferences?.tasks)
    }),
    endpoint_label: clean(input.endpoint_label || `${kind} endpoint`, 300),
    native: kind === 'native_checkpoint' ? Object.freeze(redactProviderSecrets({
      checkpoint_digest: input.native?.checkpoint_digest,
      runtime_checkpoint_digest: input.native?.runtime_checkpoint_digest,
      runtime_id: input.native?.runtime_id,
      admission: input.native?.admission
    })) : null,
    metadata: Object.freeze(redactProviderSecrets(input.metadata || {}))
  };
  const nativeAdmission = verifyNativeAdmission(provider);
  provider.native_admission = nativeAdmission;
  provider.selectable = provider.availability.value === true && provider.health !== 'offline' && nativeAdmission.admitted;
  provider.descriptor_digest = receiptDigest({ ...provider, descriptor_digest: undefined });
  return Object.freeze(provider);
}

const TASK_PROFILES = Object.freeze({
  planning: { required: ['structured_json'], preferred: ['tool_use'], context_tokens: 32000, output_tokens: 8000, latency: 'standard', role: 'planner' },
  repository_mapping: { required: ['structured_json'], preferred: ['tool_use'], context_tokens: 64000, output_tokens: 12000, latency: 'standard', role: 'mapper' },
  coding: { required: ['structured_json', 'tool_use'], preferred: ['streaming'], context_tokens: 64000, output_tokens: 16000, latency: 'standard', role: 'implementer' },
  debugging: { required: ['structured_json', 'tool_use'], preferred: ['streaming'], context_tokens: 48000, output_tokens: 12000, latency: 'fast', role: 'debugger' },
  review: { required: ['structured_json'], preferred: ['tool_use'], context_tokens: 48000, output_tokens: 8000, latency: 'standard', role: 'reviewer' },
  summarization: { required: [], preferred: ['structured_json'], context_tokens: 32000, output_tokens: 4000, latency: 'fast', role: 'summarizer' },
  browser_interpretation: { required: ['multimodal'], preferred: ['structured_json'], context_tokens: 24000, output_tokens: 8000, latency: 'fast', role: 'browser' },
  grading: { required: ['structured_json'], preferred: [], context_tokens: 32000, output_tokens: 6000, latency: 'standard', role: 'grader' }
});

export function normalizeTaskProfile(input = {}) {
  const template = TASK_PROFILES[input.type] || {};
  const type = clean(input.type || 'coding', 100);
  return Object.freeze({
    schema: 'sideways-maker-model-task/v1',
    id: clean(input.id || type, 300),
    type,
    role: clean(input.role || template.role || 'implementer', 100),
    required: unique(input.required || template.required),
    preferred: unique(input.preferred || template.preferred),
    context_tokens: Math.round(finite(input.context_tokens, template.context_tokens || 16000, 1, 10 ** 9)),
    output_tokens: Math.round(finite(input.output_tokens, template.output_tokens || 4000, 1, 10 ** 8)),
    latency: clean(input.latency || template.latency || 'standard', 40).toLowerCase(),
    privacy_minimum: PRIVACY_VALUES.includes(input.privacy_minimum) ? input.privacy_minimum : 'unknown',
    locality_preference: clean(input.locality_preference || 'any', 40).toLowerCase(),
    region_preference: clean(input.region_preference || '', 100).toLowerCase(),
    max_cost_usd: finite(input.max_cost_usd, Number.MAX_SAFE_INTEGER, 0, 10 ** 9),
    input_tokens: Math.round(finite(input.input_tokens, 0, 0, 10 ** 9)),
    operator_preference: unique(input.operator_preference),
    excluded_provider_ids: unique(input.excluded_provider_ids),
    require_independent_grader: input.require_independent_grader === true,
    output_schema: input.output_schema && typeof input.output_schema === 'object' ? structuredClone(input.output_schema) : null
  });
}

function capabilityValue(provider, name) {
  return provider.capabilities[name]?.value;
}

export function estimateProviderCost(provider, task) {
  const input = task.input_tokens || task.context_tokens;
  const output = task.output_tokens;
  return provider.cost.request_usd.value +
    (input / 1_000_000) * provider.cost.input_per_million_usd.value +
    (output / 1_000_000) * provider.cost.output_per_million_usd.value;
}

export function scoreProvider(provider, taskInput = {}, options = {}) {
  const task = taskInput.schema ? taskInput : normalizeTaskProfile(taskInput);
  const failures = [];
  if (!provider.selectable) failures.push(provider.native_admission?.reason || 'unavailable');
  if (task.excluded_provider_ids.includes(provider.id) || options.exclude_ids?.includes(provider.id)) failures.push('excluded');
  for (const capability of task.required) {
    if (capabilityValue(provider, capability) !== true) failures.push(`missing:${capability}`);
  }
  if (capabilityValue(provider, 'context_tokens') < task.context_tokens) failures.push('context_overflow');
  if (capabilityValue(provider, 'output_tokens') < task.output_tokens) failures.push('output_overflow');
  const estimatedCost = estimateProviderCost(provider, task);
  if (estimatedCost > task.max_cost_usd) failures.push('cost_ceiling');
  if (PRIVACY_RANK[capabilityValue(provider, 'privacy')] < PRIVACY_RANK[task.privacy_minimum]) failures.push('privacy');
  if (failures.length) return Object.freeze({ provider_id: provider.id, eligible: false, failures, score: -Infinity, estimated_cost_usd: estimatedCost });

  let score = 0;
  score += provider.reliability.success_rate * 100;
  score += Math.min(20, Math.log10(provider.reliability.samples + 1) * 5);
  score -= provider.reliability.consecutive_failures * 12;
  score += provider.health === 'healthy' ? 20 : provider.health === 'degraded' ? 5 : 0;
  score += task.preferred.filter(capability => capabilityValue(provider, capability) === true).length * 8;
  score += Math.max(0, 20 - (capabilityValue(provider, 'context_tokens') - task.context_tokens) / Math.max(task.context_tokens, 1));
  score += (LATENCY_RANK[capabilityValue(provider, 'latency_class')] || 0) * 3;
  score += (PRIVACY_RANK[capabilityValue(provider, 'privacy')] || 0) * 4;
  if (task.locality_preference !== 'any' && capabilityValue(provider, 'locality') === task.locality_preference) score += 18;
  if (task.region_preference && capabilityValue(provider, 'region') === task.region_preference) score += 8;
  if (task.operator_preference.includes(provider.id)) score += 40 - task.operator_preference.indexOf(provider.id);
  score += provider.preferences.operator_rank;
  if (provider.preferences.roles.includes(task.role)) score += 10;
  if (provider.preferences.tasks.includes(task.type)) score += 10;
  score -= Math.min(50, estimatedCost * 5);
  return Object.freeze({ provider_id: provider.id, eligible: true, failures: [], score: Number(score.toFixed(6)), estimated_cost_usd: Number(estimatedCost.toFixed(8)) });
}

export function selectProviders(providers, taskInput = {}, options = {}) {
  const task = taskInput.schema ? taskInput : normalizeTaskProfile(taskInput);
  const scores = providers.map(provider => scoreProvider(provider, task, options));
  return scores
    .filter(item => item.eligible)
    .sort((a, b) => b.score - a.score || a.provider_id.localeCompare(b.provider_id));
}

export function createBudgetLedger(input = {}) {
  const global = {
    requests: Math.round(finite(input.requests, 1000, 0, 10 ** 9)),
    input_tokens: Math.round(finite(input.input_tokens, 10 ** 9, 0, 10 ** 12)),
    output_tokens: Math.round(finite(input.output_tokens, 10 ** 9, 0, 10 ** 12)),
    cost_usd: finite(input.cost_usd, 10 ** 9, 0, 10 ** 9),
    wall_time_ms: Math.round(finite(input.wall_time_ms, 30 * 24 * 60 * 60 * 1000, 0, 10 ** 12))
  };
  const perTask = new Map();
  const usage = { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, wall_time_ms: 0 };
  function taskBudget(taskId, override = {}) {
    if (!perTask.has(taskId)) perTask.set(taskId, {
      requests: Math.round(finite(override.requests, global.requests, 0, global.requests)),
      input_tokens: Math.round(finite(override.input_tokens, global.input_tokens, 0, global.input_tokens)),
      output_tokens: Math.round(finite(override.output_tokens, global.output_tokens, 0, global.output_tokens)),
      cost_usd: finite(override.cost_usd, global.cost_usd, 0, global.cost_usd),
      wall_time_ms: Math.round(finite(override.wall_time_ms, global.wall_time_ms, 0, global.wall_time_ms)),
      usage: { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, wall_time_ms: 0 }
    });
    return perTask.get(taskId);
  }
  function ensureWithin(limit, current, addition, code) {
    if (current + addition > limit) throw new MakerModelRouterError(code, `${code.replaceAll('_', ' ')} exceeded`, 429);
  }
  function record(taskId, evidenceInput = {}, limits = {}) {
    const task = taskBudget(taskId, limits);
    const reported = evidenceInput.reported === true;
    const delta = {
      requests: 1,
      input_tokens: Math.round(finite(evidenceInput.input_tokens, 0, 0, 10 ** 12)),
      output_tokens: Math.round(finite(evidenceInput.output_tokens, 0, 0, 10 ** 12)),
      cost_usd: finite(evidenceInput.cost_usd, 0, 0, 10 ** 9),
      wall_time_ms: Math.round(finite(evidenceInput.wall_time_ms, 0, 0, 10 ** 12))
    };
    for (const key of Object.keys(delta)) {
      ensureWithin(global[key], usage[key], delta[key], `global_${key}_budget`);
      ensureWithin(task[key], task.usage[key], delta[key], `task_${key}_budget`);
    }
    for (const key of Object.keys(delta)) {
      usage[key] += delta[key];
      task.usage[key] += delta[key];
    }
    return Object.freeze({ ...delta, source: reported ? 'provider_reported' : 'estimated' });
  }
  function snapshot() {
    return Object.freeze({
      schema: 'sideways-maker-model-budget/v1',
      limits: structuredClone(global),
      usage: structuredClone(usage),
      tasks: [...perTask.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([task_id, value]) => ({ task_id, limits: { ...value, usage: undefined }, usage: structuredClone(value.usage) }))
    });
  }
  return Object.freeze({ record, snapshot });
}

function validateType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

export function validateStructuredOutput(value, schema = null, path = '$') {
  if (!schema) return { valid: true, errors: [] };
  const errors = [];
  if (schema.type && !validateType(value, schema.type)) errors.push(`${path} must be ${schema.type}`);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) errors.push(`${path} must match enum`);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) errors.push(...validateStructuredOutput(value[key], child, `${path}.${key}`).errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key)) errors.push(`${path}.${key} is not allowed`);
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateStructuredOutput(item, schema.items, `${path}[${index}]`).errors));
  }
  return { valid: errors.length === 0, errors };
}

function parseStructured(value) {
  if (value && typeof value === 'object') return value;
  const text = clean(value, 500000);
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const indices = ['{', '['].map(char => text.indexOf(char)).filter(index => index >= 0);
  const first = indices.length ? Math.min(...indices) : -1;
  const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));
  throw new MakerModelRouterError('invalid_json', 'provider output was not valid JSON', 422);
}

export function createModelRouter({
  providers = [],
  transports = {},
  clock = Date.now,
  sleep = async () => {},
  id = randomUUID,
  budgets = {},
  retries = 2,
  repair_retries = 1,
  circuit_failures = 3,
  circuit_cooldown_ms = 60_000
} = {}) {
  const registry = new Map(providers.map(value => {
    const provider = value.schema ? value : normalizeProviderDescriptor(value);
    return [provider.id, provider];
  }));
  const ledger = createBudgetLedger(budgets);
  const circuit = new Map();

  function circuitState(providerId) {
    if (!circuit.has(providerId)) circuit.set(providerId, { failures: 0, opened_at: 0 });
    return circuit.get(providerId);
  }

  function availableProviders(task, options = {}) {
    const stamp = clock();
    return [...registry.values()].filter(provider => {
      const state = circuitState(provider.id);
      return !(state.failures >= circuit_failures && stamp - state.opened_at < circuit_cooldown_ms);
    }).filter(provider => !options.provider_pool || options.provider_pool.includes(provider.id));
  }

  function sanitizeTaskForTransport(task, state, repair = null) {
    return Object.freeze(redactProviderSecrets({
      task_id: task.id,
      type: task.type,
      role: task.role,
      messages: state.messages,
      context: state.context,
      output_schema: task.output_schema,
      repair
    }));
  }

  async function execute(taskInput, stateInput = {}, options = {}) {
    const task = taskInput.schema ? taskInput : normalizeTaskProfile(taskInput);
    const state = Object.freeze({
      messages: structuredClone(Array.isArray(stateInput.messages) ? stateInput.messages : []),
      context: redactProviderSecrets(stateInput.context || {}),
      state_digest: receiptDigest({ messages: stateInput.messages || [], context: redactProviderSecrets(stateInput.context || {}) })
    });
    const selected = selectProviders(availableProviders(task, options), task, { exclude_ids: options.exclude_ids });
    if (!selected.length) throw new MakerModelRouterError('no_provider', 'no eligible admitted provider available', 503, { task: task.id });
    const attempts = [];
    let lastError;

    for (const selection of selected) {
      const provider = registry.get(selection.provider_id);
      const transport = transports[provider.id] || transports[provider.kind];
      if (typeof transport !== 'function') {
        attempts.push({ provider_id: provider.id, outcome: 'unavailable_transport' });
        continue;
      }
      const stateEntry = circuitState(provider.id);
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const started = clock();
        try {
          let response = await transport(sanitizeTaskForTransport(task, state), {
            provider_id: provider.id,
            attempt,
            timeout_ms: options.timeout_ms
          });
          let parsed = parseStructured(response.output ?? response.text ?? response);
          let validation = validateStructuredOutput(parsed, task.output_schema);
          let repairs = 0;
          while (!validation.valid && repairs < repair_retries) {
            repairs += 1;
            response = await transport(sanitizeTaskForTransport(task, state, {
              errors: validation.errors,
              invalid_output: parsed
            }), {
              provider_id: provider.id,
              attempt,
              repair: repairs,
              timeout_ms: options.timeout_ms
            });
            parsed = parseStructured(response.output ?? response.text ?? response);
            validation = validateStructuredOutput(parsed, task.output_schema);
          }
          if (!validation.valid) throw new MakerModelRouterError('schema_validation_failed', 'provider output failed schema validation', 422, { errors: validation.errors });
          const reportedUsage = response.usage && typeof response.usage === 'object';
          const usage = ledger.record(task.id, {
            input_tokens: response.usage?.input_tokens ?? task.input_tokens,
            output_tokens: response.usage?.output_tokens ?? Math.min(task.output_tokens, JSON.stringify(parsed).length / 4),
            cost_usd: response.usage?.cost_usd ?? selection.estimated_cost_usd,
            wall_time_ms: Math.max(0, clock() - started),
            reported: reportedUsage
          }, options.task_budget);
          stateEntry.failures = 0;
          stateEntry.opened_at = 0;
          const receipt = {
            schema: 'sideways-maker-model-route-receipt/v1',
            route_id: id(),
            task_id: task.id,
            provider: {
              id: provider.id,
              display_name: provider.display_name,
              kind: provider.kind,
              engine_label: provider.metadata.engine_label || provider.display_name,
              admission: provider.native_admission
            },
            state_digest: state.state_digest,
            score: selection.score,
            attempt,
            repairs,
            usage,
            output: redactProviderSecrets(parsed),
            attempts: [...attempts, { provider_id: provider.id, attempt, outcome: 'success', usage_source: usage.source }],
            budget: ledger.snapshot(),
            finished_at: new Date(clock()).toISOString()
          };
          receipt.receipt_digest = receiptDigest({ ...receipt, receipt_digest: undefined });
          return Object.freeze(receipt);
        } catch (error) {
          lastError = error;
          const code = clean(error.code || error.status || 'provider_failed', 100);
          const rateLimited = error.status === 429 || code === 'rate_limited' || /rate.?limit|429/i.test(error.message);
          attempts.push({
            provider_id: provider.id,
            attempt,
            outcome: 'failed',
            code,
            message: clean(redactProviderSecrets(error.message), 1000),
            rate_limited: rateLimited
          });
          stateEntry.failures += 1;
          if (stateEntry.failures >= circuit_failures) stateEntry.opened_at = clock();
          if (attempt < retries) await sleep((rateLimited ? 1000 : 250) * (attempt + 1));
        }
      }
    }
    throw new MakerModelRouterError('fallback_exhausted', 'all eligible providers failed', 502, {
      attempts,
      last_error: lastError?.message
    });
  }

  async function grade(taskInput, state, primaryReceipt, options = {}) {
    const task = normalizeTaskProfile({
      ...taskInput,
      type: 'grading',
      role: 'grader',
      excluded_provider_ids: unique([...(taskInput.excluded_provider_ids || []), primaryReceipt.provider.id])
    });
    return execute(task, {
      ...state,
      context: { ...(state.context || {}), candidate_output: primaryReceipt.output, candidate_receipt_digest: primaryReceipt.receipt_digest }
    }, { ...options, exclude_ids: unique([...(options.exclude_ids || []), primaryReceipt.provider.id]) });
  }

  async function health() {
    const values = [];
    for (const provider of [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const transport = transports[provider.id] || transports[provider.kind];
      let observed = provider.health;
      if (transport?.health) {
        try { observed = (await transport.health(provider)).status || observed; } catch { observed = 'degraded'; }
      }
      const state = circuitState(provider.id);
      values.push({
        provider_id: provider.id,
        selectable: provider.selectable,
        configured_health: provider.health,
        observed_health: HEALTH_VALUES.includes(observed) ? observed : 'unknown',
        circuit: state.failures >= circuit_failures && clock() - state.opened_at < circuit_cooldown_ms ? 'open' : 'closed',
        admission: provider.native_admission
      });
    }
    const snapshot = { schema: 'sideways-maker-model-health/v1', providers: values, at: new Date(clock()).toISOString() };
    snapshot.receipt_digest = receiptDigest({ ...snapshot, receipt_digest: undefined });
    return Object.freeze(snapshot);
  }

  return Object.freeze({
    providers: () => [...registry.values()].sort((a, b) => a.id.localeCompare(b.id)),
    select: task => selectProviders(availableProviders(task), task),
    execute,
    grade,
    health,
    budget: () => ledger.snapshot()
  });
}
