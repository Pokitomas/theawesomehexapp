import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { trainArchieSkillMixture as trainCoreSkillMixture } from './maker-archie-brain-core.mjs';

const MODEL_SCHEMA = 'archie-skill-mixture/v2';
const PLAN_SCHEMA = 'archie-compact-plan/v1';
const TRAINING_SPEC = 'duplicate-collapsed-holdout-outcome-weighted-reliability/v2';
const ROUTING_SPEC = 'outcome-weighted-specialist-reliability/v1';
const SPECIALIST_ID = /^skill_[a-f0-9]{20}$/;
const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]).filter(([, child]) => child !== undefined));
}

function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

function normalizeToken(value) {
  let token = clean(value, 200).toLowerCase();
  if (!/^[a-z]+$/.test(token) || token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ing') && token.length > 5) token = token.slice(0, -3);
  else if (token.endsWith('ed') && token.length > 4) token = token.slice(0, -2);
  else if (token.endsWith('es') && token.length > 4) token = token.slice(0, -2);
  else if (token.endsWith('s') && token.length > 4) token = token.slice(0, -1);
  if (token.length > 3 && token.at(-1) === token.at(-2) && !/[aeiou]/.test(token.at(-1))) token = token.slice(0, -1);
  return token;
}

function tokenize(value) {
  return (clean(value, 1_000_000).toLowerCase().match(/[a-z0-9_./-]{2,}/g) || []).map(normalizeToken).filter(Boolean);
}

function featureTokens(value) {
  const tokens = tokenize(value);
  const features = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    features.push(`w:${token}`);
    if (index > 0) features.push(`b:${tokens[index - 1]}|${token}`);
    if (index > 1) features.push(`t:${tokens[index - 2]}|${tokens[index - 1]}|${token}`);
    if (/[./_-]/.test(token)) {
      for (const segment of token.split(/[./_-]+/).filter(Boolean)) features.push(`p:${segment}`);
    }
  }
  return features;
}

function hashIndex(token, dimensions) {
  return crypto.createHash('sha256').update(token).digest().readUInt32BE(0) % dimensions;
}

function weightedVector(value, dimensions, idf) {
  const raw = new Map();
  for (const token of featureTokens(value)) {
    const index = hashIndex(token, dimensions);
    raw.set(index, (raw.get(index) || 0) + 1);
  }
  const weighted = new Map([...raw.entries()].map(([index, count]) => [index, count * Number(idf[index] || 1)]));
  const norm = Math.sqrt([...weighted.values()].reduce((total, weight) => total + weight * weight, 0));
  if (!norm) return new Map();
  return new Map([...weighted.entries()].map(([index, weight]) => [index, weight / norm]));
}

function arrayVector(value) {
  return new Map((Array.isArray(value) ? value : []).map(([index, weight]) => [Number(index), Number(weight)]));
}

function cosine(left, right) {
  let score = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const [index, value] of small) score += value * (large.get(index) || 0);
  return score;
}

function boundedNumber(value, fallback, minimum = 0, maximum = 1) {
  const numeric = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(numeric) ? numeric : fallback));
}

function defaultReliability(model) {
  return Object.freeze({
    successes: 0,
    failures: 0,
    observations: 0,
    alpha: Number(model.reliability_prior_alpha || 1),
    beta: Number(model.reliability_prior_beta || 1),
    posterior_mean: 1,
    lower_bound: 0,
    lower_bound_method: 'wilson-90',
    floor: boundedNumber(model.reliability_floor, 0.6),
    activation_min: Math.max(1, Math.trunc(Number(model.reliability_activation_min) || 3)),
    gate_active: false,
    gate_passed: true
  });
}

function reliabilityFactor(reliability) {
  if (!reliability || !reliability.gate_active || Number(reliability.observations || 0) === 0) return 1;
  return boundedNumber(reliability.posterior_mean, 1);
}

