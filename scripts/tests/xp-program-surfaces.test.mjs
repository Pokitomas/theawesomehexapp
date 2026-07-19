import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const contract = JSON.parse(read('product/xp-program-surfaces.json'));
const sharedCss = read('desktop/desktop.css');
const sharedJs = read('desktop/desktop.js');
const sharedSurfaces = [
  ['desktop', 'desktop/index.html', './desktop.css'],
  ['maker', 'maker/index.html', '../desktop/desktop.css'],
  ['founder', 'founder/index.html', '../desktop/desktop.css'],
  ['foundry', 'foundry/index.html', '../desktop/desktop.css'],
  ['expo', 'world-expo/index.html', '../desktop/desktop.css']
];

assert.equal(contract.schema, 'archie-public-workflow/v2');
assert.equal(contract.product_model, 'one-task-progressive-views');
assert.equal(contract.root_surface, 'one-request-router');
assert.equal(contract.workflow.automatic_routing, true);
assert.equal(contract.workflow.shared_state, 'one local task handed between views');
assert.equal(contract.mobile.minimum_phone_target_css_px, 44);
assert.equal(contract.accessibility.minimum_phone_target_css_px, 44);
assert.ok(contract.visual_rules.forbidden.includes('duplicate-request-entry-across-views'));
assert.ok(contract.visual_rules.forbidden.includes('raw-schema-as-default-interface'));
assert.ok(contract.visual_rules.forbidden.includes('twenty-four-near-duplicate-candidate-cards'));

assert.match(sharedCss, /--program-signature:\s*"archie-one-request"/);
assert.match(sharedCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
assert.match(sharedCss, /@media\s*\(forced-colors:\s*active\)/);
assert.match(sharedCss, /@media\s*\(max-width:/);
assert.doesNotMatch(sharedCss, /backdrop-filter|glassmorphism|frosted/i);

for (const [name, htmlPath, stylesheet] of sharedSurfaces) {
  const html = read(htmlPath);
  assert.match(html, /<main\b/, `${name} must have a main landmark`);
  assert.match(html, /class="skip-link"/, `${name} must have a skip link`);
  assert.match(html, /aria-label|aria-labelledby/, `${name} must expose accessible names`);
  assert.ok(html.includes(`href="${stylesheet}"`), `${name} must use the shared interface shell`);
  assert.match(html, /class="site-header"/, `${name} must use the shared navigation`);
  assert.doesNotMatch(html, /https?:\/\/(?:fonts|cdn|unpkg|jsdelivr)\./i, `${name} must not require remote UI assets`);
}

const desktop = read('desktop/index.html');
for (const id of ['universal-task', 'universal-form', 'universal-go', 'route-preview']) assert.ok(desktop.includes(`id="${id}"`));
for (const route of ['auto', 'archie', 'maker', 'founder', 'foundry']) assert.ok(desktop.includes(`data-route="${route}"`));
assert.match(desktop, /What should happen\?/);
assert.match(desktop, /Choose for me/);
assert.doesNotMatch(desktop, /Installed programs|Program groups|separate applications—not stages/i);

assert.match(sharedJs, /archie:shared-task:v2/);
for (const key of ['archie:knowledge-utility:v2', 'maker:engineering:task:v2', 'archie:founder:human-turn', 'archie:human-foundry:campaign']) assert.ok(sharedJs.includes(key));
assert.match(sharedJs, /function inferRoute/);
assert.match(sharedJs, /choose the smallest workflow/i);

const archie = read('archie/index.html');
const archieCss = read('archie/archie.css');
const archieJs = read('archie/archie.js');
assert.match(archie, /<main\b/);
assert.match(archie, /aria-label="Ask Archie"/);
assert.match(archie, /href="\.\/archie\.css"/);
assert.match(archie, /Tell Archie what you need handled\./);
assert.match(archie, />Ask Archie</);
assert.match(archie, /Local deterministic assistance\./);
assert.doesNotMatch(archie, /model picker|provider picker|specialist|benchmark|schema selector/i);
assert.match(archieCss, /min-height:44px/);
assert.match(archieCss, /@media\(prefers-reduced-motion:reduce\)/);
assert.match(archieCss, /@media\(max-width:/);
assert.match(archieJs, /archie-personal-operator\/v2/);
assert.match(archieJs, /neural_evidence:false/);
assert.match(archieJs, /Archie is new\./);
assert.match(archieJs, /There are no users, shared projects, or community activity here yet/);
assert.match(archieJs, /localStorage\.setItem/);
assert.match(archieJs, /serviceWorker\.register/);
assert.doesNotMatch(archieJs, /packet|authority inspector|runtime unobserved/i);

const maker = read('maker/index.html');
assert.match(maker, /Repository, proof, and execution controls/);
assert.match(maker, /Live public repository state/);
const founder = read('founder/index.html');
assert.match(founder, /Show different directions/);
const foundry = read('foundry/index.html');
assert.match(foundry, /Distinct approaches, not 24 nearly identical cards/);
assert.match(foundry, /Full campaign manifest and evidence boundary/);
const foundryJs = read('foundry/foundry.js');
assert.match(foundryJs, /function distinctDirections/);
assert.match(foundryJs, /candidates preserved/);

console.log('Archie public workflow contract ok: one shared router plus an honest local personal-operator surface with deterministic receipts and no fake activity');
