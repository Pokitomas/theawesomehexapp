#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[a-f0-9]{40}$/i;
const BRANCH_RE = /^(?!\/|.*(?:\.\.|\/\.|\.\/|\/\/|@\{|\\|[ ~^:?*\[]|\.lock(?:\/|$)))(?!.*\/$).+$/;
const SECRET_PATH_RE = /(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx)|credentials(?:\.json)?|secrets?(?:\.json|\.ya?ml)?)(?:$|\/)/i;
const SECRET_TEXT_RE = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+\/-]{20,}|AKIA[0-9A-Z]{16})/g;

function clean(value, limit = 10000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function redact(value) {
  return clean(value, 4000).replace(SECRET_TEXT_RE, '[REDACTED]');
}

export function normalizeRepository(value) {
  const repository = clean(value, 300).replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!REPOSITORY_RE.test(repository)) throw new Error('Repository must use owner/name form.');
  return repository;
}

export function normalizeBaseSha(value) {
  const sha = clean(value, 80).toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error('Base revision must be an exact 40-character commit SHA.');
  return sha;
}

export function normalizeBranch(value) {
  const branch = clean(value, 240);
  if (!branch || !BRANCH_RE.test(branch)) throw new Error('Branch is not a valid Git ref name.');
  return branch;
}

export function normalizeOwnedPath(value) {
  const candidate = clean(value, 1000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!candidate || path.posix.isAbsolute(candidate) || candidate.includes('\0')) throw new Error('Owned paths must be non-empty repository-relative paths.');
  const normalized = path.posix.normalize(candidate);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('Owned path escapes the repository.');
  if (normalized === '.git' || normalized.startsWith('.git/')) throw new Error('Git metadata cannot be leased.');
  if (SECRET_PATH_RE.test(normalized)) throw new Error('Secret-like paths cannot be relayed.');
  return normalized;
}

export function detectLinuxRuntime({ platform = process.platform, env = process.env, release = os.release(), procVersion = '' } = {}) {
  const linux = platform === 'linux';
  const marker = `${release} ${procVersion} ${clean(env.WSL_DISTRO_NAME, 200)} ${clean(env.WSL_INTEROP, 500)}`;
  const wsl = linux && /microsoft|wsl/i.test(marker);
  const container = linux && !wsl && Boolean(env.CONTAINER || env.container || env.KUBERNETES_SERVICE_HOST || env.GITHUB_ACTIONS);
  return {
    platform,
    supported: linux,
    kind: wsl ? 'wsl' : container ? 'container' : linux ? 'linux' : 'unsupported',
    distro: clean(env.WSL_DISTRO_NAME || env.IMAGE_OS || '', 200) || null
  };
}

export function selectTransport(capabilities = {}) {
  const values = {
    git: Boolean(capabilities.git),
    gh: Boolean(capabilities.gh),
    gh_authenticated: Boolean(capabilities.gh_authenticated),
    github_dns: Boolean(capabilities.github_dns),
    github_https: Boolean(capabilities.github_https),
    api_dns: Boolean(capabilities.api_dns),
    api_https: Boolean(capabilities.api_https),
    token: Boolean(capabilities.token),
    git_data_api: Boolean(capabilities.git_data_api)
  };
  if (values.git && values.github_dns && values.github_https) return 'native-git';
  if (values.gh && values.gh_authenticated && values.api_dns && values.api_https) return 'gh-cli';
  if (values.token && values.git_data_api && values.api_dns && values.api_https) return 'rest-git-data';
  return 'relay-packet';
}

