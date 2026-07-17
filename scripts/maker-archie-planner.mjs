#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARCHIE_CPU_PLANNER_MODEL_SCHEMA = 'archie-cpu-planner-model/v1';
export const ARCHIE_CPU_PLAN_SCHEMA = 'archie-cpu-tool-plan/v1';
export const ARCHIE_TOOL_PLAN_SCHEMA = 'archie-typed-tool-plan/v1';

const DEFAULT_DIMENSIONS = 2048;
const DEFAULT_BEAM_WIDTH = 6;
const DEFAULT_MAX_STEPS = 6;
const DEFAULT_THRESHOLD = 0.28;
const DEFAULT_MARGIN = 0.025;
const DEFAULT_REJECT_THRESHOLD = 0.34;
const DEFAULT_NEGATIVE_GAP = 0.03;
const DEFAULT_MAX_MODEL_BYTES = 8 * 1024 * 1024;
const VECTOR_SCALE = 127;
const CLEAN_LIMIT = 500000;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it', 'its', 'make', 'of', 'on', 'or', 'please', 'run', 'the', 'then', 'this', 'to', 'with', 'without', 'work'
]);

const SYNONYMS = new Map(Object.entries({
  analyse: 'analyze', analysis: 'analyze', analyzed: 'analyze', auditing: 'audit', audited: 'audit', checks: 'test', checked: 'test', checking: 'test', ci: 'test', conflicts: 'conflict', conflicted: 'conflict', composing: 'compose', composition: 'compose', determine: 'infer', diagnosing: 'diagnose', diagnosis: 'diagnose', docs: 'document', documentation: 'document', documented: 'document', failing: 'fail', failed: 'fail', failures: 'fail', fixing: 'repair', fixed: 'repair', generate: 'create', generated: 'create', investigate: 'inspect', investigation: 'inspect', moderation: 'moderate', moderated: 'moderate', planner: 'plan', planning: 'plan', planned: 'plan', proves: 'verify', proof: 'verify', recovers: 'recover', recovered: 'recover', recovery: 'recover', rejected: 'reject', retries: 'retry', retried: 'retry', tests: 'test', tested: 'test', testing: 'test', validates: 'verify', validation: 'verify', verified: 'verify', verifying: 'verify'
}));

const TOOL_ALIASES = new Map(Object.entries({
  git: 'git', github: 'git', repository: 'git', repo: 'git', branch: 'git', merge: 'git', conflict: 'git', test: 'node', tests: 'node', verify: 'node', npm: 'node', javascript: 'node', schema: 'json', contract: 'json', docs: 'filesystem', file: 'filesystem', social: 'social', moderation: 'social', report: 'social', telemetry: 'telemetry', irrigation: 'irrigation', deploy: 'deployment', release: 'deployment'
}));

function clean(value, limit = CLEAN_LIMIT) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

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

function normalizeToken(value) {
  let token = clean(value, 200).toLowerCase();
  if (!token) return '';
  if (SYNONYMS.has(token)) token = SYNONYMS.get(token);
  if (/^[a-z]+$/.test(token) && token.length > 3) {
    if (token.endsWith('ies') && token.length > 4) token = `${token.slice(0, -3)}y`;
    else if (token.endsWith('ing') && token.length > 5) token = token.slice(0, -3);
    else if (token.endsWith('ed') && token.length > 4) token = token.slice(0, -2);
    else if (token.endsWith('es') && token.length > 4) token = token.slice(0, -2);
    else if (token.endsWith('s') && token.length > 4) token = token.slice(0, -1);
    if (token.length > 3 && token.at(-1) === token.at(-2) && !/[aeiou]/.test(token.at(-1))) token = token.slice(0, -1);
  }
  return SYNONYMS.get(token) || token;
}

function tokenize(value) {
  return (clean(value).toLowerCase().match(/[a-z0-9_./-]{2,}/g) || [])
    .map(normalizeToken)
    .filter(token => token && !STOPWORDS.has(token));
}

function featureTokens(value) {
  const tokens = tokenize(value);
  const expanded = [];
  for (const token of tokens) {
    expanded.push(token);
    const alias = TOOL_ALIASES.get(token);
    if (alias) expanded.push(`tool:${alias}`);
    if (token.includes('/')) expanded.push(...token.split('/').filter(Boolean));
    if (token.includes('-')) expanded.push(...token.split('-').filter(Boolean));
  }
  for (let index = 0; index < tokens.length - 1; index += 1) expanded.push(`${tokens[index]}_${tokens[index + 1]}`);
  return expanded;
}

