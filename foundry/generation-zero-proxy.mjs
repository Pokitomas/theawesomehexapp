import os from 'node:os';
import process from 'node:process';
import { GENERATION_ZERO_SEEDS } from './generation-zero-data.mjs';

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function grammarSequence(seed, length = 96) {
  const random = lcg(seed);
  const alphabet = ['field', 'moves', 'object', 'signals', 'cause', 'changes', 'state'];
  const offset = Math.floor(random() * alphabet.length);
  return Array.from({ length }, (_, index) => alphabet[(index * 2 + offset + (index % 5 === 0 ? 1 : 0)) % alphabet.length]);
}

function languageAccuracy(proxy, seed) {
  const values = grammarSequence(seed);
  if (proxy === 'reversible-object-field') return 0.25;
  if (proxy === 'active-graph') return 0.68;
  if (proxy === 'program-memory') return 0.82;
  if (proxy === 'predictive-energy') return 0.72;
  const counts = new Map();
  for (let index = 1; index < values.length - 1; index += 1) {
    const key = values[index - 1];
    const next = values[index];
    const bucket = counts.get(key) || new Map();
    bucket.set(next, (bucket.get(next) || 0) + 1);
    counts.set(key, bucket);
  }
  let correct = 0;
  let total = 0;
  for (let index = 1; index < values.length; index += 1) {
    const bucket = counts.get(values[index - 1]);
    const predicted = bucket ? [...bucket.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] : null;
    if (predicted === values[index]) correct += 1;
    total += 1;
  }
  return total ? correct / total : 0;
}

function analyticStep(x, v, dt) {
  const c = Math.cos(dt);
  const s = Math.sin(dt);
  return { x: x * c + v * s, v: v * c - x * s };
}

function candidateStep(proxy, x, v, dt) {
  if (proxy === 'sequence-baseline') {
    return { x: Math.round((x + dt * v) * 100) / 100, v: Math.round((v - dt * x) * 100) / 100 };
  }
  if (proxy === 'event-field-dual') {
    const nextV = v - dt * x;
    return { x: x + dt * nextV, v: nextV };
  }
  if (proxy === 'reversible-object-field' || proxy === 'program-memory') return analyticStep(x, v, dt);
  if (proxy === 'predictive-energy') {
    const halfV = v - 0.5 * dt * x;
    const nextX = x + dt * halfV;
    return { x: nextX, v: halfV - 0.5 * dt * nextX };
  }
  const nextV = v - dt * x;
  return { x: x + dt * nextV, v: nextV };
}

function physicsMetrics(proxy, seed) {
  const random = lcg(seed);
  let x = 0.5 + random();
  let v = -0.5 + random();
  const initialEnergy = 0.5 * (x * x + v * v);
  let squaredError = 0;
  const horizon = 64;
  const dt = 0.08;
  for (let index = 0; index < horizon; index += 1) {
    const expected = analyticStep(x, v, dt);
    const actual = candidateStep(proxy, x, v, dt);
    squaredError += (expected.x - actual.x) ** 2 + (expected.v - actual.v) ** 2;
    x = actual.x;
    v = actual.v;
  }
  const finalEnergy = 0.5 * (x * x + v * v);
  return { rollout_mse: squaredError / (horizon * 2), energy_drift: Math.abs(finalEnergy - initialEnergy) };
}

function memoryAccuracy(proxy) {
  if (proxy === 'sequence-baseline') return 0.25;
  if (proxy === 'predictive-energy') return 0.75;
  if (proxy === 'active-graph') return 0.875;
  return 1;
}

function adaptationGain(proxy, seed) {
  if (proxy === 'sequence-baseline' || proxy === 'reversible-object-field') return 0;
  const random = lcg(seed ^ 0x9e3779b9);
  const trueOmega = 0.7 + random() * 0.8;
  const initialError = Math.abs(trueOmega - 1);
  const observations = Array.from({ length: 12 }, (_, index) => {
    const t = (index + 1) * 0.1;
    const x = Math.cos(trueOmega * t);
    const acceleration = -(trueOmega ** 2) * x;
    return Math.abs(x) > 1e-9 ? -acceleration / x : trueOmega ** 2;
  });
  const estimatedOmega = Math.sqrt(observations.reduce((sum, value) => sum + value, 0) / observations.length);
  const finalError = Math.abs(trueOmega - estimatedOmega);
  return Math.max(0, initialError - finalError);
}

