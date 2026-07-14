import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planNetworkProjection } from '../product/network-records.js';

const discover = planNetworkProjection({
  cachedPostIds: [],
  currentCandidatePostIds: [],
  incomingPostIds: ['A', 'B'],
  viewKey: 'discover'
});

assert.deepEqual(discover.cacheRetain, ['A', 'B']);
assert.deepEqual(discover.candidateMaterialize, ['A', 'B']);
assert.deepEqual(discover.candidateRemove, []);
assert.deepEqual(discover.membershipReplace.map(row => row.key), ['discover:A', 'discover:B']);

const following = planNetworkProjection({
  cachedPostIds: discover.cacheRetain,
  currentCandidatePostIds: discover.candidateMaterialize,
  incomingPostIds: ['B'],
  viewKey: 'following'
});

assert.deepEqual(following.cacheRetain, ['A', 'B'], 'changing feed views must not erase observed public facts');
assert.deepEqual(following.candidateMaterialize, ['B'], 'only B is eligible in the following view');
assert.deepEqual(following.candidateRemove, ['A'], 'A leaves delivery materialization without becoming an authoritative deletion');
assert.deepEqual(following.membershipReplace.map(row => row.key), ['following:B']);

const network = fs.readFileSync('studio/manual/product/network-records.js', 'utf8');
const workspace = fs.readFileSync('studio/manual/product/workspace-db.js', 'utf8');
const survival = fs.readFileSync('studio/manual/product/survival-ledger.js', 'utf8');

for (const token of [
  'NETWORK_RECORD_STORE',
  'NETWORK_VIEW_STORE',
  "ledgerEntry('network.materialize'",
  'authoritativeDeletes: 0',
  "authority: 'public'",
  "source: 'network-cache'"
]) {
  if (!network.includes(token)) throw new Error(`network authority implementation missing ${token}`);
}

for (const token of [
  "export const WORKSPACE_VERSION = 2",
  "export const NETWORK_RECORD_STORE = 'networkRecords'",
  "export const NETWORK_VIEW_STORE = 'networkViews'",
  "records.createIndex('nativeId'",
  "views.createIndex('viewKey'"
]) {
  if (!workspace.includes(token)) throw new Error(`workspace schema missing ${token}`);
}

if (!survival.includes("startsWith('network:')") || !survival.includes('user-owned Ark excludes server projections')) {
  throw new Error('private Ark boundary no longer excludes public delivery projections');
}

console.log('network authority contract ok: public cache survives view changes; candidate materialization remains transient');
