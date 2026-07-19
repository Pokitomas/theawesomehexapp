#!/usr/bin/env node
// Train the Archie Sprawl constrained protocol decoder and emit a
// digest-addressed, promotion:not-admitted training receipt.
//
// This executes the report's Next Step #1 ("train a compact decoder over
// OBSERVE, RETRIEVE, ASK, DECOMPOSE, ORDER, COMPARE, DRAFT, SCHEDULE, VERIFY,
// STOP") and Next Step #2 (promote the seven hard-margin failures into paired
// contrastive cases) with a real from-scratch training run and honest held-out
// measurement. It makes no admission, production, or general-competence claim.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { digest, stableJSONStringify, assertNoSecrets } from '../util.mjs';
import { OPCODES, MAX_LENGTH, MIN_LENGTH, NUM_OPCODES } from './protocol-grammar.mjs';
import { INTENT_PROTOCOL, INTENTS, buildCorpus, hardMarginSlice } from './protocol-corpus.mjs';
import { buildVocabulary, trainDecoder, evaluate } from './protocol-decoder.mjs';

const execFileAsync = promisify(execFile);
const METHOD = 'archie-sprawl-protocol-decoder/v1';

// Fixed acceptance targets, declared before measurement. These are the
// decoder's *own* local gates and are deliberately distinct from the frozen
// router's numbers in the report (a different model trained on far more data).
export const GATES = Object.freeze({
  protocol_syntax_valid: 1.0,     // required by construction (grammar-masked decode)
  heldout_exact_match: 0.85,      // group-disjoint development generalization target
  hardmargin_exact_match: 0.75    // matches the report's "hard-margin above 75%" target
});

// Group-disjoint split: hold out the last surface family of every intent for
// development so no family straddles the split, while foils always train.
function splitCorpus(examples) {
  const lastFamilyByIntent = new Map();
  for (const example of examples) {
    if (example.slice !== 'base') continue;
    const familyIndex = Number(example.group.split(':fam')[1]);
    const current = lastFamilyByIntent.get(example.intent);
    if (current === undefined || familyIndex > current) lastFamilyByIntent.set(example.intent, familyIndex);
  }
  const train = [];
  const development = [];
  for (const example of examples) {
    if (example.slice === 'base') {
      const familyIndex = Number(example.group.split(':fam')[1]);
      if (familyIndex === lastFamilyByIntent.get(example.intent)) development.push(example);
      else train.push(example);
    } else {
      train.push(example); // foils
    }
  }
  return { train, development };
}

function opcodeNames(sequence) {
  return sequence.map(index => OPCODES[index]);
}

function summarizeRecords(records) {
  return records.map(record => ({
    id: record.id,
    axis: record.axis,
    intent: record.intent,
    prompt: record.prompt,
    expected: opcodeNames(record.expected),
    predicted: opcodeNames(record.predicted),
    valid: record.valid,
    exact: record.exact,
    opcode_f1: record.opcode_f1
  }));
}

export function runTraining({ epochs = 600, hidden = 32, embed = 16, lr = 0.01, weightDecay = 1e-3, minCount = 2, seed = 1234 } = {}) {
  const corpus = buildCorpus();
  const { train, development } = splitCorpus(corpus);
  const hard = hardMarginSlice();
  const vocab = buildVocabulary(train, { minCount });

  const started = Date.now();
  const { model, history } = trainDecoder(train, vocab, { hidden, embed, epochs, lr, weightDecay, seed });
  const trainingMs = Date.now() - started;

  const trainEval = evaluate(model, train, vocab);
  const devEval = evaluate(model, development, vocab);
  const hardEval = evaluate(model, hard, vocab);

  const gateResults = {
    protocol_syntax_valid: {
      required: GATES.protocol_syntax_valid,
      measured: devEval.protocol_syntax_valid,
      pass: devEval.protocol_syntax_valid >= GATES.protocol_syntax_valid && hardEval.protocol_syntax_valid >= GATES.protocol_syntax_valid
    },
    heldout_exact_match: {
      required: GATES.heldout_exact_match,
      measured: devEval.exact_match,
      pass: devEval.exact_match >= GATES.heldout_exact_match
    },
    hardmargin_exact_match: {
      required: GATES.hardmargin_exact_match,
      measured: hardEval.exact_match,
      pass: hardEval.exact_match >= GATES.hardmargin_exact_match
    }
  };
  const gatesPassed = Object.values(gateResults).every(result => result.pass);

  return {
    model, vocab, history, trainingMs,
    corpus, train, development, hard,
    trainEval, devEval, hardEval,
    gateResults, gatesPassed
  };
}

// Record the committed revision only when no tracked file is modified. A
// receipt produced from a dirty tree records null, so code_revision never
// claims to bind code that was not actually committed. Untracked files (the
// fresh receipt itself) do not invalidate the binding.
async function resolveRevision(cwd = process.cwd()) {
  try {
    const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd });
    if (dirty.trim()) return null;
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    const value = stdout.trim();
    if (/^[0-9a-f]{40}$/i.test(value)) return value;
  } catch {}
  return null;
}

