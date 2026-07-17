import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('archie');
const read = name => fs.readFile(path.join(root, name), 'utf8');

test('Archie phone surface is installable and caches the shared shell', async () => {
  const [html, manifest, sw] = await Promise.all([read('index.html'), read('manifest.webmanifest'), read('sw.js')]);
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.display, 'standalone');
  assert.equal(parsed.start_url, './');
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /\.\/archie\.js/);
  assert.match(html, /\.\.\/desktop\/desktop\.css/);
  assert.match(html, /\.\.\/desktop\/desktop\.js/);
  assert.match(sw, /archie-phone-v3/);
  for (const asset of ['./', './index.html', './archie.js', './manifest.webmanifest', './icon.svg', '../desktop/desktop.css', '../desktop/desktop.js']) assert.match(sw, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Archie phone surface states authority and capability boundaries behind progressive disclosure', async () => {
  const [html, js] = await Promise.all([read('index.html'), read('archie.js')]);
  assert.match(html, /Optional context, proof, and permission/i);
  assert.match(html, /Machine packet and runtime truth/i);
  assert.match(html, /No admitted general model yet/i);
  assert.match(html, /Execution not performed here/i);
  assert.match(js, /execution:'not-performed'/);
  assert.match(js, /does not claim execution, model capability, deployment, or completion/i);
  assert.doesNotMatch(html, /fully autonomous|general intelligence available|always listening/i);
});

test('phone objective packet preserves outcome, world, authority, proof, and continuity', async () => {
  const js = await read('archie.js');
  for (const term of ['archie-objective-packet/v1', 'objective', 'world', 'protected_reality', 'proof_of_done', 'authority', 'continuity', 'packet_digest']) assert.match(js, new RegExp(term));
  assert.match(js, /localStorage/);
  assert.match(js, /navigator\.share/);
});