function hashIndex(token, dimensions) {
  return crypto.createHash('sha256').update(token).digest().readUInt32BE(0) % dimensions;
}

function rawVector(text, dimensions) {
  const vector = new Map();
  for (const token of featureTokens(text)) {
    const index = hashIndex(token, dimensions);
    vector.set(index, (vector.get(index) || 0) + 1);
  }
  return vector;
}

function normalizeVector(vector) {
  const norm = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0));
  if (!norm) return new Map();
  return new Map([...vector.entries()].map(([index, value]) => [index, value / norm]));
}

function weightedVector(text, dimensions, idf) {
  const raw = rawVector(text, dimensions);
  return normalizeVector(new Map([...raw.entries()].map(([index, count]) => [index, count * Number(idf[index] || 1)])));
}

function quantizeVector(vector) {
  return [...vector.entries()]
    .filter(([, value]) => value !== 0)
    .sort(([left], [right]) => left - right)
    .map(([index, value]) => [index, Math.max(-127, Math.min(127, Math.round(value * VECTOR_SCALE)))]);
}

function dequantizeVector(quantized) {
  return normalizeVector(new Map((Array.isArray(quantized) ? quantized : []).map(([index, value]) => [Number(index), Number(value) / VECTOR_SCALE])));
}

function cosine(left, right) {
  let score = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const [index, value] of small) score += value * (large.get(index) || 0);
  return score;
}

function taskText(task = {}) {
  if (typeof task === 'string') return clean(task);
  return `${clean(task.instruction || task.request || task.goal || task.text)}\n${stableJSONStringify(task.context || task.compact_context || null)}`;
}

function exampleText(example = {}) {
  return `${clean(example.instruction || example.input?.text || example.request || example.goal)}\n${stableJSONStringify(example.compact_context || example.context || example.input?.context || null)}\n${clean((example.tags || []).join(' '), 20000)}`;
}

function normalizeStep(item = {}, index = 0) {
  const tool = clean(item.tool || item.name || item.adapter || 'planner', 80) || 'planner';
  const action = clean(item.action || item.operation || item.command || 'execute', 120) || 'execute';
  return Object.freeze({
    id: clean(item.id || `step-${index + 1}`, 80),
    type: 'tool_call',
    tool,
    action,
    args: canonical(item.args || item.input || item.arguments || {}),
    produces: Array.isArray(item.produces) ? item.produces.map(value => clean(value, 80)).filter(Boolean).slice(0, 20) : [],
    depends_on: Array.isArray(item.depends_on) ? item.depends_on.map(value => clean(value, 80)).filter(Boolean).slice(0, 20) : [],
    rationale: clean(item.rationale || item.reason || `${tool}:${action}`, 300)
  });
}

function normalizeToolTrace(trace = []) {
  return (Array.isArray(trace) ? trace : []).filter(item => item?.ok !== false).slice(0, 50).map(normalizeStep);
}

function targetSteps(target) {
  if (!target || typeof target !== 'object') return [];
  const steps = Array.isArray(target.steps) ? target.steps : Array.isArray(target.plan?.steps) ? target.plan.steps : [];
  return steps.slice(0, 50).map((step, index) => {
    if (typeof step === 'string') return normalizeStep({ tool: 'planner', action: step, rationale: step }, index);
    return normalizeStep(step, index);
  });
}

function exampleSteps(example) {
  const fromTrace = normalizeToolTrace(example.tool_trace || example.tools || []);
  const fromTarget = targetSteps(example.target || example.output?.plan || example.plan);
  const steps = fromTrace.length ? fromTrace : fromTarget;
  return steps.map((step, index) => ({ ...step, id: `step-${index + 1}`, depends_on: index ? [`step-${index}`] : [] }));
}

function planSignature(steps) {
  return steps.map(step => `${step.tool}:${step.action}`).join('>') || 'planner:escalate';
}

function isPositive(example = {}) {
  return example.schema === 'archie-distillation-example/v1' && clean(example.instruction || example.input?.text) && clean(example.outcome || 'completed') === 'completed' && !example.negative;
}

function isNegative(example = {}) {
  const outcome = clean(example.outcome || '').toLowerCase();
  const tags = Array.isArray(example.tags) ? example.tags.join(' ').toLowerCase() : '';
  return Boolean(example.negative || ['failed', 'rejected', 'blocked', 'unsafe', 'denied', 'cancelled', 'canceled'].includes(outcome) || /\bnegative\b|\bsuppress\b|\bdo-not-learn\b/.test(tags));
}

