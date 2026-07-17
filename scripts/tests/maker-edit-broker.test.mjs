import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MakerEditBroker, normalizeEditTransaction } from '../../maker/runtime/edit-broker.mjs';
import { MakerToolBroker } from '../../maker/runtime/tool-broker.mjs';
import { MakerSecurityPolicy, digest } from '../maker-security-policy.mjs';

const BASE = 'a'.repeat(40);
const CLOCK = () => '2026-07-16T00:00:00.000Z';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-edit-root-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-edit-state-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(stateRoot, { recursive: true, force: true })
  ]));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'alpha\nbeta\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'b.txt'), 'bravo\n', 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), '# Outside lease\n', 'utf8');
  return { root, stateRoot };
}

function grant(capability, nonce, scope = {}, maxUses = 500) {
  return {
    capability,
    issued_by: 'kai',
    nonce,
    expires_at: '2026-07-16T02:00:00.000Z',
    human_approved: true,
    max_uses: maxUses,
    scope,
    reason: 'transaction test'
  };
}

function security() {
  return new MakerSecurityPolicy({
    clock: CLOCK,
    grants: [
      grant('write.file', 'write', { paths: ['src/**'] }),
      grant('delete.file', 'delete', { paths: ['src/**'] })
    ]
  });
}

function lease(overrides = {}) {
  return {
    base_sha: overrides.base_sha ?? BASE,
    branch: overrides.branch ?? 'maker/issue-307-test',
    writer_count: 1,
    owned_paths: ['src/**'],
    authority: { merge: 'human', deploy: 'human' },
    ...overrides
  };
}

function editBroker(root, stateRoot, overrides = {}) {
  return new MakerEditBroker({
    root,
    state_root: stateRoot,
    lease: overrides.lease || lease(),
    security_policy: overrides.security || security(),
    broker_factory: overrides.broker_factory,
    fs_impl: fs,
    clock: CLOCK
  });
}

function transaction(overrides = {}) {
  return {
    transaction_id: overrides.transaction_id || 'tx-1',
    repository: 'acme/widgets',
    base_sha: overrides.base_sha ?? BASE,
    branch: overrides.branch ?? 'maker/issue-307-test',
    request: 'Apply the exact bounded patch.',
    operations: overrides.operations ?? [
      { operation_id: 'replace-a', kind: 'replace', path: 'src/a.txt', before: 'beta', after: 'gamma', expected: { occurrences: 1 } },
      { operation_id: 'create-c', kind: 'create', path: 'src/c.txt', content: 'charlie\n', expected: { exists: false } }
    ]
  };
}

test('transaction normalization binds exact branch, base, one-writer lease, and unique operation IDs', () => {
  const normalized = normalizeEditTransaction(transaction(), lease());
  assert.equal(normalized.base_sha, BASE);
  assert.equal(normalized.branch, 'maker/issue-307-test');
  assert.equal(normalized.operations.length, 2);
  assert.match(normalized.transaction_digest, /^[0-9a-f]{64}$/);
  assert.throws(() => normalizeEditTransaction(transaction({ base_sha: 'b'.repeat(40) }), lease()), /identity differs/);
  assert.throws(() => normalizeEditTransaction(transaction({ operations: [] }), lease()), /requires 1-500/);
  assert.throws(() => normalizeEditTransaction(transaction({ operations: [
    { operation_id: 'same', kind: 'write', path: 'src/a.txt', content: 'a' },
    { operation_id: 'same', kind: 'write', path: 'src/b.txt', content: 'b' }
  ] }), lease()), /Duplicate edit operation ID/);
  assert.throws(() => normalizeEditTransaction(transaction({ operations: [
    { kind: 'write', path: 'README.md', content: 'no' }
  ] }), lease()), /outside the one-writer lease/);
});

test('external state root is mandatory and cannot live inside the checkout', async t => {
  const { root, stateRoot } = await fixture(t);
  assert.throws(() => new MakerEditBroker({ root, state_root: path.join(root, '.maker'), lease: lease(), security_policy: security() }), /outside the repository checkout/);
  assert.doesNotThrow(() => editBroker(root, stateRoot));
});

test('preview validates preconditions without mutating files or exposing staged contents', async t => {
  const { root, stateRoot } = await fixture(t);
  const broker = editBroker(root, stateRoot);
  const preview = await broker.preview(transaction());
  assert.equal(preview.mutations.length, 2);
  assert.deepEqual(preview.changed_paths, ['src/a.txt', 'src/c.txt']);
  assert.match(preview.diff, /-beta/);
  assert.match(preview.diff, /\+gamma/);
  assert.equal(Object.hasOwn(preview, 'internal_mutations'), false);
  assert.ok(!JSON.stringify(preview).includes('staged_content'));
  assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), 'alpha\nbeta\n');
  await assert.rejects(fs.stat(path.join(root, 'src', 'c.txt')));
});

