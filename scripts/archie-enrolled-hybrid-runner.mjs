#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { MakerEngine, digest as makerDigest } from './maker-engine.mjs';
import {
  ARCHIE_HYBRID_ADVERTISEMENT_SCHEMA,
  ARCHIE_HYBRID_EVENT_SCHEMA,
  ARCHIE_HYBRID_FAILURE_SCHEMA,
  ARCHIE_HYBRID_PROTOCOL_VERSION,
  ARCHIE_HYBRID_TERMINAL_SCHEMA,
  hybridEventDigest
} from './archie-hybrid-protocol.mjs';
import { WorkspaceError, sha256, stableJSONStringify } from './archie-workspace-core.mjs';

export const ARCHIE_HYBRID_RUNNER_STATE_SCHEMA = 'archie-hybrid-local-runner-state/v1';
export const ARCHIE_HYBRID_RUNNER_VERSION = '0.1.0';
const CONTROL_DIRECTORY = '.archie-runner';
const STATE_FILENAME = 'state.json';
const DEFAULT_CAPABILITIES = Object.freeze([
  'artifact.upload',
  'directory.read',
  'directory.write',
  'event.stream',
  'process.verify',
  'resume'
]);

function flag(argv, name, fallback = null) {
  const index = argv.lastIndexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new WorkspaceError(`${name} requires a value.`);
  return value;
}

function relativeFile(value, label) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized === '..' || normalized.includes('\u0000')) {
    throw new WorkspaceError(`${label} must be a relative path without traversal.`);
  }
  return normalized;
}

function pathAllowed(filename, patterns) {
  return patterns.some(pattern => pattern.endsWith('/**')
    ? filename === pattern.slice(0, -3) || filename.startsWith(pattern.slice(0, -2))
    : filename === pattern);
}

