import { createHash } from 'node:crypto';
import os from 'node:os';
import process from 'node:process';
import { GENERATION_ZERO_SEEDS } from './generation-zero-data.mjs';

const VOCAB_SIZE = 7;
const DT = 0.08;

function lcg(seed) {
  let state = seed >>> 0;
  return () => ((state = (1664525 * state + 1013904223) >>> 0) / 0x100000000);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = values => {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? values.map(value => value / total) : values.map(() => 1 / values.length);
};
const argmax = values => values.reduce((best, value, index) => value > values[best] ? index : best, 0);

function symbolicRecords(seed, length, frequencyScale = 1) {
  const random = lcg(seed);
  let current = Math.floor(random() * VOCAB_SIZE);
  const phase = random() * Math.PI * 2;
  const frequency = (0.19 + random() * 0.17) * frequencyScale;
  return Array.from({ length }, (_, index) => {
    const field = Math.sin(phase + index * frequency) + 0.25 * Math.cos(phase * 0.5 + index * frequency * 0.37);
    const periodic = index % 4;
    const next = (2 * current + (field >= 0 ? 1 : 3) + (periodic === 0 ? 2 : 0)) % VOCAB_SIZE;
    const record = { index, current, field, periodic, next };
    current = next;
    return record;
  });
}

function countPredictor(records, keyFor, ops) {
  const counts = new Map();
  for (const record of records) {
    const key = keyFor(record);
    const bucket = counts.get(key) || Array(VOCAB_SIZE).fill(1);
    bucket[record.next] += 1;
    counts.set(key, bucket);
    ops.count += 4;
  }
  return {
    state: { kind: 'count-table', entries: [...counts.entries()] },
    predict(record) {
      ops.count += VOCAB_SIZE + 2;
      return normalized(counts.get(keyFor(record)) || Array(VOCAB_SIZE).fill(1));
    }
  };
}

function prototypePredictor(records, ops) {
  const sums = Array.from({ length: VOCAB_SIZE }, () => [0, 0, 0, 0]);
  const counts = Array(VOCAB_SIZE).fill(0);
  const features = record => [record.current / 6, record.field, Math.sin(record.periodic * Math.PI / 2), Math.cos(record.periodic * Math.PI / 2)];
  for (const record of records) {
    features(record).forEach((value, index) => { sums[record.next][index] += value; ops.count += 2; });
    counts[record.next] += 1;
  }
  const centroids = sums.map((sum, label) => sum.map(value => counts[label] ? value / counts[label] : 0));
  return {
    state: { kind: 'class-centroids', centroids, counts },
    predict(record) {
      const vector = features(record);
      return normalized(centroids.map((centroid, label) => {
        let distance = 0;
        for (let index = 0; index < vector.length; index += 1) {
          distance += (vector[index] - centroid[index]) ** 2;
          ops.count += 4;
        }
        return counts[label] ? Math.exp(-4 * distance) : 0;
      }));
    }
  };
}

function programPredictor(records, ops) {
  let best = { errors: Infinity, a: 0, positive: 0, negative: 0, periodic: 0 };
  for (let a = 0; a < VOCAB_SIZE; a += 1) {
    for (let positive = 0; positive < VOCAB_SIZE; positive += 1) {
      for (let negative = 0; negative < VOCAB_SIZE; negative += 1) {
        for (let periodic = 0; periodic < VOCAB_SIZE; periodic += 1) {
          let errors = 0;
          for (const record of records) {
            const predicted = (a * record.current + (record.field >= 0 ? positive : negative) + (record.periodic === 0 ? periodic : 0)) % VOCAB_SIZE;
            if (predicted !== record.next) errors += 1;
            ops.count += 8;
            if (errors >= best.errors) break;
          }
          if (errors < best.errors) best = { errors, a, positive, negative, periodic };
        }
      }
    }
  }
  return {
    state: { kind: 'induced-modular-program', ...best },
    predict(record) {
      ops.count += 8;
      const predicted = (best.a * record.current + (record.field >= 0 ? best.positive : best.negative) + (record.periodic === 0 ? best.periodic : 0)) % VOCAB_SIZE;
      return Array.from({ length: VOCAB_SIZE }, (_, label) => label === predicted ? 0.94 : 0.01);
    }
  };
}

function symbolicPredictor(proxy, records, ops) {
  const keyed = keyFor => countPredictor(records, keyFor, ops);
  if (proxy === 'sequence-baseline') return keyed(record => String(record.current));
  if (proxy === 'event-field-dual') return keyed(record => `${record.current}:${record.field >= 0 ? 1 : 0}:${record.periodic}`);
  if (proxy === 'reversible-object-field') return keyed(record => `${record.current}:${record.periodic}`);
  if (proxy === 'predictive-energy') return prototypePredictor(records, ops);
  if (proxy === 'program-memory') return programPredictor(records, ops);
  if (proxy === 'active-graph') return keyed(record => `${record.current}->${record.field >= 0 ? 'positive' : 'negative'}:${record.periodic}`);
  throw new Error(`Unknown generation-zero proxy suite: ${proxy}.`);
}

function scoreSymbolic(predictor, records, ops) {
  let correct = 0;
  let brier = 0;
  for (const record of records) {
    const probabilities = predictor.predict(record);
    if (argmax(probabilities) === record.next) correct += 1;
    probabilities.forEach((probability, label) => {
      brier += (probability - (label === record.next ? 1 : 0)) ** 2;
      ops.count += 4;
    });
  }
  return { accuracy: correct / records.length, brier: brier / records.length };
}

function oscillator(seed, omega, length = 48) {
  const random = lcg(seed);
  const amplitude = 0.6 + random() * 0.9;
  const phase = random() * Math.PI * 2;
  return Array.from({ length }, (_, index) => {
    const t = index * DT;
    return { t, x: amplitude * Math.cos(omega * t + phase), v: -amplitude * omega * Math.sin(omega * t + phase) };
  });
}

function exactStep(x, v, omega) {
  const angle = omega * DT;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { x: x * cosine + (v / omega) * sine, v: v * cosine - x * omega * sine };
}

function estimateOmega(observations, ops) {
  let numerator = 0;
  let denominator = 0;
  for (let index = 1; index < observations.length - 1; index += 1) {
    const { x } = observations[index];
    numerator += x * (observations[index - 1].x + observations[index + 1].x);
    denominator += 2 * x * x;
    ops.count += 9;
  }
  ops.count += 4;
  return Math.acos(clamp(denominator ? numerator / denominator : 1, -1, 1)) / DT;
}

function searchOmega(observations, ops) {
  let best = { omega: 1, error: Infinity };
  for (let step = 0; step <= 160; step += 1) {
    const omega = 0.4 + step * 0.01;
    let error = 0;
    for (let index = 0; index < observations.length - 1; index += 1) {
      const predicted = exactStep(observations[index].x, observations[index].v, omega);
      error += (predicted.x - observations[index + 1].x) ** 2 + (predicted.v - observations[index + 1].v) ** 2;
      ops.count += 16;
    }
    if (error < best.error) best = { omega, error };
  }
  return best.omega;
}

function dynamicsModel(proxy, observations, ops, forcedOmega) {
  const omega = forcedOmega ?? (proxy === 'program-memory' ? searchOmega(observations, ops) : estimateOmega(observations, ops));
  const step = (x, v) => {
    if (proxy === 'sequence-baseline') {
      ops.count += 12;
      return { x: Math.round((x + DT * v) * 100) / 100, v: Math.round((v - DT * omega * omega * x) * 100) / 100 };
    }
    if (proxy === 'event-field-dual' || proxy === 'active-graph') {
      ops.count += 10;
      const nextV = v - DT * omega * omega * x;
      return { x: x + DT * nextV, v: nextV };
    }
    if (proxy === 'reversible-object-field' || proxy === 'program-memory') {
      ops.count += 18;
      return exactStep(x, v, omega);
    }
    if (proxy === 'predictive-energy') {
      ops.count += 16;
      const halfV = v - 0.5 * DT * omega * omega * x;
      const nextX = x + DT * halfV;
      return { x: nextX, v: halfV - 0.5 * DT * omega * omega * nextX };
    }
    throw new Error(`Unknown generation-zero proxy suite: ${proxy}.`);
  };
  return { omega, step, state: { kind: 'fitted-oscillator-dynamics', proxy, fitted_omega: omega } };
}

function rollout(model, initial, trueOmega, horizon, ops) {
  let truth = { x: initial.x, v: initial.v };
  let candidate = { ...truth };
  const initialEnergy = 0.5 * (candidate.v ** 2 + trueOmega ** 2 * candidate.x ** 2);
  let squaredError = 0;
  for (let index = 0; index < horizon; index += 1) {
    truth = exactStep(truth.x, truth.v, trueOmega);
    candidate = model.step(candidate.x, candidate.v);
    squaredError += (truth.x - candidate.x) ** 2 + (truth.v - candidate.v) ** 2;
    ops.count += 8;
  }
  const finalEnergy = 0.5 * (candidate.v ** 2 + trueOmega ** 2 * candidate.x ** 2);
  ops.count += 8;
  return { mse: squaredError / (horizon * 2), energyDrift: Math.abs(finalEnergy - initialEnergy) };
}

function adaptation(proxy, baseModel, changed, trueOmega, ops) {
  const before = rollout(baseModel, changed[0], trueOmega, 24, ops).mse;
  let omega = baseModel.omega;
  if (['event-field-dual', 'reversible-object-field', 'active-graph'].includes(proxy)) omega = estimateOmega(changed.slice(0, 16), ops);
  if (proxy === 'predictive-energy') omega = 0.35 * baseModel.omega + 0.65 * estimateOmega(changed.slice(0, 16), ops);
  if (proxy === 'program-memory') omega = searchOmega(changed.slice(0, 16), ops);
  const after = rollout(dynamicsModel(proxy, changed, ops, omega), changed[0], trueOmega, 24, ops).mse;
  return { before, after, gain: Math.max(0, before - after), omega };
}

function memoryEpisodes(seed, count = 12) {
  const random = lcg(seed ^ 0xa5a5a5a5);
  return Array.from({ length: count }, (_, index) => {
    const angle = random() * Math.PI * 2;
    return {
      key: [Math.cos(angle), Math.sin(angle)],
      query: [Math.cos(angle + 0.018), Math.sin(angle + 0.018)],
      symbol: (index * 3 + Math.floor(random() * 7)) % 7,
      value: random() * 2 - 1
    };
  });
}

function scoreMemory(proxy, episodes, ops) {
  const capacity = proxy === 'sequence-baseline' ? 3 : proxy === 'predictive-energy' ? 7 : 64;
  const entries = [];
  for (const episode of episodes) {
    entries.push({ key: episode.key, symbol: episode.symbol, value: episode.value, age: 0 });
    while (entries.length > capacity) entries.shift();
    entries.forEach(entry => { entry.age += 1; });
    ops.count += entries.length * 2 + 5;
  }
  let correct = 0;
  for (const episode of episodes) {
    let best;
    let bestScore = -Infinity;
    for (const entry of entries) {
      let score = entry.key[0] * episode.query[0] + entry.key[1] * episode.query[1];
      if (proxy === 'predictive-energy') score -= entry.age * 0.015;
      ops.count += 7;
      if (score > bestScore) { bestScore = score; best = entry; }
    }
    if (best?.symbol === episode.symbol && Math.abs(best.value - episode.value) < 1e-9) correct += 1;
  }
  return { accuracy: correct / episodes.length, state: { kind: `${proxy}-executable-memory`, capacity, entries } };
}

function runSeed(proxy, seed, ops) {
  const trainSymbols = symbolicRecords(seed, 160);
  const holdoutSymbols = symbolicRecords(seed ^ 0x51f15e, 96);
  const oodSymbols = symbolicRecords(seed ^ 0x9e3779b9, 96, 1.75);
  const predictor = symbolicPredictor(proxy, trainSymbols, ops);
  const language = scoreSymbolic(predictor, holdoutSymbols, ops);
  const oodLanguage = scoreSymbolic(predictor, oodSymbols, ops);

  const random = lcg(seed ^ 0x7f4a7c15);
  const trainOmega = 0.78 + random() * 0.38;
  const trainPhysics = oscillator(seed, trainOmega, 56);
  const model = dynamicsModel(proxy, trainPhysics, ops);
  const holdoutInitial = oscillator(seed ^ 0x1234abcd, trainOmega, 2)[0];
  const physics = rollout(model, holdoutInitial, trainOmega, 64, ops);
  const changedOmega = clamp(trainOmega * (1.22 + random() * 0.12), 0.45, 1.95);
  const changedPhysics = oscillator(seed ^ 0x77665544, changedOmega, 48);
  const adapted = adaptation(proxy, model, changedPhysics, changedOmega, ops);
  const memory = scoreMemory(proxy, memoryEpisodes(seed), ops);
  const state = { predictor: predictor.state, dynamics: model.state, memory: memory.state, adapted_omega: adapted.omega };

  return {
    seed,
    language_accuracy: language.accuracy,
    language_brier: language.brier,
    ood_language_accuracy: oodLanguage.accuracy,
    ood_language_brier: oodLanguage.brier,
    physics_rollout_mse: physics.mse,
    energy_drift: physics.energyDrift,
    changed_dynamics_pre_adaptation_mse: adapted.before,
    changed_dynamics_post_adaptation_mse: adapted.after,
    adaptation_gain: adapted.gain,
    delayed_joint_memory_accuracy: memory.accuracy,
    representation_bytes: Buffer.byteLength(JSON.stringify(state)),
    train_dataset_digest: hash({ symbols: trainSymbols, physics: trainPhysics }),
    holdout_dataset_digest: hash({ symbols: holdoutSymbols, physics: holdoutInitial }),
    ood_dataset_digest: hash({ symbols: oodSymbols, physics: changedPhysics }),
    mechanism_state_digest: hash(state)
  };
}

const METRIC_KEYS = Object.freeze([
  'language_accuracy', 'language_brier', 'ood_language_accuracy', 'ood_language_brier',
  'physics_rollout_mse', 'energy_drift', 'changed_dynamics_pre_adaptation_mse',
  'changed_dynamics_post_adaptation_mse', 'adaptation_gain',
  'delayed_joint_memory_accuracy', 'representation_bytes'
]);

function falsifiers(metrics) {
  const reasons = [];
  if (metrics.language_accuracy < 0.55) reasons.push('held-out-linguistic-surface-proxy-below-threshold');
  if (metrics.ood_language_accuracy < 0.45) reasons.push('ood-linguistic-surface-proxy-below-threshold');
  if (metrics.language_brier > 0.65) reasons.push('linguistic-calibration-proxy-below-threshold');
  if (metrics.physics_rollout_mse > 0.03) reasons.push('held-out-physical-rollout-proxy-below-threshold');
  if (metrics.changed_dynamics_post_adaptation_mse > metrics.changed_dynamics_pre_adaptation_mse + 1e-12) reasons.push('adaptation-made-changed-dynamics-worse');
  if (metrics.delayed_joint_memory_accuracy < 0.5) reasons.push('joint-memory-proxy-below-threshold');
  return reasons;
}

export function runGenerationZeroProxies({ genomes, clock = () => Date.now(), memory_usage = () => process.memoryUsage().rss } = {}) {
  if (!Array.isArray(genomes) || genomes.length === 0) throw new Error('Generation-zero proxy execution requires candidate genomes.');
  return genomes.map(genome => {
    const proxy = genome.evaluation?.proxy_suite;
    const ops = { count: 0 };
    const started = clock();
    const rssSamples = [memory_usage()];
    const perSeed = GENERATION_ZERO_SEEDS.map(seed => {
      const result = runSeed(proxy, seed, ops);
      rssSamples.push(memory_usage());
      return result;
    });
    const metrics = Object.fromEntries(METRIC_KEYS.map(key => [key, mean(perSeed.map(result => result[key]))]));
    const reasons = falsifiers(metrics);
    rssSamples.push(memory_usage());
    const completed = clock();
    return {
      schema: 'sideways-foundry-proxy-result/v2',
      result_id: `proxy:${genome.identity.candidate_id}`,
      candidate_id: genome.identity.candidate_id,
      proxy_suite: proxy,
      status: reasons.length ? 'falsified-at-generation-zero-proxy' : 'survived-generation-zero-proxy',
      reasons,
      metrics,
      per_seed: perSeed,
      evidence_integrity: {
        candidate_id_used_for_scoring: false,
        candidate_mechanism_selected_by: 'evaluation.proxy_suite',
        train_holdout_separated: perSeed.every(result => result.train_dataset_digest !== result.holdout_dataset_digest),
        holdout_ood_separated: perSeed.every(result => result.holdout_dataset_digest !== result.ood_dataset_digest),
        thresholds_shared_across_candidates: true,
        deterministic_seed_count: GENERATION_ZERO_SEEDS.length
      },
      resource_receipt: {
        code_revision: genome.code_revision,
        seeds: [...GENERATION_ZERO_SEEDS],
        runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
        wall_time_ms: Math.max(0, completed - started),
        rss_before_bytes: rssSamples[0],
        rss_after_bytes: rssSamples.at(-1),
        sampled_peak_rss_bytes: Math.max(...rssSamples),
        peak_rss_claim: 'sampled-at-candidate-boundaries-not-process-peak',
        bytes_moved_proxy: perSeed.reduce((sum, result) => sum + result.representation_bytes, 0),
        observed_scalar_operation_count: ops.count,
        active_flops_claim: 'not-measured',
        external_calls: 0,
        hidden_costs: 'none-known-in-dependency-free-proxy'
      },
      claim_boundary: 'This result executes candidate-specific mechanisms on separated train, holdout, and procedural OOD probes. It does not establish a final architecture, parameter scale, tokenizer, corpus sufficiency, broad intelligence, or deployability.'
    };
  });
}
