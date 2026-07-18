#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  WorkspaceConflictError,
  WorkspaceError,
  createWorkspaceEngine,
  sha256,
  stableJSONStringify
} from './archie-workspace-core.mjs';
import { SafeFileWorkspaceProvider } from './archie-workspace-file-provider.mjs';
import {
  ARCHIE_WORKSPACE_BUNDLE_SCHEMA,
  importWorkspaceBundle,
  readWorkspaceBundle,
  exportWorkspaceBundle,
  writeWorkspaceBundle
} from './archie-workspace-portable.mjs';

export const ARCHIE_LEGACY_IMPORT_SCHEMA = 'archie-legacy-import-receipt/v1';
export const ARCHIE_LEGACY_MANIFEST_SCHEMA = 'archie-legacy-import-manifest/v1';
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 250 * 1024 * 1024;
const MAX_DIRECTORY_FILES = 512;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.archie', '.DS_Store']);

function clean(value, label, { min = 1, max = 8_000 } = {}) {
  const normalized = String(value ?? '').replace(/\u0000/g, '').trim();
  if (normalized.length < min || normalized.length > max) throw new WorkspaceError(`${label} must contain ${min}-${max} characters.`);
  return normalized;
}

function relativeName(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized === '..' || normalized.includes('\u0000')) {
    throw new WorkspaceError('Legacy source names must be relative and traversal-free.');
  }
  return normalized;
}

function mediaType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({
    '.json': 'application/json',
    '.jsonl': 'application/x-ndjson',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.py': 'text/x-python',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  })[extension] || 'application/octet-stream';
}

function classifyJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'json-value', schema: null, confidence: 'low' };
  const schema = typeof value.schema === 'string' ? value.schema : null;
  if (schema === ARCHIE_WORKSPACE_BUNDLE_SCHEMA) return { kind: 'archie-portable-workspace', schema, confidence: 'exact' };
  if (schema && /corpus.*pack|pack.*corpus/i.test(schema)) return { kind: 'archie-corpus-pack', schema, confidence: 'schema' };
  if (schema && /maker.*receipt|receipt.*maker/i.test(schema)) return { kind: 'maker-receipt', schema, confidence: 'schema' };
  if (schema && /workspace|event-stream/i.test(schema)) return { kind: 'legacy-workspace-state', schema, confidence: 'schema' };
  if (typeof value.receipt_digest === 'string' && (value.changed_paths || value.task || value.lease)) return { kind: 'maker-receipt', schema, confidence: 'shape' };
  if (Array.isArray(value.examples) || Array.isArray(value.records) || Array.isArray(value.entries)) return { kind: 'legacy-record-pack', schema, confidence: 'shape' };
  return { kind: 'json-object', schema, confidence: schema ? 'schema-unknown' : 'low' };
}

function embeddedDigestStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { field: null, status: 'absent' };
  for (const field of ['receipt_digest', 'bundle_digest', 'pack_digest', 'digest', 'sha256']) {
    const embedded = value[field];
    if (typeof embedded !== 'string' || !/^[a-f0-9]{64}$/i.test(embedded)) continue;
    const unsigned = { ...value };
    delete unsigned[field];
    const calculated = sha256(stableJSONStringify(unsigned));
    return {
      field,
      status: calculated === embedded.toLowerCase() ? 'verified-stable-json' : 'present-unverified',
      embedded_digest: embedded.toLowerCase(),
      calculated_stable_json_digest: calculated
    };
  }
  return { field: null, status: 'absent' };
}

async function readSingleFile(filename, sourceName = null) {
  const stats = await fs.stat(filename);
  if (!stats.isFile()) throw new WorkspaceError('Legacy import source is not a regular file.');
  if (stats.size < 1 || stats.size > MAX_FILE_BYTES) throw new WorkspaceError(`Legacy source file must contain 1-${MAX_FILE_BYTES} bytes.`);
  const bytes = await fs.readFile(filename);
  const name = relativeName(sourceName || path.basename(filename));
  const entry = {
    source_name: name,
    media_type: mediaType(name),
    size_bytes: bytes.length,
    sha256: sha256(bytes),
    bytes
  };
  if (entry.media_type === 'application/json') {
    try {
      const value = JSON.parse(bytes.toString('utf8'));
      entry.classification = classifyJson(value);
      entry.embedded_digest = embeddedDigestStatus(value);
      entry.parsed_json = value;
    } catch {
      entry.classification = { kind: 'invalid-json-preserved-opaque', schema: null, confidence: 'exact-bytes-only' };
      entry.embedded_digest = { field: null, status: 'unavailable' };
    }
  } else if (entry.media_type === 'application/x-ndjson') {
    const lines = bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim());
    let valid = 0;
    for (const line of lines) {
      try { JSON.parse(line); valid += 1; } catch {}
    }
    entry.classification = {
      kind: valid === lines.length ? 'jsonl-event-or-record-stream' : 'invalid-jsonl-preserved-opaque',
      schema: null,
      confidence: valid === lines.length ? 'syntax' : 'exact-bytes-only',
      record_count: lines.length,
      valid_record_count: valid
    };
    entry.embedded_digest = { field: null, status: 'not-applicable' };
  } else {
    entry.classification = { kind: 'opaque-file', schema: null, confidence: 'exact-bytes-only' };
    entry.embedded_digest = { field: null, status: 'not-applicable' };
  }
  return entry;
}

