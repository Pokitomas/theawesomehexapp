import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ARCHIE_ARTIFACT_ENVELOPE_SCHEMA,
  ARCHIE_ENCRYPTED_MANIFEST_SCHEMA,
  createEncryptedArtifactPackage,
  generateArtifactKeyPair,
  inspectEncryptedTransport,
  pullEncryptedModel,
  verifyEncryptedManifest
} from '../archie-artifact-envelope.mjs';
import { inspectModel, runModel, signManifest } from '../archie-runtime-core.mjs';

async function fixture({ recipients = 1, chunkBytes = 1024 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-envelope-test-'));
  const artifactPath = path.join(root, 'archie-encrypted.gguf');
  const artifact = Buffer.concat([
    Buffer.from('ARCHIE-ENCRYPTED-GGUF\n'),
    Buffer.alloc(4096, 0x45),
    Buffer.from('\nEND')
  ]);
  await fs.writeFile(artifactPath, artifact);
  const runner = path.join(root, 'runner.mjs');
  await fs.writeFile(runner, [
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "const value = name => args[args.indexOf(name) + 1] || '';",
    "process.stdout.write(`ENCRYPTED-LOCAL:${value('--prompt')}:${path.basename(value('--model'))}\\n`);"
  ].join('\n'));
  const signer = generateArtifactKeyPair('signing');
  const devices = Array.from({ length: recipients }, () => generateArtifactKeyPair('recipient'));
  const metadata = {
    model: {
      id: 'archie-encrypted-fixture',
      version: '0.1.0',
      architecture: 'encrypted-test-artifact',
      runtime_abi: 'archie-runtime/v1',
      format: 'gguf',
      quantization: 'fixture',
      context_limit: 2048
    },
    hardware: {
      required_ram_bytes: 1,
      recommended_ram_bytes: artifact.length,
      disk_bytes: artifact.length,
      backends: ['cpu']
    },
    provenance: {
      license: 'test-only',
      source: 'generated encrypted fixture',
      training: 'none',
      code_commit: 'a'.repeat(40)
    },
    state: {
      immutable_digest: '1'.repeat(64),
      mutable_digest: '2'.repeat(64),
      mutable_regions: []
    },
    benchmarks: {
      suite_digest: '3'.repeat(64),
      report_digest: '4'.repeat(64),
      claim_boundary: 'Encrypted transport and local execution fixture only.'
    },
    runtime: {
      adapter: 'process-template/v1',
      arguments: [runner, '--model', '{artifact}', '--prompt', '{prompt}', '--max-tokens', '{max_tokens}', '--context', '{context}', '--seed', '{seed}']
    }
  };
  const outputDirectory = path.join(root, 'package');
  const packaged = await createEncryptedArtifactPackage({
    artifact_path: artifactPath,
    output_directory: outputDirectory,
    metadata,
    recipient_public_keys: devices.map(item => item.public_key_pem),
    signing_private_key_pem: signer.private_key_pem,
    signing_public_key_pem: signer.public_key_pem,
    chunk_bytes: chunkBytes
  });
  return { root, artifact, artifactPath, runner, signer, devices, metadata, outputDirectory, packaged };
}

async function cleanup(value) {
  await fs.rm(value.root, { recursive: true, force: true });
}

function resign(manifest, signer) {
  const { signature, manifest_digest, ...body } = manifest;
  return signManifest(body, {
    private_key_pem: signer.private_key_pem,
    public_key_pem: signer.public_key_pem
  });
}

test('package emits signed manifest, wrapped data key, and independently authenticated encrypted chunks', async t => {
  const value = await fixture({ recipients: 2, chunkBytes: 700 });
  t.after(() => cleanup(value));
  const { manifest } = value.packaged;
  assert.equal(manifest.schema, ARCHIE_ENCRYPTED_MANIFEST_SCHEMA);
  assert.equal(manifest.encryption.schema, ARCHIE_ARTIFACT_ENVELOPE_SCHEMA);
  assert.equal(manifest.encryption.recipients.length, 2);
  assert.ok(manifest.chunks.length > 2);
  assert.equal(new Set(manifest.chunks.map(item => item.nonce_base64)).size, manifest.chunks.length);
  assert.equal(manifest.sizes.installed_bytes, value.artifact.length);
  assert.equal(manifest.sizes.download_bytes, value.artifact.length + manifest.chunks.length * 16);
  assert.ok(manifest.chunks.every(item => item.bytes === item.plaintext_bytes + 16));
  assert.ok(manifest.chunks.every(item => /^[a-f0-9]{64}$/.test(item.aad_digest)));
  assert.doesNotThrow(() => verifyEncryptedManifest(manifest, { trusted_public_keys: [value.signer.public_key_pem] }));
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes(value.signer.private_key_pem.trim()), false);
  assert.ok(value.devices.every(device => !serialized.includes(device.private_key_pem.trim())));
});

