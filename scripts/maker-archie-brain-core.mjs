import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MODEL_SCHEMA = 'archie-skill-mixture/v2';
const PLAN_SCHEMA = 'archie-compact-plan/v1';
const TRAINING_SPEC = 'duplicate-collapsed-holdout-reliability/v1';
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

function normalizedTrainingExample(example, negative) {
  return {
    schema: 'archie-distillation-example/v1',
    instruction: clean(example.instruction, 500000),
    compact_context: canonical(example.compact_context || null),
    target: negative ? null : canonical(example.target ?? null),
    tool_trace: negative ? [] : canonical(Array.isArray(example.tool_trace) ? example.tool_trace : []),
    outcome: negative ? clean(example.outcome || 'failed', 100) : 'completed',
    negative,
    reason: negative ? clean(example.reason || '', 2000) : '',
    tags: [...new Set((Array.isArray(example.tags) ? example.tags : []).map(tag => clean(tag, 100)).filter(Boolean))].sort()
  };
}

function collapseExamples(examples, { negative = false, weightCap = 5 } = {}) {
  const groups = new Map();
  for (const source of examples) {
    const example = normalizedTrainingExample(source, negative);
    const duplicateKey = digest({
      instruction: example.instruction,
      compact_context: example.compact_context,
      target: example.target,
      tool_trace: example.tool_trace,
      negative: example.negative,
      reason: example.reason,
      tags: example.tags
    });
    const current = groups.get(duplicateKey) || {
      duplicate_key: duplicateKey,
      example,
      raw_count: 0,
      source_example_ids: new Set()
    };
    current.raw_count += 1;
    if (source.example_id) current.source_example_ids.add(clean(source.example_id, 300));
    groups.set(duplicateKey, current);
  }
  return [...groups.values()].map(entry => ({
    ...entry,
    weight: Math.max(1, Math.min(Math.max(1, Number(weightCap) || 5), entry.raw_count)),
    source_example_ids: [...entry.source_example_ids].sort()
  })).sort((left, right) => left.duplicate_key.localeCompare(right.duplicate_key));
}

function expandCollapsed(entries) {
  const expanded = [];
  for (const entry of entries) {
    for (let index = 0; index < entry.weight; index += 1) {
      expanded.push({ ...entry.example, example_id: `${entry.duplicate_key.slice(0, 20)}-${index}` });
    }
  }
  return expanded;
}

function selectPrototype(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const value = { target: entry.example.target, tool_trace: entry.example.tool_trace || [] };
    const key = digest(value);
    const current = counts.get(key) || { count: 0, value };
    current.count += entry.weight;
    counts.set(key, current);
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || digest(left.value).localeCompare(digest(right.value)))[0]?.value || { target: null, tool_trace: [] };
}

function aggregateCentroid(entries, width, idf) {
  const aggregate = new Map();
  for (const entry of entries) {
    const vector = weightedVector(exampleText(entry.example), width, idf);
    for (const [index, value] of vector) aggregate.set(index, (aggregate.get(index) || 0) + value * entry.weight);
  }
  return vectorArray(normalizeVector(aggregate));
}

function boundedNumber(value, fallback, minimum = 0, maximum = 1) {
  const numeric = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(numeric) ? numeric : fallback));
}

function evidenceFor(reliabilityEvidence, specialistId) {
  if (reliabilityEvidence instanceof Map) return reliabilityEvidence.get(specialistId) || {};
  return reliabilityEvidence && typeof reliabilityEvidence === 'object' ? reliabilityEvidence[specialistId] || {} : {};
}

function wilsonLowerBound(successes, failures, z = 1.6448536269514722) {
  const total = successes + failures;
  if (!total) return 0;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = proportion + (z * z) / (2 * total);
  const radius = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total);
  return Math.max(0, Math.min(1, (centre - radius) / denominator));
}

