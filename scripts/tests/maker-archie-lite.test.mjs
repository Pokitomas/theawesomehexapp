import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  ARCHIE_GGUF_METADATA_SCHEMA,
  buildCpuExecutionOptions,
  calculateKVCacheCost,
  calculateLiteContext,
  inspectGGUFMetadata,
  planLiteModel
} from '../archie-lite-core.mjs';
import {
  pullModel,
  sha256,
  signManifest
} from '../archie-runtime-core.mjs';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

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

function ggufString(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
}

function metadataString(key, value) {
  return Buffer.concat([ggufString(key), u32(8), ggufString(value)]);
}

function metadataUint32(key, value) {
  return Buffer.concat([ggufString(key), u32(4), u32(value)]);
}

function metadataStringArray(key, values) {
  return Buffer.concat([
    ggufString(key),
    u32(9),
    u32(8),
    u64(values.length),
    ...values.map(ggufString)
  ]);
}

function qwenGGUF() {
  const metadata = [
    metadataString('general.architecture', 'qwen2'),
    metadataUint32('qwen2.context_length', 32768),
    metadataUint32('qwen2.block_count', 28),
    metadataUint32('qwen2.embedding_length', 4096),
    metadataUint32('qwen2.attention.head_count', 32),
    metadataUint32('qwen2.attention.head_count_kv', 8),
    metadataStringArray('tokenizer.ggml.tokens', ['<unk>', 'hello'])
  ];
  return Buffer.concat([
    Buffer.from('GGUF'),
    u32(3),
    u64(0),
    u64(metadata.length),
    ...metadata
  ]);
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-lite-test-'));
  const source = path.join(root, 'source');
  const home = path.join(root, 'home');
  await fs.mkdir(source, { recursive: true });
  const artifact = qwenGGUF();
  const artifactPath = path.join(source, 'archie-lite.gguf');
  await fs.writeFile(artifactPath, artifact);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const body = {
    schema: 'archie-model-manifest/v1',
    model: {
      id: 'archie-lite-fixture',
      version: '0.1.0',
      architecture: 'qwen2',
      runtime_abi: 'archie-runtime/v1',
      format: 'gguf',
      quantization: 'fixture',
      context_limit: 8192
    },
    sizes: { download_bytes: artifact.length, installed_bytes: artifact.length },
    artifact: { filename: 'archie-lite.gguf', sha256: sha256(artifact) },
    chunks: [{
      index: 0,
      url: pathToFileURL(artifactPath).href,
      bytes: artifact.length,
      sha256: sha256(artifact)
    }],
    hardware: {
      required_ram_bytes: 1,
      recommended_ram_bytes: artifact.length,
      disk_bytes: artifact.length,
      backends: ['cpu']
    },
    provenance: {
      license: 'test-only',
      source: 'generated GGUF metadata fixture',
      training: 'none',
      code_commit: '0'.repeat(40)
    },
    state: {
      immutable_digest: '1'.repeat(64),
      mutable_digest: '2'.repeat(64),
      mutable_regions: []
    },
    benchmarks: {
      suite_digest: '3'.repeat(64),
      report_digest: '4'.repeat(64),
      claim_boundary: 'Metadata and low-compute planning fixture only.'
    },
    runtime: {
      adapter: 'process-template/v1',
      arguments: ['--model', '{artifact}', '--prompt', '{prompt}', '--ctx-size', '{context}', '--n-predict', '{max_tokens}']
    }
  };
  const manifest = signManifest(body, { private_key_pem: privateKeyPem, public_key_pem: publicKeyPem });
  const manifestPath = path.join(source, 'manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, home, artifact, artifactPath, manifestPath, publicKeyPem };
}

async function cleanup(value) {
  await fs.rm(value.root, { recursive: true, force: true });
}

test('bounded GGUF inspection extracts architecture dimensions without loading tokenizer arrays', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  const metadata = await inspectGGUFMetadata(value.artifactPath);
  assert.equal(metadata.schema, ARCHIE_GGUF_METADATA_SCHEMA);
  assert.equal(metadata.version, 3);
  assert.equal(metadata.architecture, 'qwen2');
  assert.equal(metadata.context_length, 32768);
  assert.equal(metadata.block_count, 28);
  assert.equal(metadata.embedding_length, 4096);
  assert.equal(metadata.attention.head_count, 32);
  assert.equal(metadata.attention.head_count_kv, 8);
  assert.equal(metadata.attention.key_length, 128);
  assert.equal(metadata.attention.value_length, 128);
  assert.equal(metadata.stopped_before_tokenizer, true);
  assert.equal(metadata.parsed_metadata_count, 6);
});

test('KV-cache cost is calculated per token from GGUF attention metadata', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  const metadata = await inspectGGUFMetadata(value.artifactPath);
  const cost = calculateKVCacheCost(metadata, { kv_element_bytes: 2, safety_factor: 1.10 });
  assert.equal(cost.raw_bytes_per_token, 114688);
  assert.equal(cost.budgeted_bytes_per_token, 126157);
});

