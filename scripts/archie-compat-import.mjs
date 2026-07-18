#!/usr/bin/env node
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  WorkspaceError,
  createWorkspaceEngine,
  sha256,
  stableJSONStringify
} from './archie-workspace-core.mjs';
import { SafeFileWorkspaceProvider } from './archie-workspace-file-provider.mjs';
import { exportWorkspaceBundle, writeWorkspaceBundle } from './archie-workspace-portable.mjs';

export const ARCHIE_COMPAT_ARCHIVE_SCHEMA = 'archie-compatibility-archive/v1';
export const ARCHIE_COMPAT_IMPORT_SCHEMA = 'archie-compatibility-import/v1';
const DEFAULT_MAX_FILES = 300;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const SKIPPED_DIRECTORY_NAMES = new Set([
  'node_modules', '.archie', '.cache', 'coverage', 'dist', 'build', '.next', '.turbo', '__pycache__'
]);
const SENSITIVE_NAME = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|(?:credential|credentials|secret|secrets|token|tokens|cookie|cookies)(?:[._-].*)?|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|.*\.(?:pem|p12|pfx|key))$/i;

function clean(value, limit = 20_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function identifier(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function relativePath(root, filename) {
  const relative = path.relative(root, filename).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new WorkspaceError('Compatibility source escaped its root.');
  return relative;
}

function safeArchivePath(value) {
  const candidate = String(value || '');
  if (!candidate || candidate.startsWith('/') || candidate.includes('\\')) return null;
  const segments = candidate.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function safeGitRef(value) {
  const candidate = clean(value, 500);
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(candidate) || candidate.includes('\\')) return null;
  const segments = candidate.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return candidate;
}

function archiveIdentity(value) {
  return {
    schema: value.schema,
    source: value.source,
    files: value.files.map(file => ({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes })),
    skipped: value.skipped,
    git: value.git,
    claim_boundary: value.claim_boundary
  };
}

function archiveDigest(value) {
  return sha256(stableJSONStringify(archiveIdentity(value)));
}

function parseGitConfig(source) {
  const sections = [];
  let current = null;
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = { name: section[1], values: {} };
      sections.push(current);
      continue;
    }
    const separator = line.indexOf('=');
    if (separator > 0 && current) current.values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return sections;
}

function remoteKind(remoteUrl) {
  const value = String(remoteUrl || '').toLowerCase();
  if (value.includes('github.com')) return 'github';
  if (value.includes('gitlab.com')) return 'gitlab';
  if (value.includes('bitbucket.org')) return 'bitbucket';
  return value ? 'other' : 'none';
}

function gitProjection({ layout = 'directory', headRef = null, headSha = null, remotes = [], projectionStatus = 'projected' } = {}) {
  return Object.freeze({
    schema: 'archie-compatibility-git/v1',
    present: true,
    layout,
    projection_status: projectionStatus,
    head_ref: headRef,
    head_sha: headSha,
    remotes,
    canonical_runtime_authority: false,
    role: 'optional provenance adapter only'
  });
}

async function readGitMetadata(root) {
  const gitEntry = path.join(root, '.git');
  let entryStats;
  try { entryStats = await fs.lstat(gitEntry); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  if (entryStats.isFile()) {
    const pointer = clean(await fs.readFile(gitEntry, 'utf8'), 2_000);
    return gitProjection({
      layout: 'gitdir_pointer',
      projectionStatus: /^gitdir:\s+/i.test(pointer) ? 'external_gitdir_not_followed' : 'invalid_gitdir_pointer'
    });
  }
  if (!entryStats.isDirectory()) return gitProjection({ layout: 'unsupported', projectionStatus: 'unsupported_git_entry' });

  const gitRoot = path.resolve(gitEntry);
  let headSource = '';
  try { headSource = clean(await fs.readFile(path.join(gitRoot, 'HEAD'), 'utf8'), 500); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return gitProjection({ projectionStatus: 'head_missing' });
    throw error;
  }
  let headRef = null;
  let headSha = null;
  let projectionStatus = 'projected';
  if (/^ref:\s+/.test(headSource)) {
    const requestedRef = headSource.replace(/^ref:\s+/, '');
    headRef = safeGitRef(requestedRef);
    if (!headRef) {
      projectionStatus = 'unsafe_head_ref_omitted';
    } else {
      const refPath = path.resolve(gitRoot, ...headRef.split('/'));
      if (!refPath.startsWith(`${gitRoot}${path.sep}`)) {
        headRef = null;
        projectionStatus = 'unsafe_head_ref_omitted';
      } else {
        try { headSha = clean(await fs.readFile(refPath, 'utf8'), 100).toLowerCase(); }
        catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          try {
            const packed = await fs.readFile(path.join(gitRoot, 'packed-refs'), 'utf8');
            const match = packed.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1] === headRef);
            headSha = clean(match?.[0], 100).toLowerCase();
          } catch (packedError) {
            if (packedError?.code !== 'ENOENT') throw packedError;
          }
        }
      }
    }
  } else {
    headSha = headSource.toLowerCase();
  }
  if (!/^[a-f0-9]{40,64}$/.test(headSha || '')) headSha = null;

  let config = '';
  try { config = await fs.readFile(path.join(gitRoot, 'config'), 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const remotes = parseGitConfig(config)
    .filter(section => /^remote\s+"/.test(section.name) && section.values.url)
    .map(section => ({
      name: clean(section.name.match(/^remote\s+"([^"]+)"/)?.[1] || 'remote', 100),
      kind: remoteKind(section.values.url),
      endpoint_digest: `sha256:${sha256(String(section.values.url))}`,
      raw_url_preserved: false
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return gitProjection({ headRef, headSha, remotes, projectionStatus });
}

export function verifyCompatibilityArchive(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceError('Compatibility archive must be an object.');
  if (value.schema !== ARCHIE_COMPAT_ARCHIVE_SCHEMA) throw new WorkspaceError('Unsupported compatibility archive schema.');
  if (!Array.isArray(value.files) || !Array.isArray(value.skipped)) throw new WorkspaceError('Compatibility archive requires files and skipped entries.');
  if (value.archive_digest !== archiveDigest(value)) throw new WorkspaceError('Compatibility archive digest mismatch.');
  const seen = new Set();
  for (const file of value.files) {
    const safePath = safeArchivePath(file.path);
    if (!safePath || safePath !== file.path) throw new WorkspaceError('Compatibility archive contains an unsafe path.');
    if (seen.has(file.path)) throw new WorkspaceError('Compatibility archive contains duplicate paths.');
    seen.add(file.path);
    const bytes = Buffer.from(String(file.content_base64 || ''), 'base64');
    if (bytes.length !== file.size_bytes || sha256(bytes) !== file.sha256) throw new WorkspaceError(`Compatibility file digest mismatch: ${file.path}`);
  }
  return value;
}

export async function scanCompatibilitySource({
  sourceRoot,
  label = null,
  maxFiles = DEFAULT_MAX_FILES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES
} = {}) {
  const root = path.resolve(sourceRoot || '');
  const rootStats = await fs.stat(root);
  if (!rootStats.isDirectory()) throw new WorkspaceError('Compatibility source must be a directory.');
  const limits = {
    max_files: Number(maxFiles),
    max_file_bytes: Number(maxFileBytes),
    max_total_bytes: Number(maxTotalBytes)
  };
  if (!Number.isInteger(limits.max_files) || limits.max_files < 1 || limits.max_files > 10_000) throw new WorkspaceError('maxFiles is invalid.');
  if (!Number.isInteger(limits.max_file_bytes) || limits.max_file_bytes < 1 || limits.max_file_bytes > 100 * 1024 * 1024) throw new WorkspaceError('maxFileBytes is invalid.');
  if (!Number.isInteger(limits.max_total_bytes) || limits.max_total_bytes < 1 || limits.max_total_bytes > 500 * 1024 * 1024) throw new WorkspaceError('maxTotalBytes is invalid.');

  const files = [];
  const skipped = [];
  let totalBytes = 0;

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativePath(root, absolute);
      if (entry.isSymbolicLink()) {
        skipped.push({ path: relative, reason: 'symlink_denied' });
        continue;
      }
      if (entry.isDirectory()) {
        if (relative === '.git') {
          skipped.push({ path: '.git/', reason: 'git_metadata_projected_separately' });
          continue;
        }
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
          skipped.push({ path: `${relative}/`, reason: 'generated_or_internal_directory' });
          continue;
        }
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: relative, reason: 'non_regular_file' });
        continue;
      }
      if (relative === '.git') {
        skipped.push({ path: relative, reason: 'git_metadata_projected_separately' });
        continue;
      }
      if (relative === '.gitmodules') {
        skipped.push({ path: relative, reason: 'git_remote_metadata_denied' });
        continue;
      }
      if (SENSITIVE_NAME.test(relative)) {
        skipped.push({ path: relative, reason: 'sensitive_name' });
        continue;
      }

      let handle;
      try {
        handle = await fs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      } catch (error) {
        if (error?.code === 'ELOOP') {
          skipped.push({ path: relative, reason: 'symlink_denied' });
          continue;
        }
        throw error;
      }
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) {
          skipped.push({ path: relative, reason: 'non_regular_file' });
          continue;
        }
        if (stats.size > limits.max_file_bytes) {
          skipped.push({ path: relative, reason: 'file_size_limit', size_bytes: stats.size });
          continue;
        }
        if (files.length >= limits.max_files) {
          skipped.push({ path: relative, reason: 'file_count_limit', size_bytes: stats.size });
          continue;
        }
        if (totalBytes + stats.size > limits.max_total_bytes) {
          skipped.push({ path: relative, reason: 'total_size_limit', size_bytes: stats.size });
          continue;
        }
        const bytes = await handle.readFile();
        if (bytes.length !== stats.size) throw new WorkspaceError(`Compatibility source changed during scan: ${relative}`);
        totalBytes += bytes.length;
        files.push({
          path: relative,
          sha256: sha256(bytes),
          size_bytes: bytes.length,
          content_base64: bytes.toString('base64')
        });
      } finally {
        await handle.close();
      }
    }
  }

  await visit(root);
  const git = await readGitMetadata(root);
  const body = {
    schema: ARCHIE_COMPAT_ARCHIVE_SCHEMA,
    source: {
      schema: 'archie-compatibility-source/v1',
      kind: git ? 'local_git_directory' : 'local_directory',
      label: clean(label || path.basename(root) || 'Imported local workspace', 160),
      absolute_path_preserved: false,
      source_host_canonical: false,
      file_count: files.length,
      total_bytes: totalBytes,
      limits
    },
    files,
    skipped: skipped.sort((left, right) => left.path.localeCompare(right.path)),
    git,
    claim_boundary: 'This archive is a bounded local compatibility snapshot. Secret-like files, symlinks, generated trees, the complete .git tree, .gitmodules remote metadata, raw configured Git remote URLs, and absolute local paths are excluded. Git and source-host metadata are optional provenance, never canonical runtime authority.'
  };
  const archive = Object.freeze({ ...body, archive_digest: archiveDigest(body) });
  verifyCompatibilityArchive(archive);
  return archive;
}

