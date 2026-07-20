#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './protocol-decoder.mjs';
import { ROUTES, ROUTE_PROTOCOL } from './train-route-model.mjs';
import { trainContextRouteModel, evaluateContextRoutes, predictContextRoute } from './route-context-model.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => { const index = args.indexOf(flag); return index === -1 ? fallback : args[index + 1]; };
const dataPath = value('--data');
const evalsDir = value('--evals');
const suitePath = value('--suite');
const modelOut = value('--model-out');
const receiptOut = value('--out', 'foundry/archie-protocol/runs/context-route-model-receipt.json');
if (!dataPath || !evalsDir) throw new Error('Usage: --data route-train.json --evals <dir> [--suite suite-80.json] [--model-out archie-operator/model.json]');

const rows = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const trained = trainContextRouteModel(rows, {
  hidden: Number(value('--hidden', 512)),
  epochs: Number(value('--epochs', 80)),
  seed: Number(value('--seed', 3407)),
  minCount: Number(value('--min-count', 2))
});
const readJsonl = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const suites = {};
for (const name of ['router-v2-original-heldout', 'router-real-v2-heldout', 'router-real-v3-final']) {
  const file = path.join(evalsDir, `${name}.jsonl`);
  if (fs.existsSync(file)) suites[name] = evaluateContextRoutes(trained, readJsonl(file));
}
let suite = null;
if (suitePath && fs.existsSync(suitePath)) {
  const cases = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
  suite = evaluateContextRoutes(trained, cases);
  suite.detail = cases.map(item => ({ id: item.id, expected: item.expected, actual: predictContextRoute(trained, item).route }));
}
const parameters = trained.model.hidden * trained.model.input + trained.model.hidden + trained.model.classes * trained.model.hidden + trained.model.classes;
const body = {
  schema: 'archie-context-route-model-receipt/v1',
  model: { method: 'order-context-sparse-mlp/v1', parameters, hidden: trained.model.hidden, vocabulary_features: trained.vocabulary.length },
  data: { rows: rows.length, digest: sha256(rows.map(row => ({ route: row.route, prompt: row.prompt, attachments: row.attachments || null, memory: row.memory || null }))) },
  evaluation: { suites: Object.fromEntries(Object.entries(suites).map(([name, result]) => [name, { examples: result.examples, accuracy: result.accuracy, errors: result.errors.slice(0, 24) }])), suite_80: suite },
  promotion: 'not-admitted',
  claim_boundary: 'Order/context-aware routing only. Attached-file and memory features are metadata signals, not file-content understanding or durable memory.'
};
const receipt = { ...body, receipt_digest: sha256(body) };
fs.mkdirSync(path.dirname(path.resolve(receiptOut)), { recursive: true });
fs.writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);

if (modelOut) {
  const quantize = matrix => {
    const scales = [], encoded = [];
    for (const row of matrix) {
      let max = 0; for (const value of row) max = Math.max(max, Math.abs(value));
      const scale = max / 127 || 1; scales.push(Number(scale.toPrecision(8)));
      const bytes = Int8Array.from(row, value => Math.max(-127, Math.min(127, Math.round(value / scale))));
      encoded.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'));
    }
    return { scales, rows: encoded };
  };
  const artifactBody = {
    schema: 'archie-route-model/v3',
    encoder: 'order-context/v1',
    routes: [...ROUTES],
    route_protocol: ROUTE_PROTOCOL,
    config: trained.config,
    vocabulary: trained.vocabulary,
    dims: { input: trained.model.input, hidden: trained.model.hidden, classes: trained.model.classes },
    parameters,
    weights_int8: {
      W1: quantize(trained.model.W1), W2: quantize(trained.model.W2),
      b1: Array.from(trained.model.b1, value => Number(value.toPrecision(8))),
      b2: Array.from(trained.model.b2, value => Number(value.toPrecision(8)))
    },
    evaluation: body.evaluation,
    receipt_digest: receipt.receipt_digest,
    promotion: 'not-admitted',
    claim_boundary: body.claim_boundary
  };
  const artifact = { ...artifactBody, model_digest: sha256(artifactBody) };
  fs.mkdirSync(path.dirname(path.resolve(modelOut)), { recursive: true });
  fs.writeFileSync(modelOut, `${JSON.stringify(artifact)}\n`);
}
console.log(JSON.stringify({ ok: true, parameters, suites: Object.fromEntries(Object.entries(suites).map(([name, result]) => [name, result.accuracy])), suite_80: suite?.accuracy ?? null, receipt: path.resolve(receiptOut), model_out: modelOut ? path.resolve(modelOut) : null }, null, 2));
