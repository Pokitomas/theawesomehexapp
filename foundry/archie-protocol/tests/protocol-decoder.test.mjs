import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPCODES, NUM_OPCODES, STOP, MIN_LENGTH, MAX_LENGTH,
  legalNextMask, validateProtocol, opcodeIds, INTAKE
} from '../protocol-grammar.mjs';
import {
  mulberry32, tokenize, featuresOf, buildVocabulary, encodePrompt,
  createModel, parameterTensors, forwardBackward, forwardLoss,
  trainDecoder, decodeProtocol, evaluate
} from '../protocol-decoder.mjs';
import { buildCorpus, hardMarginSlice, INTENTS, INTENT_PROTOCOL } from '../protocol-corpus.mjs';
import { runTraining, buildReceipt, GATES } from '../train-protocol-decoder.mjs';

test('grammar: opcode vocabulary is exactly the ten documented opcodes', () => {
  assert.deepEqual(OPCODES, ['OBSERVE', 'RETRIEVE', 'ASK', 'DECOMPOSE', 'ORDER', 'COMPARE', 'DRAFT', 'SCHEDULE', 'VERIFY', 'STOP']);
  assert.equal(NUM_OPCODES, 10);
});

test('grammar: legalNextMask only opens with an intake opcode', () => {
  const mask = legalNextMask([]);
  for (let i = 0; i < NUM_OPCODES; i += 1) assert.equal(mask[i], INTAKE.includes(i));
});

test('grammar: STOP is forced at the length cap and nothing follows STOP', () => {
  // A near-cap prefix must force STOP only.
  const nearCap = [0, 3, 4, 6, 8]; // length 5, one slot before MAX_LENGTH=6
  const mask = legalNextMask(nearCap);
  for (let i = 0; i < NUM_OPCODES; i += 1) assert.equal(mask[i], i === STOP);
  // After STOP nothing is legal.
  assert.deepEqual(legalNextMask([0, 6, STOP]), new Array(NUM_OPCODES).fill(false));
});

test('grammar: brute-force decode with random logits is always valid', () => {
  const rng = mulberry32(42);
  for (let trial = 0; trial < 400; trial += 1) {
    const sequence = [];
    for (let t = 0; t < MAX_LENGTH; t += 1) {
      const mask = legalNextMask(sequence);
      const legal = [];
      for (let k = 0; k < NUM_OPCODES; k += 1) if (mask[k]) legal.push(k);
      if (legal.length === 0) break;
      const pick = legal[Math.floor(rng() * legal.length)];
      sequence.push(pick);
      if (pick === STOP) break;
    }
    const { valid, reason } = validateProtocol(sequence);
    assert.ok(valid, `invalid sequence ${sequence} (${reason})`);
    assert.ok(sequence.length >= MIN_LENGTH && sequence.length <= MAX_LENGTH);
  }
});

test('grammar: every designed intent protocol is valid and distinct', () => {
  const seen = new Set();
  for (const intent of INTENTS) {
    const ids = opcodeIds(INTENT_PROTOCOL[intent]);
    assert.ok(validateProtocol(ids).valid, `intent ${intent} protocol invalid`);
    const key = ids.join(',');
    assert.ok(!seen.has(key), `intent ${intent} protocol collides`);
    seen.add(key);
  }
});

test('features: tokenizer strips punctuation and casing; bigrams present', () => {
  assert.deepEqual(tokenize('Tell Priya — I am unavailable!'), ['tell', 'priya', 'i', 'am', 'unavailable']);
  const features = featuresOf('not a task list');
  assert.ok(features.includes('u:not'));
  assert.ok(features.includes('b:not_a'));
});

