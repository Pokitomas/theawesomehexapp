import crypto from 'node:crypto';

export const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(stable(value));
}

export function digest(value) {
  return crypto.createHash('sha256').update(stableJSONStringify(value)).digest('hex');
}

export function clean(value, field, limit = 10_000) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!text) throw new Error(`${field} is required.`);
  if (text.length > limit) throw new Error(`${field} exceeds ${limit} characters.`);
  return text;
}

export function exactDigest(value, field) {
  const text = clean(value, field, 64);
  if (!DIGEST_PATTERN.test(text)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return text;
}

export function exactGitSha(value, field) {
  const text = clean(value, field, 40);
  if (!GIT_SHA_PATTERN.test(text)) throw new Error(`${field} must be a lowercase 40-character Git SHA.`);
  return text;
}

export function uniqueStrings(values, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  if (!allowEmpty && values.length === 0) throw new Error(`${field} must not be empty.`);
  const output = [];
  const seen = new Set();
  values.forEach((value, index) => {
    const text = clean(value, `${field}[${index}]`, 300);
    if (seen.has(text)) throw new Error(`${field} contains duplicate value ${text}.`);
    seen.add(text);
    output.push(text);
  });
  return output;
}

export function evidenceDigests(values, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  if (!allowEmpty && values.length === 0) throw new Error(`${field} must not be empty.`);
  const output = values.map((value, index) => exactDigest(value, `${field}[${index}]`));
  if (new Set(output).size !== output.length) throw new Error(`${field} contains duplicate evidence digests.`);
  return output;
}

export function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be finite.`);
  return number;
}

export function rangedNumber(value, field, range) {
  const number = finiteNumber(value, field);
  if (range === 'unit_interval' && (number < 0 || number > 1)) throw new Error(`${field} must be between 0 and 1.`);
  if (range === 'nonnegative' && number < 0) throw new Error(`${field} must be nonnegative.`);
  return number;
}

export function metricPasses(name, threshold, observed) {
  if (name.endsWith('_max')) return observed <= threshold;
  return observed >= threshold;
}
