import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  ARCHIE_STUDENT_QUANTIZATION_RECEIPT_SCHEMA,
  GGUF_QUANTIZATION_DESIGNS,
  digest,
  runStudentQuantization
} from '../archie-student-quantize.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-quantize-'));
  const modelDir = path.join(root, 'model');
  await fs.mkdir(modelDir);
  await fs.writeFile(path.join(modelDir, 'config.json'), '{"architectures":["FixtureForCausalLM"]}\n');
  await fs.writeFile(path.join(modelDir, 'tokenizer.json'), '{"version":"1.0"}\n');
  await fs.writeFile(path.join(modelDir, 'model.safetensors'), Buffer.from('fixture-weights'));
  const converter = path.join(root, 'convert.mjs');
  await fs.writeFile(converter, `import fs from 'node:fs'; const args=process.argv.slice(2); const out=args[args.indexOf('--outfile')+1]; fs.writeFileSync(out, Buffer.from('f16:'+args[0]));\n`);
  const quantizer = path.join(root, 'quantize.mjs');
  await fs.writeFile(quantizer, `#!/usr/bin/env node\nimport fs from 'node:fs'; const [, , input, output, type]=process.argv; fs.writeFileSync(output, Buffer.concat([Buffer.from(type+':'),fs.readFileSync(input)]));\n`);
  await fs.chmod(quantizer, 0o755);
  return { root, modelDir, converter, quantizer, outputDir: path.join(root, 'out') };
}

function options(fx, overrides = {}) {
  return {
    modelDir: fx.modelDir,
    modelId: 'archie-fixture',
    modelRevisionSha256: 'a'.repeat(64),
    converter: fx.converter,
    quantizer: fx.quantizer,
    python: process.execPath,
    outputDir: fx.outputDir,
    ...overrides
  };
}

test('emits receipt-bound Q4_K_M, Q5_K_M, and Q6_K artifacts without admitting them', async t => {
  const fx = await fixture(); t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const { receipt, receiptPath } = await runStudentQuantization(options(fx));
  assert.equal(receipt.schema, ARCHIE_STUDENT_QUANTIZATION_RECEIPT_SCHEMA);
  assert.deepEqual(receipt.artifacts.map(row => row.quantization), ['Q4_K_M', 'Q5_K_M', 'Q6_K']);
  assert.deepEqual(receipt.artifacts.map(row => row.design_id), ['gguf-q4-k-m', 'gguf-q5-k-m', 'gguf-q6-k']);
  assert.equal(receipt.environment.offline, true);
  assert.match(receipt.claim_boundary, /candidates only/);
  assert.equal(receipt.receipt_digest, digest({ ...receipt, receipt_digest: undefined }));
  const stored = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(stored.receipt_digest, receipt.receipt_digest);
  for (const row of receipt.artifacts) {
    const bytes = await fs.readFile(path.join(fx.outputDir, row.artifact.path));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), row.artifact.sha256);
  }
});

test('supports an exact canonical subset and rejects invented quantizations', async t => {
  const fx = await fixture(); t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const { receipt } = await runStudentQuantization(options(fx, { quantizations: ['Q8_0'] }));
  assert.equal(receipt.artifacts[0].design_id, GGUF_QUANTIZATION_DESIGNS.Q8_0.design_id);
  const second = await fixture(); t.after(() => fs.rm(second.root, { recursive: true, force: true }));
  await assert.rejects(() => runStudentQuantization(options(second, { quantizations: ['Q4.5_K_EXPERIMENTAL'] })), /Unsupported GGUF quantization/);
});

test('fails closed for incomplete checkpoints and nonempty output directories', async t => {
  const fx = await fixture(); t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  await fs.rm(path.join(fx.modelDir, 'model.safetensors'));
  await assert.rejects(() => runStudentQuantization(options(fx)), /no Hugging Face weight artifact/);
  const second = await fixture(); t.after(() => fs.rm(second.root, { recursive: true, force: true }));
  await fs.mkdir(second.outputDir); await fs.writeFile(path.join(second.outputDir, 'stale.txt'), 'stale');
  await assert.rejects(() => runStudentQuantization(options(second)), /Refusing nonempty output directory/);
});
