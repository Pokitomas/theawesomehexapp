import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFileDefault = promisify(execFileCallback);
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVISION_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const BRANCH_RE = /^(?!\/)(?!.*\.\.)(?!.*@\{)(?!.*[~^:?*\[\\\s])(?:[A-Za-z0-9._/-]{1,220})$/;
const RECEIPT_SCHEMA = 'sideways-maker-target-workspace/v1';
const META_SCHEMA = 'sideways-maker-target-workspace-state/v1';
const PERMISSIONS = Object.freeze({ none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 });

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

function normalizePermission(value) {
  const normalized = clean(value, 40).toLowerCase();
  return Object.hasOwn(PERMISSIONS, normalized) ? normalized : 'none';
}

export function normalizeRepositoryIdentity(value) {
  const repository = clean(value, 300).replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!REPOSITORY_RE.test(repository)) throw new Error('Repository must use owner/repository form.');
  const [owner, name] = repository.split('/');
  return Object.freeze({
    repository,
    owner,
    name,
    clone_url: `https://github.com/${owner}/${name}.git`,
    api_url: `https://api.github.com/repos/${owner}/${name}`
  });
}

export function normalizeBaseRevision(value = 'main') {
  const revision = clean(value || 'main', 200);
  if (!REVISION_RE.test(revision) || revision.startsWith('/') || revision.includes('..') || revision.includes('@{')) throw new Error('Base revision is invalid.');
  return revision;
}

export function normalizeWorkerBranch(value) {
  const branch = clean(value, 220);
  if (!BRANCH_RE.test(branch) || branch.endsWith('/') || branch.endsWith('.lock')) throw new Error('Worker branch is invalid.');
  return branch;
}

function safeChild(root, child) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, child);
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) throw new Error('Workspace path escapes the configured root.');
  return resolved;
}

function sanitizeCommand(command) {
  return {
    program: clean(command.program, 200),
    args: (command.args || []).map(value => clean(value, 1000)),
    cwd: clean(command.cwd, 4000),
    timeout_ms: Number(command.timeout_ms) || null
  };
}

function normalizeExecResult(value = {}) {
  return {
    stdout: clean(value.stdout, 200000),
    stderr: clean(value.stderr, 200000),
    code: Number(value.code ?? 0)
  };
}

async function defaultExecutor(command) {
  const result = await execFileDefault(command.program, command.args || [], {
    cwd: command.cwd,
    env: command.env,
    timeout: command.timeout_ms || 15 * 60 * 1000,
    maxBuffer: command.max_buffer || 8 * 1024 * 1024,
    windowsHide: true
  });
  return { ...result, code: 0 };
}

