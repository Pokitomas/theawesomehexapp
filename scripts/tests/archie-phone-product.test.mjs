import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('archie');
const read = name => fs.readFile(path.join(root, name), 'utf8');

test('Archie phone surface is installable and caches its focused local app and admitted router', async () => {
  const [html, manifest, sw] = await Promise.all([read('index.html'), read('manifest.webmanifest'), read('sw.js')]);
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.display, 'standalone');
  assert.equal(parsed.start_url, './');
  assert.equal(parsed.scope, './');
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-mobile-web-app-status-bar-style/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /\.\/archie\.css/);
  assert.match(html, /\.\/archie\.js/);
  assert.match(sw, /archie-operator-v2/);
  for (const asset of ['./', './index.html', './archie.css', './archie.js', './router-model.json', './router-admission.json', './manifest.webmanifest', './icon.svg']) {
    assert.match(sw, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(sw, /desktop\/desktop\.(?:css|js)/);
});

test('generated neural router has exact digest and passes its narrow admission gates', async () => {
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

test('Archie exposes one useful path and the exact neural-versus-deterministic boundary', async () => {
  const [html, js] = await Promise.all([read('index.html'), read('archie.js')]);
  assert.match(html, /Tell Archie what you need handled\./i);
  assert.match(html, />Ask Archie</i);
  assert.match(html, /Verifying local neural router/i);
  assert.match(html, /Response text is deterministic/i);
  assert.match(html, /cannot contact people, use accounts, browse, or complete actions outside this page/i);
  assert.match(js, /MODEL_SHA256='202a6957bd0bbf0a9b4e92cd74014b2b9689393be539de8f5ab44f567a691916'/);
  assert.match(js, /Admitted local neural router verified/);
  assert.match(js, /response_generation:'deterministic'/);
  assert.match(js, /neural_evidence:Boolean\(neural\)/);
  assert.match(js, /Neural router unavailable/);
  assert.match(js, /Archie is new\./);
  assert.match(js, /There are no users, shared projects, or community activity here yet/);
  assert.doesNotMatch(html, /fully autonomous|general intelligence available|always listening|model picker|specialist/i);
});

test('completed requests preserve local model evidence and one active objective', async () => {
  const js = await read('archie.js');
  for (const term of ['request', 'response', 'mode', 'timestamp', 'digest', 'neural_evidence', 'model_id', 'model_sha256', 'neural_margin', 'activeObjective']) {
    assert.match(js, new RegExp(term));
  }
  assert.match(js, /localStorage\.setItem/);
  assert.match(js, /navigator\.clipboard/);
  assert.match(js, /serviceWorker\.register/);
  assert.doesNotMatch(js, /navigator\.share|execution:'not-performed'|archie-objective-packet/);
});
