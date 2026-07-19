import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('archie');
const read = name => fs.readFile(path.join(root, name), 'utf8');

test('Archie phone surface is installable and caches Product-Only plus its verified app', async () => {
  const [html, manifest, sw] = await Promise.all([read('index.html'), read('manifest.webmanifest'), read('sw.js')]);
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.name, 'Archie — Product Only');
  assert.equal(parsed.display, 'standalone');
  assert.equal(parsed.start_url, './');
  assert.equal(parsed.scope, './');
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-mobile-web-app-title/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /What should Archie make\?/);
  assert.match(html, /One prompt\. One runnable app\./);
  assert.match(html, /apps\/field-notes/);
  assert.match(sw, /archie-product-only-v1/);
  for (const asset of ['./', './index.html', './manifest.webmanifest', './icon.svg', './apps/field-notes/', './apps/field-notes/index.html', './apps/field-notes/receipt.json']) {
    assert.match(sw, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(sw, /desktop\/desktop\.(?:css|js)/);
});

test('generated neural router retains its exact narrow infrastructure admission', async () => {
  const [modelText, admissionText] = await Promise.all([read('router-model.json'), read('router-admission.json')]);
  const model = JSON.parse(modelText);
  const admission = JSON.parse(admissionText);
  const digest = crypto.createHash('sha256').update(modelText).digest('hex');
  assert.equal(digest, '202a6957bd0bbf0a9b4e92cd74014b2b9689393be539de8f5ab44f567a691916');
  assert.equal(admission.model_sha256, digest);
  assert.equal(model.schema, 'archie-local-neural-router/v1');
  assert.equal(model.model_id, 'archie-router-bytehash-perceptron-v1');
  assert.equal(model.response_generation, 'deterministic');
  assert.equal(admission.admission, 'admitted');
  assert.equal(admission.admitted_for, 'local task-mode routing only');
  assert.equal(admission.neural_response_generation, false);
  assert.equal(admission.training.changed_tensors, true);
  assert.ok(admission.training.initial_tensors_sha256 !== admission.training.final_tensors_sha256);
  assert.ok(admission.evaluation.full_accuracy >= 0.90);
  assert.equal(admission.evaluation.admitted_accuracy, 1);
  assert.ok(admission.evaluation.admitted_coverage >= 0.90);
  assert.ok(Object.values(admission.gates).every(Boolean));
});

test('Product-Only opens one independent runnable artifact with an exact receipt', async () => {
  const [html, artifact, receiptText] = await Promise.all([
    read('index.html'),
    read('apps/field-notes/index.html'),
    read('apps/field-notes/receipt.json')
  ]);
  const receipt = JSON.parse(receiptText);
  assert.match(html, /aria-label="What should Archie make\?"/);
  assert.match(html, />Make app</);
  assert.match(html, /id="preview"/);
  assert.match(html, /download="archie-app\.html"/);
  assert.doesNotMatch(html, />TRAINING<|>FEATS<|>REEL<|Tell Archie what you need handled|>Ask Archie</i);
  assert.equal(receipt.result, 'passed');
  assert.equal(receipt.artifact.independent_runnable, true);
  assert.equal(receipt.artifact.server_calls, 0);
  assert.equal(crypto.createHash('sha256').update(artifact).digest('hex'), receipt.artifact.sha256);
});

test('Field Notes implements requested phone behavior locally without external calls', async () => {
  const artifact = await read('apps/field-notes/index.html');
  assert.match(artifact, /localStorage/);
  assert.match(artifact, /type="file"/);
  assert.match(artifact, /capture="environment"/);
  assert.match(artifact, /navigator\.geolocation/);
  assert.match(artifact, /comma separated/);
  assert.match(artifact, /type="search"/);
  assert.match(artifact, /Export JSON/);
  assert.match(artifact, /min-height:44px/);
  assert.doesNotMatch(artifact, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});