test('precondition digests, create absence, replacement counts, and duplicate paths fail before mutation', async t => {
  const { root, stateRoot } = await fixture(t);
  const broker = editBroker(root, stateRoot);
  await assert.rejects(broker.preview(transaction({ operations: [
    { kind: 'write', path: 'src/a.txt', content: 'x', expected: { sha256: 'f'.repeat(64) } }
  ] })), /digest differs/);
  await assert.rejects(broker.preview(transaction({ operations: [
    { kind: 'create', path: 'src/a.txt', content: 'x' }
  ] })), /already exists/);
  await assert.rejects(broker.preview(transaction({ operations: [
    { kind: 'replace', path: 'src/a.txt', before: 'missing', after: 'x', expected: { occurrences: 1 } }
  ] })), /found 0/);
  await assert.rejects(broker.preview(transaction({ operations: [
    { operation_id: 'one', kind: 'write', path: 'src/a.txt', content: 'x' },
    { operation_id: 'two', kind: 'delete', path: 'src/a.txt' }
  ] })), /touches a path more than once/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), 'alpha\nbeta\n');
});

test('begin writes only digests and external staged-file references to the journal', async t => {
  const { root, stateRoot } = await fixture(t);
  const broker = editBroker(root, stateRoot);
  const secretContent = 'new private implementation body 48291\n';
  await broker.begin(transaction({ transaction_id: 'staged', operations: [
    { kind: 'write', path: 'src/a.txt', content: secretContent }
  ] }));
  const journalPath = path.join(stateRoot, 'staged', 'journal.json');
  const raw = await fs.readFile(journalPath, 'utf8');
  assert.ok(!raw.includes(secretContent));
  const journal = JSON.parse(raw);
  assert.equal(journal.mutations[0].staged_content, null);
  assert.match(journal.mutations[0].staged_file, /\.stage$/);
  const stagedPath = path.join(stateRoot, 'staged', 'staged', journal.mutations[0].staged_file);
  assert.equal(await fs.readFile(stagedPath, 'utf8'), secretContent);
});

test('apply commits several files, verifies postconditions, and emits a content-free receipt', async t => {
  const { root, stateRoot } = await fixture(t);
  const broker = editBroker(root, stateRoot);
  const receipt = await broker.apply(transaction());
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.mutations.length, 2);
  assert.ok(receipt.mutations.every(value => value.status === 'verified'));
  assert.match(receipt.receipt_digest, /^[0-9a-f]{64}$/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), 'alpha\ngamma\n');
  assert.equal(await fs.readFile(path.join(root, 'src', 'c.txt'), 'utf8'), 'charlie\n');
  assert.ok(!JSON.stringify(receipt).includes('charlie'));
  assert.ok(!JSON.stringify(receipt).includes('staged_content'));
});

test('delete and move operations preserve exact backups and destination preconditions', async t => {
  const { root, stateRoot } = await fixture(t);
  const broker = editBroker(root, stateRoot);
  const receipt = await broker.apply(transaction({ transaction_id: 'move-delete', operations: [
    { operation_id: 'move-a', kind: 'move', path: 'src/a.txt', destination: 'src/moved.txt' },
    { operation_id: 'delete-b', kind: 'delete', path: 'src/b.txt' }
  ] }));
  assert.equal(receipt.status, 'applied');
  assert.equal(await fs.readFile(path.join(root, 'src', 'moved.txt'), 'utf8'), 'alpha\nbeta\n');
  await assert.rejects(fs.stat(path.join(root, 'src', 'a.txt')));
  await assert.rejects(fs.stat(path.join(root, 'src', 'b.txt')));
  assert.equal(receipt.mutations.length, 3);

  await fs.writeFile(path.join(root, 'src', 'occupied.txt'), 'occupied\n');
  await assert.rejects(broker.preview(transaction({ transaction_id: 'blocked-move', operations: [
    { kind: 'move', path: 'src/moved.txt', destination: 'src/occupied.txt' }
  ] })), /destination already exists/);
});

test('applied transactions can be rolled back later from external backups', async t => {
  const { root, stateRoot } = await fixture(t);
  const broker = editBroker(root, stateRoot);
  await broker.apply(transaction({ transaction_id: 'later-rollback' }));
  const receipt = await broker.rollback('later-rollback', 'review rejected patch');
  assert.equal(receipt.status, 'rolled_back');
  assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), 'alpha\nbeta\n');
  await assert.rejects(fs.stat(path.join(root, 'src', 'c.txt')));
  assert.ok(receipt.mutations.every(value => value.status === 'rolled_back'));
});

