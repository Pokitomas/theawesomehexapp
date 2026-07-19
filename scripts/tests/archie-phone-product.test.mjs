import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('archie');
const read = name => fs.readFile(path.join(root, name), 'utf8');

test('Archie 95 is installable and caches its central runtime', async () => {
  const [html, manifest, sw] = await Promise.all([read('index.html'), read('manifest.webmanifest'), read('sw.js')]);
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.name, 'Archie 95 — Local Operator');
  assert.equal(parsed.display, 'standalone');
  assert.equal(parsed.start_url, './');
  assert.equal(parsed.scope, './');
  assert.equal(parsed.theme_color, '#008080');
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-mobile-web-app-title/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /Archie 95/);
  assert.match(html, /What needs handling\?/);
  assert.match(sw, /archie95-local-operator-v1/);
  for (const asset of ['./', './index.html', './archie.css', './archie.js', './router-model.json', './manifest.webmanifest', './icon.svg']) {
    assert.match(sw, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
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

test('central phone operator exposes one command, result, objective, and local history', async () => {
  const [html, runtime, css] = await Promise.all([read('index.html'), read('archie.js'), read('archie.css')]);
  for (const id of ['prompt','ask','clearPrompt','result','modeLabel','answer','receipt','copy','objective','objectiveText','clearObjective','count','clearHistory','items','modelState','modelDetail']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(runtime, /loadNeuralRouter/);
  assert.match(runtime, /localStorage/);
  assert.match(css, /min-height:38px/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(html, /What should Archie make\?|Make app/i);
});
