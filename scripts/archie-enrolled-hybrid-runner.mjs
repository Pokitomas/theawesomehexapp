#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { MakerEngine, digest as makerDigest } from './maker-engine.mjs';
import { WorkspaceError, sha256, stableJSONStringify } from './archie-workspace-core.mjs';

export const ARCHIE_HYBRID_RUNNER_VERSION = '1.0.0';
export const ARCHIE_HYBRID_RUNNER_STATE_SCHEMA = 'archie-hybrid-runner-state/v1';
const CONTROL_DIRECTORY = '.archie-runner';
const STATE_FILENAME = 'state.json';
const REQUIRED_CAPABILITIES = Object.freeze([
  'artifact.upload',
  'directory.read',
  'directory.write',
  'event.stream',
  'process.verify',
  'resume'
]);

function clean(value, limit = 2_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function relativeFile(value, label) {
  const raw = clean(value, 1_000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new WorkspaceError(`${label} must be relative.`);
  const segments = raw.split('/').filter(Boolean);
  if (!segments.length || segments.some(segment => segment === '..' || segment === '.')) throw new WorkspaceError(`${label} contains an unsafe path.`);
  return segments.join('/');
}

function pathAllowed(filename, allowedPaths) {
  return allowedPaths.some(entry => {
    if (entry === '**') return true;
    if (entry.endsWith('/**')) {
      const prefix = entry.slice(0, -3);
      return filename === prefix || filename.startsWith(`${prefix}/`);
    }
    return filename === entry;
  });
}

function pathInside(root, filename) {
  const normalized = relativeFile(filename, 'runner path');
  const base = path.resolve(root);
  const absolute = path.resolve(base, ...normalized.split('/'));
  if (absolute !== base && !absolute.startsWith(`${base}${path.sep}`)) throw new WorkspaceError('Runner path escaped the bounded root.');
  return { relative: normalized, absolute };
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
    if (value.schema !== ARCHIE_HYBRID_RUNNER_STATE_SCHEMA) throw new WorkspaceError('Hybrid runner state schema is invalid.');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function diskFreeBytes(root) {
  try {
    const stats = await fs.statfs(root);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return 0;
  }
}

export async function defaultRunnerAdvertisement(root) {
  return Object.freeze({
    schema: 'archie-hybrid-runner-advertisement/v1',
    protocol_version: ARCHIE_HYBRID_RUNNER_VERSION,
    runner_version: ARCHIE_HYBRID_RUNNER_VERSION,
    capabilities: REQUIRED_CAPABILITIES,
    resources: Object.freeze({
      platform: process.platform,
      architecture: process.arch,
      cpu_count: os.cpus().length,
      memory_bytes: os.totalmem(),
      disk_free_bytes: await diskFreeBytes(root)
    }),
    privacy: Object.freeze({
      inbound_access: false,
      filesystem_scope: 'bounded_root',
      artifact_upload: 'explicit_only',
      credentials: 'local_only'
    })
  });
}

async function requestJson(url, {
  method = 'GET',
  runnerToken = null,
  fenceToken = null,
  body = null,
  bytes = null,
  mediaType = 'application/json',
  allowNoContent = false
} = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(runnerToken ? { authorization: `Bearer ${runnerToken}` } : {}),
      ...(fenceToken ? { 'x-archie-fence': fenceToken } : {}),
      ...(body !== null ? { 'content-type': 'application/json' } : {}),
      ...(bytes !== null ? { 'content-type': mediaType } : {})
    },
    body: body !== null ? JSON.stringify(body) : bytes
  });
  if (response.status === 204 && allowNoContent) return null;
  const text = await response.text();
  let value = null;
  try { value = text ? JSON.parse(text) : null; }
  catch { value = { message: text }; }
  if (!response.ok) {
    const error = new WorkspaceError(value?.message || `Hosted Archie returned HTTP ${response.status}.`, {
      code: value?.error || 'hybrid_runner_http_error',
      status: response.status
    });
    throw error;
  }
  return value;
}

function buildRunEvent({ state, leaseId, kind, summary, payload = {} }) {
  const sequence = state.event_sequence + 1;
  const body = {
    schema: 'archie-hybrid-run-event/v1',
    lease_id: leaseId,
    sequence,
    kind: clean(kind, 100),
    summary: clean(summary, 2_000),
    occurred_at: new Date().toISOString(),
    previous_digest: state.event_head,
    payload_digest: sha256(stableJSONStringify(payload))
  };
  return Object.freeze({ ...body, digest: sha256(stableJSONStringify(body)) });
}

