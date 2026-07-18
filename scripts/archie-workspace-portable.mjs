import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WorkspaceConflictError,
  WorkspaceError,
  reduceWorkspaceEvents,
  sha256,
  stableJSONStringify,
  verifyWorkspaceEventStream
} from './archie-workspace-core.mjs';

export const ARCHIE_WORKSPACE_BUNDLE_SCHEMA = 'archie-portable-workspace-bundle/v1';

function bundleIdentity(value) {
  return {
    schema: value.schema,
    workspace_id: value.workspace_id,
    event_count: value.event_count,
    head_digest: value.head_digest,
    artifacts: [...(value.artifacts || [])]
      .map(entry => ({
        artifact_id: entry.artifact_id,
        sha256: entry.sha256,
        size_bytes: entry.size_bytes,
        media_type: entry.media_type,
        name: entry.name
      }))
      .sort((left, right) => String(left.artifact_id).localeCompare(String(right.artifact_id))),
    claim_boundary: value.claim_boundary
  };
}

function bundleDigest(value) {
  return sha256(stableJSONStringify(bundleIdentity(value)));
}

function assertBundle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceError('Portable workspace bundle must be an object.');
  if (value.schema !== ARCHIE_WORKSPACE_BUNDLE_SCHEMA) throw new WorkspaceError('Unsupported portable workspace bundle schema.');
  if (value.bundle_digest !== bundleDigest(value)) throw new WorkspaceError('Portable workspace bundle digest mismatch.');
  if (!Array.isArray(value.events) || !Array.isArray(value.artifacts)) throw new WorkspaceError('Portable workspace bundle requires events and artifacts.');
  const verified = verifyWorkspaceEventStream(value.events, value.workspace_id);
  if (verified.count !== value.event_count) throw new WorkspaceError('Portable workspace bundle event count mismatch.');
  if (verified.head_digest !== value.head_digest) throw new WorkspaceError('Portable workspace bundle head digest mismatch.');
  for (const entry of value.artifacts) {
    const bytes = Buffer.from(String(entry.content_base64 || ''), 'base64');
    if (!entry.sha256 || sha256(bytes) !== entry.sha256) throw new WorkspaceError(`Portable artifact digest mismatch: ${entry.artifact_id || 'unknown'}.`);
    if (bytes.length !== entry.size_bytes) throw new WorkspaceError(`Portable artifact size mismatch: ${entry.artifact_id || 'unknown'}.`);
  }
  return value;
}

export async function exportWorkspaceBundle({ engine, workspaceId, principalId, exportedAt = null }) {
  if (!engine) throw new WorkspaceError('Workspace engine is required for export.');
  const state = await engine.inspect(workspaceId, { principalId });
  const events = await engine.events(workspaceId, { principalId });
  if (!events.length) throw new WorkspaceError('Portable export requires a nonempty workspace event stream.');
  const snapshotAt = new Date(exportedAt || events.at(-1).occurred_at).toISOString();
  const artifacts = [];
  for (const artifactId of Object.keys(state.artifacts).sort()) {
    const result = await engine.readArtifact(workspaceId, artifactId, { principalId });
    artifacts.push({
      artifact_id: artifactId,
      sha256: result.artifact.sha256,
      size_bytes: result.bytes.length,
      media_type: result.artifact.media_type,
      name: result.artifact.name,
      content_base64: result.bytes.toString('base64')
    });
  }
  const body = {
    schema: ARCHIE_WORKSPACE_BUNDLE_SCHEMA,
    workspace_id: workspaceId,
    exported_at: snapshotAt,
    event_count: events.length,
    head_digest: state.head_digest,
    events,
    artifacts,
    claim_boundary: 'This bundle preserves exact Archie-native events and admitted artifact bytes. Its default identity is stable for one immutable event head. Import verifies every digest before mutation and does not grant external authority.'
  };
  return Object.freeze({ ...body, bundle_digest: bundleDigest(body) });
}

export function verifyWorkspaceBundle(bundle) {
  return assertBundle(structuredClone(bundle));
}

export async function importWorkspaceBundle({ provider, bundle }) {
  if (!provider || typeof provider.readEvents !== 'function' || typeof provider.appendEvent !== 'function') {
    throw new WorkspaceError('A provider-neutral workspace adapter is required for import.');
  }
  const verified = assertBundle(structuredClone(bundle));
  const existing = await provider.readEvents(verified.workspace_id);
  if (existing.length) throw new WorkspaceConflictError(`Workspace ${verified.workspace_id} already exists.`);

  for (const entry of verified.artifacts) {
    const bytes = Buffer.from(entry.content_base64, 'base64');
    await provider.putArtifact(verified.workspace_id, entry.sha256, bytes);
  }

  let expectedHead = null;
  for (const event of verified.events) {
    await provider.appendEvent(verified.workspace_id, expectedHead, event);
    expectedHead = event.event_digest;
  }
  const state = reduceWorkspaceEvents(await provider.readEvents(verified.workspace_id), { workspaceId: verified.workspace_id });
  if (state.head_digest !== verified.head_digest) throw new WorkspaceError('Imported workspace head differs from the bundle.');
  return Object.freeze({ workspace_id: verified.workspace_id, state, bundle_digest: verified.bundle_digest });
}

export async function writeWorkspaceBundle(filename, bundle) {
  const verified = assertBundle(structuredClone(bundle));
  const target = path.resolve(filename);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(verified, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
  return target;
}

export async function readWorkspaceBundle(filename) {
  return assertBundle(JSON.parse(await fs.readFile(path.resolve(filename), 'utf8')));
}
