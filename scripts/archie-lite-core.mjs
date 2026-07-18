import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadInstalledModel,
  resolveArchieHome,
  runModel,
  sha256
} from './archie-runtime-core.mjs';

export const ARCHIE_LITE_PLAN_SCHEMA = 'archie-lite-plan/v1';
export const ARCHIE_LITE_RUN_RECEIPT_SCHEMA = 'archie-lite-run-receipt/v1';
export const ARCHIE_GGUF_METADATA_SCHEMA = 'archie-gguf-metadata/v1';

const MIB = 1024 ** 2;
const MAX_STRING_BYTES = 16 * MIB;
const MAX_ARRAY_ITEMS = 50_000_000;
const GGUF_TYPES = Object.freeze({
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

function safeInteger(value, field, { minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${field} must be a safe integer >= ${minimum}.`);
  }
  return number;
}

function finiteNumber(value, field, { minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${field} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return number;
}

function bigintToSafeNumber(value, field) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field} exceeds the safe integer range.`);
  return Number(value);
}

class FileCursor {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
    this.offset = 0;
  }

  async read(length, field = 'GGUF field') {
    const bytes = safeInteger(length, `${field} byte length`);
    if (this.offset + bytes > this.size) throw new Error(`${field} extends past the end of the GGUF artifact.`);
    const buffer = Buffer.allocUnsafe(bytes);
    let consumed = 0;
    while (consumed < bytes) {
      const { bytesRead } = await this.handle.read(buffer, consumed, bytes - consumed, this.offset + consumed);
      if (!bytesRead) throw new Error(`Unexpected end of file while reading ${field}.`);
      consumed += bytesRead;
    }
    this.offset += bytes;
    return buffer;
  }

  skip(length, field = 'GGUF field') {
    const bytes = safeInteger(length, `${field} byte length`);
    if (this.offset + bytes > this.size) throw new Error(`${field} extends past the end of the GGUF artifact.`);
    this.offset += bytes;
  }

  async uint8(field) { return (await this.read(1, field)).readUInt8(0); }
  async int8(field) { return (await this.read(1, field)).readInt8(0); }
  async uint16(field) { return (await this.read(2, field)).readUInt16LE(0); }
  async int16(field) { return (await this.read(2, field)).readInt16LE(0); }
  async uint32(field) { return (await this.read(4, field)).readUInt32LE(0); }
  async int32(field) { return (await this.read(4, field)).readInt32LE(0); }
  async float32(field) { return (await this.read(4, field)).readFloatLE(0); }
  async uint64(field) { return (await this.read(8, field)).readBigUInt64LE(0); }
  async int64(field) { return (await this.read(8, field)).readBigInt64LE(0); }
  async float64(field) { return (await this.read(8, field)).readDoubleLE(0); }

  async string(field, maximum = MAX_STRING_BYTES) {
    const length = bigintToSafeNumber(await this.uint64(`${field} length`), `${field} length`);
    if (length > maximum) throw new Error(`${field} exceeds the ${maximum}-byte parser limit.`);
    return (await this.read(length, field)).toString('utf8');
  }
}

function fixedWidth(type) {
  switch (type) {
    case GGUF_TYPES.UINT8:
    case GGUF_TYPES.INT8:
    case GGUF_TYPES.BOOL:
      return 1;
    case GGUF_TYPES.UINT16:
    case GGUF_TYPES.INT16:
      return 2;
    case GGUF_TYPES.UINT32:
    case GGUF_TYPES.INT32:
    case GGUF_TYPES.FLOAT32:
      return 4;
    case GGUF_TYPES.UINT64:
    case GGUF_TYPES.INT64:
    case GGUF_TYPES.FLOAT64:
      return 8;
    default:
      return 0;
  }
}

async function readScalar(cursor, type, field) {
  switch (type) {
    case GGUF_TYPES.UINT8: return cursor.uint8(field);
    case GGUF_TYPES.INT8: return cursor.int8(field);
    case GGUF_TYPES.UINT16: return cursor.uint16(field);
    case GGUF_TYPES.INT16: return cursor.int16(field);
    case GGUF_TYPES.UINT32: return cursor.uint32(field);
    case GGUF_TYPES.INT32: return cursor.int32(field);
    case GGUF_TYPES.FLOAT32: return cursor.float32(field);
    case GGUF_TYPES.BOOL: return Boolean(await cursor.uint8(field));
    case GGUF_TYPES.STRING: return cursor.string(field);
    case GGUF_TYPES.UINT64: return bigintToSafeNumber(await cursor.uint64(field), field);
    case GGUF_TYPES.INT64: {
      const value = await cursor.int64(field);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new Error(`${field} exceeds the safe integer range.`);
      }
      return Number(value);
    }
    case GGUF_TYPES.FLOAT64: return cursor.float64(field);
    default: throw new Error(`Unsupported GGUF metadata type ${type} for ${field}.`);
  }
}

