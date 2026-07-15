import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import './maker-pr-collision-gate.test.mjs';

const pagesPath = new URL('../../.github/workflows/pages.yml', import.meta.url);
const lassoPath = new URL('../../.github/workflows/weave-lasso.yml', import.meta.url);
const makerWorkerPath = new URL('../../.github/workflows/maker-native-worker.yml', import.meta.url);
const makerCollisionPath = new URL('../../.github/workflows/maker-pr-collision-gate.yml', import.meta.url);
const checkoutRef = /uses:\s*actions\/checkout@[0-9a-f]{40}(?:\s+#\s*v4)?\s*$/;

function job(source, name, next = '') {
  const start = source.indexOf(`\n  ${name}:`);
  assert.notEqual(start, -1, `missing job ${name}`);
  const end = next ? source.indexOf(`\n  ${next}:`, start + 1) : source.length;
  return source.slice(start, end === -1 ? source.length : end);
}

function checkoutBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!checkoutRef.test(lines[index])) continue;
    const indent = lines[index].match(/^\s*/)?.[0].length || 0;
    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end];
      const nextIndent = line.match(/^\s*/)?.[0].length || 0;
      if (/^\s*-\s+/.test(line) && nextIndent <= indent) break;
      end += 1;
    }
    blocks.push(lines.slice(index, end).join('\n'));
  }
  return blocks;
}

test('PR-reachable Pages jobs stay read-only and never persist checkout credentials', async () => {
  const source = await readFile(pagesPath, 'utf8');
  const top = source.match(/^permissions:\n([\s\S]*?)\nconcurrency:/m)?.[1] || '';
  assert.match(top, /^  contents: read$/m);
  assert.doesNotMatch(top, /(?:pages|id-token|issues): write/);

  for (const [name, next] of [['remote-gate', 'build'], ['build', 'deploy']]) {
    const section = job(source, name, next);
    assert.doesNotMatch(section, /^    permissions:/m);
    const checkouts = checkoutBlocks(section);
    assert.ok(checkouts.length > 0, `${name} must check out repository code`);
    for (const block of checkouts) assert.match(block, /persist-credentials: false/);
  }
});

test('Pages, OIDC, and issue mutation authority exist only in the push-only deploy job', async () => {
  const source = await readFile(pagesPath, 'utf8');
  const deploy = job(source, 'deploy');
  assert.match(deploy, /if: github\.event_name == 'push'/);
  assert.match(deploy, /^      pages: write$/m);
  assert.match(deploy, /^      id-token: write$/m);
  assert.match(deploy, /^      issues: write$/m);
  for (const block of checkoutBlocks(deploy)) assert.match(block, /persist-credentials: false/);

  const beforeDeploy = source.slice(0, source.indexOf('\n  deploy:'));
  assert.doesNotMatch(beforeDeploy, /^\s+(?:pages|id-token|issues): write$/m);
});