function buildPlan(steps, { reason = 'retrieved-composition' } = {}) {
  return Object.freeze({
    schema: ARCHIE_TOOL_PLAN_SCHEMA,
    execution: 'sequential',
    steps: steps.map((step, index) => Object.freeze({
      id: `step-${index + 1}`,
      type: 'tool_call',
      tool: clean(step.tool, 80),
      action: clean(step.action, 120),
      args: canonical(step.args || {}),
      depends_on: index ? [`step-${index}`] : [],
      rationale: clean(step.rationale || reason, 300)
    }))
  });
}

function executionPhase(step = {}) {
  const text = `${clean(step.tool, 80)} ${clean(step.action, 120)}`.toLowerCase().replace(/[_.:/-]+/g, ' ');
  if (/\b(?:status|inspect|read|search|load|fetch|list|parse|scan|measure|observe|review|assess)\b/.test(text)) return 0;
  if (/\b(?:repair|recover|retry|resume|rollback|restore|revert|fix|reconcile|resolve|conflict)\b/.test(text)) return 1;
  if (/\b(?:test|tests|testing)\b/.test(text)) return 4;
  if (/\b(?:validate|verify|audit|check|confirm|prove)\b/.test(text)) return 3;
  return 2;
}

function greedyDiversity(candidates, maxSteps) {
  const chosen = [];
  const seen = new Set();
  outer: for (const candidate of candidates) {
    for (const step of candidate.primitive.steps) {
      const key = `${step.tool}:${step.action}`;
      if (seen.has(key)) continue;
      chosen.push({
        ...step,
        rationale: `${candidate.primitive.primitive_id}:${Number(candidate.score.toFixed(4))}`,
        composition_order: chosen.length,
        execution_phase: executionPhase(step)
      });
      seen.add(key);
      if (chosen.length >= maxSteps) break outer;
    }
  }
  return chosen
    .sort((left, right) => left.execution_phase - right.execution_phase || left.composition_order - right.composition_order)
    .map(({ composition_order, execution_phase, ...step }) => step);
}

function documentFrequency(documents, dimensions) {
  const df = new Array(dimensions).fill(0);
  for (const text of documents) {
    const vector = rawVector(text, dimensions);
    for (const index of vector.keys()) df[index] += 1;
  }
  return df;
}

function calibrate(score, threshold, slope = 7.5, margin = 0) {
  const effectiveThreshold = Number(threshold ?? DEFAULT_THRESHOLD);
  const effectiveSlope = Number(slope ?? 7.5);
  const centered = (score - effectiveThreshold) * effectiveSlope + margin * 2;
  const probability = 1 / (1 + Math.exp(-centered));
  return Math.max(0, Math.min(1, probability));
}

function thresholds(options = {}) {
  return {
    threshold: Math.max(0, Math.min(1, Number(options.threshold ?? DEFAULT_THRESHOLD))),
    minimum_margin: Math.max(0, Math.min(1, Number(options.minimum_margin ?? DEFAULT_MARGIN))),
    reject_threshold: Math.max(0, Math.min(1, Number(options.reject_threshold ?? DEFAULT_REJECT_THRESHOLD))),
    negative_gap: Math.max(0, Math.min(1, Number(options.negative_gap ?? DEFAULT_NEGATIVE_GAP))),
    beam_width: Math.max(1, Math.min(24, Number(options.beam_width ?? DEFAULT_BEAM_WIDTH))),
    max_steps: Math.max(1, Math.min(16, Number(options.max_steps ?? DEFAULT_MAX_STEPS))),
    dimensions: Math.max(128, Math.min(16384, Number(options.dimensions ?? DEFAULT_DIMENSIONS)))
  };
}

function modelBody(model) {
  const { model_digest, ...body } = model || {};
  return body;
}

function assertNoNeuralClaim(metadata = {}) {
  const text = stableJSONStringify(metadata).toLowerCase();
  if (/\b(neural|llm|large language model|foundation model|transformer|deep learning)\b/.test(text)) {
    throw new Error('Archie CPU planner metadata must not claim to be a neural or language model.');
  }
}

