import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ENGINE_SCHEMA = 'sideways-maker-engine/v1';
const STATE_SCHEMA = 'sideways-maker-engine-state/v1';
const RECEIPT_SCHEMA = 'sideways-maker-engine-receipt/v1';
const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules', '.netlify', '.cache']);
const BLOCKED_BASENAMES = [/^\.env(?:\.|$)/i, /(?:^|\.)private[-_]?key/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /credentials?/i];
const SECRET_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:REMOTE_KEY|SOCIAL_SESSION_SECRET|DATABASE_URL|SIDEWAYS_MODEL_API_KEY)\s*[:=]\s*\S+/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi
];
const TERMINAL_STATES = new Set(['cancelled', 'rolled_back', 'ready']);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const nowISO = () => new Date().toISOString();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

export function redactSecrets(value) {
  if (typeof value === 'string') {
    let output = value;
    for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[REDACTED]');
    return output;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSecrets(child)]));
}

function normalizeRelative(input) {
  const raw = clean(input, 1000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error('Path must be repository-relative.');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || BLOCKED_SEGMENTS.has(part))) throw new Error(`Blocked repository path: ${raw}.`);
  if (BLOCKED_BASENAMES.some(pattern => pattern.test(parts.at(-1) || ''))) throw new Error(`Secret-like repository path is blocked: ${raw}.`);
  return parts.join('/');
}

export function resolveMakerPath(root, relative) {
  const normalized = normalizeRelative(relative);
  const base = path.resolve(root);
  const absolute = path.resolve(base, ...normalized.split('/'));
  if (absolute !== base && !absolute.startsWith(`${base}${path.sep}`)) throw new Error(`Path escapes repository: ${normalized}.`);
  return Object.freeze({ relative: normalized, absolute });
}

function normalizeLeasePath(input) {
  const raw = clean(input, 1000).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (raw === '**') return raw;
  const directory = raw.endsWith('/**');
  const base = directory ? raw.slice(0, -3) : raw;
  const normalized = normalizeRelative(base);
  return directory ? `${normalized}/**` : normalized;
}

function leasePrefix(input) {
  if (input === '**') return '';
  return input.endsWith('/**') ? input.slice(0, -3) : input;
}

export function pathsOverlap(left, right) {
  const a = normalizeLeasePath(left);
  const b = normalizeLeasePath(right);
  if (a === '**' || b === '**') return true;
  const ap = leasePrefix(a);
  const bp = leasePrefix(b);
  const aDirectory = a.endsWith('/**');
  const bDirectory = b.endsWith('/**');
  if (ap === bp) return true;
  if (aDirectory && bp.startsWith(`${ap}/`)) return true;
  if (bDirectory && ap.startsWith(`${bp}/`)) return true;
  return false;
}

export function normalizeMakerLease(input = {}) {
  const owned = [...new Set((input.owned_paths || []).map(normalizeLeasePath))].sort();
  if (!owned.length) throw new Error('Maker lease requires owned paths.');
  const lease = {
    version: 'sideways-maker-lease/v1',
    base_sha: clean(input.base_sha, 40),
    branch: clean(input.branch, 240),
    writer_count: Number(input.writer_count ?? 1),
    owned_paths: owned,
    authority: {
      merge: clean(input.authority?.merge || 'human', 40),
      deploy: clean(input.authority?.deploy || 'human', 40)
    }
  };
  if (!/^[0-9a-f]{40}$/i.test(lease.base_sha)) throw new Error('Maker lease requires an exact 40-character base SHA.');
  if (!lease.branch || !/^[A-Za-z0-9._/-]+$/.test(lease.branch)) throw new Error('Maker lease branch is invalid.');
  if (lease.writer_count !== 1) throw new Error('Maker lease requires exactly one writer.');
  if (lease.authority.merge !== 'human' || lease.authority.deploy !== 'human') throw new Error('Merge and deployment authority must remain human.');
  return Object.freeze(lease);
}

