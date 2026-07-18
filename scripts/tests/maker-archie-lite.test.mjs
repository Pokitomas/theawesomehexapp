import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLlamaLiteArgs,
  estimateKVBytesPerToken,
  inspectGGUF,
  planLiteInference
} from '../archie-lite.mjs';

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function string(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
}

function metadataString(key, value) {
  return Buffer.concat([string(key), u32(8), string(value)]);
}

function metadataU32(key, value) {
  return Buffer.concat([string(key), u32(4), u32(value)]);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-lite-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rows = [
    metadataString('general.architecture', 'qwen3'),
    metadataString('general.name', 'tiny-qwen-fixture'),
    metadataU32('qwen3.block_count', 28),
    metadataU32('qwen3.embedding_length', 2048),
    metadataU32('qwen3.attention.head_count', 16),
    metadataU32('qwen3.attention.head_count_kv', 8),
    metadataU32('qwen3.attention.key_length', 128),
    metadataU32('qwen3.attention.value_length', 128)
  ];
  const filename = path.join(root, 'fixture.gguf');
  await fs.writeFile(filename, Buffer.concat([
    Buffer.from('GGUF'),
    u32(3),
    u64(0),
    u64(rows.length),
    ...rows
  ]));
  return filename;
}

test('inspects bounded GGUF metadata and derives exact grouped-query KV cost', async t => {
  const filename = await fixture(t);
  const inspection = await inspectGGUF(filename);
  assert.equal(inspection.version, 3);
  assert.equal(inspection.metadata['general.architecture'], 'qwen3');
  assert.equal(inspection.metadata['qwen3.block_count'], 28);
  assert.equal(estimateKVBytesPerToken(inspection.metadata), 28 * 8 * (128 + 128) * 2);
});

test('plans CPU-only inference within a conservative RAM budget', async t => {
  const filename = await fixture(t);
  const inspection = await inspectGGUF(filename);
  const plan = planLiteInference({
    metadata: inspection.metadata,
    model_bytes: 1024 ** 3,
    total_memory_bytes: 8 * 1024 ** 3,
    logical_cpu_count: 8,
    requested_context: 32768
  });
  assert.equal(plan.backend, 'llama.cpp-cpu');
  assert.equal(plan.gpu_layers, 0);
  assert.equal(plan.context, plan.maximum_safe_context);
  assert.ok(plan.context >= 512);
  assert.equal(plan.threads, 6);
  assert.ok(plan.estimated_peak_bytes <= plan.memory_budget_bytes + plan.reserved_system_bytes);
});

test('reports machines that cannot conservatively fit the minimum context', () => {
  const plan = planLiteInference({
    metadata: {},
    model_bytes: 2.5 * 1024 ** 3,
    total_memory_bytes: 3 * 1024 ** 3,
    logical_cpu_count: 4
  });
  assert.equal(plan.fits_minimum_context, false);
  assert.equal(plan.context, 512);
});

test('builds an explicit no-GPU llama.cpp command', () => {
  const plan = planLiteInference({
    metadata: {},
    model_bytes: 512 * 1024 ** 2,
    total_memory_bytes: 8 * 1024 ** 3,
    logical_cpu_count: 4,
    requested_context: 2048
  });
  const args = buildLlamaLiteArgs({ model: './model.gguf', prompt: 'hello', plan, max_tokens: 32 });
  assert.deepEqual(args.slice(args.indexOf('-ngl'), args.indexOf('-ngl') + 2), ['-ngl', '0']);
  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', '2048']);
  assert.deepEqual(args.slice(args.indexOf('-n'), args.indexOf('-n') + 2), ['-n', '32']);
});