test('secret-bearing lasso execution uses only trusted default-branch code', async () => {
  const source = await readFile(lassoPath, 'utf8');
  const checkouts = checkoutBlocks(source);
  assert.equal(checkouts.length, 1);
  assert.match(checkouts[0], /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(checkouts[0], /path: trusted-lasso/);
  assert.match(checkouts[0], /persist-credentials: false/);
  assert.match(source, /name: Verify trusted lasso before execution\n        working-directory: trusted-lasso/);
  assert.match(source, /name: Group the incoming principal[\s\S]*?working-directory: trusted-lasso[\s\S]*?node scripts\/weave-lasso\.mjs github-event/);
  assert.doesNotMatch(source, /working-directory: (?!trusted-lasso)/);
});

test('Maker collision gate uses trusted default-branch code with read-only permissions', async () => {
  const source = await readFile(makerCollisionPath, 'utf8');
  assert.match(source, /^on:\n  pull_request_target:/m);
  const top = source.match(/^permissions:\n([\s\S]*?)\nconcurrency:/m)?.[1] || '';
  assert.match(top, /^  contents: read$/m);
  assert.match(top, /^  pull-requests: read$/m);
  assert.doesNotMatch(top, /write/);
  assert.doesNotMatch(source, /^\s+(?:contents|pull-requests|issues): write$/m);

  const section = job(source, 'path-lease');
  const checkouts = checkoutBlocks(section);
  assert.equal(checkouts.length, 1);
  assert.match(checkouts[0], /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(checkouts[0], /persist-credentials: false/);
  assert.match(section, /actions\/github-script@[0-9a-f]{40}/);
  assert.match(section, /github\.paginate\(github\.rest\.pulls\.listFiles/);
  assert.match(section, /github\.paginate\(github\.rest\.pulls\.list/);
  assert.match(section, /gate\.evaluatePathLease/);
  assert.match(section, /core\.setFailed/);
});

test('native Maker write authority is preflight-gated, trusted-main, and draft-PR bounded', async () => {
  const source = await readFile(makerWorkerPath, 'utf8');
  const top = source.match(/^permissions:\n([\s\S]*?)\nconcurrency:/m)?.[1] || '';
  assert.match(top, /^  contents: read$/m);
  assert.doesNotMatch(top, /write/);

  const preflight = job(source, 'preflight', 'blocked');
  assert.match(preflight, /^      contents: read$/m);
  assert.match(preflight, /^      issues: read$/m);
  assert.doesNotMatch(preflight, /contents: write|issues: write|pull-requests: write/);
  assert.match(preflight, /ownerAuthored/);
  assert.match(preflight, /makerTitle/);
  assert.match(preflight, /ownerActor/);
  assert.match(preflight, /core\.setOutput\('allowed', String\(allowed\)\)/);
  assert.match(preflight, /\^\\\[maker:\(build\|fix\|explore\|audit\)/);

  const blocked = job(source, 'blocked', 'hosted-worker');
  assert.match(blocked, /needs: preflight/);
  assert.match(blocked, /needs\.preflight\.outputs\.allowed == 'true'/);
  assert.match(blocked, /^      contents: read$/m);
  assert.match(blocked, /^      issues: write$/m);
  assert.doesNotMatch(blocked, /pull-requests: write|contents: write/);
  assert.match(blocked, /no engineering model, workspace, branch, patch, or PR ran/);

  for (const [name, next] of [['hosted-worker', 'self-hosted-worker'], ['self-hosted-worker', '']]) {
    const section = job(source, name, next);
    assert.match(section, /needs: preflight/);
    assert.match(section, /needs\.preflight\.outputs\.allowed == 'true'/);
    assert.match(section, /^      contents: write$/m);
    assert.match(section, /^      pull-requests: write$/m);
    assert.match(section, /^      issues: write$/m);
    assert.match(section, /name: Verify native worker before write authority[\s\S]*?node --check scripts\/open-model-planning\.mjs[\s\S]*?node --test scripts\/tests\/native-maker-worker\.test\.mjs/);
    assert.match(section, /run: node scripts\/maker-native-worker\.mjs/);
    assert.match(section, /SIDEWAYS_DEFAULT_BRANCH: \$\{\{ needs\.preflight\.outputs\.default_branch \}\}/);
    assert.match(section, /Preserve planning, implementation, and admission episode/);
    assert.match(section, /path: \$\{\{ runner\.temp \}\}\/sideways-native-episode\.json/);
    const checkouts = checkoutBlocks(section);
    assert.equal(checkouts.length, 1);
    assert.match(checkouts[0], /ref: \$\{\{ needs\.preflight\.outputs\.default_branch \}\}/);
    assert.match(checkouts[0], /persist-credentials: true/);
  }

  assert.match(job(source, 'self-hosted-worker'), /runs-on: \[self-hosted, sideways-maker\]/);
  assert.match(source, /SIDEWAYS_MODEL_API_KEY: \$\{\{ secrets\.SIDEWAYS_MODEL_API_KEY \}\}/);
});
