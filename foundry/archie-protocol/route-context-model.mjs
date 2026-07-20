import { ROUTES, ROUTE_PROTOCOL } from './train-route-model.mjs';

function rng(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) + 1) / 4294967297; };
}

export function tokenizeContext(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s'_-]+/g, ' ').split(/\s+/).filter(Boolean);
}

export function composeContextInput(value) {
  if (typeof value === 'string') return value;
  const row = value || {};
  const parts = [String(row.prompt ?? row.text ?? '')];
  const attachments = row.attachments ?? row.files ?? row.attached_files;
  if (Array.isArray(attachments) && attachments.length) {
    parts.push(`__has_attachment__ __attachment_count_${Math.min(4, attachments.length)}__`);
    for (const item of attachments.slice(0, 4)) {
      const name = typeof item === 'string' ? item : item?.name || item?.filename || item?.type || '';
      if (name) parts.push(`__attachment__ ${name}`);
    }
  } else if (row.has_attachment || row.has_file) parts.push('__has_attachment__');
  const memory = row.memory ?? row.memories ?? row.context?.memory;
  if (Array.isArray(memory) && memory.length) parts.push(`__has_memory__ ${memory.slice(0, 3).join(' ')}`);
  else if (typeof memory === 'string' && memory.trim()) parts.push(`__has_memory__ ${memory}`);
  else if (row.has_memory) parts.push('__has_memory__');
  if (row.reply_to || row.thread || row.context?.thread) parts.push('__has_thread__');
  return parts.join(' ');
}

export function contextFeatures(value) {
  const words = tokenizeContext(composeContextInput(value));
  const features = [];
  const lengthBucket = Math.min(7, Math.floor(words.length / 6));
  features.push(`len:${lengthBucket}`);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    features.push(`w:${word}`);
    features.push(`p${Math.min(7, Math.floor(i * 8 / Math.max(1, words.length)))}:${word}`);
    if (i < 4) features.push(`head${i}:${word}`);
    if (i >= words.length - 4) features.push(`tail${words.length - 1 - i}:${word}`);
    if (i + 1 < words.length) features.push(`b:${word}_${words[i + 1]}`);
    if (i + 2 < words.length) {
      features.push(`t:${word}_${words[i + 1]}_${words[i + 2]}`);
      features.push(`skip:${word}_${words[i + 2]}`);
    }
    const marked = `^${word}$`;
    for (let j = 0; j + 3 <= marked.length; j += 1) features.push(`c:${marked.slice(j, j + 3)}`);
  }
  return features;
}

function encode(value, vocabIndex, dimension) {
  const counts = new Map();
  for (const feature of contextFeatures(value)) {
    const id = vocabIndex.get(feature);
    if (id !== undefined) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const ids = [...counts.keys()].sort((a, b) => a - b);
  const values = new Float64Array(ids.length);
  let norm = 0;
  ids.forEach((id, position) => { const v = Math.log1p(counts.get(id)); values[position] = v; norm += v * v; });
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < values.length; i += 1) values[i] /= norm;
  return { ids, values, dimension };
}

export const CONTEXT_CONFIG = Object.freeze({ minCount: 2, hidden: 512, epochs: 80, learningRate: 0.06, weightDecay: 3e-5, seed: 3407 });