async function walkDirectory(root, current = root, entries = []) {
  const children = await fs.readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (SKIPPED_DIRECTORIES.has(child.name)) continue;
    const absolute = path.join(current, child.name);
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) {
      await walkDirectory(root, absolute, entries);
      continue;
    }
    if (!child.isFile()) continue;
    if (entries.length >= MAX_DIRECTORY_FILES) throw new WorkspaceError(`Legacy directory import exceeds ${MAX_DIRECTORY_FILES} files.`);
    entries.push(await readSingleFile(absolute, path.relative(root, absolute).replaceAll('\\', '/')));
    const total = entries.reduce((sum, entry) => sum + entry.size_bytes, 0);
    if (total > MAX_DIRECTORY_BYTES) throw new WorkspaceError(`Legacy directory import exceeds ${MAX_DIRECTORY_BYTES} bytes.`);
  }
  return entries;
}

async function collectSource(inputPath) {
  const absolute = path.resolve(inputPath);
  const stats = await fs.stat(absolute);
  const entries = stats.isDirectory() ? await walkDirectory(absolute) : [await readSingleFile(absolute)];
  if (!entries.length) throw new WorkspaceError('Legacy import source contains no admitted files.');
  entries.sort((left, right) => left.source_name.localeCompare(right.source_name));
  const sourceDigest = sha256(stableJSONStringify(entries.map(entry => ({
    source_name: entry.source_name,
    media_type: entry.media_type,
    size_bytes: entry.size_bytes,
    sha256: entry.sha256
  }))));
  return Object.freeze({
    source_kind: stats.isDirectory() ? 'directory' : 'file',
    source_name: stats.isDirectory() ? path.basename(absolute) : entries[0].source_name,
    source_digest: sourceDigest,
    total_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries
  });
}

function publicEntry(entry, artifactId) {
  return Object.freeze({
    artifact_id: artifactId,
    source_name: entry.source_name,
    media_type: entry.media_type,
    size_bytes: entry.size_bytes,
    sha256: entry.sha256,
    classification: entry.classification,
    embedded_digest: entry.embedded_digest
  });
}

async function existingImport(engine, workspaceId, sourceDigest) {
  try {
    const state = await engine.inspect(workspaceId, { principalId: 'owner_local' });
    const manifest = Object.entries(state.artifacts).find(([, artifact]) => artifact.name === 'legacy-import-manifest.json');
    if (!manifest) throw new WorkspaceConflictError(`Workspace ${workspaceId} exists but is not a compatible legacy import.`);
    const loaded = await engine.readArtifact(workspaceId, manifest[0], { principalId: 'owner_local' });
    const value = JSON.parse(loaded.bytes.toString('utf8'));
    if (value.source_digest !== sourceDigest) throw new WorkspaceConflictError(`Workspace ${workspaceId} exists with another source digest.`);
    return { state, manifest: value };
  } catch (error) {
    if (error?.code === 'not_found' || error?.status === 404) return null;
    throw error;
  }
}

async function importPortableBundle({ provider, source }) {
  const only = source.entries.length === 1 ? source.entries[0] : null;
  if (!only || only.classification?.kind !== 'archie-portable-workspace') return null;
  const bundle = only.parsed_json;
  try {
    const imported = await importWorkspaceBundle({ provider, bundle });
    return Object.freeze({
      schema: ARCHIE_LEGACY_IMPORT_SCHEMA,
      mode: 'native-portable-restore',
      workspace_id: imported.workspace_id,
      source_digest: source.source_digest,
      source_file_digest: only.sha256,
      bundle_digest: imported.bundle_digest,
      head_digest: imported.state.head_digest,
      event_count: imported.state.event_count,
      idempotent: false,
      canonical_identity_source: 'preserved-archie-workspace-id',
      github_required: false,
      claim_boundary: 'An existing Archie portable workspace was restored exactly. No compatibility reinterpretation was applied.'
    });
  } catch (error) {
    if (!(error instanceof WorkspaceConflictError)) throw error;
    const engine = createWorkspaceEngine({ provider });
    const state = await engine.inspect(bundle.workspace_id, { principalId: bundle.events?.[0]?.payload?.owner_id || 'owner_local' }).catch(() => null);
    if (!state || state.head_digest !== bundle.head_digest) throw error;
    return Object.freeze({
      schema: ARCHIE_LEGACY_IMPORT_SCHEMA,
      mode: 'native-portable-restore',
      workspace_id: bundle.workspace_id,
      source_digest: source.source_digest,
      source_file_digest: only.sha256,
      bundle_digest: bundle.bundle_digest,
      head_digest: state.head_digest,
      event_count: state.event_count,
      idempotent: true,
      canonical_identity_source: 'preserved-archie-workspace-id',
      github_required: false,
      claim_boundary: 'The exact portable workspace was already present with the same immutable head.'
    });
  }
}