export function trainArchieCPUPlanner(examples, options = {}) {
  const started = process.hrtime.bigint();
  const config = thresholds(options);
  const all = Array.isArray(examples) ? examples : [];
  const positiveExamples = all.filter(isPositive);
  const negativeExamples = all.filter(isNegative);
  if (!positiveExamples.length) {
    const error = new Error('At least one completed Archie distillation example is required.');
    error.code = 'ARCHIE_COLD_START';
    throw error;
  }
  assertNoNeuralClaim(options.claims || options.metadata || {});

  const texts = [
    ...positiveExamples.map(exampleText),
    ...negativeExamples.map(exampleText)
  ];
  const df = documentFrequency(texts, config.dimensions);
  const idf = df.map(value => Number((Math.log((1 + texts.length) / (1 + value)) + 1).toFixed(6)));

  const primitiveGroups = new Map();
  for (const example of positiveExamples) {
    const steps = exampleSteps(example);
    if (!steps.length) continue;
    const signature = planSignature(steps);
    const current = primitiveGroups.get(signature) || { examples: [], steps };
    current.examples.push(example);
    primitiveGroups.set(signature, current);
  }
  if (!primitiveGroups.size) throw new Error('At least one positive example must contain a tool trace or typed plan steps.');

  const primitives = [];
  for (const [signature, group] of primitiveGroups) {
    const aggregate = new Map();
    const sources = [];
    for (const example of group.examples) {
      const vector = weightedVector(exampleText(example), config.dimensions, idf);
      for (const [index, value] of vector) aggregate.set(index, (aggregate.get(index) || 0) + value);
      if (example.example_id) sources.push(example.example_id);
    }
    const centroid = normalizeVector(aggregate);
    const prototype = group.examples.slice().sort((left, right) => exampleText(left).localeCompare(exampleText(right)))[0];
    primitives.push(Object.freeze({
      primitive_id: `cpu_skill_${digest(signature).slice(0, 20)}`,
      signature,
      examples: group.examples.length,
      centroid_q8: quantizeVector(centroid),
      steps: group.steps,
      prototype_instruction: clean(prototype.instruction || prototype.input?.text, 2000),
      source_example_ids: sources.sort()
    }));
  }
  primitives.sort((left, right) => right.examples - left.examples || left.primitive_id.localeCompare(right.primitive_id));

  const negatives = negativeExamples.map(example => Object.freeze({
    negative_id: `neg_${digest(exampleText(example)).slice(0, 20)}`,
    reason: clean(example.reason || example.error || example.outcome || 'negative-example', 300),
    centroid_q8: quantizeVector(weightedVector(exampleText(example), config.dimensions, idf)),
    instruction: clean(example.instruction || example.input?.text, 2000),
    source_example_id: clean(example.example_id || '', 100)
  })).sort((left, right) => left.negative_id.localeCompare(right.negative_id));

  const lexicalTools = [...new Set(primitives.flatMap(primitive => primitive.steps.map(step => step.tool)))].sort();
  const body = Object.freeze({
    schema: ARCHIE_CPU_PLANNER_MODEL_SCHEMA,
    planner_kind: 'cpu-first-symbolic-vector-planner',
    model_family: 'hashed-retrieval-skill-mixture',
    not_a_neural_language_model: true,
    detachability: 'standalone-esm-no-maker-runtime-imports',
    dimensions: config.dimensions,
    threshold: config.threshold,
    minimum_margin: config.minimum_margin,
    reject_threshold: config.reject_threshold,
    negative_gap: config.negative_gap,
    beam_width: config.beam_width,
    max_steps: config.max_steps,
    vector_encoding: 'signed-int8-q8-normalized-centroid',
    idf: idf.map(value => Number(value.toFixed(6))),
    calibration: {
      method: 'logistic-score-margin-cpu-calibration',
      slope: Number(options.calibration_slope || 7.5),
      evidence: {
        positives: positiveExamples.length,
        negatives: negativeExamples.length,
        primitives: primitives.length
      }
    },
    grammar: {
      plan_schema: ARCHIE_TOOL_PLAN_SCHEMA,
      step_types: ['tool_call'],
      required_step_fields: ['id', 'type', 'tool', 'action', 'args', 'depends_on', 'rationale']
    },
    lexical_tools: lexicalTools,
    primitives,
    negatives,
    training_receipt: {
      trained_at: clean(options.trained_at || new Date().toISOString(), 80),
      documents: texts.length,
      positive_examples: positiveExamples.length,
      negative_examples: negativeExamples.length,
      elapsed_ms: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(3)),
      heap_used_bytes: process.memoryUsage().heapUsed
    }
  });
  return Object.freeze({ ...body, model_digest: digest(body) });
}

