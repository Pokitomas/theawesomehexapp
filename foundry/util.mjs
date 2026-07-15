import crypto from 'node:crypto';

export const SHA40 = /^[0-9a-f]{40}$/i;
export const FORBIDDEN_SECRET_KEYS = /(^|_)(secret|token|api[_-]?key|password|credential|private[_-]?key)($|_)/i;

export function asText(value, name, limit = 10000) {
  const result = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!result) throw new Error(`${name} is required.`);
  if (result.length > limit) throw new Error(`${name} exceeds ${limit} characters.`);
  return result;
}

export function asFiniteNumber(value, name, { min = -Infinity, max = Infinity } = {}) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}.`);
  }
  return result;
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableSort(value[key])]));
}

export function stableJSONStringify(value, space = 2) {
  return JSON.stringify(stableSort(value), null, space);
}

export function digest(value) {
  return crypto.createHash('sha256').update(stableJSONStringify(value, 0)).digest('hex');
}

export function assertNoSecrets(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.test(key)) throw new Error(`Secret-like field is forbidden at ${path}.${key}.`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}