test('RAM planning caps context and fails closed when the minimum cannot fit', () => {
  const kv_cache = { budgeted_bytes_per_token: 126157 };
  const capped = calculateLiteContext({
    model_bytes: 2 * GIB,
    manifest_context_limit: 8192,
    gguf_context_limit: 32768,
    requested_context: 8192,
    kv_cache,
    total_ram_bytes: 8 * GIB,
    free_ram_bytes: 3 * GIB,
    reserve_ratio: 0.25,
    runtime_overhead_bytes: 512 * MIB,
    free_ram_utilization: 0.90,
    minimum_context: 256
  });
  assert.ok(capped.selected_context >= 1600 && capped.selected_context <= 1800);
  assert.ok(capped.selected_context < capped.requested_context);
  assert.deepEqual(capped.capped_by, ['ram']);
  assert.throws(() => calculateLiteContext({
    model_bytes: 2 * GIB,
    manifest_context_limit: 8192,
    gguf_context_limit: 32768,
    requested_context: 8192,
    kv_cache,
    total_ram_bytes: 8 * GIB,
    free_ram_bytes: 2.5 * GIB,
    reserve_ratio: 0.25,
    runtime_overhead_bytes: 512 * MIB,
    free_ram_utilization: 0.90,
    minimum_context: 256
  }), error => error?.code === 'ARCHIE_LITE_RAM_INSUFFICIENT');
});

test('CPU execution forces zero GPU layers, hides accelerators, and rejects competing manifest overrides', () => {
  const options = buildCpuExecutionOptions(['--model', '{artifact}'], { PATH: '/test/bin', CUDA_VISIBLE_DEVICES: '0' });
  assert.deepEqual(options.runner_prefix_args, ['--gpu-layers', '0']);
  assert.equal(options.env.CUDA_VISIBLE_DEVICES, '');
  assert.equal(options.env.HIP_VISIBLE_DEVICES, '');
  assert.equal(options.enforcement.backend, 'cpu');
  assert.equal(options.enforcement.llama_cpp_gpu_layers, 0);
  assert.throws(() => buildCpuExecutionOptions(['--gpu-layers', '4']), /rejects manifest GPU override/i);
  assert.throws(() => buildCpuExecutionOptions(['-ngl=4']), /rejects manifest GPU override/i);
});

test('installed GGUF planning binds metadata, RAM cap, CPU authority, and a durable receipt', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  await pullModel(value.manifestPath, { home: value.home, trusted_public_keys: [value.publicKeyPem] });
  const result = await planLiteModel('archie-lite-fixture@0.1.0', {
    home: value.home,
    requested_context: 4096,
    total_ram_bytes: 4 * GIB,
    free_ram_bytes: 3 * GIB,
    runtime_overhead_bytes: 256 * MIB,
    minimum_context: 256
  });
  assert.equal(result.plan.model_ref, 'archie-lite-fixture@0.1.0');
  assert.equal(result.plan.architecture, 'qwen2');
  assert.equal(result.plan.cpu_enforcement.backend, 'cpu');
  assert.equal(result.plan.context.selected_context, 4096);
  assert.match(result.receipt.receipt_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await fs.readFile(result.receipt_path, 'utf8')).receipt_digest, result.receipt.receipt_digest);
});

test('package exposes both requested low-compute command spellings', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.bin['archie-lite'], 'scripts/archie-lite.mjs');
  assert.equal(packageJson.bin.archie_lite, 'scripts/archie-lite.mjs');
  assert.equal(packageJson.scripts['test:archie:lite'], 'node --test scripts/tests/maker-archie-lite.test.mjs');
});

test('Linux installer is syntactically valid and exposes an offline help path', async () => {
  const script = path.resolve(new URL('../install-archie-lite-linux.sh', import.meta.url).pathname);
  const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /downloads no model weights/i);
  assert.match(help.stdout, /ARCHIE_LLAMA_CPP_RELEASE/);
});

test('Linux installer verifies official CPU assets and pins the exact Archie commit', async () => {
  const script = await fs.readFile(new URL('../install-archie-lite-linux.sh', import.meta.url), 'utf8');
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /ARCHIE_LLAMA_CPP_RELEASE:-b10067/);
  assert.match(script, /api\.github\.com\/repos\/ggml-org\/llama\.cpp\/releases\/tags/);
  assert.match(script, /llama-\$\{release\}-bin-ubuntu-\$\{asset_arch\}\.tar\.gz/);
  assert.match(script, /\^sha256:\[a-f0-9\]\{64\}\$/);
  assert.match(script, /sha256sum --check --status/);
  assert.match(script, /archive contains an unsafe path/);
  assert.match(script, /api\.github\.com\/repos\/Pokitomas\/theawesomehexapp\/commits\/main/);
  assert.match(script, /archive\/\$\{archie_sha\}\.tar\.gz/);
  assert.match(script, /npm install --global --prefix/);
  assert.match(script, /model_downloaded: false/);
  assert.doesNotMatch(script, /huggingface|hf\.co|-hf\b/i);
});
