import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const HEX = /^[a-f0-9]{64}$/;
const GIT = /^[a-f0-9]{40,64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_KEY = /(?:^|[_-])(api[_-]?key|private[_-]?key|password|secret|access[_-]?token|authorization|cookie|credential)(?:$|[_-])/i;
const SECRET_TEXT = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{12,})/i;

export const clean = (value, limit = 500_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
export const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const stableJSONStringify = value => JSON.stringify(canonical(value));
export const canonicalJSON = value => `${JSON.stringify(canonical(value), null, 2)}\n`;
export const sha256 = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');

export function noSecrets(value, trail = 'input', depth = 0) {
  if (depth > 24) throw new Error(`${trail} exceeds supported nesting.`);
  if (typeof value === 'string') {
    if (SECRET_TEXT.test(value)) throw new Error(`${trail} contains secret material.`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => noSecrets(item, `${trail}[${index}]`, depth + 1));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`${trail}.${key} is secret-like.`);
    noSecrets(child, `${trail}.${key}`, depth + 1);
  }
}

export function identifier(value, field) {
  const result = clean(value, 128);
  if (!NAME.test(result)) throw new Error(`${field} must be a portable identifier.`);
  return result;
}
export function digest(value, field) {
  const result = clean(value, 64).toLowerCase();
  if (!HEX.test(result)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}
export function gitSha(value, field = 'base_sha') {
  const result = clean(value, 64).toLowerCase();
  if (!GIT.test(result)) throw new Error(`${field} must be a lowercase 40-64 character git digest.`);
  return result;
}
export function positiveInt(value, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${field} must be a positive safe integer.`);
  return result;
}
export function nonNegative(value, field) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${field} must be finite and non-negative.`);
  return result;
}
export function strings(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const result = [...new Set(value.map((item, index) => {
    const text = clean(item, 200);
    if (!text) throw new Error(`${field}[${index}] is empty.`);
    return text;
  }))].sort();
  if (!result.length) throw new Error(`${field} must not be empty.`);
  return result;
}
export function relative(value, field) {
  const result = clean(value, 1000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!result || result.startsWith('/') || /^[A-Za-z]:\//.test(result) || result.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${field} must be a safe relative path.`);
  return result;
}
export const without = (value, field) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
export const signed = (body, field) => Object.freeze({ ...canonical(body), [field]: sha256(canonical(body)) });
export function verifySigned(value, field, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (sha256(without(value, field)) !== digest(value[field], `${label}.${field}`)) throw new Error(`${label} digest mismatch.`);
  return value;
}
export async function exists(filename) {
  try { await fs.stat(filename); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
export async function readJSON(filename, label = filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`); throw error; }
}
export async function writeExactJSON(filename, value) {
  const content = canonicalJSON(value);
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (await exists(filename)) {
    if (await fs.readFile(filename, 'utf8') !== content) throw new Error(`Refusing to overwrite drifted artifact: ${filename}.`);
    return { filename, created: false };
  }
  const temp = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, filename);
  return { filename, created: true };
}
