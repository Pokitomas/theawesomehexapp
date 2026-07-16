import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  benchmarkModel,
  inspectModel,
  listModels,
  manifestDigest,
  pullModel,
  removeModel,
  runModel,
  sha256,
  signManifest,
  verifyManifest
} from '../archie-runtime-core.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-runtime-test-'));
  const source = path.join(root, 'source');
  const home = path.join(root, 'home');
  await fs.mkdir(source, { recursive: true });
  const artifact = Buffer.concat([
    Buffer.from('GGUF-ARCHIE-LOCAL-FIXTURE\n'),
    Buffer.alloc(4096, 0x61),
    Buffer.from('\nEND')
  ]);
  const cut = 1537;
  const chunkBuffers = [artifact.subarray(0, cut), artifact.subarray(cut)];
  const chunkFiles = [];
  for (let index = 0; index < chunkBuffers.length; index += 1) {
    const filename = path.join(source, `chunk-${index}.bin`);
    await fs.writeFile(filename, chunkBuffers[index]);
    chunkFiles.push(filename);
  }
  const runner = path.join(root, 'runner.mjs');
  await fs.writeFile(runner, [
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "const value = name => args[args.indexOf(name) + 1] || '';",
    "process.stdout.write(`LOCAL:${value('--prompt')}:${path.basename(value('--model'))}\\n`);"
  ].join('\n')); 
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const body = {
    schema: 'archie-model-manifest/v1',
    model: {
      id: 'archie-fixture',
      version: '0.1.0',
      architecture: 'test-byte-artifact',
      runtime_abi: 'archie-runtime/v1',
      format: 'gguf',
      quantization: 'fixture',
      context_limit: 2048
    },
    sizes: { download_bytes: artifact.length, installed_bytes: artifact.length },
    artifact: { filename: 'archie-fixture.gguf', sha256: sha256(artifact) },
    chunks: chunkBuffers.map((buffer, index) => ({
      index,
      url: pathToFileURL(chunkFiles[index]).href,
      bytes: buffer.length,
      sha256: sha256(buffer)
    })),
    hardware: {
      required_ram_bytes: 1,
      recommended_ram_bytes: artifact.length,
      disk_bytes: artifact.length,
      backends: ['cpu']
    },
    provenance: {
      license: 'test-only',
      source: 'generated test fixture',
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
      claim_boundary: 'Transport and local process execution fixture only.'
    },
    runtime: {
      adapter: 'process-template/v1',
      arguments: [runner, '--model', '{artifact}', '--prompt', '{prompt}', '--max-tokens', '{max_tokens}', '--context', '{context}', '--seed', '{seed}']
    }
  };
  const manifest = signManifest(body, { private_key_pem: privateKeyPem, public_key_pem: publicKeyPem });
  const manifestPath = path.join(source, 'manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, source, home, artifact, chunkFiles, runner, manifest, manifestPath, publicKeyPem, privateKeyPem };
}

async function cleanup(value) {
  await fs.rm(value.root, { recursive: true, force: true });
}

test('pull verifies signed exact-size chunks and installs a content-addressed local artifact', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  const pulled = await pullModel(value.manifestPath, { home: value.home, trusted_public_keys: [value.publicKeyPem] });
  assert.equal(pulled.receipt.schema, 'archie-model-pull-receipt/v1');
  assert.equal(pulled.receipt.payload.exact_download_bytes, value.artifact.length);
  assert.equal(pulled.receipt.payload.exact_installed_bytes, value.artifact.length);
  assert.equal(pulled.receipt.payload.chunks.length, 2);
  assert.equal(await fs.readFile(pulled.artifact_path, 'utf8').then(text => text.startsWith('GGUF-ARCHIE')), true);
  const inspected = await inspectModel('archie-fixture@0.1.0', { home: value.home });
  assert.equal(inspected.manifest.manifest_digest, manifestDigest(value.manifest));
  assert.equal(inspected.manifest.artifact.sha256, sha256(value.artifact));
  assert.deepEqual((await listModels({ home: value.home })).map(item => item.model_ref), ['archie-fixture@0.1.0']);
});

test('run invokes only the configured local process adapter and emits an artifact-bound receipt', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  await pullModel(value.manifestPath, { home: value.home, trusted_public_keys: [value.publicKeyPem] });
  const result = await runModel('archie-fixture@0.1.0', {
    home: value.home,
    prompt: 'hello local runtime',
    runner_path: process.execPath,
    max_tokens: 32,
    context: 512,
    seed: 7
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^LOCAL:hello local runtime:archie-fixture\.gguf/m);
  assert.equal(result.receipt.schema, 'archie-model-run-receipt/v1');
  assert.equal(result.receipt.payload.artifact_digest, sha256(value.artifact));
  assert.equal(result.receipt.payload.backend, 'process-template/v1');
  assert.equal(result.receipt.payload.generation.seed, 7);
});

test('benchmark emits a machine-readable report tied to suite, model and run receipts', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  await pullModel(value.manifestPath, { home: value.home, trusted_public_keys: [value.publicKeyPem] });
  const suitePath = path.join(value.root, 'suite.json');
  await fs.writeFile(suitePath, JSON.stringify({
    schema: 'archie-benchmark-suite/v1',
    id: 'local-fixture',
    cases: [
      { id: 'echo-one', prompt: 'one', expect: { includes: ['LOCAL:one:'], excludes: ['REMOTE'] } },
      { id: 'echo-two', prompt: 'two', seed: 11, expect: { includes: ['LOCAL:two:'] } }
    ]
  }));
  const report = await benchmarkModel('archie-fixture@0.1.0', suitePath, { home: value.home, runner_path: process.execPath });
  assert.equal(report.schema, 'archie-model-benchmark-report/v1');
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.passed, 2);
  assert.match(report.report_digest, /^[a-f0-9]{64}$/);
  assert.ok(report.cases.every(item => /^[a-f0-9]{64}$/.test(item.run_receipt_digest)));
});

test('tampered manifests, untrusted keys and corrupted chunks fail closed', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  assert.throws(() => verifyManifest(value.manifest), /not trusted/i);
  const tampered = structuredClone(value.manifest);
  tampered.model.context_limit += 1;
  assert.throws(() => verifyManifest(tampered, { trusted_public_keys: [value.publicKeyPem] }), /digest|signature/i);
  await fs.writeFile(value.chunkFiles[1], Buffer.from('corrupt'));
  await assert.rejects(
    pullModel(value.manifestPath, { home: path.join(value.root, 'corrupt-home'), trusted_public_keys: [value.publicKeyPem] }),
    /byte mismatch|digest mismatch/i
  );
});

test('remove deletes the indexed artifact and is idempotent', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  await pullModel(value.manifestPath, { home: value.home, trusted_public_keys: [value.publicKeyPem] });
  assert.equal((await removeModel('archie-fixture@0.1.0', { home: value.home })).removed, true);
  assert.equal((await removeModel('archie-fixture@0.1.0', { home: value.home })).removed, false);
  await assert.rejects(inspectModel('archie-fixture@0.1.0', { home: value.home }), /not installed/i);
});
