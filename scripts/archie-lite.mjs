#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DEFAULT_KV_BYTES_PER_TOKEN = 256 * 1024;
const GGUF_VALUE = Object.freeze({
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12
});
const FIXED_WIDTH = new Map([
  [GGUF_VALUE.UINT8, 1],
  [GGUF_VALUE.INT8, 1],
  [GGUF_VALUE.UINT16, 2],
  [GGUF_VALUE.INT16, 2],
  [GGUF_VALUE.UINT32, 4],
  [GGUF_VALUE.INT32, 4],
  [GGUF_VALUE.FLOAT32, 4],
  [GGUF_VALUE.BOOL, 1],
  [GGUF_VALUE.UINT64, 8],
  [GGUF_VALUE.INT64, 8],
  [GGUF_VALUE.FLOAT64, 8]
]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clean(value, limit = 500000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals > 2) {
      const name = token.slice(0, equals);
      const value = token.slice(equals + 1);
      flags.set(name, [...(flags.get(name) || []), value]);
      continue;
    }
    const next = argv[index + 1];
    const value = next !== undefined && !next.startsWith('--') ? argv[++index] : '1';
    flags.set(token, [...(flags.get(token) || []), value]);
  }
  return { positionals, flags };
}

function last(flags, name, fallback = '') {
  return flags.get(name)?.at(-1) ?? fallback;
}

function has(flags, name) {
  return flags.has(name);
}

function numericFlag(flags, name, fallback) {
  const value = Number(last(flags, name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

async function findExecutable(command, env = process.env) {
  const value = clean(command, 2000);
  if (!value) return '';
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    try {
      return (await fs.stat(path.resolve(value))).isFile() ? path.resolve(value) : '';
    } catch {
      return '';
    }
  }
  for (const directory of clean(env.PATH || '', 100000).split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, value);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return '';
}

class FileCursor {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
    this.offset = 0;
  }

  async bytes(length) {
    const amount = Number(length);
    if (!Number.isSafeInteger(amount) || amount < 0 || this.offset + amount > this.size) {
      throw new Error('Invalid or truncated GGUF file.');
    }
    const buffer = Buffer.allocUnsafe(amount);
    let read = 0;
    while (read < amount) {
      const result = await this.handle.read(buffer, read, amount - read, this.offset + read);
      if (!result.bytesRead) throw new Error('Unexpected end of GGUF file.');
      read += result.bytesRead;
    }
    this.offset += amount;
    return buffer;
  }

  skip(length) {
    const amount = Number(length);
    if (!Number.isSafeInteger(amount) || amount < 0 || this.offset + amount > this.size) {
      throw new Error('Invalid or truncated GGUF file.');
    }
    this.offset += amount;
  }

  async u8() { return (await this.bytes(1)).readUInt8(0); }
  async i8() { return (await this.bytes(1)).readInt8(0); }
  async u16() { return (await this.bytes(2)).readUInt16LE(0); }
  async i16() { return (await this.bytes(2)).readInt16LE(0); }
  async u32() { return (await this.bytes(4)).readUInt32LE(0); }
  async i32() { return (await this.bytes(4)).readInt32LE(0); }
  async f32() { return (await this.bytes(4)).readFloatLE(0); }
  async f64() { return (await this.bytes(8)).readDoubleLE(0); }

  async u64() {
    const value = (await this.bytes(8)).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GGUF integer exceeds JavaScript safe range.');
    return Number(value);
  }

  async i64() {
    const value = (await this.bytes(8)).readBigInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error('GGUF integer exceeds JavaScript safe range.');
    }
    return Number(value);
  }

  async string({ capture = true, maximum = 1024 * 1024 } = {}) {
    const length = await this.u64();
    if (!capture) {
      this.skip(length);
      return null;
    }
    if (length > maximum) throw new Error('GGUF string exceeds the inspection limit.');
    return (await this.bytes(length)).toString('utf8');
  }
}

