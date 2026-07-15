import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const audit = JSON.parse(await read('audit/archive-survival.json'));
const implementation = await read('studio/manual/product/survival-ledger.js');

globalThis.window ||= { dispatchEvent() {} };
globalThis.CustomEvent ||= class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
const { restoreArkTransaction } = await import('../../studio/manual/product/survival-ledger.js');

test('storage, same-origin copy, requested download, and completed external save remain distinct', () => {
  assert.equal(audit.canonical_private_store, 'IndexedDB');
  assert.equal(audit.same_origin_copy, 'OPFS');
  assert.equal(audit.portable_copy, '.sideways Ark');
  assert.equal(audit.states.find(state => state.id === 'mirror').portable, false);
  assert.equal(audit.states.find(state => state.id === 'ark').portable, 'not_proven');
  assert.equal(audit.states.find(state => state.id === 'external').portable, true);
  assert.deepEqual(audit.open_gaps, []);
  assert.ok(audit.external_observation_limits.length >= 2);
});

test('streaming export is primary and the Blob fallback is explicitly bounded', () => {
  assert.match(implementation, /MAX_IN_MEMORY_ARK_BYTES = 256 \* 1024 \* 1024/);
  assert.match(implementation, /await writeParts\(writable, parts\)/);
  assert.match(implementation, /for \(const part of parts\)/);
  assert.match(implementation, /ARK EXCEEDS BOUNDED MEMORY FALLBACK/);
  assert.match(implementation, /status: 'download-issued'/);
  assert.match(implementation, /status: 'external-written'/);
  assert.match(audit.streaming_contract.retention, /download-issued remains not_proven/);
});

test('forced mid-restore failure restores prior state and emits only a failure receipt', async () => {
  const prior = { records: [{ id: 1 }], assets: [{ key: 'old' }], ledger: [{ op: 'before' }], places: [{ id: 'home' }], profile: '{"name":"Before"}', legacyProfile: null };
  const live = structuredClone(prior);
  const receipts = [];
  const stage = { records: [{ text: 'new' }], assets: [{ key: 'new' }], places: [{ id: 'away' }], profile: { name: 'After' }, skipped: 0, ledgerEntries: 0, sourceCreatedAt: '2026-07-15T00:00:00.000Z' };
  await assert.rejects(() => restoreArkTransaction(stage, {
    prior,
    async applyCorpus() { live.records = stage.records; live.assets = stage.assets; },
    async applyPlaces() { live.places = stage.places; throw new Error('forced place failure'); },
    async applyProfile() { live.profile = JSON.stringify(stage.profile); },
    async rollback(snapshot) { Object.assign(live, structuredClone(snapshot)); },
    async record(op, detail) { receipts.push({ op, detail }); },
    dispatch() { throw new Error('must not dispatch success'); }
  }), /forced place failure/);
  assert.deepEqual(live, prior);
  assert.deepEqual(receipts.map(item => item.op), ['survival.ark.restore.failed']);
  assert.equal(receipts[0].detail.phase, 'places');
  assert.equal(receipts[0].detail.rollback, 'complete');
});

test('successful restore records success only after every phase commits', async () => {
  const order = [];
  const stage = { records: [{}], assets: [{}], places: [{}], profile: {}, skipped: 2, ledgerEntries: 3, sourceCreatedAt: 'fixture' };
  const result = await restoreArkTransaction(stage, {
    prior: { records: [], assets: [], ledger: [], places: [], profile: null, legacyProfile: null },
    async applyCorpus() { order.push('corpus'); },
    async applyPlaces() { order.push('places'); },
    async applyProfile() { order.push('profile'); },
    async rollback() { order.push('rollback'); },
    async record(op) { order.push(op); },
    dispatch() { order.push('dispatch'); }
  });
  assert.deepEqual(order, ['corpus', 'places', 'profile', 'survival.ark.restore', 'dispatch']);
  assert.deepEqual(result, { added: 1, skipped: 2, assets: 1, ledgerEntries: 3 });
});

test('parser and private-boundary failures are explicit in implementation and audit', () => {
  for (const token of ['NOT A SIDEWAYS ARK', 'ARK HEADER IS INVALID', 'ARK VERSION IS NOT SUPPORTED', 'ARK PAYLOAD IS TRUNCATED', 'ARK ASSET RANGE IS INVALID', 'isServerProjection', 'skipped += 1']) assert.match(implementation, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(audit.failure_contracts.every(contract => contract.condition && contract.required_result));
});
