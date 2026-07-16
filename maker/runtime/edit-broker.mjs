import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MakerToolBroker,
  normalizeToolLease,
  pathIsLeased
} from './tool-broker.mjs';
import {
  digest,
  normalizeRelativePath,
  redactSecrets
} from '../../scripts/maker-security-policy.mjs';

const TRANSACTION_SCHEMA = 'sideways-maker-edit-transaction/v1';
const JOURNAL_SCHEMA = 'sideways-maker-edit-journal/v1';
const RECEIPT_SCHEMA = 'sideways-maker-edit-receipt/v1';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_OPERATIONS = 500;
const TERMINAL = new Set(['applied', 'rolled_back', 'rollback_failed', 'cancelled']);

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const nowISO = () => new Date().toISOString();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
}

function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

function safeTransactionId(value) {
  const id = clean(value || `edit-${crypto.randomUUID()}`, 160).replace(/[^A-Za-z0-9._-]/g, '-');
  if (!id || id === '.' || id === '..') throw new Error('Edit transaction ID is invalid.');
  return id;
}

function ensureExternalStateRoot(root, stateRoot) {
  const repository = path.resolve(root);
  const external = path.resolve(stateRoot);
  if (external === repository || external.startsWith(`${repository}${path.sep}`)) {
    throw new Error('Edit transaction state must remain outside the repository checkout.');
  }
  return external;
}

function safeChild(root, child) {
  const base = path.resolve(root);
  const target = path.resolve(base, child);
  if (target === base || !target.startsWith(`${base}${path.sep}`)) throw new Error('Edit state path escapes the external state root.');
  return target;
}

