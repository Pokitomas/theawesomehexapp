import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../..', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

async function absent(path) {
  await assert.rejects(access(new URL(path, root)), error => error?.code === 'ENOENT');
}

test('product truth names distinct authority, archive, candidate, index, and fixture objects', async () => {
  const [readme, ontology] = await Promise.all([
    read('README.md'),
    read('PROGRAM_ONTOLOGY.md')
  ]);

  for (const term of [
    'Public social graph',
    'Private personal archive',
    'Ranking candidate pool',
    'Retrieval index',
    'Starter fixture'
  ]) assert.ok(ontology.includes(term), term);

  assert.match(ontology, /repository now implements this authority/);
  assert.match(ontology, /missing center is no longer a schema or authority engine/);
  assert.match(readme, /canonical public social authority/);
  assert.match(readme, /IndexedDB is the canonical hot store for the private personal archive/);
  assert.match(readme, /ranking candidate pool is temporary/);
  assert.doesNotMatch(readme, /IndexedDB is the canonical hot corpus/);
  assert.doesNotMatch(readme, /does not provide a general account system, moderation service/);
});

test('public projection cache and feed eligibility remain structurally separate', async () => {
  const [workspace, network] = await Promise.all([
    read('studio/manual/product/workspace-db.js'),
    read('studio/manual/product/network-records.js')
  ]);

  assert.match(workspace, /NETWORK_RECORD_STORE = 'networkRecords'/);
  assert.match(workspace, /NETWORK_VIEW_STORE = 'networkViews'/);
  assert.match(network, /authority: 'public'/);
  assert.match(network, /transaction\(NETWORK_RECORD_STORE, 'readwrite'\)/);
  assert.match(network, /transaction\(NETWORK_VIEW_STORE, 'readwrite'\)/);
  assert.match(network, /authoritativeDeletes: 0/);
  assert.match(network, /candidateMaterializationPlan/);
});

test('ranking-laboratory notes no longer claim a social corpus', async () => {
  const [mix, plan] = await Promise.all([
    read('notes/ranking-candidate-mix.md'),
    read('notes/ranking-candidate-plan.md')
  ]);

  assert.match(mix, /not canonical authority/);
  assert.match(mix, /Canonical Sideways publications come only from the public social authority/);
  assert.match(plan, /ranking-laboratory records are canonical Sideways social publications/);
  assert.doesNotMatch(`${mix}\n${plan}`, /social corpus/i);
  await absent('notes/social-corpus-spec.md');
  await absent('notes/social-corpus-plan.md');
});

test('corpus remains explicitly scoped to the private archive compatibility boundary', async () => {
  const [ontology, corpusDb] = await Promise.all([
    read('PROGRAM_ONTOLOGY.md'),
    read('studio/manual/shared/corpus-db.js')
  ]);

  assert.match(ontology, /corpus-db\.js` name refers only to this private archive compatibility boundary/);
  assert.match(corpusDb, /sideways-manual-corpus-v1/);
  assert.match(corpusDb, /RECORD_STORE = 'records'/);
});
