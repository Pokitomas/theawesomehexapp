import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

const product = fs.readFileSync(new URL('../../archie/index.html', import.meta.url), 'utf8');
const artifact = fs.readFileSync(new URL('../../archie/apps/field-notes/index.html', import.meta.url), 'utf8');
const receipt = JSON.parse(fs.readFileSync(new URL('../../archie/apps/field-notes/receipt.json', import.meta.url), 'utf8'));

test('Archie default surface is Product-Only', () => {
  assert.match(product, /What should Archie make\?/);
  assert.match(product, /One prompt\. One runnable app\./);
  assert.match(product, /id="form"/);
  assert.match(product, /id="preview"/);
  assert.match(product, /download="archie-app\.html"/);
  assert.doesNotMatch(product, />TRAINING<|>FEATS<|>REEL</i);
});

test('verified smoke prompt resolves to the committed independent artifact', () => {
  assert.equal(receipt.prompt, 'Make me a private phone app for quick field notes with photos, location, tags, and offline search.');
  assert.equal(receipt.result, 'passed');
  assert.equal(receipt.artifact.independent_runnable, true);
  assert.equal(receipt.artifact.server_calls, 0);
  assert.match(product, /apps\/field-notes/);
});

test('Field Notes implements the requested behavior locally', () => {
  assert.match(artifact, /localStorage/);
  assert.match(artifact, /type="file"/);
  assert.match(artifact, /navigator\.geolocation/);
  assert.match(artifact, /comma separated/);
  assert.match(artifact, /type="search"/);
  assert.match(artifact, /Export JSON/);
  assert.doesNotMatch(artifact, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});

test('smoke receipt binds the exact artifact bytes', () => {
  const digest = crypto.createHash('sha256').update(artifact).digest('hex');
  assert.equal(digest, receipt.artifact.sha256);
});
