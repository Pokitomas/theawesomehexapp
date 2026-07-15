import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

const audit = JSON.parse(await read('audit/product-journey.json'));

const byId = new Map(audit.surfaces.map(surface => [surface.id, surface]));

test('product audit defines one promise and all current entry surfaces', () => {
  assert.equal(audit.schema, 'sideways-product-journey-audit/v1');
  assert.match(audit.primary_promise, /person-owned memory/i);
  assert.deepEqual([...byId.keys()].sort(), ['founder-room', 'live', 'maker', 'private-archive', 'root-reader']);
  assert.equal(byId.get('root-reader').default_user_path, true);
  assert.equal(byId.get('private-archive').default_user_path, true);
  assert.equal(byId.get('founder-room').default_user_path, false);
  assert.equal(byId.get('maker').default_user_path, false);
});

test('journey evidence names tracked implementation surfaces and no completed gap contradicts itself', async () => {
  const named = new Set();
  for (const step of audit.journey) {
    assert.ok(byId.has(step.surface), `unknown surface ${step.surface}`);
    assert.ok(['implemented', 'partial', 'advanced'].includes(step.state));
    if (step.state === 'implemented') assert.equal(step.gap, null);
    if (step.state === 'partial') assert.ok(step.gap);
    for (const path of step.evidence) {
      named.add(path);
      await assert.doesNotReject(read(path), `missing evidence ${path}`);
    }
  }
  assert.ok(named.size >= 7);
});

test('internal founder and Maker language cannot become the default consumer promise', async () => {
  const founder = await read('founder/index.html');
  const maker = await read('maker/index.html');
  assert.match(founder, /FOUNDER ROOM/);
  assert.match(maker, /Maker/i);
  assert.match(audit.release_rule, /outside the normal user path/i);
  assert.equal(audit.surfaces.filter(surface => surface.default_user_path).length, 2);
});
