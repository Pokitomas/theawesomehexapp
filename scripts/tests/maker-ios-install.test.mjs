import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const page = await fs.readFile(new URL('../../maker/ios.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await fs.readFile(new URL('../../maker/manifest.webmanifest', import.meta.url), 'utf8'));

test('iOS install page is self-contained and opens the intended Archie PWA', () => {
  assert.match(page, /apple-mobile-web-app-capable/);
  assert.match(page, /apple-mobile-web-app-title" content="Archie"/);
  assert.match(page, /manifest\.webmanifest/);
  assert.match(page, /href="\.\/">OPEN ARCHIE/);
  assert.match(page, /href="\.\.\/manual\/">OPEN SIDEWAYS DESKTOP/);
  assert.match(page, /Add to Home Screen/);
  assert.match(page, /navigator\.share/);
  assert.match(page, /display-mode: standalone/);
  assert.doesNotMatch(page, /<script[^>]+src=/);
  assert.equal(manifest.name, 'Archie');
  assert.equal(manifest.short_name, 'Archie');
  assert.equal(manifest.orientation, 'portrait-primary');
});

test('Archie install page states the model and browser authority boundaries honestly', () => {
  assert.match(page, /no independent exact-head benchmark receipt/i);
  assert.match(page, /does not pretend the browser itself trained a strong model/i);
  assert.match(page, /Repository writes, model execution, training spend, merge, and deployment/i);
  assert.match(page, /factual substrate can be reused or transformed into Archie training and evaluation material/i);
});
