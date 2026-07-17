import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MODEL_SCHEMA = 'archie-skill-mixture/v2';
const PLAN_SCHEMA = 'archie-compact-plan/v1';
const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

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
      const segments = token.split(/[./_-]+/).filter(Boolean);
      for (const segment of segments) features.push(`p:${segment}`);
    }
  }
  return features;
}

function hashIndex(token, dimensions) {
  return crypto.createHash('sha256').update(token).digest().readUInt32BE(0) % dimensions;
}

function rawVector(value, dimensions) {
  const vector = new Map();
  for (const token of featureTokens(value)) {
    const index = hashIndex(token, dimensions);
    vector.set(index, (vector.get(index) || 0) + 1);
  }
  return vector;
}

function normalizeVector(vector) {
  const norm = Math.sqrt([...vector.values()].reduce((total, value) => total + value * value, 0));
  if (!norm) return new Map();
  return new Map([...vector.entries()].map(([index, value]) => [index, value / norm]));
}

function weightedVector(value, dimensions, idf) {
  const raw = rawVector(value, dimensions);
  return normalizeVector(new Map([...raw.entries()].map(([index, count]) => [index, count * Number(idf[index] || 1)])));
}

function vectorArray(vector) {
  return [...vector.entries()].sort(([left], [right]) => left - right).map(([index, value]) => [index, Number(value.toFixed(8))]);
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

function exampleText(example) {
  return `${clean(example.instruction)}\n${stableJSONStringify(example.compact_context || null)}`;
}

function planKey(example) {
  const tools = (example.tool_trace || []).filter(item => item?.ok !== false).map(item => `${clean(item.tool, 100)}:${clean(item.action, 100)}`).filter(Boolean);
  if (tools.length) return `tools:${tools.join('>')}`;
  return `plan:${digest(example.target || '').slice(0, 16)}`;
}

function selectPrototype(examples) {
  const counts = new Map();
  for (const example of examples) {
    const value = { target: example.target, tool_trace: example.tool_trace || [] };
    const key = digest(value);
    const current = counts.get(key) || { count: 0, value };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || digest(left.value).localeCompare(digest(right.value)))[0]?.value || { target: null, tool_trace: [] };
}

function aggregateCentroid(examples, width, idf) {
  const aggregate = new Map();
  for (const example of examples) {
    const vector = weightedVector(exampleText(example), width, idf);
    for (const [index, value] of vector) aggregate.set(index, (aggregate.get(index) || 0) + value);
  }
  return vectorArray(normalizeVector(aggregate));
}

export function trainArchieSkillMixture(examples, {
  dimensions = 8192,
  threshold = 0.22,
  minimum_margin = 0.03,
  negative_suppression_threshold = 0.55,
  negative_penalty = 0.65,
  trained_at = new Date().toISOString()
} = {}) {
  const input = Array.isArray(examples) ? examples : [];
  const admitted = input.filter(example => example?.schema === 'archie-distillation-example/v1' && example.instruction && example.outcome === 'completed' && example.negative !== true);
  const negatives = input.filter(example => example?.schema === 'archie-distillation-example/v1' && example.instruction && example.negative === true);
  if (!admitted.length) {
    const error = new Error('At least one completed Archie distillation example is required.');
    error.code = 'ARCHIE_COLD_START';
    throw error;
  }
  const width = Math.max(1024, Math.min(65536, Number(dimensions) || 8192));
  const documents = [...admitted, ...negatives];
  const documentFrequency = new Array(width).fill(0);
  for (const example of documents) {
    const vector = rawVector(exampleText(example), width);
    for (const index of vector.keys()) documentFrequency[index] += 1;
  }
  const idf = documentFrequency.map(frequency => Number((Math.log((1 + documents.length) / (1 + frequency)) + 1).toFixed(8)));
  const groups = new Map();
  for (const example of admitted) {
    const key = planKey(example);
    const group = groups.get(key) || [];
    group.push(example);
    groups.set(key, group);
  }

  const specialists = [];
  for (const [key, group] of groups) {
    const prototype = selectPrototype(group);
    specialists.push({
      specialist_id: `skill_${digest(key).slice(0, 20)}`,
      signature: key,
      examples: group.length,
      centroid: aggregateCentroid(group, width, idf),
      target: prototype.target,
      tool_trace: prototype.tool_trace,
      source_example_ids: group.map(example => example.example_id).filter(Boolean).sort()
    });
  }
  specialists.sort((left, right) => right.examples - left.examples || left.specialist_id.localeCompare(right.specialist_id));

  const negativeGroups = new Map();
  for (const example of negatives) {
    const key = [...new Set((example.tags || []).map(value => clean(value, 100).toLowerCase()).filter(Boolean))].sort().join('|') || 'negative';
    const group = negativeGroups.get(key) || [];
    group.push(example);
    negativeGroups.set(key, group);
  }
  const negative_centroids = [...negativeGroups.entries()].map(([key, group]) => ({
    negative_id: `negative_${digest(key).slice(0, 20)}`,
    signature: key,
    examples: group.length,
    centroid: aggregateCentroid(group, width, idf),
    source_example_ids: group.map(example => example.example_id).filter(Boolean).sort()
  })).sort((left, right) => right.examples - left.examples || left.negative_id.localeCompare(right.negative_id));

  const body = {
    schema: MODEL_SCHEMA,
    feature_spec: 'word-unigram+bigrams+trigrams+path-segments/v1',
    dimensions: width,
    threshold: Math.max(0, Math.min(1, Number(threshold))),
    minimum_margin: Math.max(0, Math.min(1, Number(minimum_margin))),
    negative_suppression_threshold: Math.max(0, Math.min(1, Number(negative_suppression_threshold))),
    negative_penalty: Math.max(0, Math.min(1, Number(negative_penalty))),
    document_count: admitted.length,
    negative_document_count: negatives.length,
    specialist_count: specialists.length,
    negative_specialist_count: negative_centroids.length,
    idf,
    specialists,
    negative_centroids,
    trained_at
  };
  return Object.freeze({ ...body, model_digest: digest(body) });
}

export function predictArchiePlan(model, task = {}) {
  if (model?.schema !== MODEL_SCHEMA || !Array.isArray(model.specialists) || !model.specialists.length) throw new Error('A trained Archie skill mixture is required.');
  const text = typeof task === 'string' ? task : `${clean(task.instruction || task.request || task.goal)}\n${stableJSONStringify(task.context || null)}`;
  const vector = weightedVector(text, model.dimensions, model.idf || []);
  const ranked = model.specialists.map(specialist => ({ specialist, score: cosine(vector, arrayVector(specialist.centroid)) }))
    .sort((left, right) => right.score - left.score || left.specialist.specialist_id.localeCompare(right.specialist.specialist_id));
  const negativeRanked = (model.negative_centroids || []).map(negative => ({ negative, score: cosine(vector, arrayVector(negative.centroid)) }))
    .sort((left, right) => right.score - left.score || left.negative.negative_id.localeCompare(right.negative.negative_id));
  const best = ranked[0];
  const second = ranked[1];
  const rawConfidence = Math.max(0, Math.min(1, best?.score || 0));
  const negativeScore = Math.max(0, Math.min(1, negativeRanked[0]?.score || 0));
  const confidence = Math.max(0, rawConfidence - negativeScore * Number(model.negative_penalty || 0));
  const margin = Math.max(0, confidence - (second?.score || 0));
  const suppressed = negativeScore >= Number(model.negative_suppression_threshold || 1) && negativeScore >= rawConfidence;
  const local = !suppressed && confidence >= Number(model.threshold || 0) && margin >= Number(model.minimum_margin || 0);
  const body = {
    schema: PLAN_SCHEMA,
    state: local ? 'local' : 'escalate',
    specialist_id: local ? best.specialist.specialist_id : null,
    confidence: Number(confidence.toFixed(6)),
    raw_confidence: Number(rawConfidence.toFixed(6)),
    negative_score: Number(negativeScore.toFixed(6)),
    negative_suppressed: suppressed,
    margin: Number(margin.toFixed(6)),
    plan: local ? best.specialist.target : null,
    tool_trace: local ? best.specialist.tool_trace : [],
    model_digest: model.model_digest,
    alternatives: ranked.slice(0, 3).map(item => ({ specialist_id: item.specialist.specialist_id, score: Number(item.score.toFixed(6)) })),
    negative_alternatives: negativeRanked.slice(0, 3).map(item => ({ negative_id: item.negative.negative_id, score: Number(item.score.toFixed(6)) }))
  };
  return Object.freeze({ ...body, plan_digest: digest(body) });
}

async function writeAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
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
    const examples = await this.corpus.examples({ limit: this.training.limit || 250000 });
    const model = trainArchieSkillMixture(examples, { ...this.training, trained_at: new Date(this.clock()).toISOString() });
    await writeAtomic(this.modelPath, model);
    return model;
  }

  async load() {
    try {
      const model = JSON.parse(await fs.readFile(this.modelPath, 'utf8'));
      if (model?.schema !== MODEL_SCHEMA) return this.train();
      if (model.model_digest !== digest({ ...model, model_digest: undefined })) throw new Error('Archie model integrity check failed.');
      return model;
    } catch (error) {
      if (error?.code === 'ENOENT') return this.train();
      throw error;
    }
  }

  async plan(task, { allow_teacher = true } = {}) {
    let model = null;
    let local;
    try {
      model = await this.load();
      local = predictArchiePlan(model, task);
    } catch (error) {
      if (!/at least one completed archie distillation example is required/i.test(clean(error?.message || error, 2000))) throw error;
      local = Object.freeze({
        schema: PLAN_SCHEMA,
        state: 'escalate',
        specialist_id: null,
        confidence: 0,
        raw_confidence: 0,
        negative_score: 0,
        negative_suppressed: false,
        margin: 0,
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
      subject: clean(task.subject || 'default', 300),
      input: { text: instruction, context: task.context || null },
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
      confidence: local.confidence ?? 0,
      raw_confidence: local.raw_confidence ?? local.confidence ?? 0,
      negative_score: local.negative_score ?? 0,
      negative_suppressed: local.negative_suppressed ?? false,
      margin: local.margin ?? 0,
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