export function buildReceipt(result, { codeRevision = null, hyperparameters } = {}) {
  const paramCount = [result.model.Wenc, result.model.benc, result.model.Ein, result.model.Wh, result.model.bh, result.model.Wo, result.model.bo]
    .reduce((total, tensor) => total + tensor.data.length, 0);

  const body = {
    schema: 'archie-sprawl-protocol-decoder-receipt/v1',
    method: METHOD,
    executes_report_next_steps: ['train constrained protocol decoder', 'promote hard-margin failures into contrastive pairs'],
    code_revision: codeRevision,
    opcodes: OPCODES,
    grammar: { min_length: MIN_LENGTH, max_length: MAX_LENGTH, opcode_count: NUM_OPCODES },
    intents: INTENTS,
    intent_protocol: Object.fromEntries(INTENTS.map(intent => [intent, INTENT_PROTOCOL[intent]])),
    model: {
      random_initialization: true,
      pretrained: false,
      teacher: null,
      external_runtime: false,
      parameters: paramCount,
      hyperparameters
    },
    data: {
      total_examples: result.corpus.length,
      train_examples: result.train.length,
      development_examples: result.development.length,
      hard_margin_examples: result.hard.length,
      vocabulary_features: result.vocab.size,
      split: 'group-disjoint: one surface family per intent held out for development; hard-margin slice never trained'
    },
    training: {
      // Wall-clock timing is intentionally excluded from the digested body so
      // the receipt digest is content-reproducible: the model weights, metrics,
      // and loss history are fully deterministic for a fixed seed and revision.
      epochs: hyperparameters.epochs,
      loss_history: result.history
    },
    evaluation: {
      train: { count: result.trainEval.count, exact_match: result.trainEval.exact_match, protocol_syntax_valid: result.trainEval.protocol_syntax_valid, opcode_f1: result.trainEval.opcode_f1 },
      development: { count: result.devEval.count, exact_match: result.devEval.exact_match, protocol_syntax_valid: result.devEval.protocol_syntax_valid, opcode_f1: result.devEval.opcode_f1 },
      hard_margin: { count: result.hardEval.count, exact_match: result.hardEval.exact_match, protocol_syntax_valid: result.hardEval.protocol_syntax_valid, opcode_f1: result.hardEval.opcode_f1 }
    },
    gates: result.gateResults,
    gates_passed: result.gatesPassed,
    hard_margin_detail: summarizeRecords(result.hardEval.records),
    development_detail: summarizeRecords(result.devEval.records),
    promotion: 'not-admitted',
    claim_boundary: [
      'Bounded from-scratch protocol-decoder training on a small designed corpus.',
      'Protocol syntax validity is guaranteed by grammar-masked decoding, not by model quality.',
      'Exact-match numbers are decoder-local and are NOT the frozen router\'s route-accuracy figures.',
      'No general generation, no autoregressive prose, no application execution, no admission.'
    ].join(' ')
  };
  assertNoSecrets(body);
  return { ...body, receipt_digest: digest(body) };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index === -1 ? fallback : args[index + 1];
  };
  const hyperparameters = {
    epochs: Number(value('--epochs', 600)),
    hidden: Number(value('--hidden', 32)),
    embed: Number(value('--embed', 16)),
    lr: Number(value('--lr', 0.01)),
    weightDecay: Number(value('--weight-decay', 1e-3)),
    minCount: Number(value('--min-count', 2)),
    seed: Number(value('--seed', 1234))
  };
  const outDir = value('--out', path.join('foundry', 'archie-protocol', 'runs'));

  const result = runTraining(hyperparameters);
  const codeRevision = await resolveRevision();
  const receipt = buildReceipt(result, { codeRevision, hyperparameters });

  await fs.mkdir(outDir, { recursive: true });
  const receiptPath = path.join(outDir, 'protocol-decoder-receipt.json');
  await fs.writeFile(receiptPath, `${stableJSONStringify(receipt)}\n`, 'utf8');

  console.log(stableJSONStringify({
    ok: true,
    receipt_path: path.resolve(receiptPath),
    receipt_digest: receipt.receipt_digest,
    parameters: receipt.model.parameters,
    vocabulary_features: receipt.data.vocabulary_features,
    train_exact_match: receipt.evaluation.train.exact_match,
    heldout_exact_match: receipt.evaluation.development.exact_match,
    hard_margin_exact_match: receipt.evaluation.hard_margin.exact_match,
    protocol_syntax_valid: receipt.evaluation.development.protocol_syntax_valid,
    gates_passed: receipt.gates_passed,
    promotion: receipt.promotion
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(stableJSONStringify({ ok: false, error: String(error?.stack || error?.message || error) }));
    process.exitCode = 1;
  });
}