export function buildLinuxMigrationPlan({ repository, base_sha, branch, issue_number = null, owned_paths = [], capabilities = {}, runtime = detectLinuxRuntime(), reason = '' }) {
  const repo = normalizeRepository(repository);
  const base = normalizeBaseSha(base_sha);
  const head = normalizeBranch(branch);
  const owned = [...new Set(owned_paths.map(normalizeOwnedPath))].sort();
  if (!owned.length) throw new Error('At least one owned path is required.');
  const mode = selectTransport(capabilities);
  const common = {
    schema: 'sideways-linux-migration/v1',
    repository: repo,
    base_sha: base,
    branch: head,
    issue_number: issue_number === null ? null : Number(issue_number),
    owned_paths: owned,
    runtime,
    mode,
    reason: redact(reason),
    authority: { merge: 'human', deploy: 'human', secrets: 'external-only' }
  };
  let actions;
  if (mode === 'native-git') {
    actions = [
      { program: 'git', args: ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${repo}.git`, 'workspace'] },
      { program: 'git', args: ['-C', 'workspace', 'fetch', '--depth=1', 'origin', base] },
      { program: 'git', args: ['-C', 'workspace', 'checkout', '--detach', base] },
      { program: 'git', args: ['-C', 'workspace', 'switch', '-c', head] }
    ];
  } else if (mode === 'gh-cli') {
    actions = [
      { program: 'gh', args: ['repo', 'clone', repo, 'workspace', '--', '--filter=blob:none', '--no-checkout'] },
      { program: 'git', args: ['-C', 'workspace', 'fetch', '--depth=1', 'origin', base] },
      { program: 'git', args: ['-C', 'workspace', 'checkout', '--detach', base] },
      { program: 'git', args: ['-C', 'workspace', 'switch', '-c', head] }
    ];
  } else if (mode === 'rest-git-data') {
    actions = [
      { method: 'GET', endpoint: `/repos/${repo}/git/commits/${base}`, purpose: 'prove exact base commit' },
      { method: 'GET', endpoint: `/repos/${repo}/git/trees/{base_tree_sha}?recursive=1`, purpose: 'hydrate only leased files and required context' },
      { method: 'POST', endpoint: `/repos/${repo}/git/blobs`, purpose: 'write changed blobs' },
      { method: 'POST', endpoint: `/repos/${repo}/git/trees`, purpose: 'assemble candidate tree against exact base tree' },
      { method: 'POST', endpoint: `/repos/${repo}/git/commits`, purpose: 'create one-parent candidate commit' },
      { method: 'POST', endpoint: `/repos/${repo}/git/refs`, purpose: 'create the isolated head branch without force' }
    ];
  } else {
    actions = [
      { operation: 'export-relay-packet', purpose: 'move exact base, lease, and bounded mutations to a connected GitHub authority' },
      { operation: 'import-relay-receipt', purpose: 'verify resulting branch and commit before continuing locally' }
    ];
  }
  const unsigned = { ...common, actions };
  return { ...unsigned, plan_digest: digest(unsigned) };
}

function normalizeMutation(mutation, ownedPaths) {
  const operation = clean(mutation?.operation, 40).toLowerCase();
  if (!['create', 'update', 'delete'].includes(operation)) throw new Error('Mutation operation must be create, update, or delete.');
  const target = normalizeOwnedPath(mutation?.path);
  const admitted = ownedPaths.some(owned => target === owned || target.startsWith(`${owned}/`));
  if (!admitted) throw new Error(`Mutation path is outside the owned lease: ${target}`);
  const before_sha = mutation?.before_sha ? clean(mutation.before_sha, 100).toLowerCase() : null;
  if (before_sha && !/^[a-f0-9]{40,64}$/i.test(before_sha)) throw new Error(`Invalid before_sha for ${target}.`);
  if (operation !== 'create' && !before_sha) throw new Error(`${operation} requires before_sha for ${target}.`);
  const content = operation === 'delete' ? null : String(mutation?.content ?? '');
  if (content !== null && Buffer.byteLength(content, 'utf8') > 1_000_000) throw new Error(`Mutation exceeds the 1 MB relay limit: ${target}`);
  if (content && SECRET_TEXT_RE.test(content)) {
    SECRET_TEXT_RE.lastIndex = 0;
    throw new Error(`Mutation appears to contain a credential: ${target}`);
  }
  SECRET_TEXT_RE.lastIndex = 0;
  const body = { operation, path: target, before_sha, encoding: content === null ? null : 'utf-8', content };
  return { ...body, mutation_digest: digest(body) };
}

export function buildRelayPacket({ repository, base_sha, branch, issue_number = null, owned_paths = [], mutations = [], reason = '' }) {
  const repo = normalizeRepository(repository);
  const base = normalizeBaseSha(base_sha);
  const head = normalizeBranch(branch);
  const owned = [...new Set(owned_paths.map(normalizeOwnedPath))].sort();
  if (!owned.length) throw new Error('At least one owned path is required.');
  if (!Array.isArray(mutations) || !mutations.length) throw new Error('At least one mutation is required.');
  const normalizedMutations = mutations.map(value => normalizeMutation(value, owned));
  const unsigned = {
    schema: 'sideways-github-relay/v1',
    repository: repo,
    base_sha: base,
    branch: head,
    issue_number: issue_number === null ? null : Number(issue_number),
    owned_paths: owned,
    mutations: normalizedMutations,
    reason: redact(reason),
    preconditions: {
      branch_must_not_exist: true,
      base_must_equal: base,
      force_update_forbidden: true,
      merge_forbidden: true,
      deploy_forbidden: true
    }
  };
  return { ...unsigned, packet_digest: digest(unsigned) };
}

export function verifyRelayPacket(packet) {
  if (!packet || packet.schema !== 'sideways-github-relay/v1') throw new Error('Unsupported relay packet schema.');
  const rebuilt = buildRelayPacket(packet);
  if (rebuilt.packet_digest !== packet.packet_digest) throw new Error('Relay packet digest mismatch.');
  return rebuilt;
}

function parseArgs(argv) {
  const result = { command: argv[0] || 'help' };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2).replace(/-/g, '_');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}`);
    result[key] = next;
    index += 1;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'plan') {
    const capabilities = args.capabilities_json ? JSON.parse(args.capabilities_json) : {};
    const plan = buildLinuxMigrationPlan({
      repository: args.repository,
      base_sha: args.base,
      branch: args.branch,
      issue_number: args.issue_number ?? null,
      owned_paths: clean(args.owned, 10000).split(',').filter(Boolean),
      capabilities,
      reason: args.reason || ''
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (args.command === 'verify-packet') {
    const source = args.file ? await fs.readFile(args.file, 'utf8') : await fs.readFile(0, 'utf8');
    process.stdout.write(`${JSON.stringify(verifyRelayPacket(JSON.parse(source)), null, 2)}\n`);
    return;
  }
  process.stdout.write('Usage:\n  node scripts/maker-linux-relay.mjs plan --repository owner/repo --base <40-char-sha> --branch <branch> --owned path[,path] --capabilities-json <json>\n  node scripts/maker-linux-relay.mjs verify-packet [--file packet.json]\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`maker-linux-relay: ${error.message}\n`);
    process.exitCode = 1;
  });
}
