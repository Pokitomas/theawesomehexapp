import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = relative => readFile(new URL(relative, root), 'utf8');
const forbidden = /\b(?:AI|agent|model|prompt|co-engineer|Maker|Foundry|weave|lasso|genome|simulation|command[ -]?center|debug)\b/i;

test('human Sideways assets and canonical assembly markers are exact and idempotent', async () => {
  for (const path of [
    'studio/manual/product/sideways-human.css',
    'studio/manual/product/sideways-human.js',
    'studio/manual/apply.py'
  ]) await assert.doesNotReject(access(new URL(path, root)), `missing ${path}`);

  const apply = await read('studio/manual/apply.py');
  assert.match(apply, /HUMAN_STYLE_MARKER/);
  assert.match(apply, /HUMAN_SCRIPT_MARKER/);
  assert.match(apply, /"sideways-human\.css"/);
  assert.match(apply, /"sideways-human\.js"/);
  assert.match(apply, /inject_once\(text, marker/);
});

test('ordinary product copy is human language and developer products remain separate', async () => {
  const { COPY } = await import(new URL('../../studio/manual/product/copy.js', import.meta.url));
  const copy = Object.values(COPY).join('\n');
  assert.doesNotMatch(copy, forbidden);
  assert.match(copy, /feed|profile|place|library/i);

  const productAudit = JSON.parse(await read('audit/product-journey.json'));
  const defaults = productAudit.surfaces.filter(surface => surface.default_user_path).map(surface => surface.id).sort();
  assert.deepEqual(defaults, ['private-archive', 'root-reader']);
  for (const id of ['founder-room', 'maker']) {
    const surface = productAudit.surfaces.find(item => item.id === id);
    assert.ok(surface, `missing ${id} product boundary`);
    assert.equal(surface.default_user_path, false, `${id} entered the normal user path`);
  }
});

test('human-web layer rejects glass UI and preserves explicit links, structure, and accessibility', async () => {
  const css = await read('studio/manual/product/sideways-human.css');
  const runtime = await read('studio/manual/product/sideways-human.js');

  assert.match(css, /text-decoration:\s*underline/);
  assert.match(css, /border-radius:\s*0/);
  assert.match(css, /backdrop-filter:\s*none/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /min-height:\s*40px/);
  assert.match(css, /sideways-location-bar/);
  assert.doesNotMatch(css, /radial-gradient|glassmorphism|vaporwave|CRT/i);

  assert.match(runtime, /dataset\.sidewaysHuman = 'ready'/);
  assert.match(runtime, /sideways-location-bar/);
  assert.match(runtime, /\(maker\|founder\)/);
  assert.match(runtime, /dataset\.developerBoundary = 'hidden'/);
  assert.match(runtime, /explicitDeveloperView/);
  assert.match(runtime, /sideways:remoteupdate/);
  assert.doesNotMatch(runtime, /MutationObserver/);
  assert.doesNotMatch(runtime, /innerHTML\s*=|insertAdjacentHTML|Math\.random|fake|synthetic/i);
});

test('assembled manual product exposes the human layer exactly once', async t => {
  const indexUrl = new URL('../../manual-app/index.html', import.meta.url);
  try { await access(indexUrl); }
  catch {
    t.skip('manual-app is assembled in the product workflow');
    return;
  }
  const html = await readFile(indexUrl, 'utf8');
  assert.equal((html.match(/data-sideways-human/g) || []).length, 2, 'expected one stylesheet and one runtime marker');
  assert.match(html, /sideways-human\.css/);
  assert.match(html, /sideways-human\.js/);
});
