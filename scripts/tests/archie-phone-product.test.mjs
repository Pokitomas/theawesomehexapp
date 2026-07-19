import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('archie');
const read = name => fs.readFile(path.join(root, name), 'utf8');

test('Archie phone surface is installable and caches its focused local app', async () => {
  const [html, manifest, sw] = await Promise.all([read('index.html'), read('manifest.webmanifest'), read('sw.js')]);
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.display, 'standalone');
  assert.equal(parsed.start_url, './');
  assert.equal(parsed.scope, './');
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-mobile-web-app-status-bar-style/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /\.\/archie\.css/);
  assert.match(html, /\.\/archie\.js/);
  assert.match(sw, /archie-operator-v1/);
  for (const asset of ['./', './index.html', './archie.css', './archie.js', './manifest.webmanifest', './icon.svg']) {
    assert.match(sw, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(sw, /desktop\/desktop\.(?:css|js)/);
});

test('Archie phone surface exposes one useful path and honest capability boundaries', async () => {
  const [html, js] = await Promise.all([read('index.html'), read('archie.js')]);
  assert.match(html, /Tell Archie what you need handled\./i);
  assert.match(html, />Ask Archie</i);
  assert.match(html, /Local deterministic assistance/i);
  assert.match(html, /not neural inference/i);
  assert.match(html, /cannot contact people, use accounts, browse, or complete actions outside this page/i);
  assert.match(js, /neural_evidence:false/);
  assert.match(js, /Archie is new\./);
  assert.match(js, /There are no users, shared projects, or community activity here yet/);
  assert.doesNotMatch(html, /fully autonomous|general intelligence available|always listening|model picker|specialist/i);
});

test('completed requests preserve local deterministic evidence and one active objective', async () => {
  const js = await read('archie.js');
  for (const term of ['request', 'response', 'mode', 'timestamp', 'digest', 'neural_evidence', 'activeObjective']) {
    assert.match(js, new RegExp(term));
  }
  assert.match(js, /localStorage\.setItem/);
  assert.match(js, /navigator\.clipboard/);
  assert.match(js, /serviceWorker\.register/);
  assert.doesNotMatch(js, /navigator\.share|execution:'not-performed'|archie-objective-packet/);
});
