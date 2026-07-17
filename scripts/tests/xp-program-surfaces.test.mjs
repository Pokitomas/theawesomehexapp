import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const contract = JSON.parse(read('product/xp-program-surfaces.json'));
const surfaces = [
  ['desktop', 'desktop/index.html', 'desktop/desktop.css'],
  ['archie', 'archie/index.html', 'archie/archie.css'],
  ['maker', 'maker/index.html', 'maker/maker.css'],
  ['foundry', 'foundry/index.html', 'foundry/foundry.css']
];

assert.equal(contract.schema, 'archie-xp-program-surfaces/v1');
assert.equal(contract.product_model, 'independent-programs');
assert.equal(contract.root_surface, 'desktop-program-manager');
assert.equal(contract.mobile.model, 'one-full-screen-program-at-a-time');
assert.equal(contract.accessibility.minimum_phone_target_css_px, 44);
assert.equal(contract.accessibility.drag_alternatives_required, true);
assert.ok(contract.visual_rules.forbidden.includes('glassmorphism'));
assert.ok(contract.visual_rules.forbidden.includes('icon-stage-pipeline'));
assert.ok(contract.playfulness.forbidden.includes('streaks'));
assert.ok(contract.playfulness.allowed.includes('strange-help'));

const signatures = new Set();
for (const [name, htmlPath, cssPath] of surfaces) {
  const html = read(htmlPath);
  const css = read(cssPath);
  assert.match(html, /<main\b/, `${name} must have a main landmark`);
  assert.match(html, /class="skip-link"/, `${name} must have a skip link`);
  assert.match(html, /aria-label|aria-labelledby/, `${name} must expose accessible names`);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, `${name} must support reduced motion`);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/, `${name} must support forced colors`);
  assert.match(css, /@media\s*\(max-width:/, `${name} must have a phone layout`);
  assert.doesNotMatch(css, /backdrop-filter|rgba\(|hsla\(|opacity\s*:/i, `${name} must keep primary presentation opaque`);
  assert.doesNotMatch(`${html}\n${css}`, /glassmorphism|frosted|bento|feature-grid|pipeline-step/i, `${name} must reject dashboard-template vocabulary`);
  assert.doesNotMatch(html, /https?:\/\/(?:fonts|cdn|unpkg|jsdelivr)\./i, `${name} must not require remote UI assets`);
  const signature = css.match(/--program-signature:\s*"([^"]+)"/i)?.[1];
  assert.ok(signature, `${name} must declare an independent visual signature`);
  signatures.add(signature);
}
assert.equal(signatures.size, surfaces.length, 'every application must have a distinct visual grammar');

const desktop = read('desktop/index.html');
for (const route of ['../archie/', '../maker/', '../founder/', '../foundry/', '../world-expo/']) assert.ok(desktop.includes(route));
assert.match(desktop, /data-shell="program-manager"/);
assert.doesNotMatch(desktop, /Intention[\s\S]{0,300}Planning[\s\S]{0,300}Reasoning/i);

const archie = read('archie/index.html');
for (const primitive of ['menu-bar', 'toolbar', 'explorer', 'editor', 'inspector', 'status-bar']) assert.ok(archie.includes(primitive));
const foundry = read('foundry/index.html');
for (const primitive of ['menu-bar', 'instrument-strip', 'candidate-field', 'evidence', 'status-bar']) assert.ok(foundry.includes(primitive));

console.log('XP program surfaces contract ok: opaque independent applications, phone fullscreen behavior, accessibility paths, and no glass/icon pipeline');