function reliabilityFor(evidence, {
  priorAlpha = 1,
  priorBeta = 1,
  floor = 0.6,
  activationMin = 3
} = {}) {
  const successes = Math.max(0, Math.trunc(Number(evidence?.successes) || 0));
  const failures = Math.max(0, Math.trunc(Number(evidence?.failures) || 0));
  const observations = successes + failures;
  const alpha = Math.max(0.000001, Number(priorAlpha) || 1) + successes;
  const beta = Math.max(0.000001, Number(priorBeta) || 1) + failures;
  const posteriorMean = alpha / (alpha + beta);
  const lowerBound = wilsonLowerBound(successes + Number(priorAlpha || 1), failures + Number(priorBeta || 1));
  const activated = failures > 0 || observations >= Math.max(1, Math.trunc(Number(activationMin) || 3));
  return Object.freeze({
    successes,
    failures,
    observations,
    alpha: Number(alpha.toFixed(6)),
    beta: Number(beta.toFixed(6)),
    posterior_mean: Number(posteriorMean.toFixed(6)),
    lower_bound: Number(lowerBound.toFixed(6)),
    lower_bound_method: 'wilson-90',
    floor: boundedNumber(floor, 0.6),
    activation_min: Math.max(1, Math.trunc(Number(activationMin) || 3)),
    gate_active: activated,
    gate_passed: !activated || lowerBound >= boundedNumber(floor, 0.6)
  });
}

function scoreModel(model, task) {
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
  const similarityConfidence = Math.max(0, rawConfidence - negativeScore * Number(model.negative_penalty || 0));
  const margin = Math.max(0, similarityConfidence - (second?.score || 0));
  const suppressed = negativeScore >= Number(model.negative_suppression_threshold || 1) && negativeScore >= rawConfidence;
  const reliability = best?.specialist?.reliability || reliabilityFor({}, {
    floor: model.reliability_floor,
    activationMin: model.reliability_activation_min,
    priorAlpha: model.reliability_prior_alpha,
    priorBeta: model.reliability_prior_beta
  });
  const calibratedConfidence = similarityConfidence * Number(reliability.posterior_mean ?? 1);
  const routingConfidence = reliability.gate_active ? calibratedConfidence : similarityConfidence;
  return {
    ranked,
    negativeRanked,
    best,
    rawConfidence,
    negativeScore,
    similarityConfidence,
    calibratedConfidence,
    routingConfidence,
    margin,
    suppressed,
    reliability
  };
}

function gridValues(configured, start, end, step) {
  const values = new Set([Number(configured.toFixed(6))]);
  for (let value = start; value <= end + 1e-9; value += step) values.add(Number(value.toFixed(6)));
  return [...values].sort((left, right) => left - right);
}

