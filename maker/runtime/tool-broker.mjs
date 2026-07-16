import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  SecurityAuditLog,
  buildSafeEnvironment,
  digest,
  evaluateCommand,
  evaluateDependency,
  inspectFilesystemEntry,
  normalizeRelativePath,
  redactSecrets,
  sanitizeProcessResult
} from '../../scripts/maker-security-policy.mjs';

const execFileDefault = promisify(execFileCallback);
const TOOL_SCHEMA = 'sideways-maker-tool-broker/v1';
const RECEIPT_SCHEMA = 'sideways-maker-tool-receipt/v1';
const LEASE_SCHEMA = 'sideways-maker-tool-lease/v1';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 10000;
const MAX_SEARCH_MATCHES = 500;
const TERMINAL = new Set(['cancelled', 'closed']);

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const nowISO = () => new Date().toISOString();
const sortedUnique = values => [...new Set(values)].sort();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}

function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

function normalizeLeasePath(value) {
  const raw = clean(value, 1000).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (raw === '**') return raw;
  const recursive = raw.endsWith('/**');
  const base = recursive ? raw.slice(0, -3) : raw;
  const normalized = normalizeRelativePath(base, { allow_glob: false });
  return recursive ? `${normalized}/**` : normalized;
}

function pathMatchesLease(relative, pattern) {
  if (pattern === '**') return true;
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return relative === prefix || relative.startsWith(`${prefix}/`);
  }
  return relative === pattern;
}

export function normalizeToolLease(input = {}) {
  const baseSha = clean(input.base_sha, 40).toLowerCase();
  const branch = clean(input.branch, 240);
  const paths = sortedUnique((input.owned_paths || []).map(normalizeLeasePath));
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('Tool lease requires an exact base SHA.');
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('Tool lease branch is invalid.');
  if (Number(input.writer_count ?? 1) !== 1) throw new Error('Tool lease requires exactly one writer.');
  if (!paths.length) throw new Error('Tool lease requires owned paths.');
  const lease = {
    schema: LEASE_SCHEMA,
    base_sha: baseSha,
    branch,
    writer_count: 1,
    owned_paths: paths,
    authority: {
      merge: clean(input.authority?.merge || 'human', 40),
      deploy: clean(input.authority?.deploy || 'human', 40)
    }
  };
  if (lease.authority.merge !== 'human' || lease.authority.deploy !== 'human') throw new Error('Tool lease cannot widen merge or deploy authority.');
  return Object.freeze({ ...lease, lease_digest: digest(lease) });
}

export function pathIsLeased(relativeInput, leaseInput) {
  const relative = normalizeRelativePath(relativeInput);
  const lease = normalizeToolLease(leaseInput);
  return lease.owned_paths.some(pattern => pathMatchesLease(relative, pattern));
}