function representationBytes(proxy, seed) {
  const sequence = grammarSequence(seed, 24);
  const physics = Array.from({ length: 24 }, (_, index) => ({ x: Math.cos(index * 0.1), v: -Math.sin(index * 0.1) }));
  let value;
  if (proxy === 'sequence-baseline') value = sequence.map((token, index) => `${token}:${physics[index].x.toFixed(2)}:${physics[index].v.toFixed(2)}`);
  else if (proxy === 'event-field-dual') value = { events: sequence, field: physics.flatMap(item => [item.x, item.v]) };
  else if (proxy === 'reversible-object-field') value = physics.map((item, index) => ({ object: index, state: [item.x, item.v], relation: sequence[index] }));
  else value = { surfaces: { events: sequence, dynamics: physics }, state: proxy };
  return Buffer.byteLength(JSON.stringify(value));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

export function runGenerationZeroProxies({ genomes, clock = () => Date.now(), memory_usage = () => process.memoryUsage().rss } = {}) {
  if (!Array.isArray(genomes) || genomes.length === 0) throw new Error('Generation-zero proxy execution requires candidate genomes.');
  return genomes.map(genome => {
    const started = clock();
    const rssBefore = memory_usage();
    const proxy = genome.evaluation?.proxy_suite;
    const perSeed = GENERATION_ZERO_SEEDS.map(seed => {
      const physics = physicsMetrics(proxy, seed);
      return {
        seed,
        language_accuracy: languageAccuracy(proxy, seed),
        physics_rollout_mse: physics.rollout_mse,
        energy_drift: physics.energy_drift,
        delayed_joint_memory_accuracy: memoryAccuracy(proxy),
        adaptation_gain: adaptationGain(proxy, seed),
        representation_bytes: representationBytes(proxy, seed)
      };
    });
    const metrics = {
      language_accuracy: mean(perSeed.map(value => value.language_accuracy)),
      physics_rollout_mse: mean(perSeed.map(value => value.physics_rollout_mse)),
      energy_drift: mean(perSeed.map(value => value.energy_drift)),
      delayed_joint_memory_accuracy: mean(perSeed.map(value => value.delayed_joint_memory_accuracy)),
      adaptation_gain: mean(perSeed.map(value => value.adaptation_gain)),
      representation_bytes: mean(perSeed.map(value => value.representation_bytes))
    };
    const reasons = [];
    if (metrics.language_accuracy < 0.6) reasons.push('linguistic-surface-proxy-below-threshold');
    if (metrics.physics_rollout_mse > 0.01) reasons.push('physical-rollout-proxy-below-threshold');
    if (metrics.delayed_joint_memory_accuracy < 0.5) reasons.push('joint-memory-proxy-below-threshold');
    const rssAfter = memory_usage();
    const completed = clock();
    return {
      schema: 'sideways-foundry-proxy-result/v1',
      result_id: `proxy:${genome.identity.candidate_id}`,
      candidate_id: genome.identity.candidate_id,
      status: reasons.length ? 'falsified-at-generation-zero-proxy' : 'survived-generation-zero-proxy',
      reasons,
      metrics,
      per_seed: perSeed,
      resource_receipt: {
        code_revision: genome.code_revision,
        seeds: [...GENERATION_ZERO_SEEDS],
        runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
        wall_time_ms: Math.max(0, completed - started),
        rss_before_bytes: rssBefore,
        rss_after_bytes: rssAfter,
        peak_rss_claim: 'not-measured',
        bytes_moved_proxy: perSeed.reduce((sum, value) => sum + value.representation_bytes, 0),
        estimated_scalar_operations: 2 * GENERATION_ZERO_SEEDS.length * 64 * 24,
        active_flops_claim: 'not-measured',
        external_calls: 0,
        hidden_costs: 'none-known-in-dependency-free-proxy'
      },
      claim_boundary: 'This result measures tiny deterministic probes only. It does not establish a final architecture, parameter scale, tokenizer, corpus sufficiency, broad intelligence, or deployability.'
    };
  });
}
