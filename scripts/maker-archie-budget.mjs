#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARCHIE_BUDGET_RECEIPT_SCHEMA = 'archie-reasoning-budget-receipt/v1';
export const ARCHIE_BUDGET_LEDGER_SCHEMA = 'archie-reasoning-budget-ledger/v1';

const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0));
const nonnegative = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
const integer = value => Math.max(0, Math.floor(Number.isFinite(Number(value)) ? Number(value) : 0));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

function toISO(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  return new Date(value).toISOString();
}

function tokenize(value) {
  return clean(value, 500000).toLowerCase().match(/[a-z0-9_./-]{2,}/g) || [];
}

function taskFingerprint(task) {
  const tokens = [...new Set(tokenize(`${task.instruction}\n${stableJSONStringify(task.context || null)}`))]
    .filter(token => !/^\d+$/.test(token))
    .sort();
  return `task_${digest(tokens.join(' ')).slice(0, 24)}`;
}

function recurrenceScore(value) {
  const numeric = nonnegative(value);
  return numeric <= 1 ? numeric : Math.min(1, numeric / 10);
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const normalized = {};
  for (const [key, value] of Object.entries(usage).slice(0, 100)) {
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) normalized[clean(key, 100)] = value;
    else if (typeof value === 'string') normalized[clean(key, 100)] = clean(value, 2000);
    else normalized[clean(key, 100)] = JSON.parse(stableJSONStringify(value));
  }
  return normalized;
}

function normalizeTask(task = {}) {
  const instruction = clean(task.instruction || task.request || task.goal || task.prompt || '', 200000);
  if (!instruction) throw new Error('Archie budget task instruction is required.');
  const estimatedPromptTokens = Number.isFinite(Number(task.estimated_prompt_tokens)) ? integer(task.estimated_prompt_tokens) : null;
  const estimatedCompletionTokens = Number.isFinite(Number(task.estimated_completion_tokens)) ? integer(task.estimated_completion_tokens) : null;
  const estimatedTotalTokens = Number.isFinite(Number(task.estimated_total_tokens))
    ? integer(task.estimated_total_tokens)
    : (estimatedPromptTokens !== null || estimatedCompletionTokens !== null ? integer((estimatedPromptTokens || 0) + (estimatedCompletionTokens || 0)) : null);
  const localConfidence = task.local_confidence === undefined ? null : clamp01(task.local_confidence);
  return Object.freeze({
    task_id: clean(task.task_id || task.id || '', 200) || null,
    instruction,
    context: task.context || null,
    novelty: task.novelty === undefined ? null : clamp01(task.novelty),
    uncertainty: task.uncertainty === undefined ? (localConfidence === null ? null : Number((1 - localConfidence).toFixed(6))) : clamp01(task.uncertainty),
    expected_recurrence: nonnegative(task.expected_recurrence ?? 0),
    safety_risk: clamp01(task.safety_risk ?? 0),
    tool_cost: nonnegative(task.tool_cost ?? task.estimated_cost_credits ?? 0),
    prior_local_failures: integer(task.prior_local_failures ?? 0),
    estimated_future_call_savings: nonnegative(task.estimated_future_call_savings ?? 0),
    estimated_prompt_tokens: estimatedPromptTokens,
    estimated_completion_tokens: estimatedCompletionTokens,
    estimated_total_tokens: estimatedTotalTokens,
    requested_budget_credits: task.requested_budget_credits === undefined ? null : nonnegative(task.requested_budget_credits),
    per_task_ceiling: task.per_task_ceiling === undefined ? null : nonnegative(task.per_task_ceiling),
    value: task.value === undefined ? null : clamp01(task.value),
    cancellation_key: task.cancellation_key ? clean(task.cancellation_key, 300) : null,
    priority: clean(task.priority || '', 100) || null
  });
}

