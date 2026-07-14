import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const product = path.join(root, 'studio/manual/product');
const manual = path.join(root, 'manual-app');
const index = fs.readFileSync(path.join(manual, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(product, 'remote-terminal.js'), 'utf8');
const css = fs.readFileSync(path.join(product, 'remote-terminal.css'), 'utf8');
const chrome = fs.readFileSync(path.join(product, 'workspace-chrome.js'), 'utf8');
const actions = fs.readFileSync(path.join(product, 'actions.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(manual, '.well-known/sideways-remote.json'), 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(path.join(manual, 'remote-snapshot.json'), 'utf8'));

assert.equal((index.match(/data-remote-terminal/g) || []).length, 2, 'remote terminal CSS and JS must be singular');
assert.equal((index.match(/data-sideways-remote/g) || []).length, 1, 'machine discovery link must be singular');
for (const token of ['window.SidewaysRemote', 'sideways:remoteupdate', 'data-sideways-remote-state', 'service-desc']) {
  assert.ok(script.includes(token), `terminal missing ${token}`);
}
for (const token of ["'remote.open'", "'remote.close'", "'remote.refresh'"]) {
  assert.ok(actions.includes(token), `action contract missing ${token}`);
  assert.ok(script.includes(token), `terminal does not use ${token}`);
}
for (const secret of ['REMOTE_ROOT_KEY', 'REMOTE_PRIVATE_KEY', 'x-remote-signature']) {
  assert.equal(script.includes(secret), false, `browser terminal leaked credential machinery: ${secret}`);
}
for (const token of ['remote-terminal-launch', 'remote-terminal-hero', 'remote-event', '.workspace-title-actions>.remote-terminal-launch']) {
  assert.ok(css.includes(token), `terminal styling missing ${token}`);
}
assert.ok(chrome.includes("document.querySelector('[data-sideways-remote-launch]')"), 'owned chrome does not locate live work');
assert.ok(chrome.includes('actions.prepend(liveWork)'), 'owned chrome does not mount live work in the titlebar');
assert.equal(manifest.protocol, 'sideways-universal-remote/1');
assert.equal(manifest.live, false, 'static proof build must not pretend a live function exists');
assert.equal(manifest.state.includes('/api/remote/state'), true);
assert.equal(manifest.messages.includes('/api/remote'), true);
assert.equal(manifest.weave.report, 'https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/main/REMOTE_WORK.md');
assert.equal(manifest.weave.thought, 'https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/main/REMOTE_THOUGHT.md');
assert.equal(manifest.documentation, 'https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/main/README_REMOTE.md');
assert.equal(manifest.weave.live_state, manifest.state);
assert.equal(manifest.weave.static_state, manifest.snapshot);
assert.equal(manifest.generation.protocol, 'sideways-universal-remote-generation/1');
assert.equal(manifest.generation.number, Number(process.env.REMOTE_GENERATION || 2));
assert.equal(manifest.generation.authoritative, false);
assert.equal(manifest.generation.state_ledger, false);
assert.equal(manifest.generation.semantics, 'discovery metadata only; live and static remote state remain authoritative');
const expectedBranch = process.env.REMOTE_GENERATION_BRANCH || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || 'main';
assert.equal(manifest.generation.branch, expectedBranch);
const pullMatch = (process.env.GITHUB_REF || '').match(/^refs\/pull\/(\d+)\//);
const expectedPull = pullMatch ? `https://github.com/${process.env.GITHUB_REPOSITORY || 'Pokitomas/theawesomehexapp'}/pull/${pullMatch[1]}` : null;
assert.equal(manifest.generation.pull_request, expectedPull);
assert.equal(fs.existsSync(path.join(root, 'REMOTE_WORK.md')), true, 'work entry point is missing');
assert.equal(fs.existsSync(path.join(root, 'REMOTE_THOUGHT.md')), true, 'shareable thought location is missing');
assert.equal(snapshot.state.blocker_count, 0);
assert.ok(Array.isArray(snapshot.state.messages));
console.log(JSON.stringify({
  discovery: '.well-known/sideways-remote.json',
  generation: manifest.generation,
  publicState: manifest.state,
  publicMessages: manifest.messages,
  report: manifest.weave.report,
  thought: manifest.weave.thought,
  terminal: '#live-work',
  chromeOwner: 'title actions',
  browserCredentials: 'absent'
}, null, 2));