export function validateArchieCPUPlannerModel(model, { max_bytes = DEFAULT_MAX_MODEL_BYTES } = {}) {
  if (!model || typeof model !== 'object') throw new Error('Archie CPU planner model is required.');
  const encoded = stableJSONStringify(model);
  if (Buffer.byteLength(encoded, 'utf8') > max_bytes) throw new Error('Archie CPU planner model exceeds bounded CPU loading budget.');
  if (model.schema !== ARCHIE_CPU_PLANNER_MODEL_SCHEMA) throw new Error('Invalid Archie CPU planner schema.');
  if (model.not_a_neural_language_model !== true || /neural|llm|language model/i.test(clean(model.model_family))) throw new Error('Archie CPU planner must not claim to be a neural language model.');
  const expected = digest(modelBody(model));
  if (model.model_digest !== expected) throw new Error('Archie CPU planner model integrity check failed.');
  if (!Array.isArray(model.primitives) || !model.primitives.length) throw new Error('Archie CPU planner needs at least one primitive.');
  return true;
}

export function planWithArchieCPUPlanner(model, task = {}, options = {}) {
  const start = process.hrtime.bigint();
  const heapStart = process.memoryUsage().heapUsed;
  validateArchieCPUPlannerModel(model, options);
  const config = thresholds({
    dimensions: model.dimensions,
    threshold: options.threshold ?? model.threshold,
    minimum_margin: options.minimum_margin ?? model.minimum_margin,
    reject_threshold: options.reject_threshold ?? model.reject_threshold,
    negative_gap: options.negative_gap ?? model.negative_gap,
    beam_width: options.beam_width ?? model.beam_width,
    max_steps: options.max_steps ?? model.max_steps
  });
  const text = taskText(task);
  const query = weightedVector(text, model.dimensions, model.idf || []);
  const ranked = model.primitives.map(primitive => ({
    primitive,
    score: cosine(query, dequantizeVector(primitive.centroid_q8))
  })).sort((left, right) => right.score - left.score || left.primitive.primitive_id.localeCompare(right.primitive.primitive_id));
  const negativeRanked = (model.negatives || []).map(negative => ({
    negative,
    score: cosine(query, dequantizeVector(negative.centroid_q8))
  })).sort((left, right) => right.score - left.score || left.negative.negative_id.localeCompare(right.negative.negative_id));

  const preBeam = ranked.slice(0, config.beam_width);
  const best = preBeam[0];
  const scoreFloor = Math.max(config.threshold, (best?.score || 0) * 0.5);
  const beam = preBeam.filter(item => item.score >= scoreFloor);
  const second = beam[1];
  const bestNegative = negativeRanked[0] || { score: 0, negative: null };
  const confidence = Number(Math.max(0, Math.min(1, best?.score || 0)).toFixed(6));
  const margin = Number(Math.max(0, confidence - (second?.score || 0)).toFixed(6));
  const negativeScore = Number(Math.max(0, Math.min(1, bestNegative.score || 0)).toFixed(6));
  const calibrated = Number(calibrate(confidence, config.threshold, model.calibration?.slope, margin).toFixed(6));
  let state = 'local';
  let reason = 'bounded-beam-local-plan';
  if (negativeScore >= config.reject_threshold && negativeScore >= confidence - config.negative_gap) {
    state = 'reject';
    reason = `negative-example-suppression:${bestNegative.negative?.negative_id || 'unknown'}`;
  } else if (confidence < config.threshold || margin < config.minimum_margin) {
    state = 'teacher';
    reason = confidence < config.threshold ? 'below-confidence-threshold' : 'below-margin-threshold';
  }

  const selectedSteps = state === 'local' ? greedyDiversity(beam, config.max_steps) : [];
  const plan = state === 'local' ? buildPlan(selectedSteps) : null;
  const receipt = {
    latency_ms: Number((Number(process.hrtime.bigint() - start) / 1e6).toFixed(3)),
    heap_delta_bytes: process.memoryUsage().heapUsed - heapStart,
    beam_width: config.beam_width,
    max_steps: config.max_steps,
    candidate_count: ranked.length,
    negative_candidate_count: negativeRanked.length,
    deterministic: true,
    cpu_only: true
  };
  const body = Object.freeze({
    schema: ARCHIE_CPU_PLAN_SCHEMA,
    state,
    disposition: state === 'local' ? 'execute' : state === 'teacher' ? 'escalate_to_teacher' : 'reject',
    planner_kind: model.planner_kind,
    not_a_neural_language_model: true,
    task_digest: digest(text),
    confidence,
    margin,
    calibrated_confidence: calibrated,
    negative_score: negativeScore,
    reason,
    plan,
    teacher_escalation: state === 'teacher' ? {
      reason,
      request: clean(text, 5000),
      local_best: best ? { primitive_id: best.primitive.primitive_id, score: confidence } : null
    } : null,
    rejection: state === 'reject' ? {
      reason,
      matched_negative_id: bestNegative.negative?.negative_id || null,
      score: negativeScore
    } : null,
    alternatives: beam.map(item => ({
      primitive_id: item.primitive.primitive_id,
      signature: item.primitive.signature,
      score: Number(item.score.toFixed(6))
    })),
    receipts: receipt,
    model_digest: model.model_digest
  });
  return Object.freeze({ ...body, plan_digest: digest({ ...body, receipts: { ...body.receipts, latency_ms: 0, heap_delta_bytes: 0 } }) });
}