test('mid-transaction failure compensates every applied mutation and reports rolled_back rather than success', async t => {
  const { root, stateRoot } = await fixture(t);
  let appliedWrites = 0;
  const factory = options => {
    const actual = new MakerToolBroker(options);
    const rollbackAttempt = String(options.state_path).includes('rollback-');
    return {
      write: async (...args) => {
        if (!rollbackAttempt && ++appliedWrites === 2) throw new Error('simulated disk failure');
        return actual.write(...args);
      },
      delete: (...args) => actual.delete(...args),
      close: (...args) => actual.close(...args)
    };
  };
  const broker = editBroker(root, stateRoot, { broker_factory: factory });
  const receipt = await broker.apply(transaction({ transaction_id: 'compensate' }));
  assert.equal(receipt.status, 'rolled_back');
  assert.match(receipt.errors[0].error, /simulated disk failure/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), 'alpha\nbeta\n');
  await assert.rejects(fs.stat(path.join(root, 'src', 'c.txt')));
});

test('resume recognizes an after-state written before a journal update and completes idempotently', async t => {
  const { root, stateRoot } = await fixture(t);
  const broker = editBroker(root, stateRoot);
  await broker.begin(transaction({ transaction_id: 'resume', operations: [
    { operation_id: 'write-a', kind: 'write', path: 'src/a.txt', content: 'already applied\n' },
    { operation_id: 'write-b', kind: 'write', path: 'src/b.txt', content: 'finish me\n' }
  ] }));
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'already applied\n', 'utf8');
  const receipt = await broker.resume('resume');
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.attempt, 1);
  assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), 'already applied\n');
  assert.equal(await fs.readFile(path.join(root, 'src', 'b.txt'), 'utf8'), 'finish me\n');
});

test('workspace divergence during resume triggers compensation instead of overwriting unknown data', async t => {
  const { root, stateRoot } = await fixture(t);
  const broker = editBroker(root, stateRoot);
  await broker.begin(transaction({ transaction_id: 'diverged', operations: [
    { kind: 'write', path: 'src/a.txt', content: 'desired\n' }
  ] }));
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'unknown external edit\n', 'utf8');
  let failure;
  try {
    await broker.resume('diverged');
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /rollback failed/);
  assert.equal(failure.receipt.status, 'rollback_failed');
  assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), 'unknown external edit\n');
});

test('tampered journals are rejected before resume or rollback', async t => {
  const { root, stateRoot } = await fixture(t);
  const broker = editBroker(root, stateRoot);
  await broker.begin(transaction({ transaction_id: 'tampered' }));
  const journalPath = path.join(stateRoot, 'tampered', 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  journal.status = 'applied';
  await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  await assert.rejects(broker.inspect('tampered'), /digest mismatch/);
  await assert.rejects(broker.resume('tampered'), /digest mismatch/);
});

test('duplicate transaction IDs fail rather than silently replacing journals or backups', async t => {
  const { root, stateRoot } = await fixture(t);
  const broker = editBroker(root, stateRoot);
  await broker.begin(transaction({ transaction_id: 'duplicate' }));
  await assert.rejects(broker.begin(transaction({ transaction_id: 'duplicate' })), /already exists/);
});

test('symlink, hard-link, binary-size, and secret-path attacks fail before a transaction is prepared', async t => {
  const { root, stateRoot } = await fixture(t);
  await fs.symlink(path.join(root, 'README.md'), path.join(root, 'src', 'link.txt'));
  await fs.link(path.join(root, 'src', 'a.txt'), path.join(root, 'src', 'hard.txt'));
  const broker = editBroker(root, stateRoot);
  await assert.rejects(broker.preview(transaction({ operations: [
    { kind: 'write', path: 'src/link.txt', content: 'x' }
  ] })), /regular non-linked file/);
  await assert.rejects(broker.preview(transaction({ operations: [
    { kind: 'write', path: 'src/hard.txt', content: 'x' }
  ] })), /regular non-linked file/);
  await assert.rejects(broker.preview(transaction({ operations: [
    { kind: 'create', path: 'src/.env', content: 'TOKEN=x' }
  ] })), /secret-like|blocked/);
  assert.throws(() => normalizeEditTransaction(transaction({ operations: [
    { kind: 'create', path: 'src/huge.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) }
  ] }), lease()), /byte limit/);
});

test('transaction and receipt digests change when evidence changes', async t => {
  const { root, stateRoot } = await fixture(t);
  const one = normalizeEditTransaction(transaction({ transaction_id: 'one' }), lease());
  const two = normalizeEditTransaction(transaction({ transaction_id: 'two' }), lease());
  assert.notEqual(one.transaction_digest, two.transaction_digest);
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  const broker = editBroker(root, stateRoot);
  const receipt = await broker.apply(transaction({ transaction_id: 'receipt' }));
  assert.notEqual(receipt.receipt_digest, receipt.transaction_digest);
});
