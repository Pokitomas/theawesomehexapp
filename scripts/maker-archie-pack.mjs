import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const PACK_SCHEMA = 'archie-portable-pack/v1';
const RECEIPT_SCHEMA = 'archie-portable-pack-receipt/v1';
const PORTABLE_SYSTEMS = Object.freeze(['linux', 'macos', 'windows', 'wsl', 'github-actions', 'remote-worker']);
const TEXT_EXTENSIONS = new Set(['.json', '.jsonl', '.txt', '.md', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.log']);
const SECRET_PATH = /(^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|p12|pfx|key))(?:$|\/)/i;
const SECRET_KEY = /(?:^|[_-])(secret|token|password|passwd|authorization|cookie|private[_-]?key|api[_-]?key|credential)(?:$|[_-])/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+)\b/gi;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const clean = (value, limit = 100000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const nowISO = () => new Date().toISOString();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function digest(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) || value instanceof Uint8Array ? value : typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

function safeRelative(value) {
  const relative = clean(value, 2000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!relative || relative.startsWith('/') || /^[A-Za-z]:\//.test(relative) || relative.split('/').includes('..') || relative.includes('//')) {
    throw new Error(`Unsafe pack path: ${JSON.stringify(value)}.`);
  }
  if (relative === '.archie.lock' || /(^|\/)\.git(?:\/|$)/.test(relative)) throw new Error(`Operational path is not packable: ${relative}.`);
  return relative;
}

function safeJoin(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...safeRelative(relative).split('/'));
  if (target === base || !target.startsWith(`${base}${path.sep}`)) throw new Error(`Pack path escapes root: ${relative}.`);
  return target;
}

function redactText(text) {
  return String(text).replace(SECRET_TEXT, '[redacted]');
}

function redactJSON(value, depth = 0) {
  if (depth > 18) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100000).map(item => redactJSON(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100000).map(([key, child]) => [
      clean(key, 500),
      SECRET_KEY.test(key) ? '[redacted]' : redactJSON(child, depth + 1)
    ]));
  }
  if (typeof value === 'string') return redactText(value);
  return value;
}

function normalizeTextBuffer(buffer, relative) {
  let text;
  try { text = buffer.toString('utf8'); } catch { return null; }
  if (text.includes('\u0000') || (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase()) && !['records.jsonl', 'examples.jsonl', 'ledger.jsonl'].includes(path.posix.basename(relative)))) return null;
  if (path.extname(relative).toLowerCase() === '.json') {
    try { return Buffer.from(`${JSON.stringify(redactJSON(JSON.parse(text)), null, 2)}\n`, 'utf8'); } catch { return Buffer.from(redactText(text), 'utf8'); }
  }
  if (path.extname(relative).toLowerCase() === '.jsonl') {
    const lines = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return stableJSONStringify(redactJSON(JSON.parse(line))); } catch { throw new Error(`Invalid JSONL while packing ${relative}:${index + 1}.`); }
    });
    return Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  }
  return Buffer.from(redactText(text), 'utf8');
}

async function exists(filename) {
  try { await fs.lstat(filename); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function writeAtomic(filename, bytes, mode = 0o600) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, bytes, { mode });
  await fs.rename(temporary, filename);
}

async function listFiles(root) {
  const files = [];
  async function visit(directory, prefix = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === '.archie.lock' || entry.name.startsWith('.tmp-')) continue;
      if (SECRET_PATH.test(relative)) throw new Error(`Secret-like path cannot enter an Archie pack: ${relative}.`);
      const absolute = safeJoin(root, relative);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error(`Linked filesystem entries cannot enter an Archie pack: ${relative}.`);
      if (stat.isDirectory()) await visit(absolute, relative);
      else if (stat.isFile()) files.push({ relative, absolute, stat });
      else throw new Error(`Special filesystem entry cannot enter an Archie pack: ${relative}.`);
    }
  }
  await visit(path.resolve(root));
  return files;
}