export function assertNoLeaseCollision(candidateInput, activeInputs = []) {
  const candidate = normalizeMakerLease(candidateInput);
  for (const activeInput of activeInputs) {
    const active = normalizeMakerLease(activeInput);
    if (active.branch === candidate.branch) continue;
    for (const left of candidate.owned_paths) {
      for (const right of active.owned_paths) {
        if (pathsOverlap(left, right)) throw new Error(`Maker lease collision: ${left} overlaps ${right} on ${active.branch}.`);
      }
    }
  }
  return candidate;
}

export function pathIsOwned(relative, leaseInput) {
  const file = normalizeRelative(relative);
  const lease = normalizeMakerLease(leaseInput);
  return lease.owned_paths.some(entry => {
    if (entry === '**') return true;
    if (entry.endsWith('/**')) {
      const prefix = entry.slice(0, -3);
      return file === prefix || file.startsWith(`${prefix}/`);
    }
    return file === entry;
  });
}

export function normalizeMakerTask(input = {}) {
  const task = {
    schema: ENGINE_SCHEMA,
    id: clean(input.id || `task-${crypto.randomUUID()}`, 200),
    repository: clean(input.repository, 300),
    base_sha: clean(input.base_sha, 40),
    branch: clean(input.branch, 240),
    request: clean(input.request, 8000),
    protect: clean(input.protect, 4000),
    proof: clean(input.proof, 4000),
    authority: {
      merge: 'human',
      deploy: 'human',
      production_data: 'none'
    }
  };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.repository)) throw new Error('Maker task requires owner/repository.');
  if (!/^[0-9a-f]{40}$/i.test(task.base_sha)) throw new Error('Maker task requires an exact base SHA.');
  if (!task.branch || !task.request) throw new Error('Maker task requires branch and request.');
  return Object.freeze(task);
}

function normalizeCommandRule(rule = {}) {
  const program = clean(rule.program, 200);
  const args = Array.isArray(rule.args) ? rule.args.map(value => clean(value, 1000)) : [];
  const prefix = rule.prefix === true;
  if (!program || program.includes('/') || program.includes('\\')) throw new Error('Command policy program must be a PATH executable name.');
  return Object.freeze({ program, args, prefix });
}

export function normalizeCommandPolicy(rules = []) {
  return Object.freeze(rules.map(normalizeCommandRule));
}

export function assertCommandAllowed(command = {}, policyInput = []) {
  const program = clean(command.program, 200);
  const args = Array.isArray(command.args) ? command.args.map(value => clean(value, 4000)) : [];
  if (!program || program.includes('/') || program.includes('\\')) throw new Error('Command must use an allowlisted PATH executable.');
  if (args.some(value => /[\u0000\r\n]/.test(value))) throw new Error('Command arguments cannot contain control newlines.');
  const policy = normalizeCommandPolicy(policyInput);
  const allowed = policy.some(rule => rule.program === program && (rule.prefix
    ? rule.args.every((value, index) => args[index] === value)
    : rule.args.length === args.length && rule.args.every((value, index) => args[index] === value)));
  if (!allowed) throw new Error(`Command is not allowlisted: ${[program, ...args].join(' ')}.`);
  return Object.freeze({ program, args });
}

export function verifyEventChain(events = []) {
  let previous = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1) throw new Error(`Maker event sequence mismatch at ${index + 1}.`);
    if ((event.previous_digest || null) !== previous) throw new Error(`Maker event chain predecessor mismatch at ${event.sequence}.`);
    const body = { sequence: event.sequence, at: event.at, type: event.type, payload: event.payload, previous_digest: event.previous_digest || null };
    const expected = digest(body);
    if (event.digest !== expected) throw new Error(`Maker event digest mismatch at ${event.sequence}.`);
    previous = event.digest;
  }
  return previous;
}

async function writeAtomicJSON(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filename);
}

