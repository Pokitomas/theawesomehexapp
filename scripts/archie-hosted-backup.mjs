import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WorkspaceError,
  reduceWorkspaceEvents,
  sha256,
  stableJSONStringify,
  verifyWorkspaceEventStream
} from './archie-workspace-core.mjs';

export const ARCHIE_HOSTED_BACKUP_SCHEMA = 'archie-hosted-backup/v1';

function digest(value) {
  const unsigned = { ...value };
  delete unsigned.backup_digest;
  return sha256(stableJSONStringify(unsigned));
}

export function verifyHostedBackup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceError('Hosted backup must be an object.');
  if (value.schema !== ARCHIE_HOSTED_BACKUP_SCHEMA) throw new WorkspaceError('Unsupported hosted backup schema.');
  if (value.backup_digest !== digest(value)) throw new WorkspaceError('Hosted backup digest mismatch.');
  if (!Array.isArray(value.workspaces) || value.workspace_count !== value.workspaces.length) throw new WorkspaceError('Hosted backup workspace count mismatch.');
  let artifactCount = 0;
  for (const workspace of value.workspaces) {
    const verified = verifyWorkspaceEventStream(workspace.events, workspace.workspace_id);
    if (verified.count !== workspace.event_count || verified.head_digest !== workspace.head_digest) {
      throw new WorkspaceError(`Hosted backup event identity mismatch for ${workspace.workspace_id}.`);
    }
    if (!Array.isArray(workspace.artifacts)) throw new WorkspaceError(`Hosted backup artifacts are invalid for ${workspace.workspace_id}.`);
    for (const artifact of workspace.artifacts) {
      const bytes = Buffer.from(String(artifact.content_base64 || ''), 'base64');
      if (bytes.length !== artifact.size_bytes || sha256(bytes) !== artifact.sha256) {
        throw new WorkspaceError(`Hosted backup artifact mismatch for ${workspace.workspace_id}/${artifact.artifact_id}.`);
      }
      artifactCount += 1;
    }
  }
  if (artifactCount !== value.artifact_count) throw new WorkspaceError('Hosted backup artifact count mismatch.');
  if (value.encrypted_secrets?.schema && value.encrypted_secrets.schema !== 'archie-encrypted-secret-store/v1') {
    throw new WorkspaceError('Hosted backup encrypted-secret envelope is invalid.');
  }
  return value;
}

export async function createHostedBackup({ provider, secretStore, dataRoot, serviceVersion, migrationLevel, clock = () => new Date() }) {
  if (!provider?.listWorkspaceIds || !provider?.readEvents || !provider?.readArtifact) {
    throw new WorkspaceError('Hosted backup requires a complete provider-neutral workspace adapter.');
  }
  const workspaces = [];
  let artifactCount = 0;
  for (const workspaceId of (await provider.listWorkspaceIds()).sort()) {
    const events = await provider.readEvents(workspaceId);
    const verified = verifyWorkspaceEventStream(events, workspaceId);
    const state = reduceWorkspaceEvents(events, { workspaceId });
    const artifacts = [];
    for (const artifactId of Object.keys(state.artifacts).sort()) {
      const metadata = state.artifacts[artifactId];
      const bytes = await provider.readArtifact(workspaceId, metadata.sha256);
      artifacts.push({
        artifact_id: artifactId,
        sha256: metadata.sha256,
        size_bytes: bytes.length,
        media_type: metadata.media_type,
        name: metadata.name,
        content_base64: bytes.toString('base64')
      });
      artifactCount += 1;
    }
    workspaces.push({ workspace_id: workspaceId, event_count: verified.count, head_digest: verified.head_digest, events, artifacts });
  }

  const createdAt = new Date(clock()).toISOString();
  const body = {
    schema: ARCHIE_HOSTED_BACKUP_SCHEMA,
    created_at: createdAt,
    service_version: String(serviceVersion),
    migration_level: Number(migrationLevel),
    workspace_count: workspaces.length,
    artifact_count: artifactCount,
    workspaces,
    encrypted_secrets: secretStore ? await secretStore.encryptedEnvelope() : null,
    claim_boundary: 'This backup contains exact digest-chained workspace events, admitted artifact bytes, and only encrypted secret envelopes. The raw access tokens and external session and encryption keys are intentionally absent.'
  };
  const backup = Object.freeze({ ...body, backup_digest: digest(body) });
  verifyHostedBackup(backup);

  const backupRoot = path.join(path.resolve(dataRoot), 'backups');
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const timestamp = createdAt.replace(/[:.]/g, '-');
  const filename = path.join(backupRoot, `${timestamp}-${backup.backup_digest.slice(0, 16)}.archie-backup.json`);
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(backup, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
  await fs.chmod(filename, 0o600).catch(() => {});
  return Object.freeze({ backup, filename });
}

export async function hostedBackupStatus(dataRoot) {
  const backupRoot = path.join(path.resolve(dataRoot), 'backups');
  let names;
  try { names = (await fs.readdir(backupRoot)).filter(name => name.endsWith('.archie-backup.json')).sort().reverse(); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ backup_count: 0, latest: null });
    throw error;
  }
  if (!names.length) return Object.freeze({ backup_count: 0, latest: null });
  const latest = verifyHostedBackup(JSON.parse(await fs.readFile(path.join(backupRoot, names[0]), 'utf8')));
  return Object.freeze({
    backup_count: names.length,
    latest: {
      created_at: latest.created_at,
      backup_digest: latest.backup_digest,
      workspace_count: latest.workspace_count,
      artifact_count: latest.artifact_count,
      migration_level: latest.migration_level
    }
  });
}