function selectOperatingPoint(admittedEntries, negativeEntries, options) {
  const configuredThreshold = boundedNumber(options.threshold, 0.22);
  const configuredMargin = boundedNumber(options.minimum_margin, 0.03);
  const minimumDocuments = Math.max(4, Math.trunc(Number(options.cross_validation_minimum_documents) || 4));
  const allEntries = [
    ...admittedEntries.map(entry => ({ ...entry, label: 'positive' })),
    ...negativeEntries.map(entry => ({ ...entry, label: 'negative' }))
  ];
  if (admittedEntries.length < minimumDocuments || new Set(admittedEntries.map(entry => planKey(entry.example))).size < 2) {
    return Object.freeze({
      source: 'configured-fallback',
      reason: admittedEntries.length < minimumDocuments ? 'insufficient-unique-positive-documents' : 'insufficient-specialist-diversity',
      folds: 0,
      threshold: configuredThreshold,
      minimum_margin: configuredMargin,
      precision: null,
      coverage: null,
      escalation_rate: null,
      negative_route_rate: null,
      evaluated_documents: 0,
      grid_points: 0
    });
  }

  const foldCount = Math.max(2, Math.min(5, admittedEntries.length, Math.trunc(Number(options.cross_validation_folds) || 5)));
  const observations = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const inFold = entry => Number.parseInt(entry.duplicate_key.slice(0, 8), 16) % foldCount === fold;
    const trainingPositive = admittedEntries.filter(entry => !inFold(entry));
    if (!trainingPositive.length) continue;
    const trainingNegative = negativeEntries.filter(entry => !inFold(entry));
    const foldModel = trainArchieSkillMixture([
      ...expandCollapsed(trainingPositive),
      ...expandCollapsed(trainingNegative)
    ], {
      ...options,
      threshold: 0,
      minimum_margin: 0,
      calibrate_operating_point: false,
      reliability_evidence: {},
      trained_at: '1970-01-01T00:00:00.000Z'
    });
    for (const entry of allEntries.filter(inFold)) {
      const scored = scoreModel(foldModel, {
        instruction: entry.example.instruction,
        context: entry.example.compact_context
      });
      observations.push({
        label: entry.label,
        expected_signature: entry.label === 'positive' ? planKey(entry.example) : null,
        selected_signature: scored.best?.specialist?.signature || null,
        confidence: scored.routingConfidence,
        margin: scored.margin,
        suppressed: scored.suppressed
      });
    }
  }

  const positiveTotal = observations.filter(item => item.label === 'positive').length;
  const negativeTotal = observations.filter(item => item.label === 'negative').length;
  if (!positiveTotal) {
    return Object.freeze({
      source: 'configured-fallback',
      reason: 'no-held-out-positive-observations',
      folds: foldCount,
      threshold: configuredThreshold,
      minimum_margin: configuredMargin,
      precision: null,
      coverage: null,
      escalation_rate: null,
      negative_route_rate: null,
      evaluated_documents: observations.length,
      grid_points: 0
    });
  }

  const thresholds = gridValues(configuredThreshold, 0.05, 0.6, 0.025);
  const margins = gridValues(configuredMargin, 0, 0.2, 0.01);
  const targetPrecision = boundedNumber(options.cross_validation_target_precision, 0.9);
  const candidates = [];
  for (const threshold of thresholds) {
    for (const minimumMargin of margins) {
      let routed = 0;
      let correct = 0;
      let positiveRouted = 0;
      let negativeRouted = 0;
      for (const observation of observations) {
        const local = !observation.suppressed && observation.confidence >= threshold && observation.margin >= minimumMargin;
        if (!local) continue;
        routed += 1;
        if (observation.label === 'positive') {
          positiveRouted += 1;
          if (observation.selected_signature === observation.expected_signature) correct += 1;
        } else {
          negativeRouted += 1;
        }
      }
      const precision = routed ? correct / routed : 1;
      const coverage = positiveRouted / positiveTotal;
      const escalationRate = observations.length ? 1 - routed / observations.length : 1;
      const negativeRouteRate = negativeTotal ? negativeRouted / negativeTotal : 0;
      candidates.push({
        threshold,
        minimum_margin: minimumMargin,
        routed,
        correct,
        precision,
        coverage,
        escalation_rate: escalationRate,
        negative_route_rate: negativeRouteRate
      });
    }
  }

  const feasible = candidates.filter(candidate => candidate.routed > 0 && candidate.precision >= targetPrecision);
  const selected = (feasible.length ? feasible : candidates).sort((left, right) =>
    Number(right.precision >= targetPrecision) - Number(left.precision >= targetPrecision)
    || left.negative_route_rate - right.negative_route_rate
    || right.coverage - left.coverage
    || right.precision - left.precision
    || right.threshold - left.threshold
    || right.minimum_margin - left.minimum_margin
  )[0];

  return Object.freeze({
    source: feasible.length ? 'deterministic-k-fold' : 'best-available-k-fold',
    reason: feasible.length ? null : 'target-precision-not-reached',
    folds: foldCount,
    target_precision: targetPrecision,
    threshold: selected.threshold,
    minimum_margin: selected.minimum_margin,
    precision: Number(selected.precision.toFixed(6)),
    coverage: Number(selected.coverage.toFixed(6)),
    escalation_rate: Number(selected.escalation_rate.toFixed(6)),
    negative_route_rate: Number(selected.negative_route_rate.toFixed(6)),
    evaluated_documents: observations.length,
    grid_points: candidates.length,
    observation_digest: digest(observations)
  });
}