async function sendEvent({ serviceUrl, state, leaseId, kind, summary, payload = {} }) {
  const event = buildRunEvent({ state, leaseId, kind, summary, payload });
  const result = await requestJson(new URL(`/v1/hybrid/runner/leases/${leaseId}/events`, serviceUrl), {
    method: 'POST',
    runnerToken: state.runner_token,
    fenceToken: state.fence_token,
    body: event
  });
  state.event_sequence = result.sequence;
  state.event_head = result.event_head;
  return result;
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
      repository: 'local/archie-hybrid-local',
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
    await sendEvent({
      serviceUrl,
      state,
      leaseId: claim.lease.lease_id,
      kind: 'claimed',
      summary: 'Local runner claimed the fenced lease.'
    });
    await writePrivateJson(stateFile, state);
  }
  const lease = claim.lease;

  if (stopAfter === 'claimed') {
    return Object.freeze({ schema: 'archie-hybrid-runner-cycle/v1', runner_id: state.runner_id, lease_id: lease.lease_id, status: 'interrupted_after_claim' });
  }

  try {
    await sendEvent({ serviceUrl, state, leaseId: lease.lease_id, kind: 'resumed', summary: 'Local runner resumed the fenced lease.' });
    await writePrivateJson(stateFile, state);
    if (injectFailure) throw new WorkspaceError('Injected local runner failure for terminal-receipt proof.');

    const executed = await executeAssignment({ root: boundedRoot, assignment: lease.assignment, leaseId: lease.lease_id });
    await sendEvent({
      serviceUrl,
      state,
      leaseId: lease.lease_id,
      kind: 'maker_verified',
      summary: `Maker verified ${executed.files.length} bounded files.`,
      payload: { maker_receipt_digest: executed.makerReceipt.receipt_digest, changed_paths: executed.makerReceipt.changed_paths }
    });
    await writePrivateJson(stateFile, state);

    const uploaded = [];
    for (const artifact of lease.assignment.artifact_admission) {
      const target = pathInside(boundedRoot, artifact.path);
      const bytes = await fs.readFile(target.absolute);
      if (bytes.length > artifact.max_bytes || sha256(bytes) !== artifact.sha256) throw new WorkspaceError(`Runner artifact failed admission: ${artifact.artifact_id}.`);
      await requestJson(new URL(`/v1/hybrid/runner/leases/${lease.lease_id}/artifacts/${artifact.artifact_id}`, serviceUrl), {
        method: 'PUT',
        runnerToken: state.runner_token,
        fenceToken: state.fence_token,
        bytes,
        mediaType: artifact.media_type
      });
      uploaded.push({ artifact_id: artifact.artifact_id, sha256: artifact.sha256, size_bytes: bytes.length });
      await sendEvent({
        serviceUrl,
        state,
        leaseId: lease.lease_id,
        kind: 'artifact_uploaded',
        summary: `Uploaded admitted artifact ${artifact.artifact_id}.`,
        payload: uploaded.at(-1)
      });
      await writePrivateJson(stateFile, state);
    }

    const terminal = await requestJson(new URL(`/v1/hybrid/runner/leases/${lease.lease_id}/complete`, serviceUrl), {
      method: 'POST',
      runnerToken: state.runner_token,
      fenceToken: state.fence_token,
      body: {
        maker_receipt_digest: executed.makerReceipt.receipt_digest,
        uploaded_artifacts: uploaded,
        local_event_head: state.event_head,
        local_event_sequence: state.event_sequence
      }
    });
    await fs.rm(stateFile, { force: true });
    return Object.freeze({
      schema: 'archie-hybrid-runner-cycle/v1',
      runner_id: state.runner_id,
      lease_id: lease.lease_id,
      status: 'completed',
      terminal_receipt_digest: terminal.terminal_receipt_digest
    });
  } catch (error) {
    const failure = await requestJson(new URL(`/v1/hybrid/runner/leases/${lease.lease_id}/fail`, serviceUrl), {
      method: 'POST',
      runnerToken: state.runner_token,
      fenceToken: state.fence_token,
      body: {
        code: clean(error?.code || 'local_runner_failed', 100),
        message: clean(error?.message || 'Local runner failed.', 2_000),
        local_event_head: state.event_head,
        local_event_sequence: state.event_sequence
      }
    }).catch(() => null);
    await fs.rm(stateFile, { force: true });
    return Object.freeze({
      schema: 'archie-hybrid-runner-cycle/v1',
      runner_id: state.runner_id,
      lease_id: lease.lease_id,
      status: 'failed',
      failure_receipt_digest: failure?.failure_receipt_digest || null,
      message: clean(error?.message || 'Local runner failed.', 2_000)
    });
  }
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
    process.stdout.write('archie enrolled hybrid runner\n\nUsage:\n  archie-enrolled-hybrid-runner --url <hosted-archie> --root <bounded-local-root> [--enrollment-token <one-time-token>]\n');
    return null;
  }
  const baseUrl = argument(argv, '--url', env.ARCHIED_HYBRID_URL);
  const root = argument(argv, '--root', env.ARCHIED_RUNNER_ROOT);
  if (!baseUrl || !root) throw new WorkspaceError('--url and --root are required.');
  const result = await runHybridRunnerOnce({
    baseUrl,
    root,
    enrollmentToken: argument(argv, '--enrollment-token', env.ARCHIED_ENROLLMENT_TOKEN)
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-enrolled-hybrid-runner: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
