#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARCHIE_CORPUS_PACK_SCHEMA = 'archie-corpus-pack/v1';
export const ARCHIE_CORPUS_PACK_RECEIPT_SCHEMA = 'archie-corpus-pack-receipt/v1';
export const DEFAULT_PACK_LIMITS = Object.freeze({
  max_entries: 200_000,
  max_file_bytes: 64 * 1024 * 1024,
  max_total_bytes: 256 * 1024 * 1024
});

const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)\b/i;
const SECRET_KEY = /(?:^|[_-])(?:secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential|session)(?:$|[_-])/i;
const ALLOWED_ROOT_FILES = new Set(['records.jsonl', 'examples.jsonl', 'ledger.jsonl']);
const ALLOWED_TREE_ROOTS = new Set(['objects', 'examples', 'models']);
const ALLOWED_EXTENSIONS = new Set(['.json', '.jsonl']);
const clean = (value, limit = 10_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function toISO(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  return new Date(value).toISOString();
}

function normalizedLimits(input = {}) {
  const values = { ...DEFAULT_PACK_LIMITS, ...(input || {}) };
  for (const key of Object.keys(DEFAULT_PACK_LIMITS)) {
    const value = Number(values[key]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid corpus pack limit: ${key}.`);
    values[key] = value;
  }
  return Object.freeze(values);
}

function normalizeRelativePath(value) {
  const raw = clean(value, 4000).replaceAll('\\', '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error('Corpus pack path must be relative.');
  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('Corpus pack path traversal rejected.');
  const [root] = normalized.split('/');
  const allowed = ALLOWED_ROOT_FILES.has(normalized) || (ALLOWED_TREE_ROOTS.has(root) && normalized.includes('/'));
  if (!allowed || !ALLOWED_EXTENSIONS.has(path.posix.extname(normalized))) throw new Error(`Corpus pack path is outside the owned-memory allowlist: ${normalized}`);
  if (normalized.includes('/.') || normalized.endsWith('.tmp') || normalized.includes('.tmp-') || normalized.endsWith('.lock')) throw new Error(`Transient corpus path rejected: ${normalized}`);
  return normalized;
}

function assertSafeStructuredValue(value, location = '$', depth = 0) {
  if (depth > 40) throw new Error(`Corpus pack value exceeds safe nesting at ${location}.`);
  if (Array.isArray(value)) {
    if (value.length > 1_000_000) throw new Error(`Corpus pack array is too large at ${location}.`);
    value.forEach((item, index) => assertSafeStructuredValue(item, `${location}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && SECRET_TEXT.test(value)) throw new Error(`Secret-like material rejected at ${location}.`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && child !== '[redacted]' && child !== null && child !== '') throw new Error(`Unredacted secret-like field rejected at ${location}.${key}.`);
    assertSafeStructuredValue(child, `${location}.${key}`, depth + 1);
  }
}

function validateTextPayload(relativePath, buffer) {
  const text = buffer.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') !== buffer.length) throw new Error(`Corpus pack file is not valid UTF-8: ${relativePath}`);
  if (relativePath.endsWith('.jsonl')) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      let value;
      try { value = JSON.parse(lines[index]); }
      catch { throw new Error(`Invalid JSONL at ${relativePath}:${index + 1}.`); }
      assertSafeStructuredValue(value, `${relativePath}:${index + 1}`);
    }
    return;
  }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Invalid JSON at ${relativePath}.`); }
  assertSafeStructuredValue(value, relativePath);
}

async function pathExists(filename) {
  try { await fs.access(filename); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function collectFiles(root, limits) {
  const entries = [];
  let totalBytes = 0;
  const visit = async (directory, relativeDirectory = '') => {
    const children = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (child.name === '.archie.lock' || child.name.includes('.tmp-') || child.name.endsWith('.tmp')) continue;
      if (child.isSymbolicLink()) throw new Error(`Corpus pack refuses symbolic links: ${relative}`);
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (!relativeDirectory && !ALLOWED_TREE_ROOTS.has(child.name)) continue;
        await visit(absolute, relative);
        continue;
      }
      if (!child.isFile()) throw new Error(`Corpus pack refuses non-regular files: ${relative}`);
      const normalized = normalizeRelativePath(relative);
      const stat = await fs.stat(absolute);
      if (stat.size > limits.max_file_bytes) throw new Error(`Corpus pack file exceeds max_file_bytes: ${normalized}`);
      totalBytes += stat.size;
      if (totalBytes > limits.max_total_bytes) throw new Error('Corpus pack exceeds max_total_bytes.');
      if (entries.length >= limits.max_entries) throw new Error('Corpus pack exceeds max_entries.');
      const content = await fs.readFile(absolute);
      validateTextPayload(normalized, content);
      entries.push(Object.freeze({
        path: normalized,
        bytes: content.length,
        sha256: sha256(content),
        encoding: 'base64',
        content: content.toString('base64')
      }));
    }
  };
  await visit(root);
  return Object.freeze({ entries, totalBytes });
}

function packDigestBody(pack) {
  return {
    schema: pack.schema,
    created_at: pack.created_at,
    source: pack.source,
    limits: pack.limits,
    entries: pack.entries
  };
}

export function inspectCorpusPack(input, { limits = {} } = {}) {
  const pack = typeof input === 'string' || Buffer.isBuffer(input)
    ? JSON.parse(Buffer.isBuffer(input) ? input.toString('utf8') : input)
    : structuredClone(input);
  if (pack?.schema !== ARCHIE_CORPUS_PACK_SCHEMA) throw new Error('Unsupported Archie corpus pack schema.');
  if (!Array.isArray(pack.entries)) throw new Error('Corpus pack entries are required.');
  const effectiveLimits = normalizedLimits({ ...pack.limits, ...limits });
  if (pack.entries.length > effectiveLimits.max_entries) throw new Error('Corpus pack exceeds max_entries.');
  const seen = new Set();
  let totalBytes = 0;
  const entries = pack.entries.map((entry, index) => {
    const relativePath = normalizeRelativePath(entry?.path);
    if (seen.has(relativePath)) throw new Error(`Duplicate corpus pack path: ${relativePath}`);
    seen.add(relativePath);
    if (entry?.encoding !== 'base64') throw new Error(`Unsupported corpus pack encoding at entry ${index}.`);
    const content = Buffer.from(clean(entry.content, Math.ceil(effectiveLimits.max_file_bytes * 4 / 3) + 100), 'base64');
    const declaredBytes = Number(entry.bytes);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes !== content.length) throw new Error(`Corpus pack byte count mismatch: ${relativePath}`);
    if (content.length > effectiveLimits.max_file_bytes) throw new Error(`Corpus pack file exceeds max_file_bytes: ${relativePath}`);
    totalBytes += content.length;
    if (totalBytes > effectiveLimits.max_total_bytes) throw new Error('Corpus pack exceeds max_total_bytes.');
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || sha256(content) !== entry.sha256) throw new Error(`Corpus pack content digest mismatch: ${relativePath}`);
    validateTextPayload(relativePath, content);
    return Object.freeze({ path: relativePath, bytes: content.length, sha256: entry.sha256, content });
  });
  if (Number(pack.source?.total_bytes) !== totalBytes || Number(pack.source?.entry_count) !== entries.length) throw new Error('Corpus pack source totals do not match entries.');
  const expected = sha256(stableJSONStringify(packDigestBody(pack)));
  if (!/^[a-f0-9]{64}$/.test(pack.pack_digest) || pack.pack_digest !== expected) throw new Error('Corpus pack manifest digest mismatch.');
  return Object.freeze({ pack: Object.freeze(pack), entries, total_bytes: totalBytes, entry_count: entries.length, pack_digest: expected });
}

async function writeAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, value, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

export async function exportCorpusPack({ root, destination = '', clock = Date.now, limits = {} } = {}) {
  if (!root) throw new Error('Archie corpus root is required.');
  const absoluteRoot = path.resolve(root);
  const effectiveLimits = normalizedLimits(limits);
  const { entries, totalBytes } = await collectFiles(absoluteRoot, effectiveLimits);
  const body = {
    schema: ARCHIE_CORPUS_PACK_SCHEMA,
    created_at: toISO(clock),
    source: {
      ownership: 'personal',
      format: 'archie-linux-corpus',
      entry_count: entries.length,
      total_bytes: totalBytes
    },
    limits: effectiveLimits,
    entries
  };
  const pack = Object.freeze({ ...body, pack_digest: sha256(stableJSONStringify(body)) });
  const encoded = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  if (destination) await writeAtomic(path.resolve(destination), encoded);
  return Object.freeze({
    schema: ARCHIE_CORPUS_PACK_RECEIPT_SCHEMA,
    operation: 'export',
    status: 'created',
    source_root: absoluteRoot,
    destination: destination ? path.resolve(destination) : null,
    entry_count: entries.length,
    total_bytes: totalBytes,
    pack_bytes: encoded.length,
    pack_digest: pack.pack_digest,
    pack
  });
}

async function writeStagedTree(stageRoot, inspected) {
  await fs.mkdir(stageRoot, { recursive: true, mode: 0o700 });
  for (const entry of inspected.entries) {
    const filename = path.join(stageRoot, ...entry.path.split('/'));
    const relative = path.relative(stageRoot, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Corpus pack staging path escaped root.');
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(filename, entry.content, { mode: 0o600, flag: 'wx' });
  }
}

async function verifyTree(root, inspected) {
  for (const entry of inspected.entries) {
    const filename = path.join(root, ...entry.path.split('/'));
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Imported corpus entry is not a regular file: ${entry.path}`);
    const content = await fs.readFile(filename);
    if (content.length !== entry.bytes || sha256(content) !== entry.sha256) throw new Error(`Imported corpus verification failed: ${entry.path}`);
  }
}

