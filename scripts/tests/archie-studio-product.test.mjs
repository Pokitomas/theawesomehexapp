import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJSON = async filename => JSON.parse(await fs.readFile(path.join(root, filename), 'utf8'));

const SAMPLE_TERMS = /purchase[- ]order|gmail|school|student|lbtb/i;

test('Archie Studio is the product and generated apps are independent artifacts', async () => {
  const contract = await readJSON('product/archie-studio-product.json');
  assert.equal(contract.schema, 'archie-studio-product/v1');
  assert.equal(contract.product.name, 'Archie');
  assert.match(contract.product.category, /application creation/i);
  assert.equal(contract.architecture.generated_app, 'an independent runnable and exportable artifact');
  assert.equal(contract.runtime.local_run_requires_openai_key, false);
  assert.ok(contract.surfaces.some(surface => surface.id === 'create' && surface.primary_action === 'Make app'));
  assert.ok(contract.surfaces.some(surface => surface.id === 'teach'));
  assert.ok(contract.forbidden.includes('generated apps trapped as cards inside Archie'));
});

test('sample-specific domains cannot define core Archie surfaces', async () => {
  const contract = await readJSON('product/archie-studio-product.json');
  for (const surface of contract.surfaces) {
    const publicDefinition = JSON.stringify({ id: surface.id, label: surface.label, job: surface.job, primary_action: surface.primary_action });
    assert.doesNotMatch(publicDefinition, SAMPLE_TERMS, `core surface ${surface.id} leaked sample-domain language`);
  }
  assert.doesNotMatch(contract.product.primary_request, SAMPLE_TERMS);
});

test('LBTB remains one bounded sample with explicit anti-leak rules', async () => {
  const catalog = await readJSON('product/archie-studio-samples.json');
  const lbtb = catalog.samples.find(sample => sample.id === 'lbtb-po-processor');
  assert.ok(lbtb);
  assert.equal(lbtb.status, 'sample input and generated-app target');
  assert.ok(lbtb.must_not.includes('be treated as the Archie product'));
  assert.ok(catalog.samples.some(sample => sample.domain === 'consumer personal organization'));
  assert.ok(catalog.samples.some(sample => sample.domain === 'creative data presentation'));
});

test('phone-first surface is honest about its unexecuted scaffold state', async () => {
  const html = await fs.readFile(path.join(root, 'archie-studio/index.html'), 'utf8');
  assert.match(html, /What should Archie make\?/);
  assert.match(html, /independent app/i);
  assert.match(html, /Not executed in this static product scaffold/);
  assert.match(html, /cannot truthfully be compiled/);
  assert.doesNotMatch(html, /confidence\s*[:=]\s*\d/i);
  assert.doesNotMatch(html, /successfully deployed/i);
});
