import crypto from 'node:crypto';
import { INTENTS, protocolFor, isValidProtocol } from './protocol-grammar.mjs';

const DEFAULTS = Object.freeze({ minCount: 2, hidden: 32, learningRate: 0.06, weightDecay: 1e-3, epochs: 550, seed: 3407 });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) + 1) / 4294967297;
  };
}

function tokenize(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s'-]+/g, ' ').split(/\s+/).filter(Boolean);
}

function featureStrings(text) {
  const words = tokenize(text);
  const features = words.map(word => `w:${word}`);
  for (let index = 0; index < words.length - 1; index += 1) features.push(`b:${words[index]}_${words[index + 1]}`);
  return features;
}

export function buildVocabulary(rows, { minCount = DEFAULTS.minCount } = {}) {
  const counts = new Map();
  for (const row of rows) {
    for (const feature of featureStrings(row.prompt)) counts.set(feature, (counts.get(feature) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= minCount).map(([feature]) => feature).sort();
}

export function vectorize(text, vocabulary) {
  const index = new Map(vocabulary.map((value, position) => [value, position]));
  const vector = new Float64Array(vocabulary.length);
  const counts = new Map();
  let norm = 0;
  for (const feature of featureStrings(text)) {
    if (index.has(feature)) counts.set(feature, (counts.get(feature) || 0) + 1);
  }
  for (const [feature, count] of counts) {
    const value = Math.log1p(count);
    vector[index.get(feature)] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let offset = 0; offset < vector.length; offset += 1) vector[offset] /= norm;
  return vector;
}

function initialize(input, hidden, classes, seed) {
  const random = rng(seed);
  const scale1 = Math.sqrt(6 / (input + hidden));
  const scale2 = Math.sqrt(6 / (hidden + classes));
  return {
    W1: Array.from({ length: hidden }, () => Float64Array.from({ length: input }, () => (random() * 2 - 1) * scale1)),
    b1: new Float64Array(hidden),
    W2: Array.from({ length: classes }, () => Float64Array.from({ length: hidden }, () => (random() * 2 - 1) * scale2)),
    b2: new Float64Array(classes),
    input,
    hidden,
    classes
  };
}

function forward(model, vector) {
  const hidden = new Float64Array(model.hidden);
  for (let unit = 0; unit < model.hidden; unit += 1) {
    let value = model.b1[unit];
    for (let input = 0; input < model.input; input += 1) value += model.W1[unit][input] * vector[input];
    hidden[unit] = Math.tanh(value);
  }
  const logits = new Float64Array(model.classes);
  let maximum = -Infinity;
  for (let output = 0; output < model.classes; output += 1) {
    let value = model.b2[output];
    for (let unit = 0; unit < model.hidden; unit += 1) value += model.W2[output][unit] * hidden[unit];
    logits[output] = value;
    maximum = Math.max(maximum, value);
  }
  const probabilities = new Float64Array(model.classes);
  let total = 0;
  for (let output = 0; output < model.classes; output += 1) {
    probabilities[output] = Math.exp(logits[output] - maximum);
    total += probabilities[output];
  }
  for (let output = 0; output < model.classes; output += 1) probabilities[output] /= total;
  return { hidden, logits, probabilities };
}

function gradients(model, vector, target, weightDecay) {
  const { hidden, probabilities } = forward(model, vector);
  const dlogits = Float64Array.from(probabilities);
  dlogits[target] -= 1;
  const W2 = Array.from({ length: model.classes }, () => new Float64Array(model.hidden));
  const b2 = Float64Array.from(dlogits);
  const dhidden = new Float64Array(model.hidden);
  for (let output = 0; output < model.classes; output += 1) {
    for (let unit = 0; unit < model.hidden; unit += 1) {
      W2[output][unit] = dlogits[output] * hidden[unit] + weightDecay * model.W2[output][unit];
      dhidden[unit] += model.W2[output][unit] * dlogits[output];
    }
  }
  const dz = new Float64Array(model.hidden);
  for (let unit = 0; unit < model.hidden; unit += 1) dz[unit] = dhidden[unit] * (1 - hidden[unit] * hidden[unit]);
  const W1 = Array.from({ length: model.hidden }, () => new Float64Array(model.input));
  const b1 = Float64Array.from(dz);
  for (let unit = 0; unit < model.hidden; unit += 1) {
    for (let input = 0; input < model.input; input += 1) W1[unit][input] = dz[unit] * vector[input] + weightDecay * model.W1[unit][input];
  }
  return { loss: -Math.log(Math.max(1e-12, probabilities[target])), W1, b1, W2, b2 };
}

function apply(model, gradient, learningRate) {
  for (let unit = 0; unit < model.hidden; unit += 1) {
    for (let input = 0; input < model.input; input += 1) model.W1[unit][input] -= learningRate * gradient.W1[unit][input];
    model.b1[unit] -= learningRate * gradient.b1[unit];
  }
  for (let output = 0; output < model.classes; output += 1) {
    for (let unit = 0; unit < model.hidden; unit += 1) model.W2[output][unit] -= learningRate * gradient.W2[output][unit];
    model.b2[output] -= learningRate * gradient.b2[output];
  }
}

export function trainDecoder(rows, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const vocabulary = buildVocabulary(rows, config);
  const model = initialize(vocabulary.length, config.hidden, INTENTS.length, config.seed);
  const vectors = rows.map(row => vectorize(row.prompt, vocabulary));
  const targets = rows.map(row => INTENTS.indexOf(row.intent));
  for (let epoch = 0; epoch < config.epochs; epoch += 1) {
    const rate = config.learningRate * (0.15 + 0.85 * 0.5 * (1 + Math.cos(Math.PI * epoch / config.epochs)));
    for (let count = 0; count < rows.length; count += 1) {
      const index = (count * 37 + epoch * 17) % rows.length;
      apply(model, gradients(model, vectors[index], targets[index], config.weightDecay), rate);
    }
  }
  return Object.freeze({ schema: 'archie-protocol-decoder/v1', config, vocabulary, intents: [...INTENTS], model });
}

export function predict(decoder, prompt) {
  const vector = vectorize(prompt, decoder.vocabulary);
  const { probabilities } = forward(decoder.model, vector);
  let best = 0;
  for (let index = 1; index < probabilities.length; index += 1) if (probabilities[index] > probabilities[best]) best = index;
  const intent = decoder.intents[best];
  const protocol = protocolFor(intent);
  return { intent, protocol, confidence: probabilities[best], valid: isValidProtocol(protocol) };
}

export function evaluate(decoder, rows) {
  const detail = rows.map(row => {
    const output = predict(decoder, row.prompt);
    return {
      ...row,
      predicted: output.protocol,
      predicted_intent: output.intent,
      confidence: Number(output.confidence.toFixed(6)),
      exact: output.intent === row.intent && output.protocol.join(' ') === row.expected.join(' '),
      syntax_valid: output.valid
    };
  });
  return {
    examples: rows.length,
    exact_match: Number((detail.filter(item => item.exact).length / Math.max(1, rows.length)).toFixed(4)),
    protocol_syntax_valid: Number((detail.filter(item => item.syntax_valid).length / Math.max(1, rows.length)).toFixed(4)),
    detail
  };
}

export function parameterCount(decoder) {
  const model = decoder.model;
  return model.hidden * model.input + model.hidden + model.classes * model.hidden + model.classes;
}

export function modelDigest(decoder) {
  const model = decoder.model;
  return sha256({
    schema: decoder.schema,
    config: decoder.config,
    vocabulary: decoder.vocabulary,
    intents: decoder.intents,
    W1: model.W1.map(row => [...row]),
    b1: [...model.b1],
    W2: model.W2.map(row => [...row]),
    b2: [...model.b2]
  });
}

export function finiteDifferenceGradientCheck() {
  const model = initialize(3, 2, 2, 7);
  const vector = Float64Array.from([0.2, -0.1, 0.4]);
  const target = 1;
  const weightDecay = 0.001;
  const gradient = gradients(model, vector, target, weightDecay);
  const epsilon = 1e-6;
  const loss = () => {
    const probability = forward(model, vector).probabilities[target];
    let regularization = 0;
    for (const row of model.W1) for (const value of row) regularization += value * value;
    for (const row of model.W2) for (const value of row) regularization += value * value;
    return -Math.log(probability) + 0.5 * weightDecay * regularization;
  };
  let maximumError = 0;
  for (const [matrix, expected] of [[model.W1, gradient.W1], [model.W2, gradient.W2]]) {
    for (let row = 0; row < matrix.length; row += 1) {
      for (let column = 0; column < matrix[row].length; column += 1) {
        const original = matrix[row][column];
        matrix[row][column] = original + epsilon;
        const high = loss();
        matrix[row][column] = original - epsilon;
        const low = loss();
        matrix[row][column] = original;
        maximumError = Math.max(maximumError, Math.abs((high - low) / (2 * epsilon) - expected[row][column]));
      }
    }
  }
  return maximumError;
}