function scoreModel(model, task) {
  const text = typeof task === 'string'
    ? task
    : `${clean(task.instruction || task.request || task.goal)}\n${stableJSONStringify(task.context || null)}`;
  const vector = weightedVector(text, model.dimensions, model.idf || []);
  const negativeRanked = (model.negative_centroids || [])
    .map(negative => ({ negative, score: cosine(vector, arrayVector(negative.centroid)) }))
    .sort((left, right) => right.score - left.score || left.negative.negative_id.localeCompare(right.negative.negative_id));
  const negativeScore = Math.max(0, Math.min(1, negativeRanked[0]?.score || 0));
  const fallbackReliability = defaultReliability(model);
  const ranked = model.specialists.map(specialist => {
    const rawScore = Math.max(0, Math.min(1, cosine(vector, arrayVector(specialist.centroid))));
    const similarityScore = Math.max(0, rawScore - negativeScore * Number(model.negative_penalty || 0));
    const reliability = specialist.reliability || fallbackReliability;
    const factor = reliabilityFactor(reliability);
    return Object.freeze({
      specialist,
      reliability,
      reliability_factor: factor,
      raw_score: rawScore,
      similarity_score: similarityScore,
      score: similarityScore * factor
    });
  }).sort((left, right) =>
    right.score - left.score
    || right.similarity_score - left.similarity_score
    || right.raw_score - left.raw_score
    || left.specialist.specialist_id.localeCompare(right.specialist.specialist_id)
  );
  const best = ranked[0];
  const second = ranked[1];
  const rawConfidence = best?.raw_score || 0;
  const similarityConfidence = best?.similarity_score || 0;
  const calibratedConfidence = best?.score || 0;
  const margin = Math.max(0, calibratedConfidence - (second?.score || 0));
  const suppressed = negativeScore >= Number(model.negative_suppression_threshold || 1) && negativeScore >= rawConfidence;
  return Object.freeze({
    ranked,
    negativeRanked,
    best,
    rawConfidence,
    negativeScore,
    similarityConfidence,
    calibratedConfidence,
    routingConfidence: calibratedConfidence,
    margin,
    suppressed,
    reliability: best?.reliability || fallbackReliability
  });
}

export function trainArchieSkillMixture(examples, options = {}) {
  const trained = trainCoreSkillMixture(examples, options);
  const { model_digest: ignored, ...source } = trained;
  const body = {
    ...source,
    training_spec: TRAINING_SPEC,
    routing_spec: ROUTING_SPEC
  };
  return Object.freeze({ ...body, model_digest: digest(body) });
}

export function predictArchiePlan(model, task = {}) {
  if (model?.schema !== MODEL_SCHEMA || !Array.isArray(model.specialists) || !model.specialists.length) {
    throw new Error('A trained Archie skill mixture is required.');
  }
  const scored = scoreModel(model, task);
  const local = !scored.suppressed
    && scored.routingConfidence >= Number(model.threshold || 0)
    && scored.margin >= Number(model.minimum_margin || 0)
    && scored.reliability.gate_passed;
  const body = {
    schema: PLAN_SCHEMA,
    state: local ? 'local' : 'escalate',
    specialist_id: local ? scored.best.specialist.specialist_id : null,
    candidate_specialist_id: scored.best?.specialist?.specialist_id || null,
    confidence: Number(scored.routingConfidence.toFixed(6)),
    similarity_confidence: Number(scored.similarityConfidence.toFixed(6)),
    calibrated_confidence: Number(scored.calibratedConfidence.toFixed(6)),
    raw_confidence: Number(scored.rawConfidence.toFixed(6)),
    negative_score: Number(scored.negativeScore.toFixed(6)),
    negative_suppressed: scored.suppressed,
    margin: Number(scored.margin.toFixed(6)),
    reliability: scored.reliability,
    plan: local ? scored.best.specialist.target : null,
    tool_trace: local ? scored.best.specialist.tool_trace : [],
    model_digest: model.model_digest,
    alternatives: scored.ranked.slice(0, 3).map(item => ({
      specialist_id: item.specialist.specialist_id,
      score: Number(item.score.toFixed(6)),
      similarity_score: Number(item.similarity_score.toFixed(6)),
      raw_score: Number(item.raw_score.toFixed(6)),
      reliability_factor: Number(item.reliability_factor.toFixed(6)),
      observations: Number(item.reliability.observations || 0)
    })),
    negative_alternatives: scored.negativeRanked.slice(0, 3).map(item => ({
      negative_id: item.negative.negative_id,
      score: Number(item.score.toFixed(6))
    }))
  };
  return Object.freeze({ ...body, plan_digest: digest(body) });
}

async function writeAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
}