function normalizeConfig(options = {}) {
  const totalBudget = nonnegative(options.total_budget_credits ?? options.budget ?? 150000);
  const repairReserve = Math.min(totalBudget, nonnegative(options.repair_reserve_credits ?? 15000));
  const evaluationReserve = Math.min(totalBudget - repairReserve, nonnegative(options.evaluation_reserve_credits ?? 10000));
  return Object.freeze({
    total_budget_credits: totalBudget,
    per_task_ceiling_credits: nonnegative(options.per_task_ceiling_credits ?? 30000),
    repair_reserve_credits: repairReserve,
    evaluation_reserve_credits: evaluationReserve,
    decision_threshold: clamp01(options.decision_threshold ?? 0.45),
    safety_override_threshold: clamp01(options.safety_override_threshold ?? 0.7),
    max_escalation_level: Math.max(0, Math.min(5, integer(options.max_escalation_level ?? 2))),
    max_provider_attempts: Math.max(1, Math.min(10, integer(options.max_provider_attempts ?? 3) || 3)),
    max_escalation_multiplier: Math.max(1, Math.min(3, Number(options.max_escalation_multiplier ?? 1.5))),
    fallback_enabled: options.fallback_enabled !== false,
    credits_per_token: nonnegative(options.credits_per_token ?? 1),
    minimum_call_credits: nonnegative(options.minimum_call_credits ?? 1)
  });
}

function estimateCost(task, provider = null, config = normalizeConfig()) {
  const providerEstimate = provider?.estimate_credits ?? provider?.estimated_cost_credits ?? provider?.cost_credits;
  const configured = task.requested_budget_credits ?? task.tool_cost ?? providerEstimate;
  if (Number.isFinite(Number(configured)) && Number(configured) > 0) return Math.ceil(Number(configured));
  if (task.estimated_total_tokens !== null) return Math.max(config.minimum_call_credits, Math.ceil(task.estimated_total_tokens * config.credits_per_token));
  return Math.max(config.minimum_call_credits, Math.ceil((providerEstimate && Number(providerEstimate) > 0) ? Number(providerEstimate) : 1000));
}

function usageNumber(usage, keys) {
  for (const key of keys) if (Number.isFinite(Number(usage?.[key]))) return Number(usage[key]);
  return null;
}

function deriveBudgetDebit({ usage, estimate_credits, config }) {
  const reported = normalizeUsage(usage);
  const promptTokens = usageNumber(reported, ['prompt_tokens', 'input_tokens']);
  const completionTokens = usageNumber(reported, ['completion_tokens', 'output_tokens']);
  const totalTokens = usageNumber(reported, ['total_tokens', 'tokens']) ?? (
    promptTokens !== null || completionTokens !== null ? (promptTokens || 0) + (completionTokens || 0) : null
  );
  const actualCredits = usageNumber(reported, ['budget_credits', 'credits', 'cost_credits']);
  if (actualCredits !== null) {
    return Object.freeze({
      charged_credits: Math.ceil(Math.max(0, actualCredits)),
      estimated: false,
      reason: 'provider_reported_cost',
      provider_reported_usage: reported,
      estimated_usage: null,
      token_usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        estimated: false
      }
    });
  }
  return Object.freeze({
    charged_credits: Math.ceil(Math.max(config.minimum_call_credits, estimate_credits)),
    estimated: true,
    reason: reported ? 'provider_reported_tokens_without_cost' : 'provider_usage_missing',
    provider_reported_usage: reported,
    estimated_usage: {
      estimated: true,
      budget_credits: Math.ceil(Math.max(config.minimum_call_credits, estimate_credits)),
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null
    },
    token_usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      estimated: totalTokens === null
    }
  });
}

function receiptDigest(receipt) {
  return digest({ ...receipt, receipt_digest: undefined });
}