async function readScalar(cursor, type) {
  if (type === GGUF_VALUE.UINT8) return cursor.u8();
  if (type === GGUF_VALUE.INT8) return cursor.i8();
  if (type === GGUF_VALUE.UINT16) return cursor.u16();
  if (type === GGUF_VALUE.INT16) return cursor.i16();
  if (type === GGUF_VALUE.UINT32) return cursor.u32();
  if (type === GGUF_VALUE.INT32) return cursor.i32();
  if (type === GGUF_VALUE.FLOAT32) return cursor.f32();
  if (type === GGUF_VALUE.BOOL) return Boolean(await cursor.u8());
  if (type === GGUF_VALUE.STRING) return cursor.string({ capture: true, maximum: 1024 * 1024 });
  if (type === GGUF_VALUE.UINT64) return cursor.u64();
  if (type === GGUF_VALUE.INT64) return cursor.i64();
  if (type === GGUF_VALUE.FLOAT64) return cursor.f64();
  throw new Error(`Unsupported GGUF scalar metadata type: ${type}.`);
}

async function skipValue(cursor, type) {
  if (FIXED_WIDTH.has(type)) {
    cursor.skip(FIXED_WIDTH.get(type));
    return;
  }
  if (type === GGUF_VALUE.STRING) {
    await cursor.string({ capture: false });
    return;
  }
  if (type === GGUF_VALUE.ARRAY) {
    const elementType = await cursor.u32();
    const count = await cursor.u64();
    if (count > 10_000_000) throw new Error('GGUF metadata array is unreasonably large.');
    for (let index = 0; index < count; index += 1) await skipValue(cursor, elementType);
    return;
  }
  throw new Error(`Unsupported GGUF metadata type: ${type}.`);
}

function wantedMetadataKey(key) {
  return key === 'general.architecture'
    || key === 'general.name'
    || key === 'general.file_type'
    || /\.(block_count|embedding_length|attention\.head_count|attention\.head_count_kv|attention\.key_length|attention\.value_length)$/.test(key);
}

function hasPlanningMetadata(metadata) {
  const architecture = clean(metadata['general.architecture'], 100);
  return Boolean(architecture
    && metadata[`${architecture}.block_count`] !== undefined
    && metadata[`${architecture}.embedding_length`] !== undefined
    && metadata[`${architecture}.attention.head_count`] !== undefined
    && metadata[`${architecture}.attention.head_count_kv`] !== undefined);
}

export async function inspectGGUF(filename) {
  const absolute = path.resolve(filename);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error('GGUF model path must be a file.');
  const handle = await fs.open(absolute, 'r');
  try {
    const cursor = new FileCursor(handle, stat.size);
    const magic = (await cursor.bytes(4)).toString('ascii');
    if (magic !== 'GGUF') throw new Error('Model is not a GGUF file.');
    const version = await cursor.u32();
    if (version < 2 || version > 3) throw new Error(`Unsupported GGUF version: ${version}.`);
    const tensorCount = await cursor.u64();
    const metadataCount = await cursor.u64();
    if (metadataCount > 1_000_000) throw new Error('GGUF metadata count is unreasonably large.');
    const metadata = {};
    for (let index = 0; index < metadataCount; index += 1) {
      const key = await cursor.string({ capture: true, maximum: 64 * 1024 });
      const type = await cursor.u32();
      if (wantedMetadataKey(key) && type !== GGUF_VALUE.ARRAY) metadata[key] = await readScalar(cursor, type);
      else await skipValue(cursor, type);
      if (hasPlanningMetadata(metadata)) break;
    }
    return Object.freeze({
      schema: 'archie-gguf-inspection/v1',
      path: absolute,
      bytes: stat.size,
      version,
      tensor_count: tensorCount,
      metadata_count: metadataCount,
      metadata: Object.freeze(metadata)
    });
  } finally {
    await handle.close();
  }
}

function positiveNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function estimateKVBytesPerToken(metadata = {}) {
  const architecture = clean(metadata['general.architecture'], 100);
  const blocks = positiveNumber(metadata[`${architecture}.block_count`]);
  const embedding = positiveNumber(metadata[`${architecture}.embedding_length`]);
  const heads = positiveNumber(metadata[`${architecture}.attention.head_count`]);
  const kvHeads = positiveNumber(metadata[`${architecture}.attention.head_count_kv`], heads);
  const defaultHeadLength = heads ? embedding / heads : 0;
  const keyLength = positiveNumber(metadata[`${architecture}.attention.key_length`], defaultHeadLength);
  const valueLength = positiveNumber(metadata[`${architecture}.attention.value_length`], defaultHeadLength);
  if (!blocks || !kvHeads || !keyLength || !valueLength) return DEFAULT_KV_BYTES_PER_TOKEN;
  return Math.max(1, Math.ceil(blocks * kvHeads * (keyLength + valueLength) * 2));
}