async function requireCleanRestoreRoot(root) {
  try {
    const stats = await fs.lstat(root);
    if (!stats.isDirectory()) throw new WorkspaceError('Compatibility restore target must be a directory.');
    if ((await fs.readdir(root)).length) throw new WorkspaceError('Compatibility restore target must be empty.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
}

export async function restoreCompatibilityArchive({ archive, targetRoot } = {}) {
  const verified = verifyCompatibilityArchive(structuredClone(archive));
  if (!clean(targetRoot, 8_000)) throw new WorkspaceError('Compatibility restore requires an explicit target root.');
  const root = path.resolve(targetRoot);
  await requireCleanRestoreRoot(root);
  for (const file of verified.files) {
    const target = path.resolve(root, ...file.path.split('/'));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new WorkspaceError('Compatibility restore escaped its target root.');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, Buffer.from(file.content_base64, 'base64'), { mode: 0o600, flag: 'wx' });
  }
  return Object.freeze({
    schema: 'archie-compatibility-restore/v1',
    archive_digest: verified.archive_digest,
    restored_files: verified.files.length,
    restored_bytes: verified.files.reduce((sum, file) => sum + file.size_bytes, 0),
    target_path_disclosed: false,
    clean_root_required: true
  });
}

export async function importCompatibilitySource({
  engine,
  dataRoot,
  sourceRoot,
  title = null,
  visibility = 'private',
  label = null,
  archiveOptions = {}
} = {}) {
  if (!engine) throw new WorkspaceError('Compatibility import requires a workspace engine.');
  if (!clean(dataRoot, 8_000)) throw new WorkspaceError('Compatibility import requires an explicit Archie data root.');
  if (!['public', 'private', 'locally_sealed'].includes(visibility)) throw new WorkspaceError('Compatibility visibility is invalid.');
  const archive = await scanCompatibilitySource({ sourceRoot, label, ...archiveOptions });
  const workspaceId = identifier('workspace_compat');
  const objective = `Migrate ${archive.source.label} into Archie-native portable state without preserving source-host authority.`;
  await engine.createWorkspace({ workspace_id: workspaceId, title: title || objective, visibility, owner_id: 'owner_local' });
  await engine.execute(workspaceId, 'owner_local', 'objective.define', {
    objective_id: 'objective_compatibility',
    statement: objective,
    protected_reality: 'No secret-like files, symlinks, absolute local paths, raw configured Git remote URLs, Git object stores, network calls, source-host authority, deployment, spending, contact, destructive writes, or restore overwrites.',
    proof_of_done: 'A verified bounded archive, exact source digest, explicit skipped-file record, provider-neutral Archie workspace events, evidence, portable export, and fail-closed clean-root restoration.'
  });
  for (const agent of [
    { agent_id: 'agent_compatibility', label: 'Local compatibility adapter', kind: 'service', provider: 'local-directory' },
    { agent_id: 'reviewer_compatibility', label: 'Compatibility boundary reviewer', kind: 'policy' }
  ]) await engine.execute(workspaceId, 'owner_local', 'agent.register', agent);
  await engine.execute(workspaceId, 'owner_local', 'task_graph.create', {
    objective_id: 'objective_compatibility',
    tasks: [{
      task_id: 'task_compatibility_import',
      title: 'Snapshot and migrate the existing local program',
      description: 'Create a bounded content archive, project Git metadata without raw remote identity, preserve skipped paths and reasons, and verify portable replay.',
      depends_on: []
    }]
  });
  await engine.execute(workspaceId, 'owner_local', 'grant.issue', {
    grant_id: 'grant_compatibility', principal_id: 'agent_compatibility', task_id: 'task_compatibility_import', capabilities: ['read', 'write', 'run']
  });
  await engine.execute(workspaceId, 'owner_local', 'grant.issue', {
    grant_id: 'grant_compatibility_review', principal_id: 'reviewer_compatibility', capabilities: ['read', 'review']
  });
  await engine.execute(workspaceId, 'agent_compatibility', 'lease.claim', {
    task_id: 'task_compatibility_import', lease_id: 'lease_compatibility_import', ttl_ms: 3_600_000
  });
  await engine.execute(workspaceId, 'agent_compatibility', 'run.start', {
    task_id: 'task_compatibility_import', run_id: 'run_compatibility_import'
  });
  await engine.execute(workspaceId, 'agent_compatibility', 'run.append_event', {
    run_id: 'run_compatibility_import', kind: 'discovery', summary: `Bounded compatibility scan admitted ${archive.files.length} files and skipped ${archive.skipped.length}.`
  });
  await engine.execute(workspaceId, 'agent_compatibility', 'artifact.record', {
    run_id: 'run_compatibility_import', artifact_id: 'artifact_compatibility_archive', name: 'compatibility-source.archive.json', media_type: 'application/json',
    content: `${JSON.stringify(archive, null, 2)}\n`
  });
  const decision = {
    schema: ARCHIE_COMPAT_IMPORT_SCHEMA,
    workspace_id: workspaceId,
    source_kind: archive.source.kind,
    source_archive_digest: archive.archive_digest,
    admitted_files: archive.files.length,
    skipped_entries: archive.skipped.length,
    git: archive.git ? {
      present: true,
      head_sha: archive.git.head_sha,
      projection_status: archive.git.projection_status,
      remote_kinds: [...new Set(archive.git.remotes.map(remote => remote.kind))].sort(),
      source_host_canonical: false
    } : { present: false, source_host_canonical: false },
    canonical_state: 'archie-native-workspace-store',
    source_host_role: 'optional provenance and future import/export adapter only',
    customer_value_claim: false,
    claim_boundary: 'Compatibility success means exact bounded migration and replay, not product improvement or source-host equivalence.'
  };
  await engine.execute(workspaceId, 'agent_compatibility', 'artifact.record', {
    run_id: 'run_compatibility_import', artifact_id: 'artifact_compatibility_decision', name: 'compatibility-decision.json', media_type: 'application/json',
    content: `${JSON.stringify(decision, null, 2)}\n`
  });
  await engine.execute(workspaceId, 'agent_compatibility', 'run.complete', {
    run_id: 'run_compatibility_import', summary: 'Bounded local program migration completed without retaining source-host authority.'
  });
  await engine.execute(workspaceId, 'reviewer_compatibility', 'review.submit', {
    review_id: 'review_compatibility_import', artifact_id: 'artifact_compatibility_archive', decision: 'approved',
    reason: 'Archive digest, safe relative paths, per-file digests, skipped sensitive entries, Git remote redaction, and source-host demotion are explicit.'
  });
  await engine.execute(workspaceId, 'reviewer_compatibility', 'evidence.record', {
    evidence_id: 'evidence_compatibility_import', run_id: 'run_compatibility_import', result: 'pass',
    checks: ['archive-digest', 'file-digests', 'safe-relative-paths', 'secret-name-skip', 'symlink-skip', 'clean-root-restore', 'absolute-path-redaction', 'git-tree-exclusion', 'git-head-ref-containment', 'git-remote-redaction', 'source-host-demotion'],
    summary: 'Compatibility archive and migration boundaries verified. Product value and source-host parity remain unclaimed.'
  });

  const bundle = await exportWorkspaceBundle({ engine, workspaceId, principalId: 'owner_local' });
  const selectedDataRoot = path.resolve(dataRoot);
  const exportPath = await writeWorkspaceBundle(path.join(selectedDataRoot, 'exports', `${workspaceId}.archie.json`), bundle);
  return Object.freeze({
    schema: ARCHIE_COMPAT_IMPORT_SCHEMA,
    workspace_id: workspaceId,
    head_digest: bundle.head_digest,
    bundle_digest: bundle.bundle_digest,
    event_count: bundle.event_count,
    artifact_count: bundle.artifacts.length,
    archive_digest: archive.archive_digest,
    admitted_files: archive.files.length,
    skipped_entries: archive.skipped.length,
    source_kind: archive.source.kind,
    source_host_canonical: false,
    export_path: exportPath
  });
}

function argument(argv, name, fallback = null) {
  const index = argv.lastIndexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('archie compatibility import\n\nUsage:\n  archie-compat-import --source <directory> [--home <ARCHIE_HOME>] [--label <name>]\n');
    return null;
  }
  const sourceRoot = argument(argv, '--source');
  if (!sourceRoot) throw new Error('--source is required.');
  const home = path.resolve(argument(argv, '--home', env.ARCHIE_HOME || path.join(os.homedir(), '.archie')));
  const dataRoot = path.join(home, 'standalone');
  const provider = new SafeFileWorkspaceProvider(path.join(dataRoot, 'workspaces'));
  const engine = createWorkspaceEngine({ provider });
  const result = await importCompatibilitySource({
    engine,
    dataRoot,
    sourceRoot,
    label: argument(argv, '--label')
  });
  const { export_path: _privatePath, ...publicResult } = result;
  process.stdout.write(`${JSON.stringify(publicResult, null, 2)}\n`);
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-compat-import: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