function encryptionState(adapter) {
  return Object.freeze({
    state: adapter?.seal && adapter?.open ? 'configured' : 'unavailable',
    algorithm: clean(adapter?.algorithm || '', 200) || null,
    key_reference: clean(adapter?.key_reference || '', 300) || null
  });
}

function manifestBody(input) {
  return {
    schema: PACK_SCHEMA,
    pack_id: input.pack_id,
    version: 1,
    source_kind: 'archie-corpus-and-sparse-models',
    portable_systems: PORTABLE_SYSTEMS,
    created_at: input.created_at,
    chunk_bytes: input.chunk_bytes,
    encryption: input.encryption,
    totals: input.totals,
    entries: input.entries
  };
}

function sealManifest(body) {
  return Object.freeze({ ...body, manifest_digest: digest(body) });
}

export function verifyPackManifest(input) {
  if (input?.schema !== PACK_SCHEMA || input.version !== 1) throw new Error('Unsupported Archie pack manifest version.');
  const body = { ...input };
  delete body.manifest_digest;
  if (!/^[0-9a-f]{64}$/.test(input.manifest_digest || '') || digest(body) !== input.manifest_digest) throw new Error('Archie pack manifest integrity check failed.');
  if (!Array.isArray(input.entries)) throw new Error('Archie pack entries are missing.');
  for (const entry of input.entries) {
    safeRelative(entry.path);
    if (!['text', 'metadata-reference'].includes(entry.kind)) throw new Error(`Unsupported Archie pack entry kind: ${entry.kind}.`);
    if (!/^[0-9a-f]{64}$/.test(entry.content_sha256 || '')) throw new Error(`Invalid content digest for ${entry.path}.`);
    if (entry.kind === 'text' && (!Array.isArray(entry.chunks) || !entry.chunks.length && entry.bytes > 0)) throw new Error(`Missing chunks for ${entry.path}.`);
  }
  return input;
}

function chunkPath(packRoot, storedDigest) {
  return path.join(packRoot, 'chunks', storedDigest.slice(0, 2), `${storedDigest}.bin`);
}

export class ArchiePortablePack {
  constructor({ clock = nowISO, encryption = null } = {}) {
    this.clock = clock;
    this.encryption = encryption;
  }

  capabilities() {
    return Object.freeze({
      schema: 'archie-pack-capabilities/v1',
      portability: PORTABLE_SYSTEMS,
      encryption: encryptionState(this.encryption),
      binary_media: 'metadata-reference-only',
      receipt_digest: digest({ portability: PORTABLE_SYSTEMS, encryption: encryptionState(this.encryption), binary_media: 'metadata-reference-only' })
    });
  }

