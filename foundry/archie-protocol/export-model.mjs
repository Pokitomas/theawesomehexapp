#!/usr/bin/env node
// Export a trained protocol decoder to a portable int8-quantized JSON artifact
// that a browser runtime can execute with no ML dependency. Re-trains
// deterministically (fixed seed), then quantizes W1/W2 per row to int8 with a
// per-row scale — mirroring the report's int8 lane — and records both the
// float and quantized development metrics so the quantization cost is honest.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { INTENT_PROTOCOL, INTENTS } from './protocol-grammar.mjs';
import { buildCorpus } from './protocol-corpus.mjs';
import { trainDecoder, evaluate, parameterCount, sha256, PRESETS } from './protocol-decoder.mjs';

function quantizeRows(matrix) {
  const scales = [];
  const rows = [];
  for (const row of matrix) {
    let maxAbs = 0;
    for (const value of row) maxAbs = Math.max(maxAbs, Math.abs(value));
    const scale = maxAbs / 127 || 1;
    scales.push(Number(scale.toPrecision(8)));
    const bytes = new Int8Array(row.length);
    for (let index = 0; index < row.length; index += 1) bytes[index] = Math.max(-127, Math.min(127, Math.round(row[index] / scale)));
    rows.push(Buffer.from(bytes.buffer).toString('base64'));
  }
  return { scales, rows };
}

function dequantizeRows({ scales, rows }) {
  return rows.map((encoded, rowIndex) => {
    const buffer = Buffer.from(encoded, 'base64');
    const bytes = new Int8Array(buffer.buffer, buffer.byteOffset, buffer.length);
    return Float64Array.from(bytes, value => value * scales[rowIndex]);
  });
}

function withWeights(decoder, W1, W2) {
  return { ...decoder, model: { ...decoder.model, W1, W2 } };
}

async function main() {
  const args = process.argv.slice(2);
  const presetIndex = args.indexOf('--preset');
  const presetName = presetIndex === -1 ? 'big' : args[presetIndex + 1];
  if (!PRESETS[presetName]) throw new Error(`Unknown preset: ${presetName}`);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outIndex = args.indexOf('--out');
  const outPath = outIndex === -1 ? path.join(here, 'runs', `protocol-decoder-model.${presetName}.json`) : args[outIndex + 1];

  const corpus = buildCorpus();
  const decoder = trainDecoder(corpus.train, PRESETS[presetName]);
  const floatDevelopment = evaluate(decoder, corpus.development);
  const floatHard = evaluate(decoder, corpus.hard);

  const q1 = quantizeRows(decoder.model.W1);
  const q2 = quantizeRows(decoder.model.W2);
  const quantized = withWeights(decoder, dequantizeRows(q1), dequantizeRows(q2));
  const int8Development = evaluate(quantized, corpus.development);
  const int8Hard = evaluate(quantized, corpus.hard);

  const body = {
    schema: 'archie-sprawl-protocol-decoder-model/v2',
    preset: presetName,
    intents: [...INTENTS],
    intent_protocol: INTENT_PROTOCOL,
    config: decoder.config,
    vocabulary: decoder.vocabulary,
    dims: { input: decoder.model.input, hidden: decoder.model.hidden, classes: decoder.model.classes },
    parameters: parameterCount(decoder),
    weights_int8: {
      W1: q1,
      W2: q2,
      b1: Array.from(decoder.model.b1, value => Number(value.toPrecision(8))),
      b2: Array.from(decoder.model.b2, value => Number(value.toPrecision(8)))
    },
    evaluation: {
      float: { development_exact_match: floatDevelopment.exact_match, hard_exact_match: floatHard.exact_match },
      int8: { development_exact_match: int8Development.exact_match, hard_exact_match: int8Hard.exact_match },
      protocol_syntax_valid: Math.min(floatDevelopment.protocol_syntax_valid, int8Development.protocol_syntax_valid)
    },
    promotion: 'not-admitted',
    claim_boundary: 'Constrained protocol decoder only; intent routing to fixed protocol templates. Not a general generator.'
  };
  const artifact = { ...body, model_digest: sha256(body) };
  const text = `${JSON.stringify(artifact)}\n`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text);
  console.log(JSON.stringify({
    ok: true,
    out: path.resolve(outPath),
    bytes: Buffer.byteLength(text),
    parameters: body.parameters,
    float_development: body.evaluation.float.development_exact_match,
    int8_development: body.evaluation.int8.development_exact_match,
    float_hard: body.evaluation.float.hard_exact_match,
    int8_hard: body.evaluation.int8.hard_exact_match,
    model_digest: artifact.model_digest
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(String(error?.stack || error));
    process.exitCode = 1;
  });
}