export async function importCorpusPack({ root, source = '', pack = null, replace = false, clock = Date.now, limits = {}, fault = null } = {}) {
  if (!root) throw new Error('Archie corpus root is required.');
  if (!pack && !source) throw new Error('Pass source or pack for corpus import.');
  const encoded = pack ?? JSON.parse(await fs.readFile(path.resolve(source), 'utf8'));
  const inspected = inspectCorpusPack(encoded, { limits });
  const target = path.resolve(root);
  const parent = path.dirname(target);
  const nonce = crypto.randomBytes(8).toString('hex');
  const stage = path.join(parent, `.${path.basename(target)}.stage-${nonce}`);
  const backup = path.join(parent, `.${path.basename(target)}.backup-${nonce}`);
  const existed = await pathExists(target);
  if (existed && !replace) throw new Error('Target corpus exists; pass replace=true for an explicit transactional replacement.');
  let backedUp = false;
  try {
    await writeStagedTree(stage, inspected);
    await verifyTree(stage, inspected);
    if (typeof fault === 'function') await fault('after_stage', { stage, target, backup });
    if (existed) {
      await fs.rename(target, backup);
      backedUp = true;
    }
    if (typeof fault === 'function') await fault('after_backup', { stage, target, backup });
    await fs.rename(stage, target);
    if (typeof fault === 'function') await fault('after_promote', { stage, target, backup });
    await verifyTree(target, inspected);
    if (backedUp) await fs.rm(backup, { recursive: true, force: true });
    return Object.freeze({
      schema: ARCHIE_CORPUS_PACK_RECEIPT_SCHEMA,
      operation: 'import',
      status: 'restored',
      target_root: target,
      source: source ? path.resolve(source) : null,
      replaced: existed,
      rollback: 'not_required',
      entry_count: inspected.entry_count,
      total_bytes: inspected.total_bytes,
      pack_digest: inspected.pack_digest,
      imported_at: toISO(clock)
    });
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    let rollback = 'not_required';
    if (backedUp) {
      rollback = 'complete';
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      try { await fs.rename(backup, target); }
      catch (rollbackError) {
        rollback = 'failed';
        throw new AggregateError([error, rollbackError], 'Corpus pack import and rollback failed.');
      }
    }
    error.import_receipt = Object.freeze({
      schema: ARCHIE_CORPUS_PACK_RECEIPT_SCHEMA,
      operation: 'import',
      status: 'failed',
      target_root: target,
      replaced: existed,
      rollback,
      pack_digest: inspected.pack_digest,
      error: clean(error?.message || error, 2000),
      imported_at: toISO(clock)
    });
    throw error;
  }
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2];
  if (command === 'export') {
    const root = argument('--root');
    const destination = argument('--output');
    if (!destination) throw new Error('Pass --output for corpus pack export.');
    console.log(JSON.stringify(await exportCorpusPack({ root, destination }), null, 2));
    return;
  }
  if (command === 'inspect') {
    const source = argument('--file');
    if (!source) throw new Error('Pass --file for corpus pack inspection.');
    const inspected = inspectCorpusPack(await fs.readFile(source, 'utf8'));
    console.log(JSON.stringify({ schema: ARCHIE_CORPUS_PACK_RECEIPT_SCHEMA, operation: 'inspect', status: 'valid', entry_count: inspected.entry_count, total_bytes: inspected.total_bytes, pack_digest: inspected.pack_digest }, null, 2));
    return;
  }
  if (command === 'import') {
    const root = argument('--root');
    const source = argument('--file');
    const replace = process.argv.includes('--replace');
    console.log(JSON.stringify(await importCorpusPack({ root, source, replace }), null, 2));
    return;
  }
  throw new Error('Usage: maker-archie-corpus-pack.mjs <export|inspect|import> --root <directory> [--output|--file <pack>] [--replace]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    if (error.import_receipt) console.error(JSON.stringify(error.import_receipt));
    process.exitCode = 1;
  });
}