export function planLiteInference({
  metadata = {},
  model_bytes,
  total_memory_bytes = os.totalmem(),
  logical_cpu_count = os.cpus().length,
  memory_fraction = 0.72,
  requested_context = null,
  force_context = false,
  maximum_context = 16384
} = {}) {
  const totalMemory = Math.max(GIB, positiveNumber(total_memory_bytes, os.totalmem()));
  const modelBytes = Math.max(1, positiveNumber(model_bytes));
  const fraction = clamp(positiveNumber(memory_fraction, 0.72), 0.45, 0.85);
  const reserveBytes = Math.max(GIB, Math.min(4 * GIB, Math.floor(totalMemory * 0.18)));
  const runtimeOverheadBytes = 512 * MIB;
  const modelWorkingSetBytes = Math.ceil(modelBytes * 1.08);
  const memoryBudgetBytes = Math.floor(totalMemory * fraction);
  const kvBytesPerToken = estimateKVBytesPerToken(metadata);
  const availableForKvBytes = Math.max(0, memoryBudgetBytes - reserveBytes - runtimeOverheadBytes - modelWorkingSetBytes);
  const safeContext = Math.floor(availableForKvBytes / kvBytesPerToken);
  const maxContext = Math.max(512, Math.min(131072, Math.trunc(positiveNumber(maximum_context, 16384))));
  const maxSafeContext = clamp(safeContext, 512, maxContext);
  const requested = requested_context === null || requested_context === undefined
    ? null
    : Math.max(128, Math.trunc(positiveNumber(requested_context, 512)));
  const context = requested === null
    ? maxSafeContext
    : force_context ? Math.min(requested, 131072) : Math.min(requested, maxSafeContext);
  const logicalCpus = Math.max(1, Math.trunc(positiveNumber(logical_cpu_count, 1)));
  const threads = Math.max(1, Math.min(logicalCpus, Math.floor(logicalCpus * 0.75) || 1));
  const batch = context >= 8192 ? 128 : context >= 4096 ? 64 : 32;
  const estimatedPeakBytes = modelWorkingSetBytes + runtimeOverheadBytes + reserveBytes + context * kvBytesPerToken;
  return Object.freeze({
    schema: 'archie-lite-inference-plan/v1',
    backend: 'llama.cpp-cpu',
    gpu_layers: 0,
    total_memory_bytes: totalMemory,
    memory_fraction: fraction,
    memory_budget_bytes: memoryBudgetBytes,
    reserved_system_bytes: reserveBytes,
    runtime_overhead_bytes: runtimeOverheadBytes,
    model_bytes: modelBytes,
    model_working_set_bytes: modelWorkingSetBytes,
    kv_bytes_per_token: kvBytesPerToken,
    available_for_kv_bytes: availableForKvBytes,
    maximum_safe_context: maxSafeContext,
    requested_context: requested,
    context,
    context_forced: Boolean(force_context && requested !== null && requested > maxSafeContext),
    fits_minimum_context: safeContext >= 512,
    logical_cpu_count: logicalCpus,
    threads,
    batch,
    estimated_peak_bytes: estimatedPeakBytes,
    claim_boundary: 'This is a conservative RAM and KV-cache plan for CPU inference. It does not prove response quality or exact peak memory on every llama.cpp build.'
  });
}

export function buildLlamaLiteArgs({ model, prompt, plan, max_tokens = 256, temperature = 0, seed = 0 } = {}) {
  if (!model) throw new Error('A GGUF model path is required.');
  if (!clean(prompt)) throw new Error('A non-empty prompt is required.');
  if (!plan || plan.schema !== 'archie-lite-inference-plan/v1') throw new Error('An Archie lite inference plan is required.');
  return [
    '-m', path.resolve(model),
    '-p', String(prompt),
    '-n', String(Math.max(1, Math.trunc(positiveNumber(max_tokens, 256)))),
    '-c', String(plan.context),
    '-t', String(plan.threads),
    '-b', String(plan.batch),
    '-ngl', '0',
    '--temp', String(Math.max(0, Number(temperature) || 0)),
    '--seed', String(Math.trunc(Number(seed) || 0)),
    '--no-display-prompt'
  ];
}

