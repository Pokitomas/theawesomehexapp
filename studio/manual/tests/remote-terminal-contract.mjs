import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const product = path.join(root, 'studio/manual/product');
const manual = path.join(root, 'manual-app');
const index = fs.readFileSync(path.join(manual, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(product, 'remote-terminal.js'), 'utf8');
const css = fs.readFileSync(path.join(product, 'remote-terminal.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(manual, '.well-known/sideways-remote.json'), 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(path.join(manual, 'remote-snapshot.json'), 'utf8'));

assert.equal((index.match(/data-remote-terminal/g) || []).length, 2, 'remote terminal CSS and JS must be singular');
assert.equal((index.match(/data-sideways-remote/g) || []).length, 1, 'machine discovery link must be singular');
for (const token of ['window.SidewaysRemote', 'sideways:remoteupdate', 'data-sideways-remote-state', 'service-desc']) {
  assert.ok(script.includes(token), `terminal missing ${token}`);
}
for (const secret of ['REMOTE_ROOT_KEY', 'REMOTE_PRIVATE_KEY', 'x-remote-signature']) {
  assert.equal(script.includes(secret), false, `browser terminal leaked credential machinery: ${secret}`);
}
for (const token of ['remote-terminal-launch', 'remote-terminal-hero', 'remote-event']) {
  assert.ok(css.includes(token), `terminal styling missing ${token}`);
}
assert.equal(manifest.protocol, 'sideways-universal-remote/1');
assert.equal(manifest.state.includes('/api/remote/state'), true);
assert.equal(manifest.messages.includes('/api/remote'), true);
assert.equal(snapshot.state.blocker_count, 0);
assert.ok(Array.isArray(snapshot.state.messages));
console.log(JSON.stringify({
  discovery: '.well-known/sideways-remote.json',
  publicState: manifest.state,
  publicMessages: manifest.messages,
  terminal: '#live-work',
  browserCredentials: 'absent'
}, null, 2));