async function skipValue(cursor, type, field, depth = 0) {
  const width = fixedWidth(type);
  if (width) {
    cursor.skip(width, field);
    return;
  }
  if (type === GGUF_TYPES.STRING) {
    const length = bigintToSafeNumber(await cursor.uint64(`${field} length`), `${field} length`);
    cursor.skip(length, field);
    return;
  }
  if (type !== GGUF_TYPES.ARRAY) throw new Error(`Unsupported GGUF metadata type ${type} for ${field}.`);
  if (depth >= 2) throw new Error(`Nested GGUF metadata array depth is unsupported for ${field}.`);
  const elementType = await cursor.uint32(`${field} element type`);
  const count = bigintToSafeNumber(await cursor.uint64(`${field} item count`), `${field} item count`);
  if (count > MAX_ARRAY_ITEMS) throw new Error(`${field} exceeds the ${MAX_ARRAY_ITEMS}-item parser limit.`);
  const elementWidth = fixedWidth(elementType);
  if (elementWidth) {
    cursor.skip(safeInteger(elementWidth * count, `${field} byte length`), field);
    return;
  }
  for (let index = 0; index < count; index += 1) {
    await skipValue(cursor, elementType, `${field}[${index}]`, depth + 1);
  }
}

function captureMetadataKey(key) {
  return key === 'general.architecture' || [
    '.context_length',
    '.block_count',
    '.embedding_length',
    '.attention.head_count',
    '.attention.head_count_kv',
    '.attention.key_length',
    '.attention.value_length'
  ].some(suffix => key.endsWith(suffix));
}

function requiredMetadataKeys(architecture) {
  return [
    `${architecture}.context_length`,
    `${architecture}.block_count`,
    `${architecture}.embedding_length`,
    `${architecture}.attention.head_count`
  ];
}

function numericMetadata(metadata, key, { minimum = 1 } = {}) {
  const value = metadata.get(key);
  if (value === undefined) throw new Error(`GGUF metadata is missing ${key}.`);
  return safeInteger(value, `GGUF ${key}`, { minimum });
}

