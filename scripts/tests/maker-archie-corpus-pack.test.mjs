import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ARCHIE_CORPUS_PACK_SCHEMA,
  exportCorpusPack,
  importCorpusPack,
  inspectCorpusPack
} from '../maker-archie-corpus-pack.mjs';

const fixedClock = () => Date.parse('2026-07-16T02:00:00.000Z');
const tempRoot = () => fs.mkdtemp(path.join(os.tmpdir(), 'archie-pack-'));

async function seed(root) {
  const record = {
    schema: 'archie-linux-corpus-record/v1',
    record_id: 'rec_one',
    content_digest: 'a'.repeat(64),
    input: { text: 'repair the conflict', context: { authorization: '[redacted]' } },
    output: { text: 'done', plan: ['inspect', 'repair', 'verify'] },
    outcome: 'completed'
  };
  const example = {
    schema: 'archie-distillation-example/v1',
    example_id: 'ex_one',
    example_digest: 'b'.repeat(64),
    instruction: 'repair the conflict',
    target: ['inspect', 'repair', 'verify'],
    tool_trace: [],
    outcome: 'completed'
  };
  await fs.mkdir(path.join(root, 'objects', 'aa'), { recursive: true });
  await fs.mkdir(path.join(root, 'examples', 'bb'), { recursive: true });
  await fs.writeFile(path.join(root, 'objects', 'aa', `${'a'.repeat(64)}.json`), `${JSON.stringify(record)}\n`);
  await fs.writeFile(path.join(root, 'examples', 'bb', `${'b'.repeat(64)}.json`), `${JSON.stringify(example)}\n`);
  await fs.writeFile(path.join(root, 'records.jsonl'), `${JSON.stringify({ record_id: 'rec_one', content_digest: 'a'.repeat(64), object_path: `objects/aa/${'a'.repeat(64)}.json` })}\n`);
  await fs.writeFile(path.join(root, 'examples.jsonl'), `${JSON.stringify({ example_id: 'ex_one', example_digest: 'b'.repeat(64), example_path: `examples/bb/${'b'.repeat(64)}.json` })}\n`);
  await fs.writeFile(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ operation: 'ingest.stored', content_digest: 'a'.repeat(64) })}\n`);
}

async function treeDigest(root) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else files.push([relative, crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex')]);
    }
  }
  await walk(root);
  return files;
}

test('exports and restores a deterministic owned-memory pack', async () => {
  const workspace = await tempRoot();
  const source = path.join(workspace, 'source');
  const target = path.join(workspace, 'target');
  const file = path.join(workspace, 'memory.archie.json');
  await seed(source);
  const first = await exportCorpusPack({ root: source, destination: file, clock: fixedClock });
  const second = await exportCorpusPack({ root: source, clock: fixedClock });
  assert.equal(first.pack.schema, ARCHIE_CORPUS_PACK_SCHEMA);
  assert.equal(first.pack_digest, second.pack_digest);
  assert.equal(first.entry_count, 5);
  const inspected = inspectCorpusPack(await fs.readFile(file, 'utf8'));
  assert.equal(inspected.pack_digest, first.pack_digest);
  const restored = await importCorpusPack({ root: target, source: file, clock: fixedClock });
  assert.equal(restored.status, 'restored');
  assert.deepEqual(await treeDigest(target), await treeDigest(source));
});

test('rejects content tampering, traversal, duplicate paths, and secrets', async () => {
  const workspace = await tempRoot();
  const source = path.join(workspace, 'source');
  await seed(source);
  const { pack } = await exportCorpusPack({ root: source, clock: fixedClock });
  const tampered = structuredClone(pack);
  tampered.entries[0].content = Buffer.from('{}').toString('base64');
  assert.throws(() => inspectCorpusPack(tampered), /byte count|digest mismatch/);
  const traversal = structuredClone(pack);
  traversal.entries[0].path = '../escape.json';
  assert.throws(() => inspectCorpusPack(traversal), /traversal|relative/);
  const duplicate = structuredClone(pack);
  duplicate.entries.push(structuredClone(duplicate.entries[0]));
  duplicate.source.entry_count += 1;
  duplicate.source.total_bytes += duplicate.entries[0].bytes;
  assert.throws(() => inspectCorpusPack(duplicate), /Duplicate/);
  await fs.writeFile(path.join(source, 'objects', 'aa', 'secret.json'), JSON.stringify({ api_key: 'sk-12345678901234567890' }));
  await assert.rejects(exportCorpusPack({ root: source, clock: fixedClock }), /secret-like|Unredacted/);
});

test('rejects symbolic links and bounded-memory violations', async t => {
  const workspace = await tempRoot();
  const source = path.join(workspace, 'source');
  await seed(source);
  const link = path.join(source, 'objects', 'aa', 'linked.json');
  try { await fs.symlink(path.join(source, 'records.jsonl'), link); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlink creation unavailable');
    throw error;
  }
  await assert.rejects(exportCorpusPack({ root: source, clock: fixedClock }), /symbolic links/);
  await fs.unlink(link);
  await assert.rejects(exportCorpusPack({ root: source, clock: fixedClock, limits: { max_file_bytes: 4 } }), /max_file_bytes/);
});

test('explicit replacement rolls back the previous corpus after a failed promotion', async () => {
  const workspace = await tempRoot();
  const source = path.join(workspace, 'source');
  const target = path.join(workspace, 'target');
  await seed(source);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'records.jsonl'), `${JSON.stringify({ old: true })}\n`);
  const before = await treeDigest(target);
  const { pack } = await exportCorpusPack({ root: source, clock: fixedClock });
  await assert.rejects(importCorpusPack({
    root: target,
    pack,
    replace: true,
    clock: fixedClock,
    fault(phase) { if (phase === 'after_backup') throw new Error('forced promotion failure'); }
  }), error => {
    assert.match(error.message, /forced promotion failure/);
    assert.equal(error.import_receipt.rollback, 'complete');
    return true;
  });
  assert.deepEqual(await treeDigest(target), before);
});

test('existing targets require explicit replacement authority', async () => {
  const workspace = await tempRoot();
  const source = path.join(workspace, 'source');
  const target = path.join(workspace, 'target');
  await seed(source);
  await fs.mkdir(target);
  const { pack } = await exportCorpusPack({ root: source, clock: fixedClock });
  await assert.rejects(importCorpusPack({ root: target, pack, clock: fixedClock }), /replace=true/);
});
