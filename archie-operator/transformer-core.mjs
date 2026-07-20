// transformer-core.mjs — pure-JS forward pass for the from-scratch NumPy
// transformer (archie-np-transformer-web/v1). No scaffolding: tokens in,
// six learned judgments out. Attachment / memory / thread payloads are passed
// as tokens behind channel markers, exactly as in training.

function decodeRows(q) {
  return q.rows.map((encoded, i) => {
    const raw = typeof atob === 'function' ? atob(encoded) : Buffer.from(encoded, 'base64').toString('binary');
    const out = new Float32Array(raw.length);
    for (let j = 0; j < raw.length; j += 1) { let v = raw.charCodeAt(j); if (v > 127) v -= 256; out[j] = v * q.scales[i]; }
    return out;
  });
}

export function tokenizeTf(text) {
  const out = []; let cur = '';
  for (const ch of String(text).toLowerCase()) {
    if (/[a-z0-9'-]/.test(ch)) cur += ch;
    else { if (cur) { out.push(cur); cur = ''; } if (!/\s/.test(ch)) out.push(ch); }
  }
  if (cur) out.push(cur);
  return out;
}

export function createTransformer(model) {
  const W2 = Object.fromEntries(Object.entries(model.tensors2d).map(([k, q]) => [k, decodeRows(q)]));
  const W1 = model.tensors1d;
  const vmap = new Map(model.vocab.map((t, i) => [t, i]));
  const { d, layers, heads, tmax } = model.config;
  const hd = d / heads;
  const H = Object.fromEntries(['route', 'auth', 'ctx', 'ref', 'out1', 'out2'].map(n => [n, W2[`H${n}`]]));

  function rowTokens(request, context = {}) {
    const toks = ['<cls>', ...tokenizeTf(request)];
    const chans = [['attachments', '<att>'], ['memory', '<mem>'], ['thread', '<thr>']];
    for (const [key, marker] of chans) {
      const payload = context[key];
      if (payload) toks.push(marker, ...tokenizeTf(payload).slice(0, 10));
    }
    return toks.slice(0, tmax);
  }

  function ln(x, T, g, b) {
    for (let t = 0; t < T; t += 1) {
      const o = t * d; let mu = 0;
      for (let i = 0; i < d; i += 1) mu += x[o + i];
      mu /= d; let vsum = 0;
      for (let i = 0; i < d; i += 1) { const c = x[o + i] - mu; vsum += c * c; }
      const inv = 1 / Math.sqrt(vsum / d + 1e-5);
      for (let i = 0; i < d; i += 1) x[o + i] = (x[o + i] - mu) * inv * g[i] + b[i];
    }
  }

  function matmulRows(x, T, inDim, W, bias, outDim) {
    const y = new Float32Array(T * outDim);
    for (let t = 0; t < T; t += 1) {
      for (let o = 0; o < outDim; o += 1) {
        let s = bias ? bias[o] : 0;
        for (let i = 0; i < inDim; i += 1) s += x[t * inDim + i] * W[i][o];
        y[t * outDim + o] = s;
      }
    }
    return y;
  }

  function softmaxInPlace(v) {
    let m = -Infinity; for (const x of v) if (x > m) m = x;
    let s = 0; for (let i = 0; i < v.length; i += 1) { v[i] = Math.exp(v[i] - m); s += v[i]; }
    for (let i = 0; i < v.length; i += 1) v[i] /= s;
    return v;
  }

  function forward(request, context) {
    const toks = rowTokens(request, context);
    const T = toks.length;
    let x = new Float32Array(T * d);
    for (let t = 0; t < T; t += 1) {
      const id = vmap.has(toks[t]) ? vmap.get(toks[t]) : vmap.get('<unk>');
      const e = W2.emb[id], p = W2.pos[t];
      for (let i = 0; i < d; i += 1) x[t * d + i] = e[i] + p[i];
    }
    for (let l = 0; l < layers; l += 1) {
      const l1 = Float32Array.from(x); ln(l1, T, W1[`g1${l}`], W1[`b1${l}`]);
      const qkv = matmulRows(l1, T, d, W2[`qkv${l}`], W1[`qkvb${l}`], 3 * d);
      const att = new Float32Array(T * d);
      for (let h = 0; h < heads; h += 1) {
        const qo = h * hd, ko = d + h * hd, vo = 2 * d + h * hd;
        for (let t = 0; t < T; t += 1) {
          const scores = new Float32Array(T);
          for (let u = 0; u < T; u += 1) {
            let s = 0;
            for (let i = 0; i < hd; i += 1) s += qkv[t * 3 * d + qo + i] * qkv[u * 3 * d + ko + i];
            scores[u] = s / Math.sqrt(hd);
          }
          softmaxInPlace(scores);
          for (let i = 0; i < hd; i += 1) {
            let s = 0;
            for (let u = 0; u < T; u += 1) s += scores[u] * qkv[u * 3 * d + vo + i];
            att[t * d + qo + i] = s;
          }
        }
      }
      const ao = matmulRows(att, T, d, W2[`ao${l}`], W1[`aob${l}`], d);
      for (let i = 0; i < T * d; i += 1) x[i] += ao[i];
      const l2 = Float32Array.from(x); ln(l2, T, W1[`g2${l}`], W1[`b2${l}`]);
      const h1 = matmulRows(l2, T, d, W2[`f1${l}`], W1[`f1b${l}`], 4 * d);
      for (let i = 0; i < h1.length; i += 1) if (h1[i] < 0) h1[i] = 0;
      const ff = matmulRows(h1, T, 4 * d, W2[`f2${l}`], W1[`f2b${l}`], d);
      for (let i = 0; i < T * d; i += 1) x[i] += ff[i];
    }
    ln(x, T, W1.gF, W1.bF);
    const cls = x.subarray(0, d);
    const logits = {};
    for (const [name, W] of Object.entries(H)) {
      const n = W1[`Hb${name}`].length;
      const z = new Float32Array(n);
      for (let o = 0; o < n; o += 1) {
        let s = W1[`Hb${name}`][o];
        for (let i = 0; i < d; i += 1) s += cls[i] * W[i][o];
        z[o] = s;
      }
      logits[name] = z;
    }
    return logits;
  }

  function predict(request, context = {}) {
    const logits = forward(request, context);
    const temp = model.config.route_temperature || 1.0;
    const routeP = softmaxInPlace(Float32Array.from(logits.route, v => v / temp));
    const pick = (name, labels) => labels[softmaxInPlace(Float32Array.from(logits[name])).reduce((bi, v, i, arr) => v > arr[bi] ? i : bi, 0)];
    let ri = 0; for (let i = 1; i < routeP.length; i += 1) if (routeP[i] > routeP[ri]) ri = i;
    const route = model.routes[ri];
    const o1 = pick('out1', model.out1), o2 = pick('out2', model.out2);
    let outcomes;
    if (route === 'clarify') outcomes = [];
    else if (route === 'compound') outcomes = [o1, o2].filter(o => o !== '<none>');
    else outcomes = [route];
    return {
      route,
      confidence: routeP[ri],
      authority: pick('auth', model.authority),
      context: pick('ctx', model.context),
      reference: pick('ref', model.ref),
      outcomes,
      distribution: model.routes.map((r, i) => ({ route: r, p: routeP[i] })).sort((a, b) => b.p - a.p)
    };
  }

  return { predict, forward, routes: model.routes };
}
