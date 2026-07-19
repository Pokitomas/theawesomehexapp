// From-scratch constrained protocol decoder — pure Node, no external ML runtime.
//
// The model is a tiny autoregressive decoder: a bag-of-features prompt encoder
// feeds a shared per-step MLP that predicts the next opcode. Backpropagation is
// hand-coded and gradient-checked (see tests). At decode time every step is
// masked by the grammar (protocol-grammar.mjs), so emitted protocols are always
// syntactically valid regardless of model quality.

import {
  NUM_OPCODES, NUM_INPUT_TOKENS, START_TOKEN, STOP,
  MAX_POSITIONS, MAX_LENGTH, legalNextMask, validateProtocol
} from './protocol-grammar.mjs';

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) so every run/receipt is reproducible.
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Feature extraction: word unigrams + adjacent bigrams. Bigrams give the model
// a limited handle on negation scope and relation words ("not_a", "rather_than")
// that a pure unigram bag cannot represent.
// ---------------------------------------------------------------------------
export function tokenize(prompt) {
  return String(prompt)
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function featuresOf(prompt) {
  const tokens = tokenize(prompt);
  const features = [];
  for (const token of tokens) features.push(`u:${token}`);
  for (let i = 0; i + 1 < tokens.length; i += 1) features.push(`b:${tokens[i]}_${tokens[i + 1]}`);
  return features;
}

// Vocabulary built from training examples only. Out-of-vocabulary features at
// eval time are silently dropped (honest OOV behaviour).
export function buildVocabulary(examples, { minCount = 1 } = {}) {
  const counts = new Map();
  for (const example of examples) {
    for (const feature of new Set(featuresOf(example.prompt))) {
      counts.set(feature, (counts.get(feature) || 0) + 1);
    }
  }
  const vocab = new Map();
  for (const feature of [...counts.keys()].sort()) {
    if (counts.get(feature) >= minCount) vocab.set(feature, vocab.size);
  }
  return vocab;
}

// Sparse presence vector: array of active feature ids (value 1.0 each).
export function encodePrompt(prompt, vocab) {
  const ids = new Set();
  for (const feature of featuresOf(prompt)) {
    const id = vocab.get(feature);
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Model parameters. Each tensor exposes {data, grad} Float64Arrays so training
// and finite-difference gradient checking iterate uniformly.
// ---------------------------------------------------------------------------
function tensor(size) {
  return { data: new Float64Array(size), grad: new Float64Array(size) };
}

export function createModel({ vocabSize, hidden = 48, embed = 16, seed = 1234 } = {}) {
  const rng = mulberry32(seed);
  const H = hidden;
  const D = embed;
  const P = MAX_POSITIONS;
  const C = H + D + P; // step-context width
  const model = {
    dims: { V: vocabSize, H, D, P, C, O: NUM_OPCODES, Tin: NUM_INPUT_TOKENS },
    Wenc: tensor(H * vocabSize),
    benc: tensor(H),
    Ein: tensor(NUM_INPUT_TOKENS * D),
    Wh: tensor(H * C),
    bh: tensor(H),
    Wo: tensor(NUM_OPCODES * H),
    bo: tensor(NUM_OPCODES)
  };
  const fill = (t, scale) => { for (let i = 0; i < t.data.length; i += 1) t.data[i] = (rng() * 2 - 1) * scale; };
  fill(model.Wenc, 1 / Math.sqrt(Math.max(1, Math.min(vocabSize, 32))));
  fill(model.Ein, 0.2);
  fill(model.Wh, 1 / Math.sqrt(C));
  fill(model.Wo, 1 / Math.sqrt(H));
  return model;
}

export function parameterTensors(model) {
  return [model.Wenc, model.benc, model.Ein, model.Wh, model.bh, model.Wo, model.bo];
}

function zeroGrads(model) {
  for (const t of parameterTensors(model)) t.grad.fill(0);
}

// Encode a prompt to the hidden state h0 = tanh(Wenc x + benc). Returns h0 and
// preactivation for backprop.
function encodeHidden(model, activeFeatures) {
  const { H, V } = model.dims;
  const pre = new Float64Array(H);
  for (let j = 0; j < H; j += 1) {
    let sum = model.benc.data[j];
    const row = j * V;
    for (const f of activeFeatures) sum += model.Wenc.data[row + f];
    pre[j] = sum;
  }
  const h0 = new Float64Array(H);
  for (let j = 0; j < H; j += 1) h0[j] = Math.tanh(pre[j]);
  return { h0 };
}

function softmaxCrossEntropy(logits, target) {
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  let sum = 0;
  const probs = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i += 1) { probs[i] = Math.exp(logits[i] - max); sum += probs[i]; }
  for (let i = 0; i < probs.length; i += 1) probs[i] /= sum;
  const loss = -Math.log(Math.max(probs[target], 1e-12));
  return { probs, loss };
}

// Forward + backward over one teacher-forced example. Accumulates gradients
// into model tensors and returns the summed cross-entropy loss.
export function forwardBackward(model, activeFeatures, target) {
  const { H, D, P, C, O } = model.dims;
  const { h0 } = encodeHidden(model, activeFeatures);
  const dh0 = new Float64Array(H);
  let totalLoss = 0;

  for (let t = 0; t < target.length; t += 1) {
    const prevToken = t === 0 ? START_TOKEN : target[t - 1];
    const pos = Math.min(t, P - 1);

    // context c = [h0 ; Ein[prevToken] ; posOneHot]
    const c = new Float64Array(C);
    for (let j = 0; j < H; j += 1) c[j] = h0[j];
    const embBase = prevToken * D;
    for (let j = 0; j < D; j += 1) c[H + j] = model.Ein.data[embBase + j];
    c[H + D + pos] = 1;

    // a = tanh(Wh c + bh)
    const preA = new Float64Array(H);
    const a = new Float64Array(H);
    for (let j = 0; j < H; j += 1) {
      let sum = model.bh.data[j];
      const row = j * C;
      for (let i = 0; i < C; i += 1) sum += model.Wh.data[row + i] * c[i];
      preA[j] = sum;
      a[j] = Math.tanh(sum);
    }

    // logits = Wo a + bo
    const logits = new Float64Array(O);
    for (let k = 0; k < O; k += 1) {
      let sum = model.bo.data[k];
      const row = k * H;
      for (let j = 0; j < H; j += 1) sum += model.Wo.data[row + j] * a[j];
      logits[k] = sum;
    }

    const { probs, loss } = softmaxCrossEntropy(logits, target[t]);
    totalLoss += loss;

    // dLogits
    const dLogits = probs; // reuse
    dLogits[target[t]] -= 1;

    // grads for Wo, bo; da
    const da = new Float64Array(H);
    for (let k = 0; k < O; k += 1) {
      const g = dLogits[k];
      model.bo.grad[k] += g;
      const row = k * H;
      for (let j = 0; j < H; j += 1) {
        model.Wo.grad[row + j] += g * a[j];
        da[j] += g * model.Wo.data[row + j];
      }
    }

    // through tanh -> preA
    const dPreA = new Float64Array(H);
    for (let j = 0; j < H; j += 1) dPreA[j] = da[j] * (1 - a[j] * a[j]);

    // grads for Wh, bh; dc
    const dc = new Float64Array(C);
    for (let j = 0; j < H; j += 1) {
      const g = dPreA[j];
      model.bh.grad[j] += g;
      const row = j * C;
      for (let i = 0; i < C; i += 1) {
        model.Wh.grad[row + i] += g * c[i];
        dc[i] += g * model.Wh.data[row + i];
      }
    }

    // split dc -> dh0 (accumulate), dEin[prevToken] (accumulate); position slot has no params
    for (let j = 0; j < H; j += 1) dh0[j] += dc[j];
    for (let j = 0; j < D; j += 1) model.Ein.grad[embBase + j] += dc[H + j];
  }

  // backprop dh0 through h0 = tanh(pre) to Wenc, benc
  const { H: HH, V } = model.dims;
  for (let j = 0; j < HH; j += 1) {
    const dPre = dh0[j] * (1 - h0[j] * h0[j]);
    model.benc.grad[j] += dPre;
    const row = j * V;
    for (const f of activeFeatures) model.Wenc.grad[row + f] += dPre;
  }

  return totalLoss;
}

// Loss only (for gradient checking).
export function forwardLoss(model, activeFeatures, target) {
  const { H, D, P, C, O } = model.dims;
  const { h0 } = encodeHidden(model, activeFeatures);
  let totalLoss = 0;
  for (let t = 0; t < target.length; t += 1) {
    const prevToken = t === 0 ? START_TOKEN : target[t - 1];
    const pos = Math.min(t, P - 1);
    const c = new Float64Array(C);
    for (let j = 0; j < H; j += 1) c[j] = h0[j];
    const embBase = prevToken * D;
    for (let j = 0; j < D; j += 1) c[H + j] = model.Ein.data[embBase + j];
    c[H + D + pos] = 1;
    const a = new Float64Array(H);
    for (let j = 0; j < H; j += 1) {
      let sum = model.bh.data[j];
      const row = j * C;
      for (let i = 0; i < C; i += 1) sum += model.Wh.data[row + i] * c[i];
      a[j] = Math.tanh(sum);
    }
    const logits = new Float64Array(O);
    for (let k = 0; k < O; k += 1) {
      let sum = model.bo.data[k];
      const row = k * H;
      for (let j = 0; j < H; j += 1) sum += model.Wo.data[row + j] * a[j];
      logits[k] = sum;
    }
    totalLoss += softmaxCrossEntropy(logits, target[t]).loss;
  }
  return totalLoss;
}

// ---------------------------------------------------------------------------
// Adam optimizer over all parameter tensors.
// ---------------------------------------------------------------------------
function createAdamState(model) {
  return parameterTensors(model).map(t => ({ m: new Float64Array(t.data.length), v: new Float64Array(t.data.length) }));
}

function adamStep(model, state, step, { lr, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weightDecay = 0 }) {
  const tensors = parameterTensors(model);
  const bc1 = 1 - Math.pow(beta1, step);
  const bc2 = 1 - Math.pow(beta2, step);
  for (let ti = 0; ti < tensors.length; ti += 1) {
    const t = tensors[ti];
    const s = state[ti];
    for (let i = 0; i < t.data.length; i += 1) {
      let g = t.grad[i];
      if (weightDecay) g += weightDecay * t.data[i];
      s.m[i] = beta1 * s.m[i] + (1 - beta1) * g;
      s.v[i] = beta2 * s.v[i] + (1 - beta2) * g * g;
      const mHat = s.m[i] / bc1;
      const vHat = s.v[i] / bc2;
      t.data[i] -= lr * mHat / (Math.sqrt(vHat) + eps);
    }
  }
}

// ---------------------------------------------------------------------------
// Training over a corpus. Pre-encodes prompts once against the vocabulary.
// ---------------------------------------------------------------------------
export function trainDecoder(trainExamples, vocab, {
  hidden = 32, embed = 16, epochs = 600, batchSize = 16, lr = 0.01,
  weightDecay = 1e-3, seed = 1234
} = {}) {
  const model = createModel({ vocabSize: vocab.size, hidden, embed, seed });
  const adam = createAdamState(model);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const data = trainExamples.map(ex => ({ features: encodePrompt(ex.prompt, vocab), target: ex.protocol }));
  const order = data.map((_, i) => i);
  const history = [];
  let step = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    // Fisher-Yates shuffle with the seeded RNG for a deterministic schedule.
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    let epochLoss = 0;
    for (let start = 0; start < order.length; start += batchSize) {
      zeroGrads(model);
      const end = Math.min(order.length, start + batchSize);
      const count = end - start;
      for (let k = start; k < end; k += 1) {
        const item = data[order[k]];
        epochLoss += forwardBackward(model, item.features, item.target);
      }
      // Average gradients over the minibatch.
      for (const t of parameterTensors(model)) {
        for (let i = 0; i < t.grad.length; i += 1) t.grad[i] /= count;
      }
      step += 1;
      adamStep(model, adam, step, { lr, weightDecay });
    }
    if (epoch === 0 || (epoch + 1) % 50 === 0 || epoch === epochs - 1) {
      history.push({ epoch: epoch + 1, mean_loss: epochLoss / data.length });
    }
  }
  return { model, history };
}

// ---------------------------------------------------------------------------
// Constrained greedy decode. Always returns a grammar-valid protocol.
// ---------------------------------------------------------------------------
export function decodeProtocol(model, activeFeatures) {
  const { H, D, P, C, O } = model.dims;
  const { h0 } = encodeHidden(model, activeFeatures);
  const sequence = [];
  for (let t = 0; t < MAX_LENGTH; t += 1) {
    const prevToken = t === 0 ? START_TOKEN : sequence[sequence.length - 1];
    const pos = Math.min(t, P - 1);
    const c = new Float64Array(C);
    for (let j = 0; j < H; j += 1) c[j] = h0[j];
    const embBase = prevToken * D;
    for (let j = 0; j < D; j += 1) c[H + j] = model.Ein.data[embBase + j];
    c[H + D + pos] = 1;
    const a = new Float64Array(H);
    for (let j = 0; j < H; j += 1) {
      let sum = model.bh.data[j];
      const row = j * C;
      for (let i = 0; i < C; i += 1) sum += model.Wh.data[row + i] * c[i];
      a[j] = Math.tanh(sum);
    }
    const logits = new Float64Array(O);
    for (let k = 0; k < O; k += 1) {
      let sum = model.bo.data[k];
      const row = k * H;
      for (let j = 0; j < H; j += 1) sum += model.Wo.data[row + j] * a[j];
      logits[k] = sum;
    }
    const mask = legalNextMask(sequence);
    let best = -1;
    let bestLogit = -Infinity;
    for (let k = 0; k < O; k += 1) {
      if (!mask[k]) continue;
      if (logits[k] > bestLogit) { bestLogit = logits[k]; best = k; }
    }
    sequence.push(best);
    if (best === STOP) break;
  }
  return sequence;
}

function sameSequence(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function multisetOverlapF1(predicted, target) {
  const count = seq => { const m = new Map(); for (const x of seq) m.set(x, (m.get(x) || 0) + 1); return m; };
  const pc = count(predicted);
  const tc = count(target);
  let overlap = 0;
  for (const [k, v] of pc) overlap += Math.min(v, tc.get(k) || 0);
  const precision = predicted.length ? overlap / predicted.length : 0;
  const recall = target.length ? overlap / target.length : 0;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

// Evaluate the model over a set of examples. Returns aggregate metrics plus a
// per-example record so the receipt can show the exact decoded protocols.
export function evaluate(model, examples, vocab) {
  const records = [];
  let exact = 0;
  let validCount = 0;
  let f1Sum = 0;
  for (const example of examples) {
    const features = encodePrompt(example.prompt, vocab);
    const predicted = decodeProtocol(model, features);
    const validity = validateProtocol(predicted);
    const isExact = sameSequence(predicted, example.protocol);
    const f1 = multisetOverlapF1(predicted, example.protocol);
    if (isExact) exact += 1;
    if (validity.valid) validCount += 1;
    f1Sum += f1;
    records.push({
      id: example.id,
      intent: example.intent,
      axis: example.axis,
      prompt: example.prompt,
      expected: example.protocol,
      predicted,
      valid: validity.valid,
      exact: isExact,
      opcode_f1: Number(f1.toFixed(4))
    });
  }
  const n = examples.length || 1;
  return {
    count: examples.length,
    exact_match: Number((exact / n).toFixed(4)),
    protocol_syntax_valid: Number((validCount / n).toFixed(4)),
    opcode_f1: Number((f1Sum / n).toFixed(4)),
    records
  };
}
