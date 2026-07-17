import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const read = file => fs.readFile(path.resolve(file), 'utf8');
const readMetadata = async () => JSON.parse(await read('design/product-form-factor-metadata.json'));

test('form-factor study is grounded in indie-web and community-success evidence', async () => {
  const metadata = await readMetadata();
  assert.equal(metadata.schema, 'indie-product-form-factor-study/v1');
  assert.equal(metadata.research_mode, 'bounded-indie-web-success-corpus');
  assert.ok(metadata.sources.length >= 7);
  assert.ok(metadata.success_dimensions.length >= 7);
  assert.match(metadata.claim_boundary, /does not prove/i);

  const publishers = new Set(metadata.sources.map(source => source.publisher));
  const sourceClasses = new Set(metadata.sources.map(source => source.source_class));
  assert.ok(publishers.has('Neocities'));
  assert.ok(publishers.has('IndieWeb'));
  assert.ok(sourceClasses.size >= 5);
  assert.equal(new Set(metadata.sources.map(source => source.id)).size, metadata.sources.length);
  assert.equal(new Set(metadata.sources.map(source => source.url)).size, metadata.sources.length);

  for (const source of metadata.sources) {
    assert.match(source.url, /^https:\/\//);
    assert.ok(source.signals.length >= 3);
  }
});

test('indie patterns connect product moves to multi-dimensional success proxies', async () => {
  const metadata = await readMetadata();
  assert.ok(metadata.indie_patterns.length >= 7);
  assert.equal(new Set(metadata.indie_patterns.map(pattern => pattern.id)).size, metadata.indie_patterns.length);
  for (const pattern of metadata.indie_patterns) {
    assert.ok(pattern.hypothesis.length >= 40);
    assert.ok(pattern.product_moves.length >= 3);
    assert.ok(pattern.success_proxies.length >= 3);
  }
  for (const dimension of ['first-creation', 'return', 'activity', 'long-term-survival', 'discovery', 'ownership', 'identity-attachment']) {
    assert.ok(metadata.success_dimensions.includes(dimension));
  }
});

test('four products bind distinct indie place metaphors and tracked style contracts', async () => {
  const metadata = await readMetadata();
  assert.deepEqual(Object.keys(metadata.products).sort(), ['archie', 'founder', 'maker', 'sideways']);
  const products = Object.values(metadata.products);
  assert.equal(new Set(products.map(product => product.form)).size, 4);
  assert.equal(new Set(products.map(product => product.first_act)).size, 4);
  assert.equal(new Set(products.map(product => product.return_loop)).size, 4);
  assert.equal(new Set(products.map(product => product.anti_pattern)).size, 4);

  for (const product of products) {
    assert.ok(product.personality.length >= 5);
    assert.ok(product.success_metrics.length >= 4);
    assert.ok(product.style_contracts.length >= 1);
    for (const contract of product.style_contracts) await fs.access(path.resolve(contract));
  }

  assert.ok(metadata.shared_contracts.primary_touch_target_px >= 44);
  assert.ok(metadata.shared_contracts.minimum_touch_text_px >= 16);
  assert.equal(metadata.shared_contracts.visible_focus_required, true);
  assert.equal(metadata.shared_contracts.reduced_motion_required, true);
  assert.equal(metadata.shared_contracts.portable_artifact_required, true);
  assert.equal(metadata.shared_contracts.single_shared_dashboard_skin_forbidden, true);
});

test('study rejects security-dashboard monoculture and defines indie success loops', async () => {
  const study = await read('design/PRODUCT_FORM_FACTOR_STUDY.md');
  for (const phrase of [
    'Neocities',
    'IndieWeb',
    'identity construction',
    'mastery',
    'distinctive and dynamic identities',
    'growth, retention, long-term survival, and activity',
    'first expressive act',
    'visible authored artifact',
    'sideways discovery',
    'security-console density',
    'Archie — personal atelier',
    'Maker — software workshop',
    'Founder — indie zine decision wall',
    'Sideways — neighborhood homepage'
  ]) assert.match(study, new RegExp(phrase, 'i'));
});

test('Archie, Maker, Founder, and Sideways expose distinct handmade visual languages', async () => {
  const [archie, archieHtml, maker, founder, sidewaysBase, sidewaysIndie, installer] = await Promise.all([
    read('archie/archie.css'),
    read('archie/index.html'),
    read('maker/maker.css'),
    read('founder/founder.css'),
    read('studio/manual/product/sideways-human.css'),
    read('studio/manual/product/sideways-indie.css'),
    read('studio/manual/apply.py')
  ]);

  assert.match(archieHtml, /PERSONAL ATELIER/);
  assert.match(archie, /--yellow:\s*#ffd95a/);
  assert.match(archie, /background-image/);
  assert.match(archie, /Georgia/);
  assert.doesNotMatch(archie, /color-scheme:\s*dark/);

  assert.match(maker, /--coral:\s*#ff7657/);
  assert.match(maker, /background-size:\s*24px 24px/);
  assert.match(maker, /ui-monospace/);
  assert.match(maker, /\.command-panel/);
  assert.match(maker, /BUILD • TEST • SHARE • REPEAT/);

  assert.match(founder, /--pink:\s*#ffc6dd/);
  assert.match(founder, /\.direction::before/);
  assert.match(founder, /rotate\(/);
  assert.match(founder, /Georgia/);

  assert.match(sidewaysBase, /sideways-human-web/);
  assert.match(sidewaysIndie, /--indie-yellow:\s*#ffd95a/);
  assert.match(sidewaysIndie, /YOU ARE HERE/);
  assert.match(sidewaysIndie, /UPDATED BY A HUMAN/);
  assert.match(sidewaysIndie, /nth-of-type/);
  assert.match(installer, /sideways-indie\.css/);
  assert.match(installer, /INDIE_STYLE_MARKER/);
  assert.ok(installer.indexOf('HUMAN_STYLE_MARKER, "</head>"') < installer.indexOf('INDIE_STYLE_MARKER, "</head>"'));

  const surfaces = [archie, maker, founder, sidewaysIndie];
  for (let left = 0; left < surfaces.length; left += 1) {
    for (let right = left + 1; right < surfaces.length; right += 1) assert.notEqual(surfaces[left], surfaces[right]);
  }
});

test('indie personality preserves phone reflow, readable inputs, focus, and reduced motion', async () => {
  const [archie, founder, maker, sideways] = await Promise.all([
    read('archie/archie.css'),
    read('founder/founder.css'),
    read('maker/maker.css'),
    read('studio/manual/product/sideways-indie.css')
  ]);
  assert.match(archie, /@media \(max-width: 680px\)/);
  assert.match(archie, /input,textarea\{font-size:16px\}/);
  assert.match(archie, /focus-visible/);
  assert.match(archie, /prefers-reduced-motion/);
  assert.match(founder, /@media \(max-width: 520px\)/);
  assert.match(founder, /textarea \{ font-size: 16px; \}/);
  assert.match(maker, /overflow-x:\s*hidden/);
  assert.match(maker, /@media \(max-width: 520px\)/);
  assert.match(maker, /textarea \{ font-size: 16px/);
  assert.match(sideways, /@media \(max-width: 760px\)/);
  assert.match(sideways, /focus-visible/);
  assert.match(sideways, /prefers-reduced-motion/);
});
