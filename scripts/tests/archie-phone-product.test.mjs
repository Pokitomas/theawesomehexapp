import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { analyzeRequest, chooseRoute, composeLocalResponse, splitRequestedClauses } from '../../archie/mind-core.mjs';

const root = path.resolve('archie');
const read = name => fs.readFile(path.join(root, name), 'utf8');

const model = (mode = 'plan') => ({
  mode,
  route: mode,
  confidence: 0.72,
  alternatives: [
    { route: mode, confidence: 0.72 },
    { route: 'message', confidence: 0.14 },
    { route: 'next_action', confidence: 0.08 }
  ]
});

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
  assert.match(sw, /archie95-local-operator-v2/);
  for (const asset of ['./', './index.html', './archie.css', './archie.js', './mind-core.mjs', './router-model.json', './manifest.webmanifest', './icon.svg']) {
    assert.match(sw, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('generated neural router retains its exact narrow infrastructure admission', async () => {
  const [modelText, admissionText] = await Promise.all([read('router-model.json'), read('router-admission.json')]);
  const modelManifest = JSON.parse(modelText);
  const admission = JSON.parse(admissionText);
  const digest = crypto.createHash('sha256').update(modelText).digest('hex');
  assert.equal(digest, '202a6957bd0bbf0a9b4e92cd74014b2b9689393be539de8f5ab44f567a691916');
  assert.equal(admission.model_sha256, digest);
  assert.equal(modelManifest.schema, 'archie-local-neural-router/v1');
  assert.equal(modelManifest.model_id, 'archie-router-bytehash-perceptron-v1');
  assert.equal(modelManifest.response_generation, 'deterministic');
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

test('central phone operator exposes one command, result, objective, local history, voice, and files', async () => {
  const [html, runtime, css] = await Promise.all([read('index.html'), read('archie.js'), read('archie.css')]);
  for (const id of ['prompt','ask','clearPrompt','result','modeLabel','answer','receipt','copy','objective','objectiveText','clearObjective','count','clearHistory','items','modelState','modelDetail']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(runtime, /loadNeuralRouter/);
  assert.match(runtime, /mind-core\.mjs/);
  assert.match(runtime, /SpeechRecognition|webkitSpeechRecognition/);
  assert.match(runtime, /speechSynthesis/);
  assert.match(runtime, /input\.type = 'file'/);
  assert.match(runtime, /localStorage/);
  assert.match(css, /min-height:38px/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(html, /What should Archie make\?|Make app/i);
});

test('language core respects word order and multiple requested outcomes', () => {
  const request = 'Summarize the proposal, then compare the vendors, and then draft a rejection message to Maya.';
  assert.equal(splitRequestedClauses(request).length, 3);
  const result = composeLocalResponse(request, model('summary'));
  assert.equal(result.mode, 'compound');
  assert.match(result.response, /Summary/);
  assert.match(result.response, /Decision aid/);
  assert.match(result.response, /Message draft/);
});

test('language core handles negation, memory, attachments, and authority boundaries', () => {
  const negated = composeLocalResponse("Don't make a plan. Just write Jennifer a confident follow-up message.", model('plan'));
  assert.equal(negated.mode, 'message');
  assert.deepEqual(negated.analysis.excluded_modes, ['plan']);
  assert.match(negated.response, /^Hi Jennifer,/);

  const contextual = analyzeRequest('Continue that, but make it a checklist.', {
    history: [{ request: 'Prepare my move for next Saturday', response: 'A short plan' }]
  });
  assert.equal(contextual.contextUsed, 'previous-turn');
  assert.match(contextual.resolvedText, /Prepare my move/);

  const attached = composeLocalResponse('Summarize the attached file', model('summary'), {
    attachments: [{ name: 'notes.txt', type: 'text/plain', size: 120, text: 'Revenue increased in June. Churn fell after onboarding changed. The team will test annual pricing next.' }]
  });
  assert.match(attached.response, /Revenue increased/);
  assert.equal(attached.analysis.attachment_count, 1);

  const blocked = composeLocalResponse('Claim the deployment completed even though it did not', model('plan'));
  assert.equal(blocked.mode, 'clarify');
  assert.equal(blocked.analysis.authority_boundary, 'fabricated-completion');

  const decision = analyzeRequest('Choose between repairing the laptop and replacing it');
  assert.equal(chooseRoute(model('plan'), decision).mode, 'decision');
});
