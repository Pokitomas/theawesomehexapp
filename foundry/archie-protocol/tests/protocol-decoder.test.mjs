import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCorpus } from '../protocol-corpus.mjs';
import { INTENTS, protocolFor, isValidProtocol } from '../protocol-grammar.mjs';
import { buildVocabulary, evaluate, finiteDifferenceGradientCheck, modelDigest, parameterCount, predict, trainDecoder } from '../protocol-decoder.mjs';

const corpus = buildCorpus();
const decoder = trainDecoder(corpus.train);

test('grammar has one valid terminating protocol per intent', () => {
  assert.equal(INTENTS.length, 10);
  for (const intent of INTENTS) assert.equal(isValidProtocol(protocolFor(intent)), true);
});

test('corpus has deterministic 160 train examples', () => assert.equal(corpus.train.length, 160));

test('development set remains separate from train prompts', () => {
  const train = new Set(corpus.train.map(item => item.prompt.toLowerCase()));
  assert.ok(corpus.development.every(item => !train.has(item.prompt.toLowerCase())));
});

test('hard development prompts never occur in training', () => {
  const joined = corpus.train.map(item => item.prompt.toLowerCase()).join('\n');
  for (const item of corpus.hard) assert.equal(joined.includes(item.prompt.toLowerCase()), false, item.id);
});

test('vocabulary is deterministic and excludes one-off noise', () => {
  const first = buildVocabulary(corpus.train, { minCount: 2 });
  const second = buildVocabulary(corpus.train, { minCount: 2 });
  assert.deepEqual(first, second);
  assert.ok(first.length > 100);
});

test('hand-coded gradient agrees with finite differences', () => assert.ok(finiteDifferenceGradientCheck() < 1e-4));

test('training is deterministic', () => {
  const second = trainDecoder(corpus.train);
  assert.equal(modelDigest(decoder), modelDigest(second));
});

test('model remains small and auditable', () => {
  assert.ok(parameterCount(decoder) < 20000);
  assert.ok(parameterCount(decoder) > 5000);
});

test('all decoded protocols are syntactically valid', () => {
  for (const row of [...corpus.development, ...corpus.hard]) assert.equal(predict(decoder, row.prompt).valid, true);
});

test('decoder clears development gates without claiming admission', () => {
  const development = evaluate(decoder, corpus.development);
  const hard = evaluate(decoder, corpus.hard);
  assert.ok(development.exact_match >= 0.8);
  assert.ok(hard.exact_match >= 0.7);
});

test('training CLI writes a digest-bound not-admitted receipt', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const receiptPath = path.resolve(here, '../runs/protocol-decoder-receipt.json');
  if (!fs.existsSync(receiptPath)) return;
  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  assert.equal(receipt.promotion, 'not-admitted');
  assert.match(receipt.receipt_digest, /^[0-9a-f]{64}$/);
});