export async function inspectGGUFMetadata(filename) {
  const artifact = path.resolve(filename);
  const handle = await fs.open(artifact, 'r');
  try {
    const stat = await handle.stat();
    const cursor = new FileCursor(handle, stat.size);
    const magic = (await cursor.read(4, 'GGUF magic')).toString('ascii');
    if (magic !== 'GGUF') throw new Error('Artifact is not a GGUF file: magic mismatch.');
    const version = await cursor.uint32('GGUF version');
    if (![2, 3].includes(version)) throw new Error(`Unsupported GGUF version ${version}; expected version 2 or 3.`);
    const tensorCount = bigintToSafeNumber(await cursor.uint64('GGUF tensor count'), 'GGUF tensor count');
    const metadataCount = bigintToSafeNumber(await cursor.uint64('GGUF metadata count'), 'GGUF metadata count');
    const metadata = new Map();
    let parsedMetadataCount = 0;
    let stoppedBeforeTokenizer = false;

    for (let index = 0; index < metadataCount; index += 1) {
      const key = await cursor.string(`GGUF metadata key ${index}`, 4096);
      const type = await cursor.uint32(`GGUF metadata type ${key}`);
      const architecture = metadata.get('general.architecture');
      const hasRequired = architecture && requiredMetadataKeys(architecture).every(name => metadata.has(name));
      if (hasRequired && key.startsWith('tokenizer.')) {
        stoppedBeforeTokenizer = true;
        break;
      }
      if (captureMetadataKey(key)) metadata.set(key, await readScalar(cursor, type, key));
      else await skipValue(cursor, type, key);
      parsedMetadataCount += 1;
    }

    const architecture = String(metadata.get('general.architecture') || '').trim();
    if (!architecture) throw new Error('GGUF metadata is missing general.architecture.');
    const contextLength = numericMetadata(metadata, `${architecture}.context_length`);
    const blockCount = numericMetadata(metadata, `${architecture}.block_count`);
    const embeddingLength = numericMetadata(metadata, `${architecture}.embedding_length`);
    const headCount = numericMetadata(metadata, `${architecture}.attention.head_count`);
    const headCountKv = metadata.has(`${architecture}.attention.head_count_kv`)
      ? numericMetadata(metadata, `${architecture}.attention.head_count_kv`)
      : headCount;
    const defaultHeadLength = embeddingLength / headCount;
    if (!Number.isFinite(defaultHeadLength) || defaultHeadLength <= 0) throw new Error('GGUF embedding/head metadata cannot produce a valid attention head length.');
    const keyLength = metadata.has(`${architecture}.attention.key_length`)
      ? numericMetadata(metadata, `${architecture}.attention.key_length`)
      : defaultHeadLength;
    const valueLength = metadata.has(`${architecture}.attention.value_length`)
      ? numericMetadata(metadata, `${architecture}.attention.value_length`)
      : defaultHeadLength;

    return Object.freeze({
      schema: ARCHIE_GGUF_METADATA_SCHEMA,
      version,
      tensor_count: tensorCount,
      metadata_kv_count: metadataCount,
      parsed_metadata_count: parsedMetadataCount,
      stopped_before_tokenizer: stoppedBeforeTokenizer,
      architecture,
      context_length: contextLength,
      block_count: blockCount,
      embedding_length: embeddingLength,
      attention: Object.freeze({
        head_count: headCount,
        head_count_kv: headCountKv,
        key_length: keyLength,
        value_length: valueLength
      })
    });
  } finally {
    await handle.close();
  }
}

export function calculateKVCacheCost(metadata, {
  kv_element_bytes = 2,
  safety_factor = 1.10
} = {}) {
  if (!metadata || metadata.schema !== ARCHIE_GGUF_METADATA_SCHEMA) throw new Error('A parsed Archie GGUF metadata record is required.');
  const elementBytes = safeInteger(kv_element_bytes, 'kv_element_bytes', { minimum: 1 });
  if (![1, 2, 4, 8].includes(elementBytes)) throw new Error('kv_element_bytes must be one of 1, 2, 4, or 8.');
  const safety = finiteNumber(safety_factor, 'safety_factor', { minimum: 1, maximum: 4 });
  const raw = Math.ceil(
    metadata.block_count
      * metadata.attention.head_count_kv
      * (metadata.attention.key_length + metadata.attention.value_length)
      * elementBytes
  );
  const budgeted = Math.ceil(raw * safety);
  return Object.freeze({
    kv_element_bytes: elementBytes,
    safety_factor: safety,
    raw_bytes_per_token: safeInteger(raw, 'raw KV bytes per token', { minimum: 1 }),
    budgeted_bytes_per_token: safeInteger(budgeted, 'budgeted KV bytes per token', { minimum: 1 })
  });
}