async function exists(fsImpl, filename) {
  try {
    await fsImpl.stat(filename);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeAtomic(fsImpl, filename, value) {
  await fsImpl.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsImpl.rename(temporary, filename);
}

function authorizationReceipt(repository, response = {}, required = 'write') {
  const permission = normalizePermission(response.permission || response.role_name || response.permissions?.push && 'write' || response.permissions?.pull && 'read');
  const visible = response.visible !== false && response.exists !== false;
  const requiredLevel = PERMISSIONS[normalizePermission(required)];
  const allowed = visible && PERMISSIONS[permission] >= requiredLevel;
  return Object.freeze({
    repository: repository.repository,
    visible,
    permission,
    required_permission: normalizePermission(required),
    allowed,
    default_branch: clean(response.default_branch || 'main', 200),
    archived: response.archived === true,
    disabled: response.disabled === true,
    fork: response.fork === true,
    private: response.private === true,
    source: clean(response.source || 'github-api', 120)
  });
}

function authEnvironment(credential = {}) {
  const header = clean(credential.authorization_header, 10000);
  if (!header) return { env: {}, secret_env_keys: [] };
  return {
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: header,
      GIT_TERMINAL_PROMPT: '0'
    },
    secret_env_keys: ['GIT_CONFIG_VALUE_0']
  };
}

export function createWorkspacePlan(input = {}) {
  const control = normalizeRepositoryIdentity(input.control_repository || input.repository);
  const target = normalizeRepositoryIdentity(input.target_repository || input.repository);
  const baseRevision = normalizeBaseRevision(input.base_revision || 'main');
  const branch = normalizeWorkerBranch(input.branch);
  const workspaceId = clean(input.workspace_id || `maker-${crypto.randomUUID()}`, 160).replace(/[^A-Za-z0-9._-]/g, '-');
  if (!workspaceId) throw new Error('Workspace ID is invalid.');
  const root = path.resolve(clean(input.workspace_root || path.join(os.tmpdir(), 'sideways-maker-workspaces'), 4000));
  const checkout = safeChild(root, workspaceId);
  const statePath = safeChild(root, `.state/${workspaceId}.json`);
  return Object.freeze({
    schema: 'sideways-maker-target-workspace-plan/v1',
    control_repository: control.repository,
    target_repository: target.repository,
    same_repository: control.repository.toLowerCase() === target.repository.toLowerCase(),
    base_revision: baseRevision,
    exact_base_requested: SHA_RE.test(baseRevision),
    branch,
    workspace_id: workspaceId,
    workspace_root: root,
    checkout,
    state_path: statePath,
    clone_url: target.clone_url,
    required_permission: clean(input.required_permission || 'write', 40).toLowerCase(),
    allow_submodules: input.allow_submodules === true,
    allow_lfs_pointers: input.allow_lfs_pointers === true,
    depth: Math.max(1, Math.min(1000, Number(input.depth || 64))),
    authority: {
      merge: 'human',
      deploy: 'human',
      repository_settings: 'human',
      secrets: 'none'
    }
  });
}

export class TargetWorkspaceManager {
  constructor({
    workspace_root = path.join(os.tmpdir(), 'sideways-maker-workspaces'),
    fs_impl = fs,
    executor = defaultExecutor,
    github = null,
    clock = nowISO,
    random_id = () => crypto.randomUUID()
  } = {}) {
    this.workspaceRoot = path.resolve(workspace_root);
    this.fs = fs_impl;
    this.executor = executor;
    this.github = github;
    this.clock = clock;
    this.randomId = random_id;
  }

  async #run(program, args, { cwd, env = {}, timeout_ms = 15 * 60 * 1000, secret_env_keys = [] } = {}, transcript = []) {
    const command = { program, args, cwd, env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', ...env }, timeout_ms };
    const startedAt = this.clock();
    try {
      const result = normalizeExecResult(await this.executor(command));
      if (result.code !== 0) throw Object.assign(new Error(`${program} exited ${result.code}: ${result.stderr || result.stdout}`), { result });
      transcript.push({ command: sanitizeCommand(command), secret_env_keys, started_at: startedAt, finished_at: this.clock(), ok: true, stdout_digest: digest(result.stdout), stderr_digest: digest(result.stderr) });
      return result;
    } catch (error) {
      const result = normalizeExecResult(error?.result || error);
      transcript.push({ command: sanitizeCommand(command), secret_env_keys, started_at: startedAt, finished_at: this.clock(), ok: false, stdout_digest: digest(result.stdout), stderr_digest: digest(result.stderr), error: clean(error?.message || error, 2000) });
      throw error;
    }
  }

  async #authorize(plan, credential) {
    if (!this.github?.inspectRepository) throw new Error('GitHub repository authorization adapter is required.');
    const response = await this.github.inspectRepository(plan.target_repository, credential);
    const receipt = authorizationReceipt(normalizeRepositoryIdentity(plan.target_repository), response, plan.required_permission);
    if (!receipt.allowed) throw Object.assign(new Error(`Target repository authorization denied: ${receipt.permission} < ${receipt.required_permission}.`), { authorization: receipt });
    if (receipt.archived || receipt.disabled) throw Object.assign(new Error('Target repository is archived or disabled.'), { authorization: receipt });
    return receipt;
  }

  async prepare(input = {}) {
    const plan = createWorkspacePlan({ ...input, workspace_root: this.workspaceRoot, workspace_id: input.workspace_id || this.randomId() });
    const transcript = [];
    const warnings = [];
    const authorization = await this.#authorize(plan, input.credential);
    if (plan.base_revision === 'main' && authorization.default_branch !== 'main') warnings.push(`requested main differs from target default branch ${authorization.default_branch}`);
    if (await exists(this.fs, plan.checkout)) {
      const entries = await this.fs.readdir(plan.checkout).catch(() => []);
      if (entries.length) throw new Error(`Workspace is contaminated: ${plan.checkout}.`);
      await this.fs.rm(plan.checkout, { recursive: true, force: true });
    }
    await this.fs.mkdir(plan.workspace_root, { recursive: true, mode: 0o700 });
    await this.fs.mkdir(path.dirname(plan.state_path), { recursive: true, mode: 0o700 });
    const auth = authEnvironment(input.credential);
    try {
      await this.#run('git', ['clone', '--filter=blob:none', '--no-checkout', '--origin', 'origin', '--depth', String(plan.depth), plan.clone_url, plan.checkout], {
        cwd: plan.workspace_root,
        env: auth.env,
        secret_env_keys: auth.secret_env_keys
      }, transcript);
      const realCheckout = await this.fs.realpath(plan.checkout);
      if (realCheckout !== path.resolve(plan.checkout)) throw new Error('Workspace resolved through a symlink or unexpected mount.');
      await this.#run('git', ['remote', 'set-url', 'origin', plan.clone_url], { cwd: plan.checkout }, transcript);
      await this.#run('git', ['config', '--local', '--unset-all', 'http.https://github.com/.extraheader'], { cwd: plan.checkout }, transcript).catch(() => {});
      await this.#run('git', ['fetch', '--no-tags', '--depth', String(plan.depth), 'origin', plan.base_revision], {
        cwd: plan.checkout,
        env: auth.env,
        secret_env_keys: auth.secret_env_keys
      }, transcript);
      await this.#run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: plan.checkout }, transcript);
      const resolved = clean((await this.#run('git', ['rev-parse', 'HEAD'], { cwd: plan.checkout }, transcript)).stdout, 40).toLowerCase();
      if (!SHA_RE.test(resolved)) throw new Error('Target base did not resolve to an exact commit SHA.');
      if (plan.exact_base_requested && resolved !== plan.base_revision.toLowerCase()) throw new Error(`Resolved base ${resolved} differs from requested ${plan.base_revision}.`);
      const status = clean((await this.#run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: plan.checkout }, transcript)).stdout, 2000);
      if (status) throw new Error(`Fresh target workspace is dirty: ${status}`);
      const shallow = clean((await this.#run('git', ['rev-parse', '--is-shallow-repository'], { cwd: plan.checkout }, transcript)).stdout, 20) === 'true';
      const gitmodules = await exists(this.fs, path.join(plan.checkout, '.gitmodules'));
      if (gitmodules && !plan.allow_submodules) throw new Error('Target repository contains submodules but submodule execution was not authorized.');
      if (gitmodules) warnings.push('target repository contains submodules; recursive checkout remains disabled');
      let lfsPointers = [];
      try {
        const output = (await this.#run('git', ['grep', '-l', 'version https://git-lfs.github.com/spec/v1', '--', ':!*.md'], { cwd: plan.checkout }, transcript)).stdout;
        lfsPointers = output.split(/\r?\n/).map(value => clean(value)).filter(Boolean).slice(0, 200);
      } catch {}
      if (lfsPointers.length && !plan.allow_lfs_pointers) warnings.push(`${lfsPointers.length} Git LFS pointer file(s) require an admitted LFS materialization step`);
      await this.#run('git', ['switch', '-c', plan.branch], { cwd: plan.checkout }, transcript);
      const branchHead = clean((await this.#run('git', ['rev-parse', 'HEAD'], { cwd: plan.checkout }, transcript)).stdout, 40).toLowerCase();
      const state = {
        schema: META_SCHEMA,
        workspace_id: plan.workspace_id,
        control_repository: plan.control_repository,
        target_repository: plan.target_repository,
        checkout: plan.checkout,
        base_revision: plan.base_revision,
        base_sha: resolved,
        branch: plan.branch,
        branch_head: branchHead,
        authorization,
        shallow,
        depth: plan.depth,
        gitmodules,
        lfs_pointers: lfsPointers,
        warnings,
        created_at: this.clock(),
        status: 'ready',
        authority: plan.authority
      };
      const receiptBody = {
        schema: RECEIPT_SCHEMA,
        ...state,
        transcript: transcript.map(value => ({ ...value, command: sanitizeCommand(value.command) }))
      };
      const receipt = Object.freeze({ ...receiptBody, receipt_digest: digest(receiptBody) });
      await writeAtomic(this.fs, plan.state_path, { ...state, receipt_digest: receipt.receipt_digest });
      return Object.freeze({ plan, state: Object.freeze(state), receipt });
    } catch (error) {
      await this.fs.rm(plan.checkout, { recursive: true, force: true }).catch(() => {});
      const failureBody = {
        schema: RECEIPT_SCHEMA,
        workspace_id: plan.workspace_id,
        target_repository: plan.target_repository,
        checkout: plan.checkout,
        status: 'failed',
        error: clean(error?.message || error, 4000),
        authorization: error?.authorization || authorization,
        transcript,
        failed_at: this.clock(),
        authority: plan.authority
      };
      throw Object.assign(new Error(failureBody.error), { receipt: { ...failureBody, receipt_digest: digest(failureBody) } });
    }
  }

  async readState(workspaceId) {
    const id = clean(workspaceId, 160).replace(/[^A-Za-z0-9._-]/g, '-');
    const statePath = safeChild(this.workspaceRoot, `.state/${id}.json`);
    const state = JSON.parse(await this.fs.readFile(statePath, 'utf8'));
    if (state?.schema !== META_SCHEMA || state.workspace_id !== id) throw new Error('Unsupported or mismatched workspace state.');
    return state;
  }

  async cleanup(workspaceId, { reason = 'operator cleanup' } = {}) {
    const state = await this.readState(workspaceId);
    const checkout = safeChild(this.workspaceRoot, state.workspace_id);
    await this.fs.rm(checkout, { recursive: true, force: true });
    const next = { ...state, status: 'cleaned', cleanup_reason: clean(reason, 1000), cleaned_at: this.clock() };
    const statePath = safeChild(this.workspaceRoot, `.state/${state.workspace_id}.json`);
    await writeAtomic(this.fs, statePath, next);
    const body = { schema: RECEIPT_SCHEMA, workspace_id: state.workspace_id, target_repository: state.target_repository, base_sha: state.base_sha, branch: state.branch, status: 'cleaned', reason: next.cleanup_reason, cleaned_at: next.cleaned_at };
    return Object.freeze({ ...body, receipt_digest: digest(body) });
  }

  async rollback(workspaceId, { reason = 'operator rollback' } = {}) {
    const state = await this.readState(workspaceId);
    const checkout = safeChild(this.workspaceRoot, state.workspace_id);
    const transcript = [];
    if (await exists(this.fs, checkout)) {
      await this.#run('git', ['reset', '--hard', state.base_sha], { cwd: checkout }, transcript);
      await this.#run('git', ['clean', '-ffd'], { cwd: checkout }, transcript);
    }
    const next = { ...state, status: 'rolled_back', rollback_reason: clean(reason, 1000), rolled_back_at: this.clock() };
    const statePath = safeChild(this.workspaceRoot, `.state/${state.workspace_id}.json`);
    await writeAtomic(this.fs, statePath, next);
    const body = { schema: RECEIPT_SCHEMA, workspace_id: state.workspace_id, target_repository: state.target_repository, base_sha: state.base_sha, branch: state.branch, status: 'rolled_back', reason: next.rollback_reason, transcript, rolled_back_at: next.rolled_back_at };
    return Object.freeze({ ...body, receipt_digest: digest(body) });
  }
}
