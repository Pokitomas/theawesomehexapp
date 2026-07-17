import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const read = file => fs.readFile(path.resolve(file), 'utf8');
const readMetadata = async () => JSON.parse(await read('design/product-form-factor-metadata.json'));

test('form-factor corpus is diverse, self-consistent, and explicit about inference limits', async () => {
  const metadata = await readMetadata();
  assert.equal(metadata.schema, 'archie-product-form-factor-study/v2');
  assert.equal(metadata.research_mode, 'bounded-public-design-system-corpus');
  assert.ok(metadata.sources.length >= 16);
  assert.equal(metadata.method.source_count, metadata.sources.length);

  const publishers = new Set(metadata.sources.map(source => source.publisher));
  assert.ok(publishers.size >= 8);
  assert.equal(metadata.method.publisher_count, publishers.size);
  assert.equal(new Set(metadata.sources.map(source => source.id)).size, metadata.sources.length);
  assert.ok(new Set(metadata.sources.map(source => source.source_type)).size >= 5);
  assert.ok(metadata.sources.some(source => source.evidence_strength === 'normative'));
  assert.ok(metadata.sources.some(source => source.evidence_strength === 'observational-and-testing'));

  for (const source of metadata.sources) {
    assert.match(source.url, /^https:\/\//);
    assert.ok(source.signals.length >= 2);
    assert.ok(source.applicable_products.length >= 1);
  }

  assert.match(metadata.method.inference_policy, /does not by itself prove/i);
  assert.ok(metadata.derived_relationships.length >= 5);
  for (const relationship of metadata.derived_relationships) {
    assert.match(relationship.hypothesis, /\.$/);
    assert.ok(relationship.success_proxies.length >= 2);
  }
});

test('four product roles bind distinct actions, metrics, metadata, and tracked style contracts', async () => {
  const metadata = await readMetadata();
  assert.deepEqual(Object.keys(metadata.products).sort(), ['archie', 'founder', 'maker', 'sideways']);

  const products = Object.values(metadata.products);
  assert.equal(new Set(products.map(product => product.role)).size, 4);
  assert.equal(new Set(products.map(product => product.dominant_action)).size, 4);
  assert.equal(new Set(products.map(product => product.density)).size, 4);

  for (const product of products) {
    assert.ok(product.primary_metadata.length >= 4);
    assert.ok(product.success_metrics.length >= 3);
    assert.ok(product.style_contracts.length >= 1);
    for (const contract of product.style_contracts) await fs.access(path.resolve(contract));
  }

  assert.equal(metadata.shared_tokens.minimum_target_aa_px, 24);
  assert.ok(metadata.shared_tokens.preferred_touch_target_px >= 44);
  assert.ok(metadata.shared_tokens.minimum_touch_text_px >= 16);
  assert.ok(metadata.shared_tokens.focus_ring_px >= 2);
  assert.equal(metadata.shared_tokens.state_requires_non_color_cue, true);
  assert.equal(metadata.shared_tokens.reduced_motion_required, true);
});

test('study defines conditional hypotheses and a truthful evaluation boundary', async () => {
  const study = await read('design/PRODUCT_FORM_FACTOR_STUDY.md');
  for (const phrase of [
    'software ambition',
    'required authority and evidence',
    'task-matched form factor',
    'measured product success or a falsified design hypothesis',
    'testable product hypothesis',
    'perception is not proof of correct behavior',
    'Evaluation boundary'
  ]) assert.match(study, new RegExp(phrase, 'i'));
  for (const product of ['Archie', 'Maker', 'Founder', 'Sideways']) assert.match(study, new RegExp(`### ${product}`));
  for (const publisher of ['Apple', 'GOV.UK', 'W3C', 'GitHub Primer', 'Microsoft Fluent', 'IBM Carbon', 'Atlassian', 'Baymard']) {
    assert.match(study, new RegExp(publisher, 'i'));
  }
});

test('all four programs retain role-specific visual languages', async () => {
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

  assert.match(sideways, /--human-paper:\s*#f7f4e8/);
  assert.match(sideways, /Georgia,\s*"Times New Roman"/);
  assert.match(sideways, /\.sideways-location-bar/);
  assert.match(sideways, /private archive|ordinary Sideways/i);

  const visualContracts = [archie, founder, maker, sideways];
  for (let left = 0; left < visualContracts.length; left += 1) {
    for (let right = left + 1; right < visualContracts.length; right += 1) {
      assert.notEqual(visualContracts[left], visualContracts[right]);
    }
  }
});

test('phone surfaces preserve reflow and readable touch text', async () => {
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
  assert.match(sideways, /max-width:\s*1120px/);
  assert.match(sideways, /overflow-x:\s*auto/);
});
