const MODEL_CACHE = new WeakMap();
const SCALE = 4096;
import { LAYOUT_DISTANCE } from './product-studio-spec.mjs';

export function cleanText(value) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, 8000);
}

export function hashText(value) {
  let hash = 2166136261;
  for (const char of cleanText(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function loadChunkedProductModel(baseUrl, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  const base = String(baseUrl || '').replace(/\/$/, '');
  const manifestResponse = await fetchImpl(`${base}/manifest.json`, { cache: 'no-store' });
  if (!manifestResponse.ok) throw new Error(`Model manifest HTTP ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  if (manifest.schema !== 'archie-chunked-json/v1' || !Array.isArray(manifest.parts) || !manifest.parts.length) {
    throw new Error('Unsupported product model manifest.');
  }
  const chunks = await Promise.all(manifest.parts.map(async part => {
    const response = await fetchImpl(`${base}/${part.path}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Model part HTTP ${response.status}: ${part.path}`);
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes !== part.bytes) throw new Error(`Model part byte mismatch: ${part.path}`);
    const observed = await sha256Hex(text);
    if (observed && observed !== part.sha256) throw new Error(`Model part digest mismatch: ${part.path}`);
    return text;
  }));
  const payload = chunks.join('');
  const payloadBytes = new TextEncoder().encode(payload).byteLength;
  if (payloadBytes !== manifest.logical_bytes) throw new Error('Product model logical byte mismatch.');
  const observed = await sha256Hex(payload);
  if (observed && observed !== manifest.logical_sha256) throw new Error('Product model logical digest mismatch.');
  const model = JSON.parse(payload);
  prepareModel(model);
  return Object.freeze({ model, manifest });
}

export function tokenizeBlueprintText(value) {
  const words = (cleanText(value).toLowerCase().match(/[a-z0-9_]+/g) || []).filter(token => token.length >= 2);
  return [...words, ...words.slice(0, -1).map((token, index) => `${token} ${words[index + 1]}`)];
}

function prepareModel(model) {
  if (!model || typeof model !== 'object' || !String(model.schema || '').startsWith('archie-product-blueprint-linear/')) {
    throw new Error('Unsupported product blueprint model.');
  }
  if (MODEL_CACHE.has(model)) return MODEL_CACHE.get(model);
  const index = new Map(model.vocabulary.map((feature, position) => [feature, position]));
  const prepared = { index, scale: Number(model.quantization?.scale || SCALE) };
  MODEL_CACHE.set(model, prepared);
  return prepared;
}

function vectorize(model, prompt) {
  const { index, scale } = prepareModel(model);
  const counts = new Map();
  for (const feature of tokenizeBlueprintText(prompt)) {
    const position = index.get(feature);
    if (position !== undefined) counts.set(position, (counts.get(position) || 0) + 1);
  }
  const values = [];
  let normSquared = 0;
  for (const [position, count] of counts) {
    const value = count * (Number(model.idf_q4096[position]) / scale);
    normSquared += value * value;
    values.push([position, value]);
  }
  const norm = Math.sqrt(normSquared) || 1;
  return values.map(([position, value]) => [position, value / norm]);
}

export function rankBlueprintHead(model, prompt, headName) {
  const head = model.heads?.[headName];
  if (!head) throw new Error(`Unknown blueprint head: ${headName}`);
  const { scale } = prepareModel(model);
  const vector = vectorize(model, prompt);
  return head.classes.map((label, classIndex) => {
    let score = Number(head.intercept_q4096[classIndex] || 0) / scale;
    const vectorMap = new Map(vector);
    const coefficients = head.coefficient_sparse_q4096[classIndex] || [];
    for (const [position, weight] of coefficients) score += (Number(weight) / scale) * (vectorMap.get(position) || 0);
    return { label, score };
  }).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

export function predictProductBlueprint(model, prompt) {
  const text = cleanText(prompt);
  if (!text) throw new Error('Product brief is required.');
  const rankings = Object.fromEntries(['archetype', 'layout', 'style', 'density', 'motion'].map(head => [head, rankBlueprintHead(model, text, head)]));
  return Object.freeze({
    archetype: rankings.archetype[0].label,
    layout: rankings.layout[0].label,
    style: rankings.style[0].label,
    density: rankings.density[0].label,
    motion: rankings.motion[0].label,
    confidence: Object.fromEntries(Object.entries(rankings).map(([head, values]) => [head, Number((values[0].score - (values[1]?.score || 0)).toFixed(4))])),
    rankings,
  });
}

function blueprintDistance(left, right) {
  let distance = 0;
  if (left.layout !== right.layout) distance += 4;
  if (LAYOUT_DISTANCE[left.layout]?.family !== LAYOUT_DISTANCE[right.layout]?.family) distance += 3;
  if (LAYOUT_DISTANCE[left.layout]?.axis !== LAYOUT_DISTANCE[right.layout]?.axis) distance += 2;
  if (left.style !== right.style) distance += 3;
  if (left.density !== right.density) distance += 1;
  if (left.motion !== right.motion) distance += 1;
  return distance;
}

export function selectDiverseBlueprints(model, prompt, count = 3) {
  const target = Math.max(1, Math.min(6, Number(count) || 1));
  const base = predictProductBlueprint(model, prompt);
  const layouts = base.rankings.layout.slice(0, 8).map(value => value.label);
  const styles = base.rankings.style.slice(0, 10).map(value => value.label);
  const densities = base.rankings.density.map(value => value.label);
  const motions = base.rankings.motion.map(value => value.label);
  const seed = hashText(prompt);
  const candidates = [];
  for (let li = 0; li < layouts.length; li += 1) {
    for (let si = 0; si < styles.length; si += 1) {
      const density = densities[(li + si + seed) % densities.length];
      const motion = motions[(li * 2 + si + seed) % motions.length];
      candidates.push({
        archetype: base.archetype,
        layout: layouts[li],
        style: styles[si],
        density,
        motion,
        confidence: base.confidence,
        rankCost: li * 1.6 + si * 1.2,
      });
    }
  }
  candidates.sort((a, b) => a.rankCost - b.rankCost || hashText(`${prompt}:${a.layout}:${a.style}`) - hashText(`${prompt}:${b.layout}:${b.style}`));
  const selected = [candidates.shift()];
  while (selected.length < target && candidates.length) {
    candidates.sort((a, b) => {
      const aDistance = Math.min(...selected.map(chosen => blueprintDistance(a, chosen)));
      const bDistance = Math.min(...selected.map(chosen => blueprintDistance(b, chosen)));
      return bDistance - aDistance || a.rankCost - b.rankCost || a.layout.localeCompare(b.layout) || a.style.localeCompare(b.style);
    });
    selected.push(candidates.shift());
  }
  return selected.map((blueprint, index) => Object.freeze({
    ...blueprint,
    variant: index + 1,
    diversity_distance: index === 0 ? null : Math.min(...selected.slice(0, index).map(other => blueprintDistance(blueprint, other))),
    identity: `${blueprint.archetype}:${blueprint.layout}:${blueprint.style}:${blueprint.density}:${blueprint.motion}`,
  }));
}