function reliabilityEvidenceFromRecords(records) {
  const evidence = {};
  for (const record of Array.isArray(records) ? records : []) {
    const specialistId = clean(record?.input?.context?.specialist_id || '', 100);
    if (!SPECIALIST_ID.test(specialistId)) continue;
    const current = evidence[specialistId] || { successes: 0, failures: 0 };
    if (record.outcome === 'reuse-completed') current.successes += 1;
    else if (['reuse-failed', 'reuse-cancelled', 'failed', 'cancelled'].includes(record.outcome)) current.failures += 1;
    evidence[specialistId] = current;
  }
  return evidence;
}

async function collectReliabilityEvidence(corpus, specialists, limit) {
  if (typeof corpus.recordsByKind === 'function') {
    return reliabilityEvidenceFromRecords(await corpus.recordsByKind('archie_local_reuse', { limit }));
  }
  if (typeof corpus.query !== 'function') return {};
  const records = new Map();
  for (const specialist of specialists) {
    const matches = await corpus.query(specialist.specialist_id, {
      limit: Math.max(1, Math.min(100, Number(limit) || 100)),
      kinds: ['archie_local_reuse']
    });
    for (const match of matches) {
      const record = match?.record || match;
      if (record?.record_id) records.set(record.record_id, record);
    }
  }
  return reliabilityEvidenceFromRecords([...records.values()]);
}

export async function recordLocalReuseOutcome(corpus, {
  specialist_id,
  task,
  plan = null,
  state,
  model_digest = null,
  plan_digest = null,
  run_id = '',
  receipt = null
} = {}) {
  if (!corpus || typeof corpus.ingest !== 'function') throw new Error('An Archie corpus with ingest() is required.');
  const specialistId = clean(specialist_id, 100);
  if (!SPECIALIST_ID.test(specialistId)) throw new Error('A valid Archie specialist_id is required.');
  const terminalState = clean(state, 100).toLowerCase();
  if (!['completed', 'failed', 'cancelled'].includes(terminalState)) {
    throw new Error('Archie local reuse outcome must be completed, failed, or cancelled.');
  }
  const instruction = typeof task === 'string'
    ? clean(task, 500000)
    : clean(task?.instruction || task?.request || task?.goal, 500000);
  if (!instruction) throw new Error('Archie local reuse outcome requires the original instruction.');
  const success = terminalState === 'completed';
  const boundPlanDigest = clean(plan_digest || receipt?.archie_decision?.plan_digest || receipt?.plan_digest || '', 200) || null;
  return corpus.ingest({
    kind: 'archie_local_reuse',
    subject: clean(typeof task === 'object' ? task?.subject || 'default' : 'default', 300),
    input: {
      text: instruction,
      context: {
        specialist_id: specialistId,
        task_context: typeof task === 'object' ? task?.context || null : null,
        model_digest: clean(model_digest || receipt?.model_digest || '', 200) || null,
        plan_digest: boundPlanDigest
      }
    },
    output: {
      text: `specialist ${specialistId} local reuse ${success ? 'completed' : terminalState}`,
      plan
    },
    tool_trace: [],
    outcome: success ? 'reuse-completed' : `reuse-${terminalState}`,
    source: {
      system: 'archie-personal-brain',
      run_id: clean(run_id || receipt?.session_id || receipt?.platform_run_id || '', 300),
      route_digest: boundPlanDigest || ''
    },
    tags: [
      'local-reuse',
      success ? 'reliability-success' : 'reliability-failure',
      'exclude-positive-distillation'
    ]
  });
}

export class ArchiePersonalBrain {
  constructor({ corpus, model_path, teacher = null, clock = Date.now, training = {} } = {}) {
    if (!corpus || typeof corpus.examples !== 'function' || typeof corpus.ingest !== 'function') throw new Error('An Archie corpus is required.');
    if (!model_path) throw new Error('Archie model_path is required.');
    if (teacher && typeof teacher !== 'function') throw new Error('Archie teacher must be a function.');
    this.corpus = corpus;
    this.modelPath = path.resolve(model_path);
    this.teacher = teacher;
    this.clock = clock;
    this.training = training;
  }

  async train() {
    const limit = this.training.limit || 250000;
    const examples = await this.corpus.examples({ limit });
    const trainedAt = new Date(this.clock()).toISOString();
    const skeleton = trainArchieSkillMixture(examples, {
      ...this.training,
      reliability_evidence: {},
      calibrate_operating_point: false,
      trained_at: trainedAt
    });
    const reliabilityEvidence = await collectReliabilityEvidence(this.corpus, skeleton.specialists, limit);
    const model = trainArchieSkillMixture(examples, {
      ...this.training,
      reliability_evidence: reliabilityEvidence,
      trained_at: trainedAt
    });
    await writeAtomic(this.modelPath, model);
    return model;
  }