function printJSON(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return `Archie Lite: bounded CPU inference for quantized GGUF models

Usage:
  archie-lite doctor [--runner llama-cli]
  archie-lite inspect --model <model.gguf> [--memory-fraction 0.72]
  archie-lite run --model <model.gguf> --prompt <text> [--runner llama-cli]
                  [--context <n>] [--force-context] [--max-tokens 256]
                  [--memory-fraction 0.72] [--dry-run]

Archie Lite forces -ngl 0 and computes a conservative context limit from model size,
GGUF attention metadata, machine RAM, and KV-cache bytes per token.`;
}

export async function runArchieLiteCommand({
  positionals = [],
  flags = new Map(),
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  total_memory_bytes = os.totalmem(),
  logical_cpu_count = os.cpus().length
} = {}) {
  const offset = positionals[0] === 'lite' ? 1 : 0;
  const action = positionals[offset] || (has(flags, '--help') ? 'help' : 'doctor');
  if (action === 'help') {
    stdout.write(`${usage()}\n`);
    return null;
  }
  const runner = last(flags, '--runner', env.ARCHIE_RUNNER || 'llama-cli');
  const runnerPath = await findExecutable(runner, env);
  if (action === 'doctor') {
    const result = Object.freeze({
      schema: 'archie-lite-doctor/v1',
      platform: process.platform,
      architecture: process.arch,
      total_memory_bytes,
      logical_cpu_count,
      runner,
      runner_path: runnerPath || null,
      ready: Boolean(runnerPath),
      next_command: 'archie-lite inspect --model /path/to/model.gguf'
    });
    printJSON(result, stdout);
    return result;
  }
  const model = path.resolve(last(flags, '--model', positionals[offset + 1] || ''));
  if (!last(flags, '--model', positionals[offset + 1] || '')) throw new Error('Pass --model <model.gguf>.');
  const inspection = await inspectGGUF(model);
  const plan = planLiteInference({
    metadata: inspection.metadata,
    model_bytes: inspection.bytes,
    total_memory_bytes,
    logical_cpu_count,
    memory_fraction: numericFlag(flags, '--memory-fraction', 0.72),
    requested_context: has(flags, '--context') ? numericFlag(flags, '--context', 512) : null,
    force_context: has(flags, '--force-context'),
    maximum_context: numericFlag(flags, '--maximum-context', 16384)
  });
  if (action === 'inspect') {
    const result = Object.freeze({ schema: 'archie-lite-inspection-result/v1', inspection, plan });
    printJSON(result, stdout);
    return result;
  }
  if (action !== 'run') throw new Error(`Unknown Archie Lite command: ${action}.`);
  let prompt = last(flags, '--prompt');
  const promptFile = last(flags, '--prompt-file');
  if (promptFile) prompt = await fs.readFile(path.resolve(promptFile), 'utf8');
  const args = buildLlamaLiteArgs({
    model,
    prompt,
    plan,
    max_tokens: numericFlag(flags, '--max-tokens', 256),
    temperature: numericFlag(flags, '--temperature', 0),
    seed: numericFlag(flags, '--seed', 0)
  });
  const command = runnerPath || runner;
  const receipt = Object.freeze({
    schema: 'archie-lite-run-receipt/v1',
    state: has(flags, '--dry-run') ? 'planned' : 'running',
    command,
    args,
    inspection,
    plan,
    claim_boundary: 'CPU execution and bounded memory planning do not establish model capability, safety, or correctness.'
  });
  if (has(flags, '--dry-run')) {
    printJSON(receipt, stdout);
    return receipt;
  }
  if (!runnerPath) throw new Error(`Local runner not found: ${runner}. Run archie-lite doctor or pass --runner.`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(runnerPath, args, { stdio: 'inherit', env, windowsHide: true });
    child.once('error', reject);
    child.once('close', value => resolve(value ?? 1));
  });
  const completed = Object.freeze({ ...receipt, state: code === 0 ? 'completed' : 'failed', exit_code: code });
  stderr.write(`${JSON.stringify(completed)}\n`);
  if (code !== 0) {
    const error = new Error(`llama.cpp exited with code ${code}.`);
    error.code = code;
    throw error;
  }
  return completed;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  return runArchieLiteCommand(parsed);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-lite: ${error?.stack || error}\n`);
    process.exitCode = Number.isInteger(error?.code) ? error.code : 1;
  });
}