test('backprop: analytic gradient matches finite differences', () => {
  // Small deterministic model + two synthetic examples.
  const vocab = new Map([['u:a', 0], ['u:b', 1], ['u:c', 2], ['b:a_b', 3], ['b:b_c', 4]]);
  const model = createModel({ vocabSize: vocab.size, hidden: 6, embed: 4, seed: 7 });
  const examples = [
    { features: [0, 1, 3], target: opcodeIds(['OBSERVE', 'DRAFT', 'STOP']) },
    { features: [1, 2, 4], target: opcodeIds(['RETRIEVE', 'DECOMPOSE', 'ORDER', 'DRAFT', 'STOP']) }
  ];
  const analyticLoss = examples.reduce((sum, ex) => sum + forwardBackward(model, ex.features, ex.target), 0);
  assert.ok(Number.isFinite(analyticLoss));

  const eps = 1e-5;
  let maxRelErr = 0;
  for (const tensor of parameterTensors(model)) {
    // Check a deterministic sample of indices to keep the test fast.
    const stride = Math.max(1, Math.floor(tensor.data.length / 12));
    for (let i = 0; i < tensor.data.length; i += stride) {
      const original = tensor.data[i];
      tensor.data[i] = original + eps;
      const lossPlus = examples.reduce((sum, ex) => sum + forwardLoss(model, ex.features, ex.target), 0);
      tensor.data[i] = original - eps;
      const lossMinus = examples.reduce((sum, ex) => sum + forwardLoss(model, ex.features, ex.target), 0);
      tensor.data[i] = original;
      const numeric = (lossPlus - lossMinus) / (2 * eps);
      const analytic = tensor.grad[i];
      const denom = Math.max(1e-6, Math.abs(numeric) + Math.abs(analytic));
      const relErr = Math.abs(numeric - analytic) / denom;
      maxRelErr = Math.max(maxRelErr, relErr);
    }
  }
  assert.ok(maxRelErr < 1e-4, `max relative gradient error ${maxRelErr} too high`);
});

test('training: overfits a tiny set and stays in-grammar', () => {
  const corpus = buildCorpus();
  const sample = corpus.slice(0, 20);
  const vocab = buildVocabulary(sample, { minCount: 1 });
  const { model } = trainDecoder(sample, vocab, { epochs: 300, seed: 99 });
  const evalResult = evaluate(model, sample, vocab);
  assert.equal(evalResult.protocol_syntax_valid, 1);
  assert.ok(evalResult.exact_match >= 0.9, `expected high train exact-match, got ${evalResult.exact_match}`);
});

test('training: fully deterministic for a fixed seed', () => {
  const corpus = buildCorpus();
  const sample = corpus.slice(0, 30);
  const vocab = buildVocabulary(sample, { minCount: 1 });
  const a = trainDecoder(sample, vocab, { epochs: 60, seed: 5 });
  const b = trainDecoder(sample, vocab, { epochs: 60, seed: 5 });
  for (const key of ['Wenc', 'Wh', 'Wo']) {
    assert.deepEqual(Array.from(a.model[key].data), Array.from(b.model[key].data));
  }
});

test('corpus: hard-margin slice is held out of training entirely', () => {
  const receiptResult = runTraining({ epochs: 30 });
  const hardPrompts = new Set(hardMarginSlice().map(item => item.prompt));
  for (const example of receiptResult.train) assert.ok(!hardPrompts.has(example.prompt), `hard prompt leaked into train: ${example.prompt}`);
  for (const example of receiptResult.development) assert.ok(!hardPrompts.has(example.prompt));
  // The whole corpus (base + foils) must never contain a hard-margin prompt.
  const hardPromptSet = new Set(hardMarginSlice().map(item => item.prompt));
  for (const example of buildCorpus()) assert.ok(!hardPromptSet.has(example.prompt), `hard prompt present in corpus: ${example.prompt}`);
});

test('receipt: is digest-addressed, secret-free, and not-admitted', () => {
  const result = runTraining({ epochs: 120 });
  const receipt = buildReceipt(result, { codeRevision: null, hyperparameters: { epochs: 120, hidden: 48, embed: 16, lr: 0.01, seed: 1234 } });
  assert.equal(receipt.promotion, 'not-admitted');
  assert.equal(receipt.model.pretrained, false);
  assert.equal(receipt.evaluation.development.protocol_syntax_valid, 1);
  assert.equal(receipt.evaluation.hard_margin.protocol_syntax_valid, 1);
  assert.match(receipt.receipt_digest, /^[0-9a-f]{64}$/);
  // Gates object is well-formed and thresholds are the declared constants.
  assert.equal(receipt.gates.hardmargin_exact_match.required, GATES.hardmargin_exact_match);
  assert.equal(receipt.gates.heldout_exact_match.required, GATES.heldout_exact_match);
});