test('encrypted pull unwraps locally, verifies both ciphertext and plaintext, and remains runnable without an API key', async t => {
  const value = await fixture({ recipients: 1, chunkBytes: 1024 });
  t.after(() => cleanup(value));
  const home = path.join(value.root, 'home');
  const pulled = await pullEncryptedModel(value.packaged.manifest_path, {
    home,
    trusted_public_keys: [value.signer.public_key_pem],
    recipient_private_keys: [value.devices[0].private_key_pem]
  });
  assert.equal(pulled.receipt.schema, 'archie-encrypted-model-pull-receipt/v1');
  assert.equal(pulled.receipt.payload.exact_installed_bytes, value.artifact.length);
  assert.equal(pulled.receipt.payload.envelope.publisher_trust, 'trusted');
  assert.equal(await fs.readFile(pulled.artifact_path).then(buffer => buffer.equals(value.artifact)), true);
  const installed = await inspectModel('archie-encrypted-fixture@0.1.0', { home });
  const transport = await inspectEncryptedTransport(installed.artifact_path);
  assert.equal(transport.outer_manifest.manifest_digest, value.packaged.manifest.manifest_digest);
  assert.equal(transport.encrypted_pull_receipt.receipt_digest, pulled.receipt.receipt_digest);
  const result = await runModel('archie-encrypted-fixture@0.1.0', {
    home,
    prompt: 'hello envelope',
    runner_path: process.execPath,
    max_tokens: 32,
    context: 512,
    env: { ...process.env, SIDEWAYS_MODEL_API_KEY: '', OPENAI_API_KEY: '' }
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^ENCRYPTED-LOCAL:hello envelope:archie-encrypted\.gguf/m);
});

test('optional recovery recipient can unwrap the same data key independently', async t => {
  const value = await fixture({ recipients: 2, chunkBytes: 1500 });
  t.after(() => cleanup(value));
  const pulled = await pullEncryptedModel(value.packaged.manifest_path, {
    home: path.join(value.root, 'recovery-home'),
    trusted_public_keys: [value.signer.public_key_pem],
    recipient_private_keys: [value.devices[1].private_key_pem]
  });
  assert.equal(pulled.receipt.payload.envelope.recipient_fingerprint, value.devices[1].fingerprint);
  assert.equal(await fs.readFile(pulled.artifact_path).then(buffer => buffer.equals(value.artifact)), true);
});

test('wrong keys, modified signed metadata, corrupted ciphertext, and tampered wrapped keys fail closed', async t => {
  const value = await fixture({ recipients: 1, chunkBytes: 1024 });
  t.after(() => cleanup(value));
  const wrongDevice = generateArtifactKeyPair('recipient');
  await assert.rejects(pullEncryptedModel(value.packaged.manifest_path, {
    home: path.join(value.root, 'wrong-key-home'),
    trusted_public_keys: [value.signer.public_key_pem],
    recipient_private_keys: [wrongDevice.private_key_pem]
  }), /No wrapped data key matches/);

  const metadataTamper = structuredClone(value.packaged.manifest);
  metadataTamper.model.context_limit += 1;
  assert.throws(() => verifyEncryptedManifest(metadataTamper, { trusted_public_keys: [value.signer.public_key_pem] }), /digest|signature/i);

  const ciphertextPath = new URL(value.packaged.manifest.chunks[0].url);
  const originalCiphertext = await fs.readFile(ciphertextPath);
  const corrupted = Buffer.from(originalCiphertext);
  corrupted[0] ^= 0xff;
  await fs.writeFile(ciphertextPath, corrupted);
  await assert.rejects(pullEncryptedModel(value.packaged.manifest_path, {
    home: path.join(value.root, 'ciphertext-home'),
    trusted_public_keys: [value.signer.public_key_pem],
    recipient_private_keys: [value.devices[0].private_key_pem]
  }), /digest mismatch/);
  await fs.writeFile(ciphertextPath, originalCiphertext);

  const wrappedTamper = structuredClone(value.packaged.manifest);
  const wrapped = Buffer.from(wrappedTamper.encryption.recipients[0].wrapped_key_base64, 'base64');
  wrapped[0] ^= 0xff;
  wrappedTamper.encryption.recipients[0].wrapped_key_base64 = wrapped.toString('base64');
  const resigned = resign(wrappedTamper, value.signer);
  const resignedPath = path.join(value.root, 'tampered-wrapped-manifest.json');
  await fs.writeFile(resignedPath, JSON.stringify(resigned));
  await assert.rejects(pullEncryptedModel(resignedPath, {
    home: path.join(value.root, 'wrapped-home'),
    trusted_public_keys: [value.signer.public_key_pem],
    recipient_private_keys: [value.devices[0].private_key_pem]
  }), /Wrapped data key authentication failed/);
});
