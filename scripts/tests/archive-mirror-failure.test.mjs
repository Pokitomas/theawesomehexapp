import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { dispatchEvent() {} };
globalThis.CustomEvent ||= class CustomEvent {};
const { mirrorAll } = await import('../../studio/manual/product/survival-ledger.js');

const capture = async () => ({
  records: [{ id: 1, hash: 'one', assetKey: 'asset:one' }, { id: 2, hash: 'two', assetKey: 'asset:two' }],
  assets: [{ key: 'asset:one', blob: { size: 3 } }, { key: 'asset:two', blob: { size: 7 } }]
});
const open = async () => ({ vault: { id: 'vault' }, assets: { id: 'assets' } });

test('interrupted mirror records exact partial bytes, cleans staging, and never checkpoints', async () => {
  const receipts = [];
  let writes = 0;
  let cleaned = false;
  await assert.rejects(mirrorAll({
    capture, open, generationId: () => 'fixture-generation',
    async makeGeneration(dirs, generation) { return { assets: dirs.assets, generation, async cleanup() { cleaned = true; } }; },
    async write() { writes += 1; if (writes === 2) throw new DOMException('quota interrupted mirror', 'QuotaExceededError'); },
    async record(op, detail) { receipts.push({ op, detail }); }
  }), /quota interrupted mirror/);
  assert.equal(writes, 2);
  assert.equal(cleaned, true);
  assert.deepEqual(receipts.map(item => item.op), ['survival.mirror.failed']);
  assert.equal(receipts[0].detail.writtenAssets, 1);
  assert.equal(receipts[0].detail.bytes, 3);
  assert.equal(receipts[0].detail.errorCode, 'quota-exceeded');
  assert.equal(receipts[0].detail.promoted, false);
});

test('complete mirror promotes manifest last and only then checkpoints', async () => {
  const receipts = [];
  const writes = [];
  const result = await mirrorAll({
    capture, open, generationId: () => 'fixture-generation',
    async makeGeneration(dirs, generation) { return { assets: dirs.assets, generation, async cleanup() {} }; },
    async write(directory, name) { writes.push({ directory: directory.id, name }); },
    async record(op, detail) { receipts.push({ op, detail }); }
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.promoted, true);
  assert.equal(result.generation, 'fixture-generation');
  assert.equal(result.bytes, 10);
  assert.deepEqual(writes.map(item => item.name), ['asset_3Aone.bin', 'asset_3Atwo.bin', 'manifest.pending.json', 'manifest.json']);
  assert.deepEqual(receipts.map(item => item.op), ['survival.mirror.checkpoint']);
  assert.equal(receipts[0].detail.canonicalStore, 'IndexedDB');
});

test('unavailable OPFS records unavailable with IndexedDB still canonical', async () => {
  const receipts = [];
  const result = await mirrorAll({ capture, open: async () => null, async record(op, detail) { receipts.push({ op, detail }); } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.canonicalStore, 'IndexedDB');
  assert.deepEqual(receipts.map(item => item.op), ['survival.mirror.unavailable']);
});
