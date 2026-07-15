import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const audit = JSON.parse(await read('audit/archive-survival.json'));
const implementation = await read('studio/manual/product/survival-ledger.js');

test('survival audit keeps storage, same-origin copy, and portable Ark distinct', () => {
  assert.equal(audit.schema, 'sideways-archive-survival-audit/v1');
  assert.equal(audit.canonical_private_store, 'IndexedDB');
  assert.equal(audit.same_origin_copy, 'OPFS');
  assert.equal(audit.portable_copy, '.sideways Ark');
  assert.equal(audit.states.find(state => state.id === 'mirror').portable, false);
  assert.equal(audit.states.find(state => state.id === 'external').portable, true);
});

test('failure matrix is bound to exact implementation outcomes', () => {
  const required = audit.failure_contracts.map(contract => contract.required_result);
  assert.ok(required.some(value => value.includes('survival.mirror.unavailable')));
  assert.match(implementation, /survival\.mirror\.unavailable/);
  assert.match(implementation, /NOT A SIDEWAYS ARK/);
  assert.match(implementation, /ARK HEADER IS INVALID/);
  assert.match(implementation, /ARK VERSION IS NOT SUPPORTED/);
  assert.match(implementation, /isServerProjection/);
  assert.match(implementation, /skipped \+= 1/);
});

test('audit does not overclaim browser-download retention or same-origin durability', () => {
  const ark = audit.states.find(state => state.id === 'ark');
  const mirror = audit.states.find(state => state.id === 'mirror');
  assert.equal(ark.portable, 'not_proven');
  assert.equal(mirror.portable, false);
  assert.ok(audit.open_gaps.length >= 4);
  assert.match(implementation, /status: 'download-issued'/);
  assert.match(implementation, /sameOrigin: true/);
});