function sanitize(value, root) {
  const source = String(value ?? '');
  return source.split(path.resolve(root)).join('<bounded-root>').replace(/(?:[A-Za-z]:)?[/\\][^\s"']*\.archie-runner[^\s"']*/g, '<runner-control>');
}

async function writePrivateJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
  await fs.chmod(filename, 0o600).catch(() => {});
}

async function readState(filename) {
  try {
    const value = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (value.schema !== ARCHIE_HYBRID_RUNNER_STATE_SCHEMA) throw new WorkspaceError('Local runner state schema is invalid.');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function requestJson(url, { method = 'GET', body = null, runnerToken = null, fenceToken = null, allowNoContent = false } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== null) headers['content-type'] = 'application/json';
  if (runnerToken) headers.authorization = `Bearer ${runnerToken}`;
  if (fenceToken) headers['x-archie-fence'] = fenceToken;
  const response = await fetch(url, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
  if (allowNoContent && response.status === 204) return null;
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new WorkspaceError(value.message || `Hybrid request failed with HTTP ${response.status}.`, { status: response.status, code: value.error || 'hybrid_request_failed' });
  return value;
}

async function uploadBytes(url, bytes, { runnerToken, fenceToken, mediaType = 'application/octet-stream' }) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${runnerToken}`,
      'x-archie-fence': fenceToken,
      'content-type': mediaType,
      'content-length': String(bytes.length)
    },
    body: bytes
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new WorkspaceError(value.message || `Artifact upload failed with HTTP ${response.status}.`, { status: response.status, code: value.error || 'artifact_upload_failed' });
  return value;
}

export async function defaultRunnerAdvertisement(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  let diskFreeBytes = 1;
  try {
    const stats = await fs.statfs(root);
    diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {}
  return Object.freeze({
    schema: ARCHIE_HYBRID_ADVERTISEMENT_SCHEMA,
    protocol_version: ARCHIE_HYBRID_PROTOCOL_VERSION,
    runner_version: ARCHIE_HYBRID_RUNNER_VERSION,
    capabilities: [...DEFAULT_CAPABILITIES],
    resources: {
      platform: process.platform,
      architecture: process.arch,
      cpu_count: Math.max(1, os.cpus().length),
      memory_bytes: Math.max(1, os.totalmem()),
      disk_free_bytes: Math.max(1, Math.floor(diskFreeBytes))
    },
    privacy: {
      inbound_access: false,
      filesystem_scope: 'bounded_root',
      artifact_upload: 'explicit_only',
      credentials: 'local_only'
    }
  });
}

function runnerEvent({ leaseId, sequence, previousDigest, kind, summary, payload = {} }) {
  const event = {
    schema: ARCHIE_HYBRID_EVENT_SCHEMA,
    lease_id: leaseId,
    sequence,
    kind,
    summary,
    occurred_at: new Date().toISOString(),
    previous_digest: previousDigest,
    payload_digest: sha256(stableJSONStringify(payload))
  };
  event.digest = hybridEventDigest(event);
  return Object.freeze(event);
}

async function ensureVerifier(controlRoot) {
  const filename = path.join(controlRoot, 'verify.mjs');
  const source = `import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const manifest = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const root = path.resolve(process.argv[3]);
for (const entry of manifest.files) {
  const bytes = await fs.readFile(path.join(root, entry.path));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, entry.sha256, entry.path);
  assert.equal(bytes.length, entry.size_bytes, entry.path);
}
process.stdout.write(JSON.stringify({ ok: true, files: manifest.files.length }));
`;
  await fs.mkdir(controlRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, source, { encoding: 'utf8', mode: 0o600 });
  return filename;
}

async function executeAssignment({ root, assignment, leaseId }) {
  const controlRoot = path.join(root, CONTROL_DIRECTORY);
  const allowedPaths = assignment.allowed_paths;
  const files = assignment.execution.files.map((entry, index) => {
    const filename = relativeFile(entry.path, `execution.files[${index}].path`);
    if (!pathAllowed(filename, allowedPaths)) throw new WorkspaceError(`Runner refused path outside the lease fence: ${filename}.`);
    const bytes = Buffer.from(entry.content_base64, 'base64');
    if (sha256(bytes) !== entry.sha256) throw new WorkspaceError(`Runner refused invalid assigned bytes for ${filename}.`);
    return { ...entry, path: filename, bytes };
  });
  await ensureVerifier(controlRoot);
  const manifestPath = path.join(controlRoot, `assignment-${leaseId}.json`);
  await writePrivateJson(manifestPath, { schema: assignment.execution.schema, files: files.map(({ bytes: _bytes, ...entry }) => entry) });
  const relativeManifest = path.relative(root, manifestPath).replaceAll('\\', '/');
  const command = { program: 'node', args: [`${CONTROL_DIRECTORY}/verify.mjs`, relativeManifest, '.'] };
  const maker = await MakerEngine.create({
    root,
    state_path: path.join(controlRoot, `maker-${leaseId}.json`),
    task: {
      repository: 'archie-hybrid-local',
      base_sha: makerDigest({ leaseId, assignment }).slice(0, 40),
      branch: `hybrid/${leaseId}`,
      request: assignment.execution.request,
      protect: `Write only ${allowedPaths.join(', ')}. No network, contact, spending, deployment, publishing, credentials, or writes outside the bounded root.`,
      proof: 'Exact assigned digests, allowlisted local verification, Maker receipt, explicit artifact admission, and terminal hybrid receipt.'
    },
    lease: {
      base_sha: makerDigest({ leaseId, assignment }).slice(0, 40),
      branch: `hybrid/${leaseId}`,
      writer_count: 1,
      owned_paths: allowedPaths,
      authority: { merge: 'human', deploy: 'human' }
    },
    command_policy: [command]
  });
  for (const entry of files) await maker.write(entry.path, entry.bytes);
  await maker.checkpoint('hybrid-assignment-materialized');
  const verification = await maker.verify([command]);
  if (!verification.ok) throw new WorkspaceError('Hybrid Maker verification failed.');
  const receipt = await maker.receipt();
  if (JSON.stringify(receipt).includes(path.resolve(root))) throw new WorkspaceError('Maker receipt leaked the bounded local root.');
  return Object.freeze({ makerReceipt: receipt, files });
}

export async function runHybridRunnerOnce({
  baseUrl,
  enrollmentToken = null,
  root,
  advertisement = null,
  stopAfter = null,
  injectFailure = false
} = {}) {
  const serviceUrl = new URL(baseUrl).href;
  const boundedRoot = path.resolve(root);
  const controlRoot = path.join(boundedRoot, CONTROL_DIRECTORY);
  const stateFile = path.join(controlRoot, STATE_FILENAME);
  await fs.mkdir(controlRoot, { recursive: true, mode: 0o700 });
  let state = await readState(stateFile);

  if (!state?.runner_token) {
    if (!enrollmentToken) throw new WorkspaceError('A first-run enrollment token is required.');
    const identity = await requestJson(new URL('/v1/hybrid/runner/enroll', serviceUrl), {
      method: 'POST',
      body: { enrollment_token: enrollmentToken, advertisement: advertisement || await defaultRunnerAdvertisement(boundedRoot) }
    });
    state = {
      schema: ARCHIE_HYBRID_RUNNER_STATE_SCHEMA,
      service_url: serviceUrl,
      runner_id: identity.runner_id,
      runner_token: identity.runner_token,
      runner_expires_at: identity.expires_at,
      lease_id: null,
      fence_token: null,
      event_sequence: 0,
      event_head: null,
      phase: 'enrolled'
    };
    await writePrivateJson(stateFile, state);
  }
  if (state.service_url !== serviceUrl) throw new WorkspaceError('Runner state is bound to a different hosted Archie service.');

  let claim;
  if (state.lease_id && state.fence_token) {
    claim = await requestJson(new URL(`/v1/hybrid/runner/leases/${state.lease_id}`, serviceUrl), {
      runnerToken: state.runner_token,
      fenceToken: state.fence_token
    });
  } else {
    claim = await requestJson(new URL('/v1/hybrid/runner/claim', serviceUrl), {
      method: 'POST',
      runnerToken: state.runner_token,
      allowNoContent: true
    });
    if (!claim) return Object.freeze({ schema: 'archie-hybrid-runner-cycle/v1', runner_id: state.runner_id, status: 'idle' });
    state.lease_id = claim.lease.lease_id;
    state.fence_token = claim.lease.fence_token;
    state.event_sequence = claim.lease.event_sequence;
    state.event_head = claim.lease.event_head;
    state.phase = 'claimed';
    await writePrivateJson(stateFile, state);
  }
  const lease = claim.lease;
  const assignment = claim.assignment;

  async function emit(kind, summary, payload = {}) {
    const event = runnerEvent({
      leaseId: state.lease_id,
      sequence: state.event_sequence + 1,
      previousDigest: state.event_head,
      kind,
      summary,
      payload
    });
    const ack = await requestJson(new URL(`/v1/hybrid/runner/leases/${state.lease_id}/events`, serviceUrl), {
      method: 'POST',
      body: event,
      runnerToken: state.runner_token,
      fenceToken: state.fence_token
    });
    state.event_sequence = ack.sequence;
    state.event_head = ack.event_head;
    state.phase = kind;
    await writePrivateJson(stateFile, state);
    return event;
  }

  if (state.event_sequence === 0) await emit('claimed', 'Claimed one fenced outbound lease.', { offer_id: assignment.offer_id });
  if (stopAfter === 'claimed') return Object.freeze({ schema: 'archie-hybrid-runner-cycle/v1', runner_id: state.runner_id, lease_id: state.lease_id, status: 'interrupted_after_claim' });

  try {
    if (injectFailure) throw new WorkspaceError('Injected local execution failure for terminal-receipt verification.');
    await emit('executing', 'Executing the admitted local Maker directory task.', { allowed_paths: assignment.allowed_paths });
    const executed = await executeAssignment({ root: boundedRoot, assignment, leaseId: state.lease_id });
    await emit('verified', 'Local Maker verification passed without network or authority expansion.', { receipt_digest: executed.makerReceipt.receipt_digest });

    const uploaded = {};
    for (const admitted of assignment.artifact_admission) {
      const filename = relativeFile(admitted.path, 'artifact path');
      if (!pathAllowed(filename, assignment.allowed_paths)) throw new WorkspaceError(`Artifact path escaped the lease fence: ${filename}.`);
      const bytes = await fs.readFile(path.join(boundedRoot, filename));
      if (bytes.length > admitted.max_bytes) throw new WorkspaceError(`Artifact exceeds its admitted byte limit: ${admitted.artifact_id}.`);
      if (admitted.sha256 && sha256(bytes) !== admitted.sha256) throw new WorkspaceError(`Artifact digest differs from admission: ${admitted.artifact_id}.`);
      uploaded[admitted.artifact_id] = await uploadBytes(
        new URL(`/v1/hybrid/runner/leases/${state.lease_id}/artifacts/${admitted.artifact_id}`, serviceUrl),
        bytes,
        { runnerToken: state.runner_token, fenceToken: state.fence_token, mediaType: admitted.media_type }
      );
    }
    await emit('uploaded', 'Uploaded only explicitly admitted digest-bound artifacts.', { artifact_ids: Object.keys(uploaded).sort() });

    const terminal = await requestJson(new URL(`/v1/hybrid/runner/leases/${state.lease_id}/complete`, serviceUrl), {
      method: 'POST',
      runnerToken: state.runner_token,
      fenceToken: state.fence_token,
      body: {
        schema: ARCHIE_HYBRID_TERMINAL_SCHEMA,
        summary: 'Bounded local Maker work completed, verified, and explicitly uploaded.',
        maker_receipt: executed.makerReceipt
      }
    });
    state.lease_id = null;
    state.fence_token = null;
    state.event_sequence = 0;
    state.event_head = null;
    state.phase = 'completed';
    await writePrivateJson(stateFile, state);
    return Object.freeze({
      schema: 'archie-hybrid-runner-cycle/v1',
      runner_id: state.runner_id,
      status: 'completed',
      terminal_receipt_digest: terminal.receipt_digest,
      uploaded_artifacts: uploaded
    });
  } catch (error) {
    const message = sanitize(error?.message || String(error), boundedRoot);
    let failure = null;
    try {
      if (state.event_sequence >= 0) await emit('failed', 'Local runner emitted a terminal failure receipt.', { error_class: error?.name || 'Error' });
      failure = await requestJson(new URL(`/v1/hybrid/runner/leases/${state.lease_id}/fail`, serviceUrl), {
        method: 'POST',
        runnerToken: state.runner_token,
        fenceToken: state.fence_token,
        body: {
          schema: ARCHIE_HYBRID_FAILURE_SCHEMA,
          summary: 'Bounded local work failed without authority expansion.',
          failure: { phase: state.phase || 'execution', error_class: error?.name || 'Error', message }
        }
      });
      state.lease_id = null;
      state.fence_token = null;
      state.event_sequence = 0;
      state.event_head = null;
      state.phase = 'failed';
      await writePrivateJson(stateFile, state);
    } catch (reportError) {
      throw new AggregateError([error, reportError], 'Hybrid runner failed and could not deliver its terminal failure receipt.');
    }
    return Object.freeze({
      schema: 'archie-hybrid-runner-cycle/v1',
      runner_id: state.runner_id,
      status: 'failed',
      failure_receipt_digest: failure.receipt_digest,
      message
    });
  }
}

export function resolveHybridRunnerConfig(argv = process.argv.slice(2), env = process.env) {
  const baseUrl = flag(argv, '--url', env.ARCHIE_HOSTED_URL || null);
  const root = flag(argv, '--root', env.ARCHIE_RUNNER_ROOT || null);
  const enrollmentToken = flag(argv, '--enrollment-token', env.ARCHIE_RUNNER_ENROLLMENT_TOKEN || null);
  if (!baseUrl) throw new WorkspaceError('--url or ARCHIE_HOSTED_URL is required.');
  if (!root) throw new WorkspaceError('--root or ARCHIE_RUNNER_ROOT is required.');
  return Object.freeze({ baseUrl, root, enrollmentToken });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`archie-hybrid-runner\n\nUsage:\n  archie-hybrid-runner --url https://archie.example/ --root /private/work --enrollment-token <single-use-token>\n\nThe runner makes outbound HTTPS requests only, writes solely inside the bounded root granted by each lease, uploads only admitted artifacts, and cannot contact, spend, deploy, publish, or transfer credentials. Subsequent runs reuse encrypted-by-filesystem local identity state and do not need the enrollment token.\n`);
    return null;
  }
  const result = await runHybridRunnerOnce(resolveHybridRunnerConfig(argv, env));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-hybrid-runner: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
