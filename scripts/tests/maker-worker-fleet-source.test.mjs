import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const cases = [
  ['scripts/maker-worker-fleet.mjs', 300],
  ['scripts/tests/maker-worker-fleet.test.mjs', 150],
  ['maker/contracts/worker-fleet.schema.json', 50]
];

test('worker-fleet implementation, tests, and contract remain reviewable source', async () => {
  for (const [path, minimumLines] of cases) {
    const content = await fs.readFile(path, 'utf8');
    assert.ok(content.split(/\r?\n/).length >= minimumLines, `${path} collapsed into a generated/minified artifact`);
    assert.doesNotMatch(content, /sourceMappingURL|^\s*\/\*![^]*generated/i);
  }
  JSON.parse(await fs.readFile('maker/contracts/worker-fleet.schema.json', 'utf8'));
});
