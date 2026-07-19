import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('archie');
const read = name => fs.readFile(path.join(root, name), 'utf8');
const readScripts = async () => (await Promise.all(['archie.js', 'archie-media.js', 'archie-media-surface.js', 'archie-media-variants.js', 'archie-media-image.js', 'archie-model-lab.js', 'archie-runtime.js', 'archie-runtime-base.js', 'archie-surface-bridge.js'].map(read))).join('\n');

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
  assert.match(sw, /archie-operator-v4/);
  for (const asset of ['./', './index.html', './archie.css', './archie.js', './archie-media.js', './archie-media-surface.js', './archie-media-variants.js', './archie-media-image.js', './archie-model-lab.js', './archie-runtime.js', './archie-runtime-base.js', './archie-surface-bridge.js', './router-model.json', './router-admission.json', './surface-perceptron-model.json', './surface-perceptron-admission.json', './manifest.webmanifest', './icon.svg']) {
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


test('admitted screenshot router has exact digest and stays inside its coarse-layout boundary', async () => {
  const [modelText, admissionText] = await Promise.all([read('surface-perceptron-model.json'), read('surface-perceptron-admission.json')]);
  const model = JSON.parse(modelText);
  const admission = JSON.parse(admissionText);
  const digest = crypto.createHash('sha256').update(modelText).digest('hex');
  assert.equal(digest, '6703c4095dd8c2e65f58f8f4c5e18fbe51f2c93c8f71e3aeab363216a9aee705');
  assert.equal(admission.model_sha256, digest);
  assert.equal(model.schema, 'archie-screenshot-perceptron/v1');
  assert.equal(model.model_id, 'archie-surface-perceptron-int8-v1');
  assert.deepEqual(model.classes, ['document', 'chat', 'receipt', 'calendar', 'error', 'notes']);
  assert.equal(admission.promotion, 'admitted');
  assert.equal(admission.admitted_for, 'six coarse screenshot-layout classes only');
  assert.ok(admission.boundaries.includes('no OCR'));
  assert.ok(admission.boundaries.includes('no arbitrary-photo understanding'));
  assert.equal(admission.evaluation.quantized_accuracy, 1);
});

test('Archie exposes one useful path and the exact neural-versus-deterministic boundary', async () => {
  const [html, js] = await Promise.all([read('index.html'), readScripts()]);
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
  const js = await readScripts();
  for (const term of ['request', 'response', 'mode', 'timestamp', 'digest', 'neural_evidence', 'model_id', 'model_sha256', 'neural_margin', 'activeObjective']) {
    assert.match(js, new RegExp(term));
  }
  assert.match(js, /localStorage\.setItem/);
  assert.match(js, /navigator\.clipboard/);
  assert.match(js, /serviceWorker\.register/);
  assert.doesNotMatch(js, /navigator\.share|execution:'not-performed'|archie-objective-packet/);
});

test('Archie multimodal showcase executes real browser primitives instead of pre-rendered proof theater', async () => {
  const [html, css, js] = await Promise.all([read('index.html'), read('archie.css'), readScripts()]);
  for (const id of ['motionField', 'imageInput', 'voiceButton', 'imageStage', 'pictureGrid', 'lossChart', 'confusionMatrix', 'distillButton', 'quantCanvas', 'recordShowcase']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const primitive of ['SEE', 'HEAR', 'ROUTE', 'COMPOSE', 'COMPRESS', 'SPEAK']) {
    assert.match(html, new RegExp(`>${primitive}<`));
  }
  assert.match(html, /Six views from one picture/);
  assert.match(html, /Train a student in this tab/);
  assert.match(html, /Screen recording is downloaded locally as WebM and is never uploaded/);
  assert.match(css, /#motionField\{position:fixed;inset:0/);
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  for (const mechanism of [
    'createImageBitmap',
    'analyzeCanvas',
    'loadSurfaceRouter',
    'classifySurface',
    'renderVariant',
    'getUserMedia',
    'SpeechRecognition',
    'speechSynthesis',
    'getDisplayMedia',
    'MediaRecorder',
    'distillStudent',
    'Float32Array',
    'Math.log',
    'renderConfusionMatrix',
    'quantizeStudent',
  ]) assert.match(js, new RegExp(mechanism));
  assert.match(js, /video\/webm/);
  assert.match(js, /image_signature/);
  assert.match(js, /SURFACE_MODEL_SHA256='6703c4095dd8c2e65f58f8f4c5e18fbe51f2c93c8f71e3aeab363216a9aee705'/);
  assert.match(js, /no OCR, object recognition/);
  assert.match(js, /response_generation:'deterministic'/);
  assert.doesNotMatch(js, /api\.openai|anthropic|gemini|replicate|fal\.ai/i);
});
