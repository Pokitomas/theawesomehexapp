import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
import {
  PRODUCT_ARCHETYPES,
  compileDiverseProducts,
  compileProductHtml,
  predictProductBlueprint,
  selectDiverseBlueprints,
  tokenizeBlueprintText,
} from '../../archie/product-studio.mjs';

function readChunkedJson(relativeDirectory) {
  const directory = new URL(relativeDirectory, import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', directory), 'utf8'));
  const payload = Buffer.concat(manifest.parts.map(part => {
    const bytes = fs.readFileSync(new URL(part.path, directory));
    assert.equal(bytes.length, part.bytes);
    assert.equal(sha256(bytes), part.sha256);
    return bytes;
  }));
  assert.equal(payload.length, manifest.logical_bytes);
  assert.equal(sha256(payload), manifest.logical_sha256);
  return { model: JSON.parse(payload.toString('utf8')), manifest, payload };
}
const loadedModel = readChunkedJson('../../archie/product-style-model/');
const model = loadedModel.model;
const receipt = JSON.parse(fs.readFileSync(new URL('../../archie/product-style-model-receipt.json', import.meta.url), 'utf8'));
const app = fs.readFileSync(new URL('../../archie/apps/product-studio/index.html', import.meta.url), 'utf8');
const archie = fs.readFileSync(new URL('../../archie/index.html', import.meta.url), 'utf8');

test('visual blueprint artifact is byte-bound to a large held-out training receipt', () => {
  assert.equal(loadedModel.manifest.logical_sha256, receipt.artifact.logical_sha256);
  assert.equal(loadedModel.payload.length, receipt.artifact.logical_bytes);
  assert.equal(loadedModel.manifest.parts.length, receipt.artifact.part_count);
  assert.equal(receipt.training_rows, 36000);
  assert.equal(receipt.heldout_rows, 7200);
  assert.equal(model.promotion, 'not-admitted');
  assert.equal(receipt.promotion, 'not-admitted');
  assert.equal(receipt.metrics.archetype.accuracy, 1);
  assert.ok(receipt.metrics.layout.accuracy >= 0.97);
  assert.ok(receipt.metrics.style.accuracy >= 0.96);
  assert.ok(receipt.metrics.density.accuracy >= 0.99);
  assert.ok(receipt.metrics.motion.accuracy >= 0.99);
});

test('browser tokenizer and trained heads classify all product archetypes', () => {
  assert.deepEqual(tokenizeBlueprintText('Field notes app'), ['field', 'notes', 'app', 'field notes', 'notes app']);
  const prompts = {
    tracker: 'Build a progress tracker with status rows and compact controls.',
    dashboard: 'Create an analytics dashboard for monitoring performance metrics.',
    planner: 'Make a weekly planner with milestones on a timeline.',
    editor: 'Build a writing editor with an editor and preview split pane.',
    catalog: 'Create a product catalog as a visual card gallery.',
    communication: 'Make a team inbox and message center with a sidebar list.',
    learning: 'Build a study coach and lesson tracker with a guided flow.',
    utility: 'Create a single purpose converter with one focused screen.',
    field: 'Make a field notes inspection app for on location capture.',
    decision: 'Build a decision matrix that scores options and tradeoffs.',
  };
  for (const [expected, prompt] of Object.entries(prompts)) {
    assert.equal(predictProductBlueprint(model, prompt).archetype, expected, prompt);
  }
  assert.deepEqual([...PRODUCT_ARCHETYPES].sort(), Object.keys(prompts).sort());
});

test('six requested variants have unique structural and visual identities', () => {
  const variants = selectDiverseBlueprints(model, 'Build a cinematic field inspection tracker with large touch controls and evidence capture.', 6);
  assert.equal(variants.length, 6);
  assert.equal(new Set(variants.map(value => `${value.layout}:${value.style}`)).size, 6);
  assert.equal(new Set(variants.map(value => value.identity)).size, 6);
  assert.ok(variants.slice(1).every(value => value.diversity_distance >= 6));
  assert.ok(new Set(variants.map(value => value.layout)).size >= 4);
  assert.ok(new Set(variants.map(value => value.style)).size >= 4);
});

test('compiler emits standalone local interactive apps, not recolored screenshots', () => {
  const prompt = 'Build an editorial neighborhood resource catalog with a card mosaic and comfortable density.';
  const products = compileDiverseProducts(model, prompt, 6);
  const hashes = new Set();
  const structuralMarkers = new Set();
  for (const { blueprint, html } of products) {
    hashes.add(sha256(html));
    structuralMarkers.add(blueprint.layout);
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /localStorage/);
    assert.match(html, /Export JSON/);
    assert.match(html, new RegExp(`data-layout="${blueprint.layout}"`));
    assert.match(html, new RegExp(`data-style="${blueprint.style}"`));
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /\bfetch\s*\(/);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
  }
  assert.equal(hashes.size, 6);
  assert.ok(structuralMarkers.size >= 4);
});

test('every layout family compiles responsive runnable HTML', () => {
  const blueprint = predictProductBlueprint(model, 'Build a calm local field notes app.');
  for (const layout of ['split-workbench','card-mosaic','ledger','timeline','command-deck','canvas','list-detail','kiosk','board','stacked-flow']) {
    const html = compileProductHtml({ ...blueprint, layout, identity: `field:${layout}:calm:balanced:subtle` }, `Field capture in a ${layout}`);
    assert.match(html, new RegExp(`data-layout="${layout}"`));
    assert.match(html, /@media\(max-width:760px\)/);
    assert.match(html, /id="capture"/);
    assert.match(html, /id="items"/);
  }
});

test('Product Studio is publicly reachable through Archie and exposes model truth', () => {
  assert.match(app, /One brief[\s\S]*Actually different products/);
  assert.match(app, /loadChunkedProductModel/);
  assert.match(app, /product-style-model/);
  assert.match(app, /promotion:not-admitted/);
  assert.match(app, /Build diverse products/);
  assert.match(archie, /apps\/product-studio/);
  assert.match(archie, /Product Studio/);
});
