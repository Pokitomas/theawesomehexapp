// mind-core.mjs — introspection layer over the governed route model.
//
// Everything here is computed from the real int8 weights. Nothing is invented:
// - reflect() returns the full softmax over all routes plus the raw margin;
// - attribute() runs honest leave-one-word-out occlusion to show which words
//   pulled the mind toward its chosen route (Δ log-prob when the word is removed);
// - reverie() free-associates by walking a bigram Markov chain built from the
//   model's own vocabulary, then routes each drifting thought — the being
//   acting on nothing but the shape of what it learned.

import { featureStrings, tokenize } from './operator-core.mjs';

function mcDecodeInt8(rows, scales) {
  return rows.map((encoded, index) => {
    const raw = typeof atob === 'function' ? atob(encoded) : Buffer.from(encoded, 'base64').toString('binary');
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) { let v = raw.charCodeAt(i); if (v > 127) v -= 256; out[i] = v * scales[index]; }
    return out;
  });
}

export function createMind(model) {
  const W1 = mcDecodeInt8(model.weights_int8.W1.rows, model.weights_int8.W1.scales);
  const W2 = mcDecodeInt8(model.weights_int8.W2.rows, model.weights_int8.W2.scales);
  const b1 = model.weights_int8.b1, b2 = model.weights_int8.b2;
  const vocab = new Map(model.vocabulary.map((f, i) => [f, i]));
  const charNgrams = Boolean(model.config?.charNgrams);
  const routes = model.routes || model.intents;
  const protocols = model.route_protocol || model.intent_protocol;
  const { input: IN, hidden: H, classes: C } = model.dims;

  function forwardFeatures(featureList) {
    const counts = new Map();
    for (const f of featureList) { const id = vocab.get(f); if (id !== undefined) counts.set(id, (counts.get(id) || 0) + 1); }
    const ids = [...counts.keys()];
    let norm = 0; const raw = ids.map(id => { const v = Math.log1p(counts.get(id)); norm += v * v; return v; });
    norm = Math.sqrt(norm) || 1;
    const hidden = new Float32Array(H);
    for (let u = 0; u < H; u += 1) {
      let v = b1[u]; const row = W1[u];
      for (let k = 0; k < ids.length; k += 1) v += row[ids[k]] * (raw[k] / norm);
      hidden[u] = Math.tanh(v);
    }
    const logits = new Float32Array(C); let max = -Infinity;
    for (let o = 0; o < C; o += 1) {
      let v = b2[o]; const row = W2[o];
      for (let u = 0; u < H; u += 1) v += row[u] * hidden[u];
      logits[o] = v; if (v > max) max = v;
    }
    const probs = new Float32Array(C); let sum = 0;
    for (let o = 0; o < C; o += 1) { probs[o] = Math.exp(logits[o] - max); sum += probs[o]; }
    let best = 0; for (let o = 0; o < C; o += 1) { probs[o] /= sum; if (probs[o] > probs[best]) best = o; }
    return { probs, best, matched: ids.length };
  }

  // Full reflection: chosen route, protocol, ordered distribution, margin, coverage.
  function reflect(prompt) {
    const feats = featureStrings(prompt, charNgrams);
    const { probs, best, matched } = forwardFeatures(feats);
    const distribution = routes.map((route, i) => ({ route, p: probs[i] })).sort((a, b) => b.p - a.p);
    const margin = distribution.length > 1 ? distribution[0].p - distribution[1].p : distribution[0]?.p || 0;
    const totalFeat = feats.length || 1;
    return {
      route: routes[best],
      protocol: protocols[routes[best]] || ['OBSERVE', 'STOP'],
      confidence: probs[best],
      margin,
      distribution,
      coverage: matched / totalFeat,          // fraction of features the mind recognized
      recognized: matched,
      abstains: routes[best] === 'clarify'
    };
  }

  // Leave-one-word-out attribution toward the chosen route.
  function attribute(prompt) {
    const words = tokenize(prompt);
    const full = forwardFeatures(featureStrings(prompt, charNgrams));
    const target = full.best;
    const baseLogP = Math.log(Math.max(1e-9, full.probs[target]));
    const out = [];
    for (let i = 0; i < words.length; i += 1) {
      const without = words.slice(0, i).concat(words.slice(i + 1)).join(' ');
      const alt = forwardFeatures(featureStrings(without, charNgrams));
      const delta = baseLogP - Math.log(Math.max(1e-9, alt.probs[target])); // >0 ⇒ word supports the choice
      out.push({ word: words[i], pull: delta, flips: alt.best !== target });
    }
    const maxAbs = out.reduce((m, x) => Math.max(m, Math.abs(x.pull)), 1e-6);
    for (const x of out) x.weight = x.pull / maxAbs; // -1..1
    return { route: routes[target], words: out };
  }

  // Bigram Markov reverie built from the vocabulary's word features.
  const chain = (() => {
    const nexts = new Map(); const starts = [];
    for (const feat of model.vocabulary) {
      if (feat.startsWith('b:')) {
        const [a, b] = feat.slice(2).split('_');
        if (!a || !b) continue;
        if (!nexts.has(a)) nexts.set(a, []);
        nexts.get(a).push(b);
      } else if (feat.startsWith('w:')) {
        starts.push(feat.slice(2));
      }
    }
    return { nexts, starts };
  })();

  function reverie(seed) {
    let x = (seed >>> 0) || 0x9e3779b9;
    const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296); };
    const pick = arr => arr[Math.floor(rnd() * arr.length)];
    const len = 4 + Math.floor(rnd() * 6);
    let word = pick(chain.starts);
    const words = [word];
    for (let i = 1; i < len; i += 1) {
      const opts = chain.nexts.get(word);
      if (!opts || !opts.length) { word = pick(chain.starts); } else { word = pick(opts); }
      words.push(word);
    }
    const thought = words.join(' ');
    return { thought, ...reflect(thought) };
  }

  return { reflect, attribute, reverie, routes, protocols };
}