export function calculateLiteContext({
  model_bytes,
  manifest_context_limit,
  gguf_context_limit,
  requested_context,
  kv_cache,
  total_ram_bytes = os.totalmem(),
  free_ram_bytes = os.freemem(),
  reserve_ratio = 0.25,
  reserve_bytes = 0,
  runtime_overhead_bytes,
  free_ram_utilization = 0.90,
  minimum_context = 256
}) {
  const modelBytes = safeInteger(model_bytes, 'model_bytes', { minimum: 1 });
  const manifestLimit = safeInteger(manifest_context_limit, 'manifest_context_limit', { minimum: 1 });
  const ggufLimit = safeInteger(gguf_context_limit, 'gguf_context_limit', { minimum: 1 });
  const requested = requested_context === undefined || requested_context === null
    ? Math.min(manifestLimit, ggufLimit)
    : safeInteger(requested_context, 'requested_context', { minimum: 1 });
  const minimum = safeInteger(minimum_context, 'minimum_context', { minimum: 1 });
  const totalRam = safeInteger(total_ram_bytes, 'total_ram_bytes', { minimum: 1 });
  const freeRam = Math.min(totalRam, safeInteger(free_ram_bytes, 'free_ram_bytes', { minimum: 0 }));
  const ratio = finiteNumber(reserve_ratio, 'reserve_ratio', { minimum: 0, maximum: 0.80 });
  const utilization = finiteNumber(free_ram_utilization, 'free_ram_utilization', { minimum: 0.10, maximum: 1 });
  const explicitReserve = safeInteger(reserve_bytes, 'reserve_bytes', { minimum: 0 });
  const reserve = Math.max(explicitReserve, Math.floor(totalRam * ratio), 512 * MIB);
  const runtimeOverhead = runtime_overhead_bytes === undefined || runtime_overhead_bytes === null
    ? Math.max(256 * MIB, Math.ceil(modelBytes * 0.08))
    : safeInteger(runtime_overhead_bytes, 'runtime_overhead_bytes', { minimum: 0 });
  const totalCapacity = Math.max(0, totalRam - reserve);
  const liveCapacity = Math.max(0, Math.floor(freeRam * utilization));
  const residentCapacity = Math.min(totalCapacity, liveCapacity);
  const kvBudget = Math.max(0, residentCapacity - modelBytes - runtimeOverhead);
  const kvBytesPerToken = safeInteger(kv_cache?.budgeted_bytes_per_token, 'kv_cache.budgeted_bytes_per_token', { minimum: 1 });
  const ramContextLimit = Math.floor(kvBudget / kvBytesPerToken);
  const declaredLimit = Math.min(requested, manifestLimit, ggufLimit);
  const selected = Math.min(declaredLimit, ramContextLimit);
  const requiredForRequested = reserve + modelBytes + runtimeOverhead + declaredLimit * kvBytesPerToken;

  if (selected < minimum) {
    const error = new Error(`ARCHIE_LITE_RAM_INSUFFICIENT: available RAM supports context ${selected}, below minimum ${minimum}.`);
    error.code = 'ARCHIE_LITE_RAM_INSUFFICIENT';
    error.details = Object.freeze({
      selected_context: selected,
      minimum_context: minimum,
      ram_context_limit: ramContextLimit,
      total_ram_bytes: totalRam,
      free_ram_bytes: freeRam,
      model_bytes: modelBytes,
      runtime_overhead_bytes: runtimeOverhead,
      reserve_bytes: reserve,
      kv_budget_bytes: kvBudget,
      required_ram_bytes_for_declared_context: requiredForRequested
    });
    throw error;
  }

  const cappedBy = [];
  if (selected === ramContextLimit && ramContextLimit < declaredLimit) cappedBy.push('ram');
  if (selected === manifestLimit && manifestLimit <= requested && manifestLimit <= ggufLimit) cappedBy.push('manifest');
  if (selected === ggufLimit && ggufLimit <= requested && ggufLimit <= manifestLimit) cappedBy.push('gguf');
  if (selected === requested && requested <= manifestLimit && requested <= ggufLimit) cappedBy.push('requested');

  return Object.freeze({
    requested_context: requested,
    selected_context: selected,
    minimum_context: minimum,
    manifest_context_limit: manifestLimit,
    gguf_context_limit: ggufLimit,
    ram_context_limit: ramContextLimit,
    capped_by: Object.freeze(cappedBy),
    memory: Object.freeze({
      total_ram_bytes: totalRam,
      free_ram_bytes: freeRam,
      reserve_bytes: reserve,
      free_ram_utilization: utilization,
      resident_capacity_bytes: residentCapacity,
      model_bytes: modelBytes,
      runtime_overhead_bytes: runtimeOverhead,
      kv_budget_bytes: kvBudget,
      estimated_peak_bytes: modelBytes + runtimeOverhead + selected * kvBytesPerToken,
      required_ram_bytes_for_declared_context: requiredForRequested
    })
  });
}