  async export({ source_root, pack_root, pack_id = null, chunk_bytes = DEFAULT_CHUNK_BYTES, max_file_bytes = DEFAULT_MAX_FILE_BYTES, max_total_bytes = DEFAULT_MAX_TOTAL_BYTES, encrypt = false } = {}) {
    if (!source_root || !pack_root) throw new Error('Archie pack export requires source_root and pack_root.');
    const source = path.resolve(source_root);
    const destination = path.resolve(pack_root);
    if (destination === source || destination.startsWith(`${source}${path.sep}`)) throw new Error('Pack output must remain outside the source corpus.');
    const encryption = encryptionState(this.encryption);
    if (encrypt && encryption.state !== 'configured') throw new Error('Archie pack encryption adapter is unavailable.');
    const width = Math.max(1024, Math.min(4 * 1024 * 1024, Number(chunk_bytes) || DEFAULT_CHUNK_BYTES));
    const files = await listFiles(source);
    const entries = [];
    let totalInputBytes = 0;
    let totalPackedBytes = 0;
    let chunksWritten = 0;
    let chunksReused = 0;
    for (const file of files) {
      if (file.stat.size > max_file_bytes) throw new Error(`Archie pack file exceeds the byte ceiling: ${file.relative}.`);
      totalInputBytes += file.stat.size;
      if (totalInputBytes > max_total_bytes) throw new Error('Archie pack exceeds the total byte ceiling.');
      const original = await fs.readFile(file.absolute);
      const normalized = normalizeTextBuffer(original, file.relative);
      if (normalized === null) {
        entries.push({
          path: file.relative,
          kind: 'metadata-reference',
          bytes: file.stat.size,
          content_sha256: digest(original),
          chunks: [],
          retained: false,
          reason: 'binary media remains an external metadata reference'
        });
        continue;
      }
      const chunks = [];
      for (let offset = 0; offset < normalized.length || (normalized.length === 0 && offset === 0); offset += width) {
        const plain = normalized.subarray(offset, Math.min(normalized.length, offset + width));
        const plainDigest = digest(plain);
        let stored = plain;
        let sealMetadata = null;
        if (encrypt) {
          const sealed = await this.encryption.seal({ bytes: Buffer.from(plain), aad: `${file.relative}:${chunks.length}:${plainDigest}` });
          stored = Buffer.from(sealed?.bytes || sealed);
          sealMetadata = sealed?.metadata || null;
        }
        const storedDigest = digest(stored);
        const target = chunkPath(destination, storedDigest);
        let reused = false;
        if (await exists(target)) {
          const current = await fs.readFile(target);
          if (digest(current) !== storedDigest) throw new Error(`Existing pack chunk is corrupt: ${storedDigest}.`);
          reused = true;
          chunksReused += 1;
        } else {
          await writeAtomic(target, stored);
          chunksWritten += 1;
        }
        totalPackedBytes += stored.length;
        chunks.push({
          index: chunks.length,
          plain_sha256: plainDigest,
          stored_sha256: storedDigest,
          plain_bytes: plain.length,
          stored_bytes: stored.length,
          encrypted: encrypt,
          seal_metadata: redactJSON(sealMetadata)
        });
        if (normalized.length === 0) break;
      }
      entries.push({
        path: file.relative,
        kind: 'text',
        bytes: normalized.length,
        source_bytes: file.stat.size,
        content_sha256: digest(normalized),
        chunks,
        retained: true,
        redacted: digest(original) !== digest(normalized)
      });
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const createdAt = typeof this.clock === 'function' ? this.clock() : this.clock;
    const body = manifestBody({
      pack_id: clean(pack_id || `pack_${digest(entries).slice(0, 24)}`, 200),
      created_at: new Date(createdAt).toISOString(),
      chunk_bytes: width,
      encryption: { ...encryption, enabled: encrypt },
      totals: {
        entries: entries.length,
        retained_entries: entries.filter(entry => entry.retained).length,
        metadata_references: entries.filter(entry => !entry.retained).length,
        source_bytes: totalInputBytes,
        packed_bytes: totalPackedBytes,
        chunks: entries.reduce((total, entry) => total + (entry.chunks?.length || 0), 0)
      },
      entries
    });
    const manifest = sealManifest(body);
    await writeAtomic(path.join(destination, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    const receiptBody = {
      schema: RECEIPT_SCHEMA,
      operation: 'export',
      pack_id: manifest.pack_id,
      manifest_digest: manifest.manifest_digest,
      entries: manifest.totals.entries,
      retained_entries: manifest.totals.retained_entries,
      chunks_written: chunksWritten,
      chunks_reused: chunksReused,
      encryption: manifest.encryption.state,
      completed_at: manifest.created_at
    };
    return Object.freeze({ manifest, receipt: Object.freeze({ ...receiptBody, receipt_digest: digest(receiptBody) }) });
  }

  async inspect(packRoot) {
    const manifest = verifyPackManifest(JSON.parse(await fs.readFile(path.join(path.resolve(packRoot), 'manifest.json'), 'utf8')));
    let verifiedChunks = 0;
    for (const entry of manifest.entries) {
      for (const chunk of entry.chunks || []) {
        const bytes = await fs.readFile(chunkPath(packRoot, chunk.stored_sha256));
        if (digest(bytes) !== chunk.stored_sha256) throw new Error(`Archie pack chunk integrity check failed: ${chunk.stored_sha256}.`);
        verifiedChunks += 1;
      }
    }
    return Object.freeze({ manifest, verified_chunks: verifiedChunks, inspection_digest: digest({ manifest_digest: manifest.manifest_digest, verified_chunks: verifiedChunks }) });
  }

  async import({ pack_root, target_root, resume = true } = {}) {
    if (!pack_root || !target_root) throw new Error('Archie pack import requires pack_root and target_root.');
    const pack = path.resolve(pack_root);
    const target = path.resolve(target_root);
    if (target === pack || target.startsWith(`${pack}${path.sep}`)) throw new Error('Import target must remain outside the pack directory.');
    const manifest = verifyPackManifest(JSON.parse(await fs.readFile(path.join(pack, 'manifest.json'), 'utf8')));
    if (manifest.encryption?.enabled && encryptionState(this.encryption).state !== 'configured') throw new Error('Archie pack decryption adapter is unavailable.');
    const stage = path.join(path.dirname(target), `.archie-import-${manifest.manifest_digest.slice(0, 16)}`);
    const backup = path.join(path.dirname(target), `.archie-backup-${manifest.manifest_digest.slice(0, 16)}`);
    if (!resume) await fs.rm(stage, { recursive: true, force: true });
    await fs.mkdir(stage, { recursive: true, mode: 0o700 });
    let restored = 0;
    let reused = 0;
    for (const entry of manifest.entries) {
      if (entry.kind !== 'text' || !entry.retained) continue;
      const destination = safeJoin(stage, entry.path);
      if (resume && await exists(destination)) {
        const current = await fs.readFile(destination);
        if (digest(current) === entry.content_sha256) {
          reused += 1;
          continue;
        }
      }
      const pieces = [];
      for (const chunk of entry.chunks) {
        const stored = await fs.readFile(chunkPath(pack, chunk.stored_sha256));
        if (digest(stored) !== chunk.stored_sha256) throw new Error(`Archie pack chunk integrity check failed: ${chunk.stored_sha256}.`);
        let plain = stored;
        if (chunk.encrypted) {
          const opened = await this.encryption.open({ bytes: Buffer.from(stored), aad: `${entry.path}:${chunk.index}:${chunk.plain_sha256}`, metadata: chunk.seal_metadata });
          plain = Buffer.from(opened?.bytes || opened);
        }
        if (digest(plain) !== chunk.plain_sha256) throw new Error(`Archie pack plaintext integrity check failed: ${entry.path} chunk ${chunk.index}.`);
        pieces.push(plain);
      }
      const content = Buffer.concat(pieces);
      if (digest(content) !== entry.content_sha256 || content.length !== entry.bytes) throw new Error(`Archie pack file integrity check failed: ${entry.path}.`);
      await writeAtomic(destination, content);
      restored += 1;
    }
    await fs.rm(backup, { recursive: true, force: true });
    let movedExisting = false;
    try {
      if (await exists(target)) {
        await fs.rename(target, backup);
        movedExisting = true;
      }
      await fs.rename(stage, target);
      await fs.rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (movedExisting && !(await exists(target)) && await exists(backup)) await fs.rename(backup, target).catch(() => {});
      throw error;
    }
    const receiptBody = {
      schema: RECEIPT_SCHEMA,
      operation: 'import',
      pack_id: manifest.pack_id,
      manifest_digest: manifest.manifest_digest,
      restored_files: restored,
      resumed_files: reused,
      metadata_references: manifest.totals.metadata_references,
      encryption: manifest.encryption.state,
      completed_at: new Date(typeof this.clock === 'function' ? this.clock() : this.clock).toISOString()
    };
    return Object.freeze({ ...receiptBody, receipt_digest: digest(receiptBody) });
  }
}

export function createArchiePortablePack(options) {
  return new ArchiePortablePack(options);
}
