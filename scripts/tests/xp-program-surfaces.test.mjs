import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const archieManifest = JSON.parse(read('archie/manifest.webmanifest'));
const routerAdmission = JSON.parse(read('archie/router-admission.json'));
const smokeArtifact = read('archie/apps/field-notes/index.html');
const smokeReceipt = JSON.parse(read('archie/apps/field-notes/receipt.json'));

assert.match(archie, /<main\b/);
assert.match(archie, /<h1>What should Archie make\?<\/h1>/);
assert.match(archie, /aria-label="What should Archie make\?"/);
assert.match(archie, /One prompt\. One runnable app\./);
assert.match(archie, />Make app</);
assert.match(archie, /id="preview"/);
assert.match(archie, /download="archie-app\.html"/);
assert.match(archie, /apps\/field-notes/);
assert.match(archie, /localStorage\.setItem/);
assert.match(archie, /serviceWorker\.register/);
assert.doesNotMatch(archie, />TRAINING<|>FEATS<|>REEL<|Tell Archie what you need handled|>Ask Archie</i);
assert.doesNotMatch(archie, /https?:\/\/(?:fonts|cdn|unpkg|jsdelivr)\./i);
assert.equal(archieManifest.name, 'Archie — Product Only');
assert.equal(archieManifest.display, 'standalone');

assert.equal(smokeReceipt.schema, 'archie-product-only-smoke-receipt/v1');
assert.equal(smokeReceipt.result, 'passed');
assert.equal(smokeReceipt.artifact.independent_runnable, true);
assert.equal(smokeReceipt.artifact.server_calls, 0);
assert.equal(crypto.createHash('sha256').update(smokeArtifact).digest('hex'), smokeReceipt.artifact.sha256);
assert.match(smokeArtifact, /localStorage/);
assert.match(smokeArtifact, /type="file"/);
assert.match(smokeArtifact, /navigator\.geolocation/);
assert.match(smokeArtifact, /type="search"/);
assert.match(smokeArtifact, /Export JSON/);
assert.doesNotMatch(smokeArtifact, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);

assert.equal(routerAdmission.admission, 'admitted');
assert.equal(routerAdmission.admitted_for, 'local task-mode routing only');
assert.equal(routerAdmission.neural_response_generation, false);

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

console.log('Archie public workflow contract ok: Product-Only prompt creates and opens an independent local app with a digest-bound smoke receipt.');
