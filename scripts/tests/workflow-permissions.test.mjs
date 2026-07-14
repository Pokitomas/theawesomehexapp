import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pagesPath = new URL('../../.github/workflows/pages.yml', import.meta.url);
const lassoPath = new URL('../../.github/workflows/weave-lasso.yml', import.meta.url);

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
    if (!/uses:\s*actions\/checkout@v4\s*$/.test(lines[index])) continue;
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
