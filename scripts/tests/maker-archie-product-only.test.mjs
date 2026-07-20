import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../../archie/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../archie/archie.css', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('../../archie/archie.js', import.meta.url), 'utf8');
const mind = fs.readFileSync(new URL('../../archie/mind-core.mjs', import.meta.url), 'utf8');

test('Archie defaults to the central Win95-style operator', () => {
  assert.match(html, /Archie 95/);
  assert.match(html, /What needs handling\?/);
  assert.match(html, /id="prompt"/);
  assert.match(html, /id="ask"/);
  assert.match(html, /id="result"/);
  assert.match(html, /id="items"/);
  assert.doesNotMatch(html, /What should Archie make\?|Make app|generated standalone app/i);
});

test('the phone shell has recognizable Windows 95 interaction primitives', () => {
  assert.match(html, /class="taskbar"/);
  assert.match(html, /class="start-button"/);
  assert.match(html, /class="window main-window"/);
  assert.match(css, /--desktop:#008080/);
  assert.match(css, /border:2px outset/);
  assert.match(css, /safe-area-inset-bottom/);
});

test('the central app loads the admitted local router and language runtime', () => {
  assert.match(html, /src="\.\/archie\.js"/);
  assert.match(runtime, /archie-local-neural-router\/v1/);
  assert.match(runtime, /archie-router-bytehash-perceptron-v1/);
  assert.match(runtime, /MODEL_SHA256\s*=\s*'202a6957bd0bbf0a9b4e92cd74014b2b9689393be539de8f5ab44f567a691916'/);
  assert.match(runtime, /import\('\.\/mind-core\.mjs'\)/);
  assert.match(runtime, /response_generation:\s*'deterministic-context-language-core'/);
  assert.match(mind, /composeLocalResponse/);
  assert.match(mind, /ordered-multi-outcome/);
  assert.match(mind, /fabricated-completion/);
});

test('local work stays on the phone', () => {
  assert.match(runtime, /localStorage/);
  assert.match(runtime, /state\.history/);
  assert.match(runtime, /file\.slice\(0, 32000\)\.text\(\)/);
  assert.match(html, /saved only on this phone/i);
});
