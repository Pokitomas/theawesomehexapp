import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const audit = JSON.parse(await read('audit/operations-reality.json'));

test('operations audit permits only explicit evidence states', () => {
  assert.equal(audit.schema, 'sideways-operations-reality/v1');
  const allowed = new Set(['verified', 'previously_verified', 'unknown']);
  for (const fact of audit.facts) {
    assert.ok(allowed.has(fact.state), `${fact.id} has invalid state`);
    if (fact.state === 'verified') assert.ok(fact.evidence.length > 0, `${fact.id} lacks evidence`);
    if (fact.state === 'unknown') assert.deepEqual(fact.evidence, [], `${fact.id} disguises unknown evidence`);
  }
});

test('repository workflow evidence exists but does not certify external operation', async () => {
  const pages = await read('.github/workflows/pages.yml');
  const receipt = await read('scripts/tests/deployment-receipt.test.mjs');
  assert.match(pages, /Build and deploy manual root-kernel feed/);
  assert.match(receipt, /deployment/i);
  assert.ok(audit.facts.some(fact => fact.scope === 'external' && fact.state === 'unknown'));
  assert.match(audit.admission_rule, /cannot turn an unknown external configuration into a verified fact/);
});

test('previous deployment evidence requires a fresh check', () => {
  const publicUrl = audit.facts.find(fact => fact.id === 'static-public-url');
  assert.equal(publicUrl.state, 'previously_verified');
  assert.equal(publicUrl.recheck_required, true);
  assert.ok(audit.next_proof.length >= 4);
});
