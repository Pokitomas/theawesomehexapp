#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus } from './protocol-corpus.mjs';
import { evaluate, modelDigest, parameterCount, sha256, trainDecoder } from './protocol-decoder.mjs';

function values(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  return String(process.argv[index + 1] || '')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(Number.isFinite);
}

function scalar(flag, fallback) {
  const found = values(flag, []);
  return found.length ? found[0] : fallback;
}

const widths = values('--widths', [128, 256, 512, 768, 1024]);
const seeds = values('--seeds', [3407, 3419, 3433]);
const epochs = scalar('--epochs', 180);
const learningRate = scalar('--learning-rate', 0.035);
const weightDecay = scalar('--weight-decay', 0.003);
const minCount = scalar('--min-count', 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const outputIndex = process.argv.indexOf('--out');
const outputPath = outputIndex === -1
  ? path.join(here, 'runs', 'protocol-decoder-sweep.v7.json')
  : path.resolve(process.argv[outputIndex + 1]);

if (!widths.length || !seeds.length) throw new Error('At least one width and seed are required.');

const corpus = buildCorpus();
const runs = [];
for (const hidden of widths) {
  for (const seed of seeds) {
    const config = {
      minCount,
      hidden,
      epochs,
      learningRate,
      weightDecay,
      seed,
      charNgrams: true
    };
    const started = Date.now();
    const decoder = trainDecoder(corpus.train, config);
    const train = evaluate(decoder, corpus.train);
    const development = evaluate(decoder, corpus.development);
    const hard = evaluate(decoder, corpus.hard);
    runs.push({
      hidden,
      seed,
      parameters: parameterCount(decoder),
      vocabulary_features: decoder.vocabulary.length,
      duration_seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
      train_exact_match: train.exact_match,
      development_exact_match: development.exact_match,
      hard_exact_match: hard.exact_match,
      protocol_syntax_valid: Math.min(development.protocol_syntax_valid, hard.protocol_syntax_valid),
      model_digest: modelDigest(decoder)
    });
    console.log(`v7 h${hidden} seed${seed} ${runs.at(-1).parameters} dev=${development.exact_match} hard=${hard.exact_match}`);
  }
}

const grouped = widths.map(hidden => {
  const candidates = runs.filter(run => run.hidden === hidden);
  const mean = key => Number((candidates.reduce((sum, run) => sum + run[key], 0) / candidates.length).toFixed(6));
  const variance = key => {
    const average = mean(key);
    return Number((candidates.reduce((sum, run) => sum + (run[key] - average) ** 2, 0) / candidates.length).toFixed(8));
  };
  return {
    hidden,
    parameters: candidates[0].parameters,
    seeds: candidates.length,
    mean_development_exact_match: mean('development_exact_match'),
    development_variance: variance('development_exact_match'),
    mean_hard_exact_match: mean('hard_exact_match'),
    hard_variance: variance('hard_exact_match'),
    syntax_floor: Math.min(...candidates.map(run => run.protocol_syntax_valid))
  };
});

const ranked = [...grouped].sort((left, right) =>
  right.mean_development_exact_match - left.mean_development_exact_match
  || right.mean_hard_exact_match - left.mean_hard_exact_match
  || left.development_variance - right.development_variance
  || left.parameters - right.parameters
);
const champion = ranked[0];
const body = {
  schema: 'archie-protocol-scaling-sweep/v1',
  method: 'deterministic multi-seed width sweep over the committed protocol corpus',
  configuration: { widths, seeds, epochs, learningRate, weightDecay, minCount, charNgrams: true },
  data: {
    train_examples: corpus.train.length,
    development_examples: corpus.development.length,
    hard_examples: corpus.hard.length
  },
  runs,
  grouped,
  champion,
  promotion: 'not-admitted',
  claim_boundary: 'This receipt measures one small route-classification corpus. It does not establish general intelligence, text generation, tool use, or monotonic scaling.'
};
const receipt = { ...body, receipt_digest: sha256(body) };
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, champion, runs: runs.length, receipt_digest: receipt.receipt_digest, receipt_path: outputPath }, null, 2));