const GPU_ARGUMENTS = Object.freeze(new Set([
  '--gpu-layers', '-ngl', '--n-gpu-layers',
  '--device', '-dev',
  '--split-mode', '-sm',
  '--tensor-split', '-ts',
  '--main-gpu', '-mg',
  '--rpc', '--rpc-server',
  '--kv-offload', '-kvo', '--no-kv-offload',
  '--op-offload', '--no-op-offload',
  '--mmproj-offload', '--no-mmproj-offload',
  '--fit', '-fit', '--fit-target', '-fitt', '--fit-ctx', '-fitc',
  '--override-tensor', '-ot'
]));

export function buildCpuExecutionOptions(manifestArguments = [], env = process.env) {
  const argumentsList = Array.isArray(manifestArguments) ? manifestArguments.map(value => String(value)) : [];
  for (const argument of argumentsList) {
    const name = argument.split('=', 1)[0];
    if (GPU_ARGUMENTS.has(name)) throw new Error(`Archie lite rejects manifest GPU override ${name}; CPU authority must be singular.`);
  }
  return Object.freeze({
    runner_prefix_args: Object.freeze([
      '--device', 'none',
      '--gpu-layers', '0',
      '--no-kv-offload',
      '--no-op-offload',
      '--no-mmproj-offload',
      '--fit', 'off'
    ]),
    env: Object.freeze({
      ...env,
      CUDA_VISIBLE_DEVICES: '',
      HIP_VISIBLE_DEVICES: '',
      ROCR_VISIBLE_DEVICES: '',
      ZE_AFFINITY_MASK: '',
      GGML_VK_VISIBLE_DEVICES: '',
      LLAMA_ARG_DEVICE: 'none',
      LLAMA_ARG_N_GPU_LAYERS: '0',
      LLAMA_ARG_KV_OFFLOAD: '0',
      LLAMA_ARG_MMPROJ_OFFLOAD: '0',
      LLAMA_ARG_FIT: 'off'
    }),
    enforcement: Object.freeze({
      backend: 'cpu',
      llama_cpp_device: 'none',
      llama_cpp_gpu_layers: 0,
      llama_cpp_kv_offload: false,
      llama_cpp_op_offload: false,
      llama_cpp_mmproj_offload: false,
      llama_cpp_fit: false,
      hidden_accelerator_environments: Object.freeze([
        'CUDA_VISIBLE_DEVICES',
        'HIP_VISIBLE_DEVICES',
        'ROCR_VISIBLE_DEVICES',
        'ZE_AFFINITY_MASK',
        'GGML_VK_VISIBLE_DEVICES'
      ])
    })
  });
}

function makeReceipt(schema, payload, clock = Date.now) {
  const observed_at = new Date(typeof clock === 'function' ? clock() : clock).toISOString();
  const body = { schema, observed_at, payload };
  return Object.freeze({ ...body, receipt_digest: sha256(body) });
}

async function writeJSONAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

async function recordReceipt(home, category, receipt) {
  const filename = path.join(home, 'receipts', category, `${receipt.receipt_digest}.json`);
  await writeJSONAtomic(filename, receipt);
  return filename;
}

