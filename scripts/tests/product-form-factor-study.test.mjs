import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const read = file => fs.readFile(path.resolve(file), 'utf8');

test('form-factor study binds public evidence to four distinct product roles', async () => {
  const metadata = JSON.parse(await read('design/product-form-factor-metadata.json'));
  assert.equal(metadata.schema, 'archie-product-form-factor-study/v1');
  assert.equal(metadata.research_mode, 'bounded-public-corpus');
  assert.ok(metadata.sources.length >= 5);
  assert.deepEqual(Object.keys(metadata.products).sort(), ['archie', 'founder', 'maker', 'sideways']);
  assert.equal(new Set(Object.values(metadata.products).map(product => product.role)).size, 4);
  assert.equal(new Set(Object.values(metadata.products).map(product => product.dominant_action)).size, 4);
  assert.ok(metadata.shared_tokens.minimum_touch_target_px >= 44);
  assert.ok(metadata.shared_tokens.minimum_touch_text_px >= 16);
});

test('study states the causal relationship between form factor and verified success', async () => {
  const study = await read('design/PRODUCT_FORM_FACTOR_STUDY.md');
  for (const phrase of [
    'software ambition',
    'required authority and evidence',
    'suitable form factor',
    'measurable product success',
    'A form factor is successful when it minimizes the distance between intent and verified completion'
  ]) assert.match(study, new RegExp(phrase, 'i'));
  for (const product of ['Archie', 'Maker', 'Founder', 'Sideways']) assert.match(study, new RegExp(`### ${product}`));
});

test('Archie, Founder, and Maker retain distinct visual languages with accessibility contracts', async () => {
  const [archie, deployedArchie, founder, maker] = await Promise.all([
    read('archie/archie.css'),
    read('dist/archie/archie.css'),
    read('founder/founder.css'),
    read('maker/maker.css')
  ]);
  assert.equal(archie, deployedArchie);
  assert.match(archie, /--accent:#d9ff62/);
  assert.match(archie, /backdrop-filter:blur/);
  assert.match(archie, /min-height:44px/);
  assert.match(archie, /prefers-reduced-motion/);
  assert.match(founder, /--acid:#d8ff3e/);
  assert.match(founder, /Georgia|direction/i);
  assert.match(founder, /prefers-reduced-motion/);
  assert.match(maker, /ui-monospace/);
  assert.match(maker, /--navy:\s*#10233f/);
  assert.match(maker, /\.command-panel/);
  assert.match(maker, /\.state-panel/);
  assert.notEqual(archie, founder);
  assert.notEqual(archie, maker);
  assert.notEqual(founder, maker);
});

test('phone surfaces avoid horizontal-layout assumptions and preserve readable touch text', async () => {
  const [archie, founder, maker] = await Promise.all([read('archie/archie.css'), read('founder/founder.css'), read('maker/maker.css')]);
  assert.match(archie, /@media\(max-width:680px\)/);
  assert.match(archie, /input,textarea\{font-size:16px\}/);
  assert.match(founder, /@media\(max-width:520px\)/);
  assert.match(founder, /textarea\{font-size:16px\}/);
  assert.match(maker, /overflow-x:\s*hidden/);
  assert.match(maker, /@media \(max-width: 520px\)/);
});