async function readJSONLines(filename) {
  try {
    const content = await fs.readFile(filename, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { throw new Error(`Invalid Archie budget ledger JSON at ${filename}:${index + 1}`); }
      if (!parsed || parsed.receipt_digest !== receiptDigest(parsed)) throw new Error(`Archie budget ledger tamper detected at ${filename}:${index + 1}`);
      return parsed;
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendJSONLine(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.appendFile(filename, `${stableJSONStringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function writeAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
}

async function withLock(root, work) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, '.archie-budget.lock');
  let handle;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error('Timed out waiting for the Archie budget lock.');
  try {
    return await work();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

function spentCredits(receipts) {
  return receipts.reduce((total, receipt) => total + nonnegative(receipt.budget?.debit?.charged_credits ?? 0), 0);
}

function successfulFingerprints(receipts) {
  return new Set(receipts.filter(receipt => receipt.decision?.state === 'completed' && receipt.learning?.recorded_for_amortization).map(receipt => receipt.task.fingerprint));
}

function findReplay(receipts, idempotencyKey) {
  if (!idempotencyKey) return null;
  return receipts.find(receipt => receipt.idempotency_key === idempotencyKey) || null;
}

function scoreTask(task, estimateCredits, localAvailable) {
  const novelty = task.novelty === null ? (localAvailable ? 0.05 : 0.75) : task.novelty;
  const uncertainty = task.uncertainty === null ? (localAvailable ? 0.05 : 0.7) : task.uncertainty;
  const recurrence = recurrenceScore(task.expected_recurrence);
  const safety = task.safety_risk;
  const failures = Math.min(1, task.prior_local_failures / 3);
  const savingsRatio = estimateCredits > 0 ? Math.min(1, task.estimated_future_call_savings / Math.max(1, estimateCredits * 3)) : 0;
  const value = task.value ?? Math.max(recurrence, savingsRatio);
  const toolCostPenalty = Math.min(1, task.tool_cost / Math.max(1, estimateCredits * 2));
  const score = Math.max(0, Math.min(1,
    novelty * 0.22 + uncertainty * 0.22 + recurrence * 0.16 + savingsRatio * 0.15 + safety * 0.15 + failures * 0.1 + value * 0.08 - toolCostPenalty * 0.08
  ));
  return Object.freeze({
    novelty: Number(novelty.toFixed(6)),
    uncertainty: Number(uncertainty.toFixed(6)),
    expected_recurrence: Number(recurrence.toFixed(6)),
    safety_risk: Number(safety.toFixed(6)),
    prior_local_failures: Number(failures.toFixed(6)),
    estimated_future_call_savings: Number(savingsRatio.toFixed(6)),
    value: Number(value.toFixed(6)),
    tool_cost_penalty: Number(toolCostPenalty.toFixed(6)),
    teacher_value_score: Number(score.toFixed(6))
  });
}

function planDecision({ task, config, history, providerEstimate = null, idempotency_key = null, cancelled = false }) {
  const fingerprint = taskFingerprint(task);
  const localAvailable = successfulFingerprints(history).has(fingerprint);
  const estimateCredits = estimateCost(task, providerEstimate, config);
  const perTaskCeiling = Math.max(config.minimum_call_credits, Math.min(task.per_task_ceiling ?? config.per_task_ceiling_credits, config.per_task_ceiling_credits || Infinity));
  const used = spentCredits(history);
  const totalRemaining = Math.max(0, config.total_budget_credits - used);
  const reserved = Math.min(totalRemaining, config.repair_reserve_credits + config.evaluation_reserve_credits);
  const routineAvailable = Math.max(0, totalRemaining - reserved);
  const score = scoreTask(task, estimateCredits, localAvailable);
  const safetyOverride = score.safety_risk >= config.safety_override_threshold;
  const unknownEscalation = score.novelty >= 0.75 && score.uncertainty >= 0.65;
  const escalationLevel = safetyOverride ? config.max_escalation_level : (unknownEscalation || task.prior_local_failures > 0 ? Math.min(config.max_escalation_level, 1) : 0);
  const escalationMultiplier = Math.min(config.max_escalation_multiplier, 1 + escalationLevel * 0.25);
  const requested = Math.ceil(Math.min(perTaskCeiling, Math.max(config.minimum_call_credits, estimateCredits * escalationMultiplier)));
  const spendable = safetyOverride ? totalRemaining : routineAvailable;
  const allocated = Math.min(requested, spendable, perTaskCeiling);
  const base = {
    fingerprint,
    local_available: localAvailable,
    estimate_credits: estimateCredits,
    per_task_ceiling_credits: perTaskCeiling,
    global_budget_credits: config.total_budget_credits,
    used_credits: used,
    remaining_credits: totalRemaining,
    routine_available_credits: routineAvailable,
    reservations: {
      repair_credits: config.repair_reserve_credits,
      evaluation_credits: config.evaluation_reserve_credits,
      protected_for_routine_calls: !safetyOverride
    },
    score,
    safety_override: safetyOverride,
    escalation_level: escalationLevel,
    allocated_credits: Math.floor(allocated),
    idempotency_key
  };
  if (cancelled) return Object.freeze({ ...base, state: 'cancelled', reason: 'cancelled_before_allocation' });
  if (localAvailable && !safetyOverride) return Object.freeze({ ...base, state: 'denied', reason: 'repeated_task_amortized_to_local_skill', allocated_credits: 0 });
  const requiredMinimum = Math.min(estimateCredits, perTaskCeiling);
  if (totalRemaining < config.minimum_call_credits || allocated < config.minimum_call_credits || spendable < requiredMinimum) {
    return Object.freeze({ ...base, state: 'denied', reason: 'global_budget_exhausted', allocated_credits: Math.max(0, Math.floor(allocated)) });
  }
  if (!safetyOverride && score.teacher_value_score < config.decision_threshold) {
    return Object.freeze({ ...base, state: 'denied', reason: 'teacher_call_value_below_threshold', allocated_credits: 0 });
  }
  return Object.freeze({ ...base, state: 'approved', reason: safetyOverride ? 'safety_override' : (unknownEscalation ? 'unknown_task_escalation' : 'expected_value_positive') });
}

function normalizeProvider(provider, index) {
  if (typeof provider === 'function') return { id: `provider-${index + 1}`, call: provider, estimate_credits: null };
  if (!provider || typeof provider.call !== 'function') throw new Error('Each Archie budget provider must be a function or { id, call }.');
  return {
    id: clean(provider.id || provider.name || `provider-${index + 1}`, 200),
    call: provider.call,
    estimate_credits: provider.estimate_credits ?? provider.estimated_cost_credits ?? provider.cost_credits ?? null
  };
}

export class ArchieReasoningBudgetController {
  constructor(options = {}) {
    this.root = path.resolve(options.root || process.env.ARCHIE_BUDGET_ROOT || '.archie-budget');
    this.clock = options.clock || Date.now;
    this.config = normalizeConfig(options);
    this.ledgerPath = path.join(this.root, 'ledger.jsonl');
  }

  async history() {
    return readJSONLines(this.ledgerPath);
  }

  async spent() {
    return spentCredits(await this.history());
  }

  async decide(taskInput = {}, options = {}) {
    const task = normalizeTask(taskInput);
    const history = await this.history();
    return planDecision({
      task,
      config: normalizeConfig({ ...this.config, ...options }),
      history,
      providerEstimate: options.provider_estimate || null,
      idempotency_key: options.idempotency_key ? clean(options.idempotency_key, 300) : null,
      cancelled: Boolean(options.cancelled || taskInput.cancelled || options.signal?.aborted)
    });
  }

  async allocate(taskInput = {}, options = {}) {
    return withLock(this.root, async () => {
      const config = normalizeConfig({ ...this.config, ...options });
      const task = normalizeTask(taskInput);
      const idempotencyKey = clean(options.idempotency_key || taskInput.idempotency_key || '', 300) || null;
      const history = await this.history();
      const replay = findReplay(history, idempotencyKey);
      const requestDigest = digest({ task, config, idempotencyKey });
      if (replay) {
        if (replay.request_digest !== requestDigest) throw new Error('Archie budget replay idempotency key reused for a different request.');
        return Object.freeze({ ...replay, replayed: true });
      }

      const providers = (Array.isArray(options.providers) ? options.providers : []).map(normalizeProvider);
      const providerEstimate = providers.find(provider => provider.estimate_credits !== null) || null;
      const decision = planDecision({
        task,
        config,
        history,
        providerEstimate,
        idempotency_key: idempotencyKey,
        cancelled: Boolean(options.cancelled || taskInput.cancelled || options.signal?.aborted)
      });
      const observedAt = toISO(this.clock);
      const attempts = [];
      let result = null;
      let debit = {
        charged_credits: 0,
        estimated: false,
        reason: 'not_executed',
        provider_reported_usage: null,
        estimated_usage: null,
        token_usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, estimated: false }
      };
      let state = decision.state;
      let reason = decision.reason;

      if (decision.state === 'approved') {
        const attemptLimit = Math.min(
          providers.length || 0,
          config.fallback_enabled ? config.max_provider_attempts : 1
        );
        if (!attemptLimit) {
          state = 'approved';
          reason = 'approved_without_provider_execution';
        }
        for (let index = 0; index < attemptLimit; index += 1) {
          if (options.signal?.aborted) {
            state = 'cancelled';
            reason = 'cancelled_before_provider_attempt';
            break;
          }
          const provider = providers[index];
          try {
            const output = await provider.call(task, { decision, attempt: index + 1, signal: options.signal });
            const usage = output?.usage || output?.provider_usage || null;
            debit = deriveBudgetDebit({ usage, estimate_credits: Math.min(decision.allocated_credits || decision.estimate_credits, decision.per_task_ceiling_credits), config });
            attempts.push({ provider_id: provider.id, status: 'completed', fallback: index > 0, usage: debit.provider_reported_usage });
            result = output?.result ?? output?.plan ?? output ?? null;
            state = 'completed';
            reason = index > 0 ? 'provider_fallback_completed' : 'provider_completed';
            break;
          } catch (error) {
            attempts.push({ provider_id: provider.id, status: 'failed', fallback: index > 0, error: clean(error?.message || error, 2000) });
            state = index + 1 >= attemptLimit ? 'failed' : 'fallback';
            reason = index + 1 >= attemptLimit ? 'provider_attempts_exhausted' : 'provider_failed_trying_fallback';
          }
        }
      }

      const receiptBody = {
        schema: ARCHIE_BUDGET_RECEIPT_SCHEMA,
        ledger_schema: ARCHIE_BUDGET_LEDGER_SCHEMA,
        observed_at: observedAt,
        request_digest: requestDigest,
        idempotency_key: idempotencyKey,
        task: {
          ...task,
          fingerprint: decision.fingerprint
        },
        decision: {
          state,
          reason,
          initial_state: decision.state,
          initial_reason: decision.reason,
          score: decision.score,
          safety_override: decision.safety_override,
          escalation_level: decision.escalation_level,
          local_available: decision.local_available
        },
        budget: {
          global_budget_credits: decision.global_budget_credits,
          used_before_credits: decision.used_credits,
          remaining_before_credits: decision.remaining_credits,
          routine_available_before_credits: decision.routine_available_credits,
          per_task_ceiling_credits: decision.per_task_ceiling_credits,
          estimate_credits: decision.estimate_credits,
          allocated_credits: decision.allocated_credits,
          reservations: decision.reservations,
          debit
        },
        provider_attempts: attempts,
        result,
        learning: {
          recorded_for_amortization: state === 'completed' && task.expected_recurrence > 0,
          estimated_future_call_savings: task.estimated_future_call_savings,
          estimate_explicit: true
        },
        replayed: false
      };
      const receipt = Object.freeze({ ...receiptBody, receipt_digest: receiptDigest(receiptBody) });
      await appendJSONLine(this.ledgerPath, receipt);
      await writeAtomic(path.join(this.root, 'receipts', `${receipt.receipt_digest}.json`), receipt);
      return receipt;
    });
  }
}

export function createArchieReasoningBudgetController(options) {
  return new ArchieReasoningBudgetController(options);
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2];
  const root = argument('--root', process.env.ARCHIE_BUDGET_ROOT || '');
  if (!root) throw new Error('Pass --root or set ARCHIE_BUDGET_ROOT.');
  const controller = createArchieReasoningBudgetController({
    root,
    total_budget_credits: Number(argument('--budget', '150000'))
  });
  if (command === 'decide' || command === 'allocate') {
    const taskFile = argument('--task');
    if (!taskFile) throw new Error('Pass --task with a JSON task file.');
    const task = JSON.parse(await fs.readFile(taskFile, 'utf8'));
    const receipt = command === 'decide' ? await controller.decide(task) : await controller.allocate(task);
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  if (command === 'history') {
    console.log(JSON.stringify(await controller.history(), null, 2));
    return;
  }
  throw new Error('Usage: maker-archie-budget.mjs <decide|allocate|history> --root <directory> [--task task.json] [--budget 150000]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