  async load() {
    try {
      const model = JSON.parse(await fs.readFile(this.modelPath, 'utf8'));
      if (model?.schema !== MODEL_SCHEMA || model?.training_spec !== TRAINING_SPEC || model?.routing_spec !== ROUTING_SPEC) return this.train();
      const { model_digest: modelDigest, ...body } = model;
      if (modelDigest !== digest(body)) throw new Error('Archie model integrity check failed.');
      return model;
    } catch (error) {
      if (error?.code === 'ENOENT') return this.train();
      throw error;
    }
  }

  async recordPlanOutcome(options = {}) {
    return recordLocalReuseOutcome(this.corpus, options);
  }

  async plan(task, { allow_teacher = true } = {}) {
    let model = null;
    let local;
    try {
      model = await this.load();
      local = predictArchiePlan(model, task);
    } catch (error) {
      if (error?.code !== 'ARCHIE_COLD_START' && !/at least one completed archie distillation example is required/i.test(clean(error?.message || error, 2000))) throw error;
      local = Object.freeze({
        schema: PLAN_SCHEMA,
        state: 'escalate',
        specialist_id: null,
        candidate_specialist_id: null,
        confidence: 0,
        similarity_confidence: 0,
        calibrated_confidence: 0,
        raw_confidence: 0,
        negative_score: 0,
        negative_suppressed: false,
        margin: 0,
        reliability: defaultReliability(this.training),
        plan: null,
        tool_trace: [],
        model_digest: null,
        alternatives: [],
        negative_alternatives: [],
        plan_digest: digest({ state: 'escalate', reason: 'empty-corpus' })
      });
    }
    if (local.state === 'local' || !allow_teacher || !this.teacher) return local;
    const teacherResult = await this.teacher(task, { local_attempt: local, model });
    const instruction = typeof task === 'string' ? task : clean(task.instruction || task.request || task.goal);
    const stored = await this.corpus.ingest({
      kind: 'archie_teacher_plan',
      subject: clean(task?.subject || 'default', 300),
      input: { text: instruction, context: task?.context || null },
      output: { text: clean(teacherResult?.text || ''), plan: teacherResult?.plan || null },
      tool_trace: teacherResult?.tool_trace || [],
      outcome: 'proposed',
      source: {
        system: 'archie-personal-brain',
        run_id: clean(teacherResult?.run_id || '', 300),
        teacher: clean(teacherResult?.teacher || 'external-teacher', 300),
        model: clean(teacherResult?.model || '', 300),
        route_digest: clean(teacherResult?.receipt?.receipt_digest || '', 200),
        cost_usd: teacherResult?.cost_usd ?? null
      },
      tags: ['teacher-escalation', 'pending-proposal', 'exclude-positive-distillation']
    });
    return Object.freeze({
      schema: PLAN_SCHEMA,
      state: 'teacher',
      specialist_id: null,
      candidate_specialist_id: local.candidate_specialist_id ?? null,
      confidence: local.confidence ?? 0,
      similarity_confidence: local.similarity_confidence ?? local.confidence ?? 0,
      calibrated_confidence: local.calibrated_confidence ?? local.confidence ?? 0,
      raw_confidence: local.raw_confidence ?? local.confidence ?? 0,
      negative_score: local.negative_score ?? 0,
      negative_suppressed: local.negative_suppressed ?? false,
      margin: local.margin ?? 0,
      reliability: local.reliability || null,
      plan: teacherResult?.plan || null,
      tool_trace: teacherResult?.tool_trace || [],
      model_digest: model?.model_digest || null,
      learned_plan: null,
      corpus_record: stored,
      teacher: clean(teacherResult?.teacher || 'external-teacher', 300),
      teacher_model: clean(teacherResult?.model || '', 300),
      teacher_receipt: teacherResult?.receipt || null,
      plan_digest: digest({ teacher_result: teacherResult, proposal_record: stored.record_id })
    });
  }
}

export function createArchiePersonalBrain(options) {
  return new ArchiePersonalBrain(options);
}
