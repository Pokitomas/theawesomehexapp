import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { dispatchEvent() {} };
const { mirrorAll } = await import('../../studio/manual/product/survival-ledger.js');

const capture = async () => ({
  records: [{ id: 1, hash: 'one', assetKey: 'asset:one' }, { id: 2, hash: 'two', assetKey: 'asset:two' }],
  assets: [{ key: 'asset:one', blob: { size: 3 } }, { key: 'asset:two', blob: { size: 7 } }]
});
const open = async () => ({ vault: { id: 'vault' }, assets: { id: 'assets' } });

test('interrupted mirror records one failure and never records a checkpoint', async () => {
  const receipts = [];
  let writes = 0;
  await assert.rejects(
    mirrorAll({
      capture,
      open,
      async write() {
        writes += 1;
        if (writes === 2) throw new Error('quota interrupted mirror');
      },
      async record(op, detail) { receipts.push({ op, detail }); }
    }),
    /quota interrupted mirror/
  );
  assert.equal(writes, 2);
  assert.deepEqual(receipts.map(receipt => receipt.op), ['survival.mirror.failed']);
  assert.equal(receipts[0].detail.status, 'failed');
  assert.equal(receipts[0].detail.writtenAssets, 1);
  assert.equal(receipts[0].detail.bytes, 3);
  assert.equal(receipts.some(receipt => receipt.op === 'survival.mirror.checkpoint'), false);
});

test('complete mirror writes assets and manifest before the checkpoint receipt', async () => {
  const receipts = [];
  const writes = [];
  const result = await mirrorAll({
    capture,
    open,
    async write(directory, name, value) { writes.push({ directory: directory.id, name, value }); },
    async record(op, detail) { receipts.push({ op, detail }); }
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.assets, 2);
  assert.equal(result.bytes, 10);
  assert.deepEqual(writes.map(write => write.name), ['asset_3Aone.bin', 'asset_3Atwo.bin', 'manifest.json']);
  assert.deepEqual(receipts.map(receipt => receipt.op), ['survival.mirror.checkpoint']);
});

test('unavailable OPFS records an unavailable receipt instead of a checkpoint', async () => {
  const receipts = [];
  const result = await mirrorAll({
    capture,
    open: async () => null,
    async record(op, detail) { receipts.push({ op, detail }); }
  });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(receipts.map(receipt => receipt.op), ['survival.mirror.unavailable']);
});