async function prepareLiteModel(reference, {
  home = resolveArchieHome(),
  requested_context,
  kv_element_bytes = 2,
  kv_safety_factor = 1.10,
  reserve_ratio = 0.25,
  reserve_bytes = 0,
  runtime_overhead_bytes,
  free_ram_utilization = 0.90,
  minimum_context = 256,
  total_ram_bytes = os.totalmem(),
  free_ram_bytes = os.freemem(),
  env = process.env,
  clock = Date.now,
  record = true
} = {}) {
  const installed = await loadInstalledModel(reference, { home });
  if (String(installed.manifest.model.format).toLowerCase() !== 'gguf') throw new Error('Archie lite requires an installed GGUF artifact.');
  if (!installed.manifest.hardware.backends.map(value => String(value).toLowerCase()).includes('cpu')) {
    throw new Error('Archie lite requires the manifest to admit the CPU backend.');
  }
  const stat = await fs.stat(installed.artifact_path);
  const gguf = await inspectGGUFMetadata(installed.artifact_path);
  const kvCache = calculateKVCacheCost(gguf, { kv_element_bytes, safety_factor: kv_safety_factor });
  const context = calculateLiteContext({
    model_bytes: stat.size,
    manifest_context_limit: installed.manifest.model.context_limit,
    gguf_context_limit: gguf.context_length,
    requested_context,
    kv_cache: kvCache,
    total_ram_bytes,
    free_ram_bytes,
    reserve_ratio,
    reserve_bytes,
    runtime_overhead_bytes,
    free_ram_utilization,
    minimum_context
  });
  const cpu = buildCpuExecutionOptions(installed.manifest.runtime.arguments, env);
  const payload = Object.freeze({
    model_ref: installed.reference,
    artifact_digest: installed.manifest.artifact.sha256,
    manifest_digest: installed.manifest.manifest_digest,
    artifact_bytes: stat.size,
    format: installed.manifest.model.format,
    architecture: gguf.architecture,
    gguf: Object.freeze({
      metadata_digest: sha256(gguf),
      version: gguf.version,
      context_length: gguf.context_length,
      block_count: gguf.block_count,
      embedding_length: gguf.embedding_length,
      attention: gguf.attention,
      parsed_metadata_count: gguf.parsed_metadata_count,
      stopped_before_tokenizer: gguf.stopped_before_tokenizer
    }),
    kv_cache: kvCache,
    context,
    cpu_enforcement: cpu.enforcement,
    claim_boundary: 'This plan proves GGUF metadata inspection, conservative RAM budgeting, and CPU-only runner configuration. It does not prove model quality, speed, training, or admission.'
  });
  const receipt = makeReceipt(ARCHIE_LITE_PLAN_SCHEMA, payload, clock);
  const receiptPath = record ? await recordReceipt(home, 'lite-plans', receipt) : null;
  return { installed, plan: payload, plan_receipt: receipt, plan_receipt_path: receiptPath, cpu };
}

export async function planLiteModel(reference, options = {}) {
  const prepared = await prepareLiteModel(reference, options);
  return Object.freeze({
    plan: prepared.plan,
    receipt: prepared.plan_receipt,
    receipt_path: prepared.plan_receipt_path
  });
}

export async function runLiteModel(reference, {
  prompt,
  runner_path = process.env.ARCHIE_RUNNER || 'llama-cli',
  max_tokens = 256,
  temperature = 0,
  seed = 0,
  timeout_ms = 5 * 60_000,
  ...planOptions
} = {}) {
  const home = path.resolve(planOptions.home || resolveArchieHome());
  const prepared = await prepareLiteModel(reference, { ...planOptions, home });
  const clock = planOptions.clock ?? Date.now;
  const run = await runModel(reference, {
    home,
    prompt,
    runner_path,
    runner_prefix_args: prepared.cpu.runner_prefix_args,
    max_tokens,
    context: prepared.plan.context.selected_context,
    temperature,
    seed,
    timeout_ms,
    env: prepared.cpu.env,
    clock
  });
  const liteReceipt = makeReceipt(ARCHIE_LITE_RUN_RECEIPT_SCHEMA, Object.freeze({
    model_ref: prepared.plan.model_ref,
    artifact_digest: prepared.plan.artifact_digest,
    plan_receipt_digest: prepared.plan_receipt.receipt_digest,
    model_run_receipt_digest: run.receipt.receipt_digest,
    selected_context: prepared.plan.context.selected_context,
    cpu_enforcement: prepared.plan.cpu_enforcement,
    exit_code: run.code,
    signal: run.signal
  }), clock);
  const liteReceiptPath = await recordReceipt(home, 'lite-runs', liteReceipt);
  return Object.freeze({
    ...run,
    lite_plan: prepared.plan,
    lite_plan_receipt: prepared.plan_receipt,
    lite_plan_receipt_path: prepared.plan_receipt_path,
    lite_receipt: liteReceipt,
    lite_receipt_path: liteReceiptPath
  });
}
