#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCorpus } from './protocol-corpus.mjs';
import { trainDecoder, evaluate, parameterCount, modelDigest, sha256, PRESETS } from './protocol-decoder.mjs';

const presetName = (() => {
  const index = process.argv.indexOf('--preset');
  const name = index === -1 ? 'recovered' : String(process.argv[index + 1] || '');
  if (!PRESETS[name]) throw new Error(`Unknown preset: ${name}. Known: ${Object.keys(PRESETS).join(', ')}.`);
  return name;
})();

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(here, 'runs');
const outputPath = path.join(outputDirectory, presetName === 'recovered'
  ? 'protocol-decoder-receipt.json'
  : `protocol-decoder-receipt.${presetName}.json`);
fs.mkdirSync(outputDirectory, { recursive: true });

const corpus = buildCorpus();
const decoder = trainDecoder(corpus.train, PRESETS[presetName]);
const train = evaluate(decoder, corpus.train);
const development = evaluate(decoder, corpus.development);
const hardDevelopment = evaluate(decoder, corpus.hard);

let codeRevision = null;
try {
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (!dirty) codeRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  codeRevision = null;
}

const thresholds = {
  development_exact_match: 0.9,
  hard_development_exact_match: 0.8,
  protocol_syntax_valid: 1
};
const gatesPassed = development.exact_match >= thresholds.development_exact_match
  && hardDevelopment.exact_match >= thresholds.hard_development_exact_match
  && development.protocol_syntax_valid === 1
  && hardDevelopment.protocol_syntax_valid === 1;

const body = {
  schema: 'archie-sprawl-protocol-decoder-receipt/v2',
  code_revision: codeRevision,
  model: {
    method: 'deterministic-bigram-mlp/v1',
    preset: presetName,
    parameters: parameterCount(decoder),
    vocabulary_features: decoder.vocabulary.length,
    hidden: decoder.config.hidden,
    model_digest: modelDigest(decoder)
  },
  data: {
    train_examples: corpus.train.length,
    development_examples: corpus.development.length,
    hard_development_examples: corpus.hard.length,
    total_examples: corpus.train.length + corpus.development.length + corpus.hard.length,
    split_policy: 'Whole authored prompt families; the seven-case hard set is development-only after adaptive inspection.'
  },
  evaluation: { train, development, hard_development: hardDevelopment },
  thresholds,
  gates_passed: gatesPassed,
  promotion: 'not-admitted',
  claim_boundary: 'Gates measure decoder-local development performance and syntax only. The hard set was previously inspected and is not an independent admission set.'
};
const receipt = { ...body, receipt_digest: sha256(body) };
fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  gates_passed: gatesPassed,
  train_exact_match: train.exact_match,
  heldout_exact_match: development.exact_match,
  hard_margin_exact_match: hardDevelopment.exact_match,
  protocol_syntax_valid: Math.min(development.protocol_syntax_valid, hardDevelopment.protocol_syntax_valid),
  parameters: body.model.parameters,
  vocabulary_features: body.model.vocabulary_features,
  promotion: body.promotion,
  receipt_digest: receipt.receipt_digest,
  receipt_path: outputPath
}, null, 2));