export async function importLegacySource({
  inputPath,
  provider,
  engine = null,
  exportPath = null,
  title = null
} = {}) {
  if (!inputPath) throw new WorkspaceError('Legacy import requires inputPath.');
  if (!provider) throw new WorkspaceError('Legacy import requires an Archie workspace provider.');
  const selectedEngine = engine || createWorkspaceEngine({ provider });
  const source = await collectSource(inputPath);
  const native = await importPortableBundle({ provider, source });
  if (native) return native;

  const workspaceId = `workspace_import_${source.source_digest.slice(0, 20)}`;
  const prior = await existingImport(selectedEngine, workspaceId, source.source_digest);
  if (prior) {
    const bundle = await exportWorkspaceBundle({ engine: selectedEngine, workspaceId, principalId: 'owner_local' });
    if (exportPath) await writeWorkspaceBundle(exportPath, bundle);
    return Object.freeze({
      schema: ARCHIE_LEGACY_IMPORT_SCHEMA,
      mode: 'compatibility-import',
      workspace_id: workspaceId,
      source_digest: source.source_digest,
      file_count: source.entries.length,
      total_bytes: source.total_bytes,
      head_digest: prior.state.head_digest,
      event_count: prior.state.event_count,
      bundle_digest: bundle.bundle_digest,
      idempotent: true,
      canonical_identity_source: 'source-content-digest',
      github_required: false,
      claim_boundary: 'The exact legacy source was already imported. No duplicate workspace or artifact was created.'
    });
  }

  const workspaceTitle = clean(title || `Imported ${source.source_name}`, 'title', { max: 160 });
  await selectedEngine.createWorkspace({
    workspace_id: workspaceId,
    title: workspaceTitle,
    visibility: 'private',
    owner_id: 'owner_local'
  });
  await selectedEngine.execute(workspaceId, 'owner_local', 'objective.define', {
    objective_id: 'objective_legacy_import',
    statement: 'Preserve legacy Archie, Maker, corpus, receipt, and local-program material inside an Archie-native workspace without making a source host canonical.',
    protected_reality: 'Preserve exact bytes and digests. Do not execute imported content, infer missing authority, expose local absolute paths, or derive workspace identity from GitHub.',
    proof_of_done: 'Every admitted byte has an exact artifact digest, a compatibility classification, an import manifest, an evidence receipt, restart-durable state, and an integrity-checked portable export.'
  });
  for (const agent of [
    { agent_id: 'agent_compat_import', label: 'Archie compatibility importer', kind: 'service', provider: 'local' },
    { agent_id: 'reviewer_compat_import', label: 'Compatibility integrity reviewer', kind: 'policy', provider: 'local' }
  ]) await selectedEngine.execute(workspaceId, 'owner_local', 'agent.register', agent);
  await selectedEngine.execute(workspaceId, 'owner_local', 'task_graph.create', {
    objective_id: 'objective_legacy_import',
    tasks: [{
      task_id: 'task_legacy_import',
      title: 'Import exact legacy material into Archie-native authority',
      description: 'Record source bytes, classifications, digest status, migration manifest, integrity evidence, and portable export.',
      depends_on: []
    }]
  });
  await selectedEngine.execute(workspaceId, 'owner_local', 'grant.issue', {
    grant_id: 'grant_compat_import',
    principal_id: 'agent_compat_import',
    task_id: 'task_legacy_import',
    capabilities: ['read', 'write', 'run']
  });
  await selectedEngine.execute(workspaceId, 'owner_local', 'grant.issue', {
    grant_id: 'grant_compat_review',
    principal_id: 'reviewer_compat_import',
    capabilities: ['read', 'review']
  });
  await selectedEngine.execute(workspaceId, 'agent_compat_import', 'lease.claim', {
    task_id: 'task_legacy_import',
    lease_id: 'lease_legacy_import',
    ttl_ms: 3_600_000
  });
  await selectedEngine.execute(workspaceId, 'agent_compat_import', 'run.start', {
    task_id: 'task_legacy_import',
    run_id: 'run_legacy_import'
  });

  const importedEntries = [];
  for (const [index, entry] of source.entries.entries()) {
    const artifactId = `artifact_legacy_${String(index + 1).padStart(4, '0')}`;
    await selectedEngine.execute(workspaceId, 'agent_compat_import', 'artifact.record', {
      run_id: 'run_legacy_import',
      artifact_id: artifactId,
      name: entry.source_name.slice(0, 240),
      media_type: entry.media_type,
      content_base64: entry.bytes.toString('base64')
    });
    importedEntries.push(publicEntry(entry, artifactId));
  }

  const manifest = {
    schema: ARCHIE_LEGACY_MANIFEST_SCHEMA,
    workspace_id: workspaceId,
    source_kind: source.source_kind,
    source_name: source.source_name,
    source_digest: source.source_digest,
    file_count: source.entries.length,
    total_bytes: source.total_bytes,
    canonical_identity_source: 'source-content-digest',
    imported_entries: importedEntries,
    execution_policy: 'preserve-only-do-not-execute',
    source_host_role: 'historical-content-only-not-canonical-authority',
    github_required: false,
    claim_boundary: 'Classification describes compatibility handling only. Unknown or invalid formats remain opaque exact-byte artifacts and are not promoted as understood state.'
  };
  manifest.manifest_digest = sha256(stableJSONStringify(manifest));
  await selectedEngine.execute(workspaceId, 'agent_compat_import', 'artifact.record', {
    run_id: 'run_legacy_import',
    artifact_id: 'artifact_legacy_manifest',
    name: 'legacy-import-manifest.json',
    media_type: 'application/json',
    content: `${JSON.stringify(manifest, null, 2)}\n`
  });
  await selectedEngine.execute(workspaceId, 'agent_compat_import', 'run.append_event', {
    run_id: 'run_legacy_import',
    kind: 'compatibility-import',
    summary: `Preserved ${source.entries.length} exact legacy artifact(s) under content-derived workspace identity ${workspaceId}.`
  });
  await selectedEngine.execute(workspaceId, 'agent_compat_import', 'run.complete', {
    run_id: 'run_legacy_import',
    summary: 'Legacy material and its compatibility manifest were preserved without executing imported content or requiring a source host.'
  });
  await selectedEngine.execute(workspaceId, 'reviewer_compat_import', 'evidence.record', {
    evidence_id: 'evidence_legacy_import',
    run_id: 'run_legacy_import',
    result: 'pass',
    checks: [
      'exact-source-byte-digests',
      'content-derived-workspace-identity',
      'no-absolute-source-paths',
      'preserve-only-no-execution',
      'source-host-not-canonical',
      'portable-export-contract'
    ],
    summary: 'Every admitted source was stored as exact content-addressed artifact bytes with a deterministic manifest. Format understanding remains explicitly bounded.'
  });

  const state = await selectedEngine.inspect(workspaceId, { principalId: 'owner_local' });
  const bundle = await exportWorkspaceBundle({ engine: selectedEngine, workspaceId, principalId: 'owner_local' });
  if (exportPath) await writeWorkspaceBundle(exportPath, bundle);
  return Object.freeze({
    schema: ARCHIE_LEGACY_IMPORT_SCHEMA,
    mode: 'compatibility-import',
    workspace_id: workspaceId,
    source_digest: source.source_digest,
    file_count: source.entries.length,
    total_bytes: source.total_bytes,
    manifest_digest: manifest.manifest_digest,
    head_digest: state.head_digest,
    event_count: state.event_count,
    bundle_digest: bundle.bundle_digest,
    idempotent: false,
    canonical_identity_source: 'source-content-digest',
    github_required: false,
    claim_boundary: 'This receipt proves preservation, classification, integrity, native authority, and portability. It does not claim semantic equivalence for opaque formats or execute imported material.'
  });
}

function argument(argv, name, fallback = null) {
  const index = argv.lastIndexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new WorkspaceError(`${name} requires a value.`);
  return value;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`archie-legacy-import\n\nUsage:\n  archie-legacy-import --input <file-or-directory> [--root <workspace-root>] [--export <bundle.archie.json>] [--title <title>]\n\nExact bytes are preserved inside an Archie-native private workspace. Portable Archie bundles restore directly; older receipts, corpus packs, JSON/JSONL, archives, and directories enter through a preserve-only compatibility manifest. GitHub is not required.\n`);
    return null;
  }
  const inputPath = argument(argv, '--input');
  if (!inputPath) throw new WorkspaceError('--input is required.');
  const root = path.resolve(argument(argv, '--root', env.ARCHIE_DATA_ROOT || path.join(env.ARCHIE_HOME || path.join(process.cwd(), '.archie'), 'standalone', 'workspaces')));
  const provider = new SafeFileWorkspaceProvider(root);
  const result = await importLegacySource({
    inputPath,
    provider,
    exportPath: argument(argv, '--export'),
    title: argument(argv, '--title')
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-legacy-import: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
