import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const page = await fs.readFile(new URL('../../maker/ios.html', import.meta.url), 'utf8');

test('iOS install page is self-contained and opens the intended Maker PWA', () => {
  assert.match(page, /apple-mobile-web-app-capable/);
  assert.match(page, /manifest\.webmanifest/);
  assert.match(page, /href="\.\/">OPEN MAKER/);
  assert.match(page, /Add to Home Screen/);
  assert.match(page, /navigator\.share/);
  assert.match(page, /display-mode: standalone/);
  assert.doesNotMatch(page, /<script[^>]+src=/);
});

test('iOS install page explains the browser authority boundary in ordinary language', () => {
  assert.match(page, /No App Store account/);
  assert.match(page, /browser never receives repository or model credentials/);
  assert.match(page, /authorized GitHub workflow/);
});