export function trainArchieSkillMixture(examples, {
  dimensions = 8192,
  threshold = 0.22,
  minimum_margin = 0.03,
  negative_suppression_threshold = 0.55,
  negative_penalty = 0.65,
  duplicate_weight_cap = 5,
  reliability_evidence = {},
  reliability_prior_alpha = 1,
  reliability_prior_beta = 1,
  reliability_floor = 0.6,
  reliability_activation_min = 3,
  calibrate_operating_point = true,
  cross_validation_folds = 5,
  cross_validation_minimum_documents = 4,
  cross_validation_target_precision = 0.9,
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
  const weightCap = Math.max(1, Math.min(100, Math.trunc(Number(duplicate_weight_cap) || 5)));
  const admittedEntries = collapseExamples(admitted, { weightCap });
  const negativeEntries = collapseExamples(negatives, { negative: true, weightCap });
  const documents = [...admittedEntries, ...negativeEntries];
  const documentFrequency = new Array(width).fill(0);
  for (const entry of documents) {
    const vector = rawVector(exampleText(entry.example), width);
    for (const index of vector.keys()) documentFrequency[index] += 1;
  }
  const idf = documentFrequency.map(frequency => Number((Math.log((1 + documents.length) / (1 + frequency)) + 1).toFixed(8)));

  const groups = new Map();
  for (const entry of admittedEntries) {
    const key = planKey(entry.example);
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }

  const specialists = [];
  for (const [key, group] of groups) {
    const specialistId = `skill_${digest(key).slice(0, 20)}`;
    const prototype = selectPrototype(group);
    const sourceExampleIds = [...new Set(group.flatMap(entry => entry.source_example_ids))].sort();
    const rawExamples = group.reduce((total, entry) => total + entry.raw_count, 0);
    specialists.push({
      specialist_id: specialistId,
      signature: key,
      examples: rawExamples,
      unique_examples: group.length,
      effective_weight: group.reduce((total, entry) => total + entry.weight, 0),
      centroid: aggregateCentroid(group, width, idf),
      target: prototype.target,
      tool_trace: prototype.tool_trace,
      source_example_ids: sourceExampleIds,
      reliability: reliabilityFor(evidenceFor(reliability_evidence, specialistId), {
        priorAlpha: reliability_prior_alpha,
        priorBeta: reliability_prior_beta,
        floor: reliability_floor,
        activationMin: reliability_activation_min
      })
    });
  }
  specialists.sort((left, right) => right.examples - left.examples || left.specialist_id.localeCompare(right.specialist_id));

  const negativeGroups = new Map();
  for (const entry of negativeEntries) {
    const key = [...new Set((entry.example.tags || []).map(value => clean(value, 100).toLowerCase()).filter(Boolean))].sort().join('|') || 'negative';
    const group = negativeGroups.get(key) || [];
    group.push(entry);
    negativeGroups.set(key, group);
  }
  const negativeCentroids = [...negativeGroups.entries()].map(([key, group]) => ({
    negative_id: `negative_${digest(key).slice(0, 20)}`,
    signature: key,
    examples: group.reduce((total, entry) => total + entry.raw_count, 0),
    unique_examples: group.length,
    effective_weight: group.reduce((total, entry) => total + entry.weight, 0),
    centroid: aggregateCentroid(group, width, idf),
    source_example_ids: [...new Set(group.flatMap(entry => entry.source_example_ids))].sort()
  })).sort((left, right) => right.examples - left.examples || left.negative_id.localeCompare(right.negative_id));

  const operatingPoint = calibrate_operating_point
    ? selectOperatingPoint(admittedEntries, negativeEntries, {
        dimensions: width,
        threshold: boundedNumber(threshold, 0.22),
        minimum_margin: boundedNumber(minimum_margin, 0.03),
        negative_suppression_threshold,
        negative_penalty,
        duplicate_weight_cap: weightCap,
        reliability_prior_alpha,
        reliability_prior_beta,
        reliability_floor,
        reliability_activation_min,
        cross_validation_folds,
        cross_validation_minimum_documents,
        cross_validation_target_precision
      })
    : Object.freeze({
        source: 'configured-no-evaluation',
        reason: null,
        folds: 0,
        threshold: boundedNumber(threshold, 0.22),
        minimum_margin: boundedNumber(minimum_margin, 0.03),
        precision: null,
        coverage: null,
        escalation_rate: null,
        negative_route_rate: null,
        evaluated_documents: 0,
        grid_points: 0
      });

  const body = {
    schema: MODEL_SCHEMA,
    training_spec: TRAINING_SPEC,
    feature_spec: 'word-unigram+bigrams+trigrams+path-segments/v1',
    dimensions: width,
    threshold: operatingPoint.threshold,
    minimum_margin: operatingPoint.minimum_margin,
    configured_threshold: boundedNumber(threshold, 0.22),
    configured_minimum_margin: boundedNumber(minimum_margin, 0.03),
    negative_suppression_threshold: boundedNumber(negative_suppression_threshold, 0.55),
    negative_penalty: boundedNumber(negative_penalty, 0.65),
    duplicate_weight_cap: weightCap,
    reliability_prior_alpha: Math.max(0.000001, Number(reliability_prior_alpha) || 1),
    reliability_prior_beta: Math.max(0.000001, Number(reliability_prior_beta) || 1),
    reliability_floor: boundedNumber(reliability_floor, 0.6),
    reliability_activation_min: Math.max(1, Math.trunc(Number(reliability_activation_min) || 3)),
    document_count: admitted.length,
    unique_document_count: admittedEntries.length,
    negative_document_count: negatives.length,
    unique_negative_document_count: negativeEntries.length,
    specialist_count: specialists.length,
    negative_specialist_count: negativeCentroids.length,
    reliability_evidence_count: specialists.reduce((total, specialist) => total + specialist.reliability.observations, 0),
    operating_point: operatingPoint,
    idf,
    specialists,
    negative_centroids: negativeCentroids,
    trained_at
  };
  return Object.freeze({ ...body, model_digest: digest(body) });
}

export function predictArchiePlan(model, task = {}) {
  if (model?.schema !== MODEL_SCHEMA || !Array.isArray(model.specialists) || !model.specialists.length) throw new Error('A trained Archie skill mixture is required.');
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
    alternatives: scored.ranked.slice(0, 3).map(item => ({ specialist_id: item.specialist.specialist_id, score: Number(item.score.toFixed(6)) })),
    negative_alternatives: scored.negativeRanked.slice(0, 3).map(item => ({ negative_id: item.negative.negative_id, score: Number(item.score.toFixed(6)) }))
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
    if (!/^skill_[a-f0-9]{20}$/.test(specialistId)) continue;
    const current = evidence[specialistId] || { successes: 0, failures: 0 };
    if (record.outcome === 'reuse-completed') current.successes += 1;
    else if (['reuse-failed', 'failed', 'cancelled'].includes(record.outcome)) current.failures += 1;
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
    const skeleton = trainArchieSkillMixture(examples, {
      ...this.training,
      reliability_evidence: {},
      calibrate_operating_point: false,
      trained_at: new Date(this.clock()).toISOString()
    });
    const reliabilityEvidence = await collectReliabilityEvidence(this.corpus, skeleton.specialists, limit);
    const model = trainArchieSkillMixture(examples, {
      ...this.training,
      reliability_evidence: reliabilityEvidence,
      trained_at: new Date(this.clock()).toISOString()
    });
    await writeAtomic(this.modelPath, model);
    return model;
  }

  async load() {
    try {
      const model = JSON.parse(await fs.readFile(this.modelPath, 'utf8'));
      if (model?.schema !== MODEL_SCHEMA || model?.training_spec !== TRAINING_SPEC) return this.train();
      if (model.model_digest !== digest({ ...model, model_digest: undefined })) throw new Error('Archie model integrity check failed.');
      return model;
    } catch (error) {
      if (error?.code === 'ENOENT') return this.train();
      throw error;
    }
  }

  async recordPlanOutcome({ specialist_id, task, plan = null, state, model_digest = null, plan_digest = null, run_id = '', receipt = null } = {}) {
    const specialistId = clean(specialist_id, 100);
    if (!/^skill_[a-f0-9]{20}$/.test(specialistId)) throw new Error('A valid Archie specialist_id is required.');
    const terminalState = clean(state, 100).toLowerCase();
    if (!['completed', 'failed', 'cancelled'].includes(terminalState)) throw new Error('Archie local reuse outcome must be completed, failed, or cancelled.');
    const instruction = typeof task === 'string' ? clean(task, 500000) : clean(task?.instruction || task?.request || task?.goal, 500000);
    if (!instruction) throw new Error('Archie local reuse outcome requires the original instruction.');
    const success = terminalState === 'completed';
    return this.corpus.ingest({
      kind: 'archie_local_reuse',
      subject: clean(typeof task === 'object' ? task?.subject || 'default' : 'default', 300),
      input: {
        text: instruction,
        context: {
          specialist_id: specialistId,
          task_context: typeof task === 'object' ? task?.context || null : null,
          model_digest: clean(model_digest, 200) || null,
          plan_digest: clean(plan_digest, 200) || null
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
        route_digest: clean(plan_digest || receipt?.archie_decision?.plan_digest || '', 200)
      },
      tags: [
        'local-reuse',
        success ? 'reliability-success' : 'reliability-failure',
        'exclude-positive-distillation'
      ]
    });
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
        candidate_specialist_id: null,
        confidence: 0,
        similarity_confidence: 0,
        calibrated_confidence: 0,
        raw_confidence: 0,
        negative_score: 0,
        negative_suppressed: false,
        margin: 0,
        reliability: reliabilityFor({}, {
          floor: this.training.reliability_floor,
          activationMin: this.training.reliability_activation_min,
          priorAlpha: this.training.reliability_prior_alpha,
          priorBeta: this.training.reliability_prior_beta
        }),
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
