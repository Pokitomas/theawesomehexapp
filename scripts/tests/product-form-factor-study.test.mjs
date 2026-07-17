import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const read = file => fs.readFile(path.resolve(file), 'utf8');

test('form-factor study binds a multi-domain public corpus to four distinct product roles', async () => {
  const metadata = JSON.parse(await read('design/product-form-factor-metadata.json'));
  assert.equal(metadata.schema, 'archie-product-form-factor-study/v1');
  assert.equal(metadata.research_mode, 'bounded-multi-domain-public-corpus');
  assert.ok(metadata.sources.length >= 15);
  assert.ok(new Set(metadata.sources.map(source => source.publisher)).size >= 7);
  assert.equal(new Set(metadata.sources.map(source => source.url)).size, metadata.sources.length, 'source URLs must be unique');
  for (const source of metadata.sources) {
    assert.match(source.url, /^https:\/\//);
    assert.ok(source.source_class);
    assert.ok(Array.isArray(source.signals) && source.signals.length >= 2);
  }
  assert.ok(metadata.corpus_summary.domains.length >= 6);
  assert.ok(metadata.corpus_summary.excluded.length >= 4);
  assert.deepEqual(Object.keys(metadata.products).sort(), ['archie', 'founder', 'maker', 'sideways']);
  assert.equal(new Set(Object.values(metadata.products).map(product => product.role)).size, 4);
  assert.equal(new Set(Object.values(metadata.products).map(product => product.dominant_action)).size, 4);
  assert.equal(new Set(Object.values(metadata.products).map(product => product.anti_pattern)).size, 4);
  for (const product of Object.values(metadata.products)) {
    assert.ok(product.success_signals.length >= 5);
    assert.ok(product.primary_metadata.length >= 4);
  }
  assert.ok(metadata.shared_tokens.primary_touch_target_px >= 44);
  assert.ok(metadata.shared_tokens.wcag_minimum_target_px >= 24);
  assert.ok(metadata.shared_tokens.minimum_touch_text_px >= 16);
});

test('study states the causal relationship and its measurement boundary', async () => {
  const study = await read('design/PRODUCT_FORM_FACTOR_STUDY.md');
  for (const phrase of [
    'software ambition',
    'required authority and evidence',
    'consequence of error',
    'suitable form factor',
    'measurable product success',
    'A form factor is successful when it minimizes the distance between intent and verified completion',
    'not proof that styling alone causes market success'
  ]) assert.match(study, new RegExp(phrase, 'i'));
  for (const product of ['Archie', 'Maker', 'Founder', 'Sideways']) assert.match(study, new RegExp(`### ${product}`));
  for (const publisher of ['Apple', 'GOV.UK', 'Baymard', 'GitHub Primer', 'Microsoft Fluent', 'IBM Carbon', 'W3C']) {
    assert.match(study, new RegExp(publisher, 'i'));
  }
});

test('Archie, Founder, Maker, and Sideways retain distinct visual languages with accessibility contracts', async () => {
  const [archie, deployedArchie, founder, maker, sideways] = await Promise.all([
    read('archie/archie.css'),
    read('dist/archie/archie.css'),
    read('founder/founder.css'),
    read('maker/maker.css'),
    read('studio/manual/product/sideways-human.css')
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
  assert.match(sideways, /Verdana/);
  assert.match(sideways, /Georgia/);
  assert.match(sideways, /backdrop-filter:\s*none/);
  assert.match(sideways, /prefers-reduced-motion/);
  const surfaces = [archie, founder, maker, sideways];
  for (let left = 0; left < surfaces.length; left += 1) {
    for (let right = left + 1; right < surfaces.length; right += 1) assert.notEqual(surfaces[left], surfaces[right]);
  }
});

test('phone surfaces avoid horizontal-layout assumptions and preserve readable touch text', async () => {
  const [archie, founder, maker, sideways] = await Promise.all([
    read('archie/archie.css'),
    read('founder/founder.css'),
    read('maker/maker.css'),
    read('studio/manual/product/sideways-human.css')
  ]);
  assert.match(archie, /@media\(max-width:680px\)/);
  assert.match(archie, /input,textarea\{font-size:16px\}/);
  assert.match(founder, /@media\(max-width:520px\)/);
  assert.match(founder, /textarea\{font-size:16px\}/);
  assert.match(maker, /overflow-x:\s*hidden/);
  assert.match(maker, /@media \(max-width: 520px\)/);
  assert.match(sideways, /@media \(max-width: 760px\)/);
  assert.match(sideways, /sideways-location-note[\s\S]*display:\s*none/);
});