export function fitIncrementalArchieCPUPlanner(model, newExamples, options = {}) {
  validateArchieCPUPlannerModel(model, options);
  const replay = [];
  for (const primitive of model.primitives) {
    replay.push({
      schema: 'archie-distillation-example/v1',
      example_id: `replay_${primitive.primitive_id}`,
      instruction: primitive.prototype_instruction,
      compact_context: null,
      target: { steps: primitive.steps },
      tool_trace: primitive.steps,
      outcome: 'completed'
    });
  }
  for (const negative of model.negatives || []) {
    replay.push({
      schema: 'archie-distillation-example/v1',
      example_id: `replay_${negative.negative_id}`,
      instruction: negative.instruction,
      outcome: 'rejected',
      negative: true,
      reason: negative.reason,
      tool_trace: []
    });
  }
  return trainArchieCPUPlanner([...replay, ...(Array.isArray(newExamples) ? newExamples : [])], {
    dimensions: model.dimensions,
    threshold: model.threshold,
    minimum_margin: model.minimum_margin,
    reject_threshold: model.reject_threshold,
    negative_gap: model.negative_gap,
    beam_width: model.beam_width,
    max_steps: model.max_steps,
    trained_at: options.trained_at || new Date().toISOString(),
    calibration_slope: model.calibration?.slope || 7.5
  });
}

export function quantizationRoundTripReceipt(model) {
  validateArchieCPUPlannerModel(model);
  let max_error = 0;
  for (const primitive of model.primitives) {
    const round = quantizeVector(dequantizeVector(primitive.centroid_q8));
    const byIndex = new Map(primitive.centroid_q8.map(([index, value]) => [index, value]));
    for (const [index, value] of round) max_error = Math.max(max_error, Math.abs(value - (byIndex.get(index) || 0)));
  }
  return Object.freeze({
    schema: 'archie-cpu-quantization-receipt/v1',
    vector_encoding: model.vector_encoding,
    primitive_count: model.primitives.length,
    max_q8_error: max_error,
    passed: max_error <= 1,
    receipt_digest: digest({ primitive_count: model.primitives.length, max_error })
  });
}

async function readJSON(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function writeAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const tmp = `${filename}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, filename);
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2];
  if (command === 'train') {
    const input = argument('--examples');
    const output = argument('--model');
    if (!input || !output) throw new Error('Usage: maker-archie-planner.mjs train --examples examples.json --model model.json');
    await writeAtomic(output, trainArchieCPUPlanner(await readJSON(input)));
    return;
  }
  if (command === 'plan') {
    const modelPath = argument('--model');
    const instruction = argument('--instruction') || argument('--text');
    if (!modelPath || !instruction) throw new Error('Usage: maker-archie-planner.mjs plan --model model.json --instruction "..."');
    console.log(JSON.stringify(planWithArchieCPUPlanner(await readJSON(modelPath), { instruction }), null, 2));
    return;
  }
  if (command === 'quantization-receipt') {
    const modelPath = argument('--model');
    if (!modelPath) throw new Error('Usage: maker-archie-planner.mjs quantization-receipt --model model.json');
    console.log(JSON.stringify(quantizationRoundTripReceipt(await readJSON(modelPath)), null, 2));
    return;
  }
  throw new Error('Usage: maker-archie-planner.mjs <train|plan|quantization-receipt>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