async function exists(filename) {
  try { await fs.stat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function assertMutableState(state) {
  if (TERMINAL_STATES.has(state.status)) throw new Error(`Maker task is terminal: ${state.status}.`);
}

export class MakerEngine {
  constructor({ root, statePath, state, commandPolicy, execFileImpl = execFileAsync, clock = nowISO }) {
    this.root = path.resolve(root);
    this.statePath = path.resolve(statePath);
    this.backupRoot = path.join(path.dirname(this.statePath), 'backups');
    this.state = state;
    this.commandPolicy = normalizeCommandPolicy(commandPolicy);
    this.execFileImpl = execFileImpl;
    this.clock = clock;
  }

  static async create({ root = process.cwd(), state_path, task, lease, active_leases = [], command_policy = [], exec_file, clock } = {}) {
    if (!state_path) throw new Error('Maker engine requires an external state path.');
    const normalizedTask = normalizeMakerTask(task);
    const normalizedLease = assertNoLeaseCollision(lease, active_leases);
    if (normalizedTask.base_sha !== normalizedLease.base_sha || normalizedTask.branch !== normalizedLease.branch) throw new Error('Task and lease identity differ.');
    if (await exists(state_path)) throw new Error('Maker engine state already exists; resume it instead.');
    const state = {
      schema: STATE_SCHEMA,
      task: normalizedTask,
      lease: normalizedLease,
      status: 'leased',
      attempt: 1,
      created_at: (clock || nowISO)(),
      updated_at: null,
      events: [],
      backups: {},
      changed_paths: [],
      commands: [],
      failures: [],
      verification: [],
      checkpoints: [],
      receipt: null
    };
    const engine = new MakerEngine({ root, statePath: state_path, state, commandPolicy: command_policy, execFileImpl: exec_file || execFileAsync, clock: clock || nowISO });
    await engine.#append('lease_acquired', { lease: normalizedLease });
    return engine;
  }

  static async resume({ root = process.cwd(), state_path, command_policy = [], exec_file, clock } = {}) {
    if (!state_path) throw new Error('Maker engine requires an external state path.');
    const state = JSON.parse(await fs.readFile(state_path, 'utf8'));
    if (state?.schema !== STATE_SCHEMA) throw new Error('Unsupported Maker engine state.');
    verifyEventChain(state.events || []);
    state.attempt = Number(state.attempt || 0) + 1;
    const engine = new MakerEngine({ root, statePath: state_path, state, commandPolicy: command_policy, execFileImpl: exec_file || execFileAsync, clock: clock || nowISO });
    await engine.#append('resumed', { attempt: state.attempt, prior_status: state.status });
    return engine;
  }

  async #persist() {
    this.state.updated_at = this.clock();
    await writeAtomicJSON(this.statePath, this.state);
  }

  async #append(type, payload = {}) {
    const sanitized = redactSecrets(payload);
    const previous = this.state.events.at(-1)?.digest || null;
    const body = { sequence: this.state.events.length + 1, at: this.clock(), type: clean(type, 100), payload: sanitized, previous_digest: previous };
    const event = Object.freeze({ ...body, digest: digest(body) });
    this.state.events.push(event);
    await this.#persist();
    return event;
  }

  #target(relative, requireOwned = false) {
    const target = resolveMakerPath(this.root, relative);
    if (requireOwned && !pathIsOwned(target.relative, this.state.lease)) throw new Error(`Path is outside the Maker lease: ${target.relative}.`);
    return target;
  }

  async capabilities() {
    return Object.freeze({
      schema: ENGINE_SCHEMA,
      tools: ['read', 'search', 'write', 'replace', 'delete', 'run', 'repair_start', 'repair_complete', 'checkpoint', 'resume', 'cancel', 'rollback', 'verify', 'receipt'],
      shell: false,
      network: false,
      command_policy: this.commandPolicy,
      branch: this.state.task.branch,
      base_sha: this.state.task.base_sha,
      owned_paths: this.state.lease.owned_paths,
      status: this.state.status,
      human_gates: ['merge', 'deploy', 'production data', 'training spend']
    });
  }

  async read(relative, { start = 1, end = 400 } = {}) {
    const target = this.#target(relative);
    const stat = await fs.stat(target.absolute);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) throw new Error(`File is not bounded UTF-8 text: ${target.relative}.`);
    const lines = (await fs.readFile(target.absolute, 'utf8')).split(/\r?\n/);
    const first = Math.max(1, Number(start) || 1);
    const last = Math.min(lines.length, Math.max(first, Number(end) || first + 399));
    await this.#append('file_read', { path: target.relative, start: first, end: last, total_lines: lines.length });
    return Object.freeze({ path: target.relative, start: first, end: last, total_lines: lines.length, content: lines.slice(first - 1, last).join('\n') });
  }

  async search(query, { prefix = '' } = {}) {
    const needle = clean(query, 1000);
    if (!needle) throw new Error('Search query is required.');
    const root = prefix ? this.#target(prefix).absolute : this.root;
    const matches = [];
    const visit = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (BLOCKED_SEGMENTS.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          const stat = await fs.stat(absolute);
          if (stat.size > MAX_TEXT_BYTES) continue;
          let text;
          try { text = await fs.readFile(absolute, 'utf8'); } catch { continue; }
          text.split(/\r?\n/).forEach((line, index) => {
            if (line.includes(needle) && matches.length < 400) matches.push({ path: path.relative(this.root, absolute).replace(/\\/g, '/'), line: index + 1, text: clean(line, 2000) });
          });
        }
      }
    };
    await visit(root);
    await this.#append('repository_search', { query: needle, prefix: clean(prefix, 1000), matches: matches.length });
    return Object.freeze(matches);
  }

  #latestUnrepairedFailure() {
    return [...this.state.failures].reverse().find(value => !value.repaired) || null;
  }

  #assertRepairMutationAllowed() {
    const failure = this.#latestUnrepairedFailure();
    if (!failure) return;
    if (failure.repair?.status !== 'started') {
      throw new Error(`Begin a falsifiable repair for ${failure.id} before mutating files.`);
    }
  }

  async #backup(target) {
    if (Object.hasOwn(this.state.backups, target.relative)) return;
    await fs.mkdir(this.backupRoot, { recursive: true });
    const present = await exists(target.absolute);
    const descriptor = { existed: present, backup: null, sha256: null };
    if (present) {
      const stat = await fs.stat(target.absolute);
      if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) throw new Error(`Cannot safely back up file: ${target.relative}.`);
      const bytes = await fs.readFile(target.absolute);
      const backup = path.join(this.backupRoot, digest(target.relative));
      await fs.writeFile(backup, bytes);
      descriptor.backup = backup;
      descriptor.sha256 = digest(bytes);
    }
    this.state.backups[target.relative] = descriptor;
  }

  async write(relative, content) {
    assertMutableState(this.state);
    this.#assertRepairMutationAllowed();
    const target = this.#target(relative, true);
    const text = String(content ?? '').replace(/\u0000/g, '');
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('Maker write exceeds bounded UTF-8 size.');
    await this.#backup(target);
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    const temporary = `${target.absolute}.maker-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporary, text, 'utf8');
    await fs.rename(temporary, target.absolute);
    if (!this.state.changed_paths.includes(target.relative)) this.state.changed_paths.push(target.relative);
    this.state.status = this.state.status === 'failed' ? 'repairing' : 'executing';
    await this.#append('file_written', { path: target.relative, bytes: Buffer.byteLength(text), sha256: digest(text) });
    return Object.freeze({ path: target.relative, bytes: Buffer.byteLength(text), sha256: digest(text) });
  }

  async replace(relative, before, after, { expected = 1 } = {}) {
    const target = this.#target(relative, true);
    const original = await fs.readFile(target.absolute, 'utf8');
    const needle = String(before ?? '');
    if (!needle) throw new Error('Replacement needle is required.');
    const count = original.split(needle).length - 1;
    if (count !== Number(expected)) throw new Error(`Replacement count mismatch for ${target.relative}: expected ${expected}, found ${count}.`);
    return this.write(target.relative, original.split(needle).join(String(after ?? '')));
  }

  async delete(relative) {
    assertMutableState(this.state);
    this.#assertRepairMutationAllowed();
    const target = this.#target(relative, true);
    await this.#backup(target);
    if (!await exists(target.absolute)) throw new Error(`Cannot delete missing file: ${target.relative}.`);
    await fs.rm(target.absolute);
    if (!this.state.changed_paths.includes(target.relative)) this.state.changed_paths.push(target.relative);
    this.state.status = 'executing';
    await this.#append('file_deleted', { path: target.relative });
    return Object.freeze({ path: target.relative, deleted: true });
  }

  async run(command, { timeout_ms = 180000 } = {}) {
    assertMutableState(this.state);
    const selected = assertCommandAllowed(command, this.commandPolicy);
    const started = Date.now();
    const env = { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CI: '1', NODE_ENV: 'test', NO_COLOR: '1' };
    let result;
    try {
      const value = await this.execFileImpl(selected.program, selected.args, { cwd: this.root, env, timeout: timeout_ms, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      result = { ok: true, program: selected.program, args: selected.args, exit_code: 0, duration_ms: Date.now() - started, stdout: clean(value.stdout, 24000), stderr: clean(value.stderr, 24000) };
      if (this.state.status === 'failed') this.state.status = 'repairing';
    } catch (error) {
      result = { ok: false, program: selected.program, args: selected.args, exit_code: Number.isInteger(error.code) ? error.code : 1, duration_ms: Date.now() - started, stdout: clean(error.stdout, 24000), stderr: clean(error.stderr || error.message, 24000) };
      this.state.status = 'failed';
      const command = [selected.program, ...selected.args];
      const activeRepair = [...this.state.failures].reverse().find(value =>
        !value.repaired
        && value.repair?.status === 'started'
        && stableJSONStringify(value.command) === stableJSONStringify(command)
      );
      const failure = activeRepair || {
        id: `failure-${this.state.failures.length + 1}`,
        command,
        evidence: redactSecrets(result.stderr || result.stdout),
        at: this.clock(),
        repaired: false
      };
      if (!activeRepair) this.state.failures.push(failure);
      else {
        failure.evidence = redactSecrets(result.stderr || result.stdout);
        failure.repair.failed_probes = Number(failure.repair.failed_probes || 0) + 1;
        failure.repair.last_failed_probe_at = this.clock();
      }
      result.failure_id = failure.id;
    }
    const sanitized = redactSecrets(result);
    this.state.commands.push(sanitized);
    await this.#append('command_finished', sanitized);
    return Object.freeze(sanitized);
  }

  async beginRepair(failureId, hypothesis) {
    assertMutableState(this.state);
    const failure = this.state.failures.find(value => value.id === failureId);
    if (!failure) throw new Error(`Unknown failure: ${failureId}.`);
    if (failure.repaired) throw new Error(`Failure is already repaired: ${failureId}.`);
    const statement = clean(hypothesis, 4000);
    if (!statement) throw new Error('Repair hypothesis is required.');
    const latest = this.#latestUnrepairedFailure();
    if (latest?.id !== failureId) throw new Error(`Repair the latest unresolved failure first: ${latest?.id}.`);
    if (failure.repair?.status === 'started') throw new Error(`Repair is already active: ${failureId}.`);
    failure.repair = {
      status: 'started',
      hypothesis: statement,
      command_index: this.state.commands.length,
      started_at: this.clock(),
      failed_probes: 0
    };
    this.state.status = 'repairing';
    await this.#append('repair_started', { failure_id: failureId, hypothesis: statement, command_index: failure.repair.command_index });
    return Object.freeze({ failure_id: failureId, status: 'repairing', hypothesis: statement });
  }

  async markRepaired(failureId, evidence) {
    assertMutableState(this.state);
    const failure = this.state.failures.find(value => value.id === failureId);
    if (!failure) throw new Error(`Unknown failure: ${failureId}.`);
    if (failure.repaired) throw new Error(`Failure is already repaired: ${failureId}.`);
    if (failure.repair?.status !== 'started') throw new Error(`Start a repair hypothesis before completing ${failureId}.`);
    const expected = stableJSONStringify(failure.command);
    const witnessIndex = this.state.commands.findIndex((command, index) =>
      index >= Number(failure.repair.command_index || 0)
      && command.ok === true
      && stableJSONStringify([command.program, ...(command.args || [])]) === expected
    );
    if (witnessIndex === -1) {
      throw new Error(`Repair completion requires a successful rerun of: ${failure.command.join(' ')}.`);
    }
    const witness = this.state.commands[witnessIndex];
    failure.repaired = true;
    failure.repair_evidence = redactSecrets(clean(evidence, 8000));
    failure.repair = {
      ...failure.repair,
      status: 'proved',
      completed_at: this.clock(),
      witness_command_index: witnessIndex,
      witness: { command: [...failure.command], duration_ms: witness.duration_ms, exit_code: witness.exit_code }
    };
    this.state.status = this.state.failures.some(value => !value.repaired) ? 'repairing' : 'executing';
    await this.#append('repair_completed', { failure_id: failureId, evidence: failure.repair_evidence, witness: failure.repair.witness });
    return Object.freeze(failure);
  }

  async checkpoint(label) {
    assertMutableState(this.state);
    const body = { label: clean(label, 500), changed_paths: [...this.state.changed_paths].sort(), event_head: this.state.events.at(-1)?.digest || null };
    const checkpoint = { ...body, digest: digest(body), at: this.clock() };
    this.state.checkpoints.push(checkpoint);
    await this.#append('checkpoint_created', checkpoint);
    return Object.freeze(checkpoint);
  }

  async verify(commands = []) {
    assertMutableState(this.state);
    if (this.state.failures.some(value => !value.repaired)) throw new Error('Cannot verify with unrepaired failures.');
    this.state.status = 'verifying';
    await this.#append('verification_started', { count: commands.length });
    const results = [];
    for (const command of commands) {
      const result = await this.run(command);
      results.push(result);
      if (!result.ok) {
        this.state.verification = results;
        await this.#append('verification_failed', { command: [result.program, ...result.args], failure_id: result.failure_id });
        return Object.freeze({ ok: false, results });
      }
    }
    this.state.verification = results;
    this.state.status = 'ready';
    await this.#append('verification_passed', { commands: results.map(value => [value.program, ...value.args]) });
    return Object.freeze({ ok: true, results });
  }

  async cancel(reason) {
    assertMutableState(this.state);
    this.state.status = 'cancelled';
    await this.#append('cancelled', { reason: clean(reason, 4000) });
    return Object.freeze({ status: 'cancelled' });
  }

  async rollback(reason = 'operator rollback') {
    if (this.state.status === 'rolled_back') return Object.freeze({ status: 'rolled_back', restored_paths: Object.keys(this.state.backups).sort() });
    if (this.state.status === 'ready') throw new Error('Ready state requires an explicit new task before rollback.');
    const restored = [];
    for (const [relative, descriptor] of Object.entries(this.state.backups)) {
      const target = this.#target(relative, true);
      if (descriptor.existed) {
        const bytes = await fs.readFile(descriptor.backup);
        if (descriptor.sha256 !== digest(bytes)) throw new Error(`Backup digest mismatch: ${relative}.`);
        await fs.mkdir(path.dirname(target.absolute), { recursive: true });
        await fs.writeFile(target.absolute, bytes);
      } else {
        await fs.rm(target.absolute, { force: true });
      }
      restored.push(relative);
    }
    this.state.status = 'rolled_back';
    await this.#append('rolled_back', { reason: clean(reason, 4000), restored_paths: restored.sort() });
    return Object.freeze({ status: 'rolled_back', restored_paths: restored.sort() });
  }

  async receipt() {
    if (this.state.status !== 'ready') throw new Error(`Maker receipt requires ready state, not ${this.state.status}.`);
    verifyEventChain(this.state.events);
    const body = {
      schema: RECEIPT_SCHEMA,
      task: this.state.task,
      lease: this.state.lease,
      status: this.state.status,
      changed_paths: [...this.state.changed_paths].sort(),
      commands: this.state.commands,
      failures: this.state.failures,
      verification: this.state.verification,
      checkpoints: this.state.checkpoints,
      event_count: this.state.events.length,
      event_head: this.state.events.at(-1)?.digest || null,
      human_gates: ['merge', 'deploy', 'production data', 'training spend']
    };
    const receipt = Object.freeze({ ...body, receipt_digest: digest(body) });
    this.state.receipt = receipt;
    await this.#append('receipt_created', { receipt_digest: receipt.receipt_digest });
    return receipt;
  }

  snapshot() {
    verifyEventChain(this.state.events);
    return structuredClone(this.state);
  }
}

export const MAKER_ENGINE_SCHEMA = ENGINE_SCHEMA;
export const MAKER_ENGINE_STATE_SCHEMA = STATE_SCHEMA;
export const MAKER_ENGINE_RECEIPT_SCHEMA = RECEIPT_SCHEMA;