async function exists(fsImpl, filename) {
  try { await fsImpl.lstat(filename); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function atomicWrite(fsImpl, filename, content, mode = 0o600) {
  await fsImpl.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsImpl.writeFile(temporary, content, { encoding: 'utf8', mode });
  await fsImpl.rename(temporary, filename);
}

async function realExec(command) {
  const value = await execFileDefault(command.program, command.args, {
    cwd: command.cwd,
    env: command.env,
    timeout: command.timeout_ms,
    maxBuffer: command.max_output_bytes,
    windowsHide: true,
    signal: command.signal
  });
  return { code: 0, stdout: value.stdout, stderr: value.stderr, signal: null, timed_out: false, killed: false };
}

class ReceiptLog {
  constructor({ clock = nowISO } = {}) {
    this.clock = clock;
    this.events = [];
  }

  append(type, payload = {}) {
    const previous = this.events.at(-1)?.digest || null;
    const body = {
      sequence: this.events.length + 1,
      at: this.clock(),
      type: clean(type, 160),
      payload: redactSecrets(payload),
      previous_digest: previous
    };
    const event = Object.freeze({ ...body, digest: digest(body) });
    this.events.push(event);
    return event;
  }

  verify() {
    let previous = null;
    for (let index = 0; index < this.events.length; index += 1) {
      const event = this.events[index];
      if (event.sequence !== index + 1 || event.previous_digest !== previous) throw new Error(`Tool receipt chain mismatch at ${index + 1}.`);
      const body = { sequence: event.sequence, at: event.at, type: event.type, payload: event.payload, previous_digest: event.previous_digest };
      if (digest(body) !== event.digest) throw new Error(`Tool receipt digest mismatch at ${index + 1}.`);
      previous = event.digest;
    }
    return previous;
  }

  receipt(metadata = {}) {
    const body = { schema: RECEIPT_SCHEMA, ...redactSecrets(metadata), event_count: this.events.length, terminal_digest: this.verify(), events: this.events };
    return Object.freeze({ ...body, receipt_digest: digest(body) });
  }
}

export class MakerToolBroker {
  constructor({
    root,
    lease,
    security_policy,
    command_allowlist = [],
    adapters = {},
    fs_impl = fs,
    executor = realExec,
    clock = nowISO,
    state_path = null
  } = {}) {
    if (!root) throw new Error('Tool broker requires a repository root.');
    if (!security_policy?.decide) throw new Error('Tool broker requires a security policy.');
    this.root = path.resolve(root);
    this.lease = normalizeToolLease(lease);
    this.security = security_policy;
    this.commandAllowlist = Object.freeze(command_allowlist.map(value => Object.freeze({ ...value, args: Object.freeze([...(value.args || [])]) })));
    this.adapters = Object.freeze({ ...adapters });
    this.fs = fs_impl;
    this.executor = executor;
    this.clock = clock;
    this.statePath = state_path ? path.resolve(state_path) : null;
    this.log = new ReceiptLog({ clock });
    this.securityAudit = new SecurityAuditLog({ clock });
    this.status = 'open';
    this.cancelReason = null;
    this.backups = new Map();
    this.artifacts = new Map();
    this.active = new Map();
    this.log.append('broker.opened', { root: this.root, lease: this.lease, adapters: Object.keys(this.adapters).sort() });
  }

  #assertOpen() {
    if (TERMINAL.has(this.status)) throw new Error(`Tool broker is terminal: ${this.status}.`);
  }

  async #persist() {
    if (!this.statePath) return;
    const state = {
      schema: TOOL_SCHEMA,
      status: this.status,
      cancel_reason: this.cancelReason,
      lease: this.lease,
      backups: Object.fromEntries([...this.backups.entries()].map(([key, value]) => [key, value.metadata])),
      artifacts: Object.fromEntries(this.artifacts),
      receipt: this.log.receipt({ status: this.status })
    };
    await atomicWrite(this.fs, this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async #resolve(relativeInput, { must_exist = false, allow_directory = true } = {}) {
    const relative = normalizeRelativePath(relativeInput);
    const absolute = path.resolve(this.root, ...relative.split('/'));
    if (absolute !== this.root && !absolute.startsWith(`${this.root}${path.sep}`)) throw new Error(`Path escapes repository: ${relative}.`);
    const segments = relative.split('/');
    let cursor = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      cursor = path.join(cursor, segments[index]);
      if (!(await exists(this.fs, cursor))) {
        if (must_exist || index < segments.length - 1) throw new Error(`Repository path does not exist: ${segments.slice(0, index + 1).join('/')}.`);
        break;
      }
      const stat = await this.fs.lstat(cursor);
      const inspection = inspectFilesystemEntry({
        path: segments.slice(0, index + 1).join('/'),
        type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : stat.isFIFO() ? 'fifo' : stat.isSocket() ? 'socket' : stat.isBlockDevice() || stat.isCharacterDevice() ? 'device' : 'special',
        symlink: stat.isSymbolicLink(),
        nlink: stat.nlink,
        size: stat.size,
        max_bytes: MAX_TEXT_BYTES
      });
      if (!inspection.allowed) throw new Error(inspection.errors.join('; '));
      if (index === segments.length - 1 && stat.isDirectory() && !allow_directory) throw new Error(`Expected file but found directory: ${relative}.`);
    }
    return Object.freeze({ relative, absolute });
  }

  #assertLeased(relative) {
    if (!pathIsLeased(relative, this.lease)) throw new Error(`Path is outside the one-writer lease: ${relative}.`);
  }

  #authorize(capability, context, { origin = 'model_output', human_gate = false } = {}) {
    const decision = this.security.decide({ capability, origin, context, human_gate });
    if (!decision.allowed) throw Object.assign(new Error(`Security policy denied ${capability}: ${decision.reason}.`), { decision });
    return decision;
  }

  async list(prefix = '') {
    this.#assertOpen();
    const normalizedPrefix = prefix ? normalizeRelativePath(prefix) : '';
    const start = normalizedPrefix ? await this.#resolve(normalizedPrefix, { must_exist: true }) : { relative: '', absolute: this.root };
    const decision = this.#authorize('read.repository', { path: normalizedPrefix || '.' }, { origin: 'worker_attestation' });
    const entries = [];
    const visit = async (absolute, relative) => {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      const children = await this.fs.readdir(absolute, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (entries.length >= MAX_LIST_ENTRIES) break;
        if (child.name === '.git' || child.name === 'node_modules') continue;
        const childRelative = relative ? `${relative}/${child.name}` : child.name;
        const target = await this.#resolve(childRelative, { must_exist: true });
        const stat = await this.fs.lstat(target.absolute);
        entries.push({ path: childRelative, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size });
        if (stat.isDirectory()) await visit(target.absolute, childRelative);
      }
    };
    const stat = await this.fs.lstat(start.absolute);
    if (stat.isDirectory()) await visit(start.absolute, start.relative);
    else entries.push({ path: start.relative, type: 'file', size: stat.size });
    const result = Object.freeze({ entries: Object.freeze(entries), truncated: entries.length >= MAX_LIST_ENTRIES, decision_digest: decision.decision_digest });
    this.log.append('tool.list', { prefix: normalizedPrefix, count: entries.length, truncated: result.truncated, decision_digest: decision.decision_digest });
    await this.#persist();
    return result;
  }

  async read(relativeInput, { start = 1, end = null, max_bytes = MAX_TEXT_BYTES } = {}) {
    this.#assertOpen();
    const target = await this.#resolve(relativeInput, { must_exist: true, allow_directory: false });
    const decision = this.#authorize('read.repository', { path: target.relative }, { origin: 'worker_attestation' });
    const stat = await this.fs.lstat(target.absolute);
    const bounded = Math.max(1, Math.min(MAX_TEXT_BYTES, Number(max_bytes || MAX_TEXT_BYTES)));
    if (stat.size > bounded) throw new Error(`File exceeds read byte limit: ${target.relative}.`);
    const text = await this.fs.readFile(target.absolute, 'utf8');
    const lines = text.split(/\r?\n/);
    const first = Math.max(1, Number(start || 1));
    const last = Math.min(lines.length, Math.max(first, Number(end || first + 239)));
    const content = lines.slice(first - 1, last).join('\n');
    const result = Object.freeze({ path: target.relative, start: first, end: last, total_lines: lines.length, content, content_digest: digest(content), decision_digest: decision.decision_digest });
    this.log.append('tool.read', { path: target.relative, start: first, end: last, bytes: Buffer.byteLength(content), content_digest: result.content_digest, decision_digest: decision.decision_digest });
    await this.#persist();
    return result;
  }

  async search(queryInput, { prefix = '', max_matches = MAX_SEARCH_MATCHES } = {}) {
    this.#assertOpen();
    const query = clean(queryInput, 2000);
    if (!query) throw new Error('Search query is required.');
    const listing = await this.list(prefix);
    const matches = [];
    for (const entry of listing.entries) {
      if (matches.length >= max_matches || entry.type !== 'file' || entry.size > MAX_TEXT_BYTES) continue;
      let text;
      try { text = await this.fs.readFile(path.join(this.root, entry.path), 'utf8'); } catch { continue; }
      text.split(/\r?\n/).forEach((line, index) => {
        if (matches.length < max_matches && line.includes(query)) matches.push({ path: entry.path, line: index + 1, text: clean(redactSecrets(line), 2000) });
      });
    }
    const result = Object.freeze({ query, matches: Object.freeze(matches), truncated: matches.length >= max_matches });
    this.log.append('tool.search', { query_digest: digest(query), prefix, count: matches.length, truncated: result.truncated });
    await this.#persist();
    return result;
  }

  async #backup(target) {
    if (this.backups.has(target.relative)) return this.backups.get(target.relative);
    if (!(await exists(this.fs, target.absolute))) {
      const value = { existed: false, content: null, metadata: { existed: false, content_digest: null } };
      this.backups.set(target.relative, value);
      return value;
    }
    const stat = await this.fs.lstat(target.absolute);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) throw new Error(`Only bounded regular files may be mutated: ${target.relative}.`);
    const content = await this.fs.readFile(target.absolute, 'utf8');
    const value = { existed: true, content, metadata: { existed: true, content_digest: digest(content), mode: stat.mode } };
    this.backups.set(target.relative, value);
    return value;
  }

  async write(relativeInput, contentInput, { origin = 'model_output' } = {}) {
    this.#assertOpen();
    const target = await this.#resolve(relativeInput, { must_exist: false, allow_directory: false });
    this.#assertLeased(target.relative);
    const content = String(contentInput ?? '');
    if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error(`Write exceeds byte limit: ${target.relative}.`);
    const decision = this.#authorize('write.file', { path: target.relative }, { origin });
    const backup = await this.#backup(target);
    await atomicWrite(this.fs, target.absolute, content);
    const result = Object.freeze({ path: target.relative, bytes: Buffer.byteLength(content), content_digest: digest(content), created: !backup.existed, decision_digest: decision.decision_digest });
    this.log.append('tool.write', result);
    await this.#persist();
    return result;
  }

  async replace(relativeInput, beforeInput, afterInput, { expected = 1, origin = 'model_output' } = {}) {
    this.#assertOpen();
    const target = await this.#resolve(relativeInput, { must_exist: true, allow_directory: false });
    this.#assertLeased(target.relative);
    const before = String(beforeInput ?? '');
    const after = String(afterInput ?? '');
    if (!before) throw new Error('Replace requires non-empty before text.');
    const current = await this.fs.readFile(target.absolute, 'utf8');
    const occurrences = current.split(before).length - 1;
    if (occurrences !== Number(expected)) throw new Error(`Replace expected ${expected} occurrence(s), found ${occurrences}.`);
    const decision = this.#authorize('write.file', { path: target.relative }, { origin });
    await this.#backup(target);
    const next = current.split(before).join(after);
    if (Buffer.byteLength(next) > MAX_TEXT_BYTES) throw new Error(`Replacement exceeds byte limit: ${target.relative}.`);
    await atomicWrite(this.fs, target.absolute, next);
    const result = Object.freeze({ path: target.relative, occurrences, content_digest: digest(next), decision_digest: decision.decision_digest });
    this.log.append('tool.replace', result);
    await this.#persist();
    return result;
  }

  async delete(relativeInput, { origin = 'model_output' } = {}) {
    this.#assertOpen();
    const target = await this.#resolve(relativeInput, { must_exist: true, allow_directory: false });
    this.#assertLeased(target.relative);
    const decision = this.#authorize('delete.file', { path: target.relative }, { origin });
    const backup = await this.#backup(target);
    await this.fs.rm(target.absolute, { force: false });
    const result = Object.freeze({ path: target.relative, prior_digest: backup.metadata.content_digest, decision_digest: decision.decision_digest });
    this.log.append('tool.delete', result);
    await this.#persist();
    return result;
  }

  async run(input = {}) {
    this.#assertOpen();
    const command = evaluateCommand(input, { allowlist: this.commandAllowlist });
    if (!command.allowed) throw new Error(`Command policy denied execution: ${command.errors.join('; ')}.`);
    const commandText = [command.program, ...command.args].join(' ');
    const decision = this.#authorize('command.execute', { command: commandText, repository: input.repository || null }, { origin: input.origin || 'model_output' });
    const environment = buildSafeEnvironment(input.env || {}, { secret_references: input.secret_references || {} });
    const operationId = clean(input.operation_id || `operation-${crypto.randomUUID()}`, 200);
    if (this.active.has(operationId)) throw new Error(`Operation already active: ${operationId}.`);
    const controller = new AbortController();
    this.active.set(operationId, controller);
    this.log.append('tool.run.started', { operation_id: operationId, program: command.program, args: command.args, limits: command.limits, env_receipt: environment.receipt, decision_digest: decision.decision_digest });
    await this.#persist();
    let result;
    try {
      result = sanitizeProcessResult(await this.executor({
        program: command.program,
        args: [...command.args],
        cwd: this.root,
        env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', ...environment.env },
        timeout_ms: command.limits.timeout_ms,
        max_output_bytes: command.limits.max_output_bytes,
        signal: controller.signal
      }));
    } catch (error) {
      result = sanitizeProcessResult({ code: Number(error?.code) || 1, stdout: error?.stdout || '', stderr: error?.stderr || error?.message || error, signal: error?.signal, timed_out: error?.code === 'ETIMEDOUT', killed: controller.signal.aborted });
    } finally {
      this.active.delete(operationId);
    }
    this.log.append('tool.run.finished', { operation_id: operationId, result, decision_digest: decision.decision_digest });
    await this.#persist();
    return Object.freeze({ operation_id: operationId, command: commandText, result, decision_digest: decision.decision_digest });
  }

  cancel(operationId, reason = 'operator cancellation') {
    this.#assertOpen();
    const id = clean(operationId, 200);
    const controller = this.active.get(id);
    if (!controller) return Object.freeze({ operation_id: id, cancelled: false, reason: 'operation is not active' });
    controller.abort(new Error(clean(reason, 1000)));
    this.log.append('tool.run.cancelled', { operation_id: id, reason: clean(reason, 1000) });
    return Object.freeze({ operation_id: id, cancelled: true, reason: clean(reason, 1000) });
  }

  async installDependency(input = {}) {
    this.#assertOpen();
    const dependency = evaluateDependency(input.dependency || input);
    if (!dependency.allowed) throw new Error(`Dependency policy denied installation: ${dependency.errors.join('; ')}.`);
    const decision = this.#authorize('dependency.install', { name: dependency.name, version: dependency.version, host: input.registry_host || input.dependency?.registry_host }, { origin: input.origin || 'model_output' });
    const run = await this.run({
      ...input.command,
      operation_id: input.operation_id || `dependency-${dependency.name}-${dependency.version}`,
      origin: input.origin || 'model_output',
      repository: input.repository,
      env: input.env,
      secret_references: input.secret_references
    });
    const result = Object.freeze({ dependency, run, decision_digest: decision.decision_digest });
    this.log.append('tool.dependency', result);
    await this.#persist();
    return result;
  }

  async invokeAdapter(nameInput, actionInput, payload = {}, { origin = 'model_output', human_gate = false } = {}) {
    this.#assertOpen();
    const name = clean(nameInput, 120).toLowerCase();
    const action = clean(actionInput, 120).toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !/^[a-z][a-z0-9-]*$/.test(action)) throw new Error('Adapter name and action are invalid.');
    const adapter = this.adapters[name];
    if (!adapter?.invoke) {
      const unavailable = Object.freeze({ available: false, adapter: name, action, reason: 'adapter is not configured' });
      this.log.append('tool.adapter.unavailable', unavailable);
      await this.#persist();
      return unavailable;
    }
    const decision = this.#authorize(`adapter.${name}.${action}`, { adapter: name, action }, { origin, human_gate });
    const output = redactSecrets(await adapter.invoke(action, payload));
    const result = Object.freeze({ available: true, adapter: name, action, output, output_digest: digest(output), decision_digest: decision.decision_digest });
    this.log.append('tool.adapter.finished', result);
    await this.#persist();
    return result;
  }

  async registerArtifact(relativeInput, { kind = 'artifact', origin = 'worker_attestation' } = {}) {
    this.#assertOpen();
    const target = await this.#resolve(relativeInput, { must_exist: true, allow_directory: false });
    const decision = this.#authorize('read.artifact', { path: target.relative }, { origin });
    const stat = await this.fs.lstat(target.absolute);
    if (stat.size > 64 * 1024 * 1024) throw new Error(`Artifact exceeds registration byte limit: ${target.relative}.`);
    const bytes = await this.fs.readFile(target.absolute);
    const metadata = Object.freeze({ path: target.relative, kind: clean(kind, 120), bytes: stat.size, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), registered_at: this.clock(), decision_digest: decision.decision_digest });
    this.artifacts.set(target.relative, metadata);
    this.log.append('tool.artifact.registered', metadata);
    await this.#persist();
    return metadata;
  }

  async rollback(reason = 'tool rollback') {
    this.#assertOpen();
    const restored = [];
    for (const [relative, backup] of [...this.backups.entries()].reverse()) {
      const target = await this.#resolve(relative, { must_exist: false, allow_directory: false });
      if (backup.existed) await atomicWrite(this.fs, target.absolute, backup.content, backup.metadata.mode || 0o600);
      else await this.fs.rm(target.absolute, { force: true });
      restored.push(relative);
    }
    this.backups.clear();
    this.log.append('tool.rollback', { reason: clean(reason, 1000), restored });
    await this.#persist();
    return Object.freeze({ restored: Object.freeze(restored), reason: clean(reason, 1000) });
  }

  async close(reason = 'completed') {
    if (this.status === 'closed') return this.receipt();
    for (const [id, controller] of this.active) {
      controller.abort(new Error('broker closed'));
      this.log.append('tool.run.cancelled', { operation_id: id, reason: 'broker closed' });
    }
    this.active.clear();
    this.status = 'closed';
    this.log.append('broker.closed', { reason: clean(reason, 1000) });
    await this.#persist();
    return this.receipt();
  }

  receipt() {
    return this.log.receipt({ schema: TOOL_SCHEMA, status: this.status, lease: this.lease, artifacts: Object.fromEntries(this.artifacts), cancel_reason: this.cancelReason });
  }
}