export function trainContextRouteModel(rows, options = {}) {
  const config = { ...CONTEXT_CONFIG, ...options };
  const counts = new Map();
  for (const row of rows) for (const feature of new Set(contextFeatures(row))) counts.set(feature, (counts.get(feature) || 0) + 1);
  const vocabulary = [...counts].filter(([, count]) => count >= config.minCount).map(([feature]) => feature).sort();
  const index = new Map(vocabulary.map((feature, i) => [feature, i]));
  const V = vocabulary.length, H = config.hidden, C = ROUTES.length;
  const random = rng(config.seed);
  const s1 = Math.sqrt(6 / (V + H)), s2 = Math.sqrt(6 / (H + C));
  const W1 = Array.from({ length: H }, () => Float64Array.from({ length: V }, () => (random() * 2 - 1) * s1));
  const b1 = new Float64Array(H);
  const W2 = Array.from({ length: C }, () => Float64Array.from({ length: H }, () => (random() * 2 - 1) * s2));
  const b2 = new Float64Array(C);
  const data = rows.map(row => ({ x: encode(row, index, V), y: ROUTES.indexOf(row.route) }));
  const hidden = new Float64Array(H), logits = new Float64Array(C), dz = new Float64Array(H);
  for (let epoch = 0; epoch < config.epochs; epoch += 1) {
    const rate = config.learningRate * (0.1 + 0.9 * 0.5 * (1 + Math.cos(Math.PI * epoch / config.epochs)));
    const decay = 1 - rate * config.weightDecay;
    for (let step = 0; step < data.length; step += 1) {
      const { x, y } = data[(step * 2654435761 + epoch * 40503) % data.length];
      for (let u = 0; u < H; u += 1) { let v = b1[u]; for (let k = 0; k < x.ids.length; k += 1) v += W1[u][x.ids[k]] * x.values[k]; hidden[u] = Math.tanh(v); }
      let max = -Infinity;
      for (let o = 0; o < C; o += 1) { let v = b2[o]; for (let u = 0; u < H; u += 1) v += W2[o][u] * hidden[u]; logits[o] = v; max = Math.max(max, v); }
      let sum = 0; for (let o = 0; o < C; o += 1) { logits[o] = Math.exp(logits[o] - max); sum += logits[o]; }
      dz.fill(0);
      for (let o = 0; o < C; o += 1) { const g = logits[o] / sum - (o === y ? 1 : 0); b2[o] -= rate * g; for (let u = 0; u < H; u += 1) { dz[u] += W2[o][u] * g; W2[o][u] = W2[o][u] * decay - rate * g * hidden[u]; } }
      for (let u = 0; u < H; u += 1) { const g = dz[u] * (1 - hidden[u] * hidden[u]); b1[u] -= rate * g; for (let k = 0; k < x.ids.length; k += 1) { const id = x.ids[k]; W1[u][id] = W1[u][id] * decay - rate * g * x.values[k]; } }
    }
  }
  return { schema: 'archie-context-route-model/v1', config, vocabulary, routes: [...ROUTES], route_protocol: ROUTE_PROTOCOL, model: { W1, b1, W2, b2, input: V, hidden: H, classes: C } };
}

export function predictContextRoute(trained, value) {
  const index = trained.__index || (trained.__index = new Map(trained.vocabulary.map((feature, i) => [feature, i])));
  const x = encode(value, index, trained.model.input);
  const { W1, b1, W2, b2, hidden: H, classes: C } = trained.model;
  const hidden = new Float64Array(H), logits = new Float64Array(C);
  for (let u = 0; u < H; u += 1) { let v = b1[u]; for (let k = 0; k < x.ids.length; k += 1) v += W1[u][x.ids[k]] * x.values[k]; hidden[u] = Math.tanh(v); }
  let max = -Infinity, best = 0;
  for (let o = 0; o < C; o += 1) { let v = b2[o]; for (let u = 0; u < H; u += 1) v += W2[o][u] * hidden[u]; logits[o] = v; if (v > max) { max = v; best = o; } }
  let sum = 0; const exps = Float64Array.from(logits, value => { const result = Math.exp(value - max); sum += result; return result; });
  const route = trained.routes[best];
  return { route, confidence: exps[best] / sum, protocol: trained.route_protocol[route] };
}

export function evaluateContextRoutes(trained, cases) {
  let correct = 0; const errors = [];
  for (const item of cases) { const output = predictContextRoute(trained, item); if (output.route === item.expected || output.route === item.route) correct += 1; else errors.push({ id: item.id, expected: item.expected || item.route, actual: output.route }); }
  return { examples: cases.length, accuracy: Number((correct / Math.max(1, cases.length)).toFixed(4)), errors };
}