async function exists(fsImpl, filename) {
  try {
    await fsImpl.lstat(filename);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeAtomic(fsImpl, filename, value) {
  await fsImpl.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsImpl.rename(temporary, filename);
}

function journalDigest(state) {
  const body = { ...state };
  delete body.journal_digest;
  return digest(body);
}

function sealJournal(state) {
  return { ...state, journal_digest: journalDigest(state) };
}

function verifyJournal(state) {
  if (state?.schema !== JOURNAL_SCHEMA) throw new Error('Unsupported edit transaction journal.');
  if (state.journal_digest !== journalDigest(state)) throw new Error('Edit transaction journal digest mismatch.');
  return state;
}

function operationKind(value) {
  const kind = clean(value, 40).toLowerCase();
  if (!['create', 'write', 'replace', 'delete', 'move'].includes(kind)) throw new Error(`Unsupported edit operation: ${kind || '(empty)'}.`);
  return kind;
}

function normalizeExpected(input = {}) {
  const expected = {
    exists: input.exists === undefined ? null : input.exists === true,
    sha256: clean(input.sha256, 64).toLowerCase() || null,
    occurrences: input.occurrences === undefined ? null : Number(input.occurrences)
  };
  if (expected.sha256 && !/^[0-9a-f]{64}$/.test(expected.sha256)) throw new Error('Expected content digest must be a SHA-256 value.');
  if (expected.occurrences !== null && (!Number.isInteger(expected.occurrences) || expected.occurrences < 0)) throw new Error('Expected replacement occurrence count is invalid.');
  return Object.freeze(expected);
}

function normalizeOperation(input = {}, index = 0) {
  const kind = operationKind(input.kind || input.type);
  const pathValue = normalizeRelativePath(input.path);
  const operation = {
    operation_id: clean(input.operation_id || `operation-${index + 1}`, 160),
    kind,
    path: pathValue,
    destination: kind === 'move' ? normalizeRelativePath(input.destination) : null,
    content: ['create', 'write'].includes(kind) ? String(input.content ?? '') : null,
    before: kind === 'replace' ? String(input.before ?? '') : null,
    after: kind === 'replace' ? String(input.after ?? '') : null,
    expected: normalizeExpected(input.expected || {}),
    overwrite: input.overwrite === true
  };
  if (!operation.operation_id) throw new Error('Edit operation ID is required.');
  if (kind === 'replace' && !operation.before) throw new Error('Replace operation requires non-empty before text.');
  if (kind === 'move' && operation.destination === operation.path) throw new Error('Move source and destination must differ.');
  for (const value of [operation.content, operation.after]) {
    if (value !== null && Buffer.byteLength(value) > MAX_TEXT_BYTES) throw new Error(`Edit content exceeds byte limit for ${operation.path}.`);
  }
  return Object.freeze(operation);
}

export function normalizeEditTransaction(input = {}, leaseInput = null) {
  const lease = normalizeToolLease(leaseInput || input.lease);
  const baseSha = clean(input.base_sha || lease.base_sha, 40).toLowerCase();
  const branch = clean(input.branch || lease.branch, 240);
  if (baseSha !== lease.base_sha || branch !== lease.branch) throw new Error('Edit transaction identity differs from the one-writer lease.');
  const rawOperations = Array.isArray(input.operations) ? input.operations : [];
  if (!rawOperations.length || rawOperations.length > MAX_OPERATIONS) throw new Error(`Edit transaction requires 1-${MAX_OPERATIONS} operations.`);
  const operations = rawOperations.map(normalizeOperation);
  const ids = new Set();
  for (const operation of operations) {
    if (ids.has(operation.operation_id)) throw new Error(`Duplicate edit operation ID: ${operation.operation_id}.`);
    ids.add(operation.operation_id);
    if (!pathIsLeased(operation.path, lease)) throw new Error(`Edit path is outside the one-writer lease: ${operation.path}.`);
    if (operation.destination && !pathIsLeased(operation.destination, lease)) throw new Error(`Edit destination is outside the one-writer lease: ${operation.destination}.`);
  }
  const transaction = {
    schema: TRANSACTION_SCHEMA,
    transaction_id: safeTransactionId(input.transaction_id),
    repository: clean(input.repository, 300) || null,
    base_sha: baseSha,
    branch,
    request: clean(redactSecrets(input.request), 4000) || null,
    lease,
    operations
  };
  return Object.freeze({ ...transaction, transaction_digest: digest(transaction) });
}

function absolutePath(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...relative.split('/'));
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error(`Edit path escapes repository: ${relative}.`);
  return target;
}

async function readSnapshot(fsImpl, root, relative) {
  const absolute = absolutePath(root, relative);
  if (!(await exists(fsImpl, absolute))) return Object.freeze({ path: relative, exists: false, content: null, sha256: null, bytes: 0, mode: null });
  const stat = await fsImpl.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error(`Edit path must be one regular non-linked file: ${relative}.`);
  if (stat.size > MAX_TEXT_BYTES) throw new Error(`Edit path exceeds text byte limit: ${relative}.`);
  const content = await fsImpl.readFile(absolute, 'utf8');
  return Object.freeze({ path: relative, exists: true, content, sha256: digest(content), bytes: stat.size, mode: stat.mode });
}

function assertExpected(snapshot, expected, operation) {
  if (expected.exists !== null && snapshot.exists !== expected.exists) throw new Error(`Precondition failed for ${operation.path}: existence differs.`);
  if (expected.sha256 && snapshot.sha256 !== expected.sha256) throw new Error(`Precondition failed for ${operation.path}: content digest differs.`);
  if (operation.kind === 'create' && snapshot.exists) throw new Error(`Create target already exists: ${operation.path}.`);
  if (['replace', 'delete', 'move'].includes(operation.kind) && !snapshot.exists) throw new Error(`${operation.kind} source does not exist: ${operation.path}.`);
}

function lineDiff(relative, before, after) {
  const left = before === null ? [] : String(before).split(/\r?\n/);
  const right = after === null ? [] : String(after).split(/\r?\n/);
  const body = [`--- ${before === null ? '/dev/null' : `a/${relative}`}`, `+++ ${after === null ? '/dev/null' : `b/${relative}`}`, '@@'];
  const limit = 400;
  for (const line of left.slice(0, limit)) body.push(`-${line}`);
  for (const line of right.slice(0, limit)) body.push(`+${line}`);
  if (left.length > limit || right.length > limit) body.push('… diff truncated …');
  return body.join('\n');
}

function mutationRecord({ operation, path: relative, before, afterContent, sourceOperationId, role = 'primary' }) {
  const afterExists = afterContent !== null;
  return {
    mutation_id: `${sourceOperationId}:${role}:${digest(relative).slice(0, 12)}`,
    operation_id: sourceOperationId,
    kind: operation.kind,
    role,
    path: relative,
    before: {
      exists: before.exists,
      sha256: before.sha256,
      bytes: before.bytes,
      mode: before.mode
    },
    after: {
      exists: afterExists,
      sha256: afterExists ? digest(afterContent) : null,
      bytes: afterExists ? Buffer.byteLength(afterContent) : 0
    },
    staged_content: afterExists ? afterContent : null,
    status: 'pending',
    applied_at: null,
    verified_at: null,
    rollback_status: null,
    error: null
  };
}

function publicMutation(mutation) {
  return {
    mutation_id: mutation.mutation_id,
    operation_id: mutation.operation_id,
    kind: mutation.kind,
    role: mutation.role,
    path: mutation.path,
    before: mutation.before,
    after: mutation.after,
    status: mutation.status,
    applied_at: mutation.applied_at,
    verified_at: mutation.verified_at,
    rollback_status: mutation.rollback_status,
    error: mutation.error
  };
}

export class MakerEditBroker {
  constructor({
    root,
    state_root,
    lease,
    security_policy,
    command_allowlist = [],
    adapters = {},
    fs_impl = fs,
    broker_factory = options => new MakerToolBroker(options),
    clock = nowISO
  } = {}) {
    if (!root) throw new Error('Edit broker requires a repository root.');
    if (!state_root) throw new Error('Edit broker requires an external state root.');
    if (!security_policy?.decide) throw new Error('Edit broker requires a security policy.');
    this.root = path.resolve(root);
    this.stateRoot = ensureExternalStateRoot(this.root, state_root);
    this.lease = normalizeToolLease(lease);
    this.security = security_policy;
    this.commandAllowlist = command_allowlist;
    this.adapters = adapters;
    this.fs = fs_impl;
    this.brokerFactory = broker_factory;
    this.clock = clock;
  }

  #paths(transactionId) {
    const directory = safeChild(this.stateRoot, transactionId);
    return Object.freeze({
      directory,
      journal: path.join(directory, 'journal.json'),
      backups: path.join(directory, 'backups')
    });
  }

  async #readJournal(transactionId) {
    const paths = this.#paths(safeTransactionId(transactionId));
    const state = verifyJournal(JSON.parse(await this.fs.readFile(paths.journal, 'utf8')));
    if (state.transaction_id !== transactionId) throw new Error('Edit transaction journal identity mismatch.');
    return { paths, state };
  }

  async #writeJournal(paths, state) {
    const sealed = sealJournal({ ...state, updated_at: this.clock() });
    await writeAtomic(this.fs, paths.journal, sealed);
    return sealed;
  }

  async preview(input = {}) {
    const transaction = normalizeEditTransaction(input, this.lease);
    const touched = new Set();
    const mutations = [];
    const diffs = [];
    for (const operation of transaction.operations) {
      if (touched.has(operation.path)) throw new Error(`Edit transaction touches a path more than once: ${operation.path}.`);
      touched.add(operation.path);
      const before = await readSnapshot(this.fs, this.root, operation.path);
      assertExpected(before, operation.expected, operation);
      if (operation.kind === 'create' || operation.kind === 'write') {
        const afterContent = operation.content;
        mutations.push(mutationRecord({ operation, path: operation.path, before, afterContent, sourceOperationId: operation.operation_id }));
        diffs.push(lineDiff(operation.path, before.content, afterContent));
      } else if (operation.kind === 'replace') {
        const occurrences = before.content.split(operation.before).length - 1;
        const expected = operation.expected.occurrences ?? 1;
        if (occurrences !== expected) throw new Error(`Replace expected ${expected} occurrence(s), found ${occurrences} in ${operation.path}.`);
        const afterContent = before.content.split(operation.before).join(operation.after);
        if (Buffer.byteLength(afterContent) > MAX_TEXT_BYTES) throw new Error(`Replacement exceeds byte limit: ${operation.path}.`);
        mutations.push(mutationRecord({ operation, path: operation.path, before, afterContent, sourceOperationId: operation.operation_id }));
        diffs.push(lineDiff(operation.path, before.content, afterContent));
      } else if (operation.kind === 'delete') {
        mutations.push(mutationRecord({ operation, path: operation.path, before, afterContent: null, sourceOperationId: operation.operation_id }));
        diffs.push(lineDiff(operation.path, before.content, null));
      } else if (operation.kind === 'move') {
        if (touched.has(operation.destination)) throw new Error(`Edit transaction touches a path more than once: ${operation.destination}.`);
        touched.add(operation.destination);
        const destination = await readSnapshot(this.fs, this.root, operation.destination);
        if (destination.exists && !operation.overwrite) throw new Error(`Move destination already exists: ${operation.destination}.`);
        mutations.push(mutationRecord({ operation, path: operation.destination, before: destination, afterContent: before.content, sourceOperationId: operation.operation_id, role: 'destination' }));
        mutations.push(mutationRecord({ operation, path: operation.path, before, afterContent: null, sourceOperationId: operation.operation_id, role: 'source' }));
        diffs.push(lineDiff(operation.destination, destination.content, before.content));
        diffs.push(lineDiff(operation.path, before.content, null));
      }
    }
    const body = {
      schema: 'sideways-maker-edit-preview/v1',
      transaction: {
        schema: transaction.schema,
        transaction_id: transaction.transaction_id,
        repository: transaction.repository,
        base_sha: transaction.base_sha,
        branch: transaction.branch,
        request: transaction.request,
        lease_digest: transaction.lease.lease_digest,
        operation_count: transaction.operations.length,
        transaction_digest: transaction.transaction_digest
      },
      mutations: mutations.map(publicMutation),
      changed_paths: [...touched].sort(),
      diff: clean(diffs.join('\n\n'), 200000),
      created_at: this.clock()
    };
    return Object.freeze({ ...body, preview_digest: digest(body), internal_mutations: Object.freeze(mutations) });
  }

  async begin(input = {}) {
    const preview = await this.preview(input);
    const transactionId = preview.transaction.transaction_id;
    const paths = this.#paths(transactionId);
    if (await exists(this.fs, paths.journal)) throw new Error(`Edit transaction already exists: ${transactionId}.`);
    await this.fs.mkdir(paths.backups, { recursive: true, mode: 0o700 });
    const backupManifest = {};
    for (const mutation of preview.internal_mutations) {
      if (!mutation.before.exists) continue;
      const backupName = `${digest(mutation.path)}.bak`;
      const backupPath = path.join(paths.backups, backupName);
      const current = await readSnapshot(this.fs, this.root, mutation.path);
      if (current.sha256 !== mutation.before.sha256) throw new Error(`Workspace changed while beginning transaction: ${mutation.path}.`);
      await this.fs.copyFile(absolutePath(this.root, mutation.path), backupPath);
      backupManifest[mutation.path] = { file: backupName, sha256: mutation.before.sha256, bytes: mutation.before.bytes, mode: mutation.before.mode };
    }
    const state = {
      schema: JOURNAL_SCHEMA,
      transaction_id: transactionId,
      repository: preview.transaction.repository,
      base_sha: preview.transaction.base_sha,
      branch: preview.transaction.branch,
      request: preview.transaction.request,
      lease: this.lease,
      transaction_digest: preview.transaction.transaction_digest,
      preview_digest: preview.preview_digest,
      status: 'prepared',
      attempt: 0,
      created_at: this.clock(),
      updated_at: null,
      current_mutation: null,
      mutations: preview.internal_mutations,
      backups: backupManifest,
      diff_digest: digest(preview.diff),
      errors: [],
      receipt: null
    };
    const journal = await this.#writeJournal(paths, state);
    return Object.freeze({ transaction_id: transactionId, journal: redactSecrets(journal), preview: { ...preview, internal_mutations: undefined } });
  }

  #toolBroker(paths, attempt) {
    return this.brokerFactory({
      root: this.root,
      lease: this.lease,
      security_policy: this.security,
      command_allowlist: this.commandAllowlist,
      adapters: this.adapters,
      fs_impl: this.fs,
      clock: this.clock,
      state_path: path.join(paths.directory, `tool-state-attempt-${attempt}.json`)
    });
  }

  async #currentMatches(mutation, side) {
    const snapshot = await readSnapshot(this.fs, this.root, mutation.path);
    const expected = mutation[side];
    return snapshot.exists === expected.exists && snapshot.sha256 === expected.sha256;
  }

  async #applyMutation(broker, mutation) {
    if (mutation.after.exists) return broker.write(mutation.path, mutation.staged_content, { origin: 'control_plane' });
    if (await exists(this.fs, absolutePath(this.root, mutation.path))) return broker.delete(mutation.path, { origin: 'control_plane' });
    return { path: mutation.path, already_absent: true };
  }

  async #restoreMutation(broker, paths, state, mutation) {
    if (mutation.before.exists) {
      const backup = state.backups[mutation.path];
      if (!backup) throw new Error(`Missing backup metadata for ${mutation.path}.`);
      const backupPath = path.join(paths.backups, backup.file);
      const content = await this.fs.readFile(backupPath, 'utf8');
      if (digest(content) !== backup.sha256) throw new Error(`Backup digest mismatch for ${mutation.path}.`);
      await broker.write(mutation.path, content, { origin: 'control_plane' });
      return;
    }
    if (await exists(this.fs, absolutePath(this.root, mutation.path))) await broker.delete(mutation.path, { origin: 'control_plane' });
  }

  async #rollbackState(paths, state, reason) {
    const attempt = Number(state.attempt || 0) + 1;
    const broker = this.#toolBroker(paths, `rollback-${attempt}`);
    state.status = 'rolling_back';
    state.rollback_reason = clean(redactSecrets(reason), 2000);
    state = await this.#writeJournal(paths, state);
    let failed = null;
    for (const mutation of [...state.mutations].reverse()) {
      if (!['applied', 'applying', 'verified'].includes(mutation.status)) continue;
      try {
        if (await this.#currentMatches(mutation, 'before')) {
          mutation.rollback_status = 'already_restored';
        } else {
          await this.#restoreMutation(broker, paths, state, mutation);
          if (!(await this.#currentMatches(mutation, 'before'))) throw new Error(`Rollback verification failed for ${mutation.path}.`);
          mutation.rollback_status = 'restored';
        }
        mutation.status = 'rolled_back';
        mutation.error = null;
      } catch (error) {
        mutation.rollback_status = 'failed';
        mutation.error = clean(redactSecrets(error?.message || error), 2000);
        failed = error;
      }
      state = await this.#writeJournal(paths, state);
      if (failed) break;
    }
    await broker.close(failed ? 'rollback failed' : 'rollback complete').catch(() => {});
    state.status = failed ? 'rollback_failed' : 'rolled_back';
    state.current_mutation = null;
    if (failed) state.errors.push({ at: this.clock(), stage: 'rollback', error: clean(redactSecrets(failed.message), 2000) });
    const receipt = this.#receipt(state);
    state.receipt = receipt;
    state = await this.#writeJournal(paths, state);
    if (failed) throw Object.assign(new Error(`Edit rollback failed: ${failed.message}`), { receipt });
    return receipt;
  }

  #receipt(state) {
    const body = {
      schema: RECEIPT_SCHEMA,
      transaction_id: state.transaction_id,
      repository: state.repository,
      base_sha: state.base_sha,
      branch: state.branch,
      transaction_digest: state.transaction_digest,
      preview_digest: state.preview_digest,
      status: state.status,
      attempt: state.attempt,
      mutations: state.mutations.map(publicMutation),
      backups: Object.fromEntries(Object.entries(state.backups || {}).map(([key, value]) => [key, { sha256: value.sha256, bytes: value.bytes }])),
      diff_digest: state.diff_digest,
      errors: redactSecrets(state.errors || []),
      authority: { merge: 'human', deploy: 'human' },
      finished_at: this.clock()
    };
    return Object.freeze({ ...body, receipt_digest: digest(body) });
  }

  async #applyExisting(paths, state) {
    if (state.status === 'applied') return state.receipt || this.#receipt(state);
    if (TERMINAL.has(state.status)) throw new Error(`Edit transaction is terminal: ${state.status}.`);
    state.attempt = Number(state.attempt || 0) + 1;
    state.status = 'applying';
    state = await this.#writeJournal(paths, state);
    const broker = this.#toolBroker(paths, state.attempt);
    try {
      for (const mutation of state.mutations) {
        if (mutation.status === 'verified' || mutation.status === 'applied') continue;
        state.current_mutation = mutation.mutation_id;
        mutation.status = 'applying';
        state = await this.#writeJournal(paths, state);
        if (await this.#currentMatches(mutation, 'after')) {
          mutation.status = 'applied';
          mutation.applied_at ||= this.clock();
        } else if (await this.#currentMatches(mutation, 'before')) {
          await this.#applyMutation(broker, mutation);
          mutation.status = 'applied';
          mutation.applied_at = this.clock();
        } else {
          throw new Error(`Workspace diverged from both before and after states for ${mutation.path}.`);
        }
        state = await this.#writeJournal(paths, state);
        if (!(await this.#currentMatches(mutation, 'after'))) throw new Error(`Postcondition failed for ${mutation.path}.`);
        mutation.status = 'verified';
        mutation.verified_at = this.clock();
        state = await this.#writeJournal(paths, state);
      }
      await broker.close('transaction applied');
      state.status = 'applied';
      state.current_mutation = null;
      const receipt = this.#receipt(state);
      state.receipt = receipt;
      await this.#writeJournal(paths, state);
      return receipt;
    } catch (error) {
      state.errors.push({ at: this.clock(), stage: 'apply', mutation_id: state.current_mutation, error: clean(redactSecrets(error?.message || error), 2000) });
      state.status = 'apply_failed';
      await this.#writeJournal(paths, state);
      await broker.close('transaction apply failed').catch(() => {});
      return this.#rollbackState(paths, state, error?.message || error);
    }
  }

  async apply(input = {}) {
    const prepared = await this.begin(input);
    const { paths, state } = await this.#readJournal(prepared.transaction_id);
    return this.#applyExisting(paths, state);
  }

  async resume(transactionId) {
    const id = safeTransactionId(transactionId);
    const { paths, state } = await this.#readJournal(id);
    return this.#applyExisting(paths, state);
  }

  async rollback(transactionId, reason = 'operator rollback') {
    const id = safeTransactionId(transactionId);
    const { paths, state } = await this.#readJournal(id);
    if (state.status === 'rolled_back') return state.receipt || this.#receipt(state);
    return this.#rollbackState(paths, state, reason);
  }

  async inspect(transactionId) {
    const { state } = await this.#readJournal(safeTransactionId(transactionId));
    return Object.freeze(redactSecrets({ ...state, mutations: state.mutations.map(publicMutation), receipt: state.receipt }));
  }
}
