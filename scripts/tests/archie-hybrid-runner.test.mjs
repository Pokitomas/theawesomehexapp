import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HybridQueue, verifyHybridEvents } from '../archie-hybrid-queue.mjs';
import { startHybridHostedArchied } from '../archie-hybrid-hosted.mjs';
import { resolveHybridRunnerConfig, runHybridOnce } from '../archie-hybrid-runner.mjs';
import { tokenSha256 } from '../archie-hosted-security.mjs';

const founderToken = 'archie-founder-hybrid-token-0123456789abcdef';
const developerToken = 'archie-developer-hybrid-token-abcdef0123456789';
const runnerToken = 'archie-runner-hybrid-token-fedcba9876543210';
const objective = 'Make this purchase-order workflow genuinely good on a phone while preserving explicit approval and the final audit trail.';
const requestedChange = 'Preserve why the alternative product hypothesis lost and include the final audit trail.';

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function api(baseUrl, token, pathname, { method = 'GET', body = null } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : null
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { text }; }
  return { response, payload };
}

function hostedOptions(home, runnerTokenValue, keys) {
  return {
    home,
    founderTokenSha256: tokenSha256(founderToken),
    developerTokenSha256: tokenSha256(developerToken),
    sessionKey: keys.session,
    secretKey: keys.secret,
    runnerToken: runnerTokenValue,
    host: '127.0.0.1',
    port: 0,
    allowInsecure: true,
    env: {}
  };
}

test('hybrid queue expires leases, advances fencing, rejects stale writers, and replays exactly', async t => {
  const root = await tempRoot(t, 'archie-hybrid-queue-');
  let now = new Date('2026-07-18T00:00:00.000Z');
  let sequence = 0;
  const queue = await HybridQueue.open({
    root,
    clock: () => now,
    randomId: prefix => `${prefix}_${String(++sequence).padStart(24, '0')}`
  });
  const submitted = await queue.submit({ objective, requested_change: requestedChange, approve: true, max_attempts: 3 });
  const first = await queue.lease({ runner_id: 'runner-a', capabilities: ['maker', 'portable_workspace'], ttl_ms: 5_000 });
  assert.equal(first.job_id, submitted.job_id);
  assert.equal(first.lease.fencing_token, 1);

  now = new Date(now.getTime() + 6_000);
  const second = await queue.lease({ runner_id: 'runner-b', capabilities: ['maker', 'portable_workspace'], ttl_ms: 5_000 });
  assert.equal(second.lease.fencing_token, 2);
  assert.equal(second.attempt, 2);

  await assert.rejects(
    queue.complete(submitted.job_id, first.lease, {
      workspace_id: 'workspace_aaaaaaaaaaaaaaaa',
      bundle_digest: 'a'.repeat(64),
      head_digest: 'b'.repeat(64),
      event_count: 1,
      artifact_count: 0
    }),
    error => error.code === 'stale_lease'
  );

  const completed = await queue.complete(submitted.job_id, second.lease, {
    workspace_id: 'workspace_aaaaaaaaaaaaaaaa',
    bundle_digest: 'a'.repeat(64),
    head_digest: 'b'.repeat(64),
    event_count: 1,
    artifact_count: 0
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result.completed_by_runner, 'runner-b');

  const rawEvents = (await fs.readFile(path.join(root, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  const verified = verifyHybridEvents(rawEvents);
  assert.equal(verified.event_count, 5);
  const reopened = await HybridQueue.open({ root, clock: () => now });
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.counts.completed, 1);
  assert.equal(snapshot.head_digest, verified.head_digest);
});

test('outbound runner executes locally, returns a verified bundle, and hosted Archie imports it durably', async t => {
  const hostedHome = await tempRoot(t, 'archie-hybrid-hosted-');
  const runnerHome = await tempRoot(t, 'archie-hybrid-local-');
  const keys = {
    session: crypto.randomBytes(32).toString('base64'),
    secret: crypto.randomBytes(32).toString('base64')
  };
  const runtime = await startHybridHostedArchied(hostedOptions(hostedHome, runnerToken, keys));
  t.after(() => runtime.close().catch(() => {}));

  const wrongSubmit = await api(runtime.url, runnerToken, '/v1/hybrid/jobs', {
    method: 'POST',
    body: { objective, requested_change: requestedChange, approve: true }
  });
  assert.equal(wrongSubmit.response.status, 401);

  const developerSubmit = await api(runtime.url, developerToken, '/v1/hybrid/jobs', {
    method: 'POST',
    body: { objective, requested_change: requestedChange, approve: true }
  });
  assert.equal(developerSubmit.response.status, 401);

  const wrongLease = await api(runtime.url, founderToken, '/v1/hybrid/lease', {
    method: 'POST',
    body: { runner_id: 'wrong-role', capabilities: ['maker', 'portable_workspace'], ttl_ms: 120_000 }
  });
  assert.equal(wrongLease.response.status, 401);

  const submitted = await api(runtime.url, founderToken, '/v1/hybrid/jobs', {
    method: 'POST',
    body: { objective, requested_change: requestedChange, approve: true, visibility: 'private' }
  });
  assert.equal(submitted.response.status, 201);
  const jobId = submitted.payload.job.job_id;
  assert.equal(submitted.payload.job.state, 'pending');

  const config = resolveHybridRunnerConfig({
    home: runnerHome,
    env: {
      ARCHIED_HYBRID_URL: runtime.url,
      ARCHIED_RUNNER_TOKEN: runnerToken,
      ARCHIED_RUNNER_ID: 'phone-local-runner',
      ARCHIED_RUNNER_POLL_MS: '1000',
      ARCHIED_RUNNER_LEASE_MS: '120000'
    }
  });
  const result = await runHybridOnce(config);
  assert.equal(result.status, 'completed');
  assert.equal(result.job_id, jobId);
  assert.match(result.workspace_id, /^workspace_[a-f0-9]{16}$/);
  assert.match(result.bundle_digest, /^[a-f0-9]{64}$/);

  const status = await api(runtime.url, founderToken, `/v1/hybrid/jobs/${jobId}`);
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.job.state, 'completed');
  assert.equal(status.payload.job.result.workspace_id, result.workspace_id);
  assert.equal(status.payload.job.result.bundle_digest, result.bundle_digest);

  const imported = await runtime.hosted.internal.engine.inspect(result.workspace_id, { principalId: 'owner_local' });
  assert.equal(imported.head_digest, status.payload.job.result.head_digest);
  assert.equal(Object.keys(imported.approvals).length, 1);
  assert.equal(Object.keys(imported.rollbacks).length, 1);

  const queueStatus = await api(runtime.url, founderToken, '/v1/hybrid/status');
  assert.equal(queueStatus.response.status, 200);
  assert.equal(queueStatus.payload.queue.counts.completed, 1);
  assert.equal(queueStatus.payload.service.execution.inbound_local_access_required, false);
  assert.equal(queueStatus.payload.service.github_required, false);

  await runtime.close();
  const restarted = await startHybridHostedArchied(hostedOptions(hostedHome, runnerToken, keys));
  t.after(() => restarted.close().catch(() => {}));
  const afterRestart = await api(restarted.url, founderToken, `/v1/hybrid/jobs/${jobId}`);
  assert.equal(afterRestart.response.status, 200);
  assert.equal(afterRestart.payload.job.state, 'completed');
  const restoredWorkspace = await restarted.hosted.internal.engine.inspect(result.workspace_id, { principalId: 'owner_local' });
  assert.equal(restoredWorkspace.head_digest, imported.head_digest);
});

test('hybrid hosted authority requires distinct founder developer and runner credentials', async () => {
  const shared = 'shared-authority-token-0123456789abcdef';
  const keys = {
    session: crypto.randomBytes(32).toString('base64'),
    secret: crypto.randomBytes(32).toString('base64')
  };
  await assert.rejects(
    startHybridHostedArchied({
      home: path.join(os.tmpdir(), 'archie-hybrid-distinct-authority'),
      founderTokenSha256: tokenSha256(shared),
      developerTokenSha256: tokenSha256(developerToken),
      sessionKey: keys.session,
      secretKey: keys.secret,
      runnerToken: shared,
      host: '127.0.0.1',
      port: 0,
      allowInsecure: true,
      env: {}
    }),
    /must be distinct/
  );
});

test('runner source is outbound-only and opens no listener', async () => {
  const source = await fs.readFile(new URL('../archie-hybrid-runner.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createServer\s*\(/);
  assert.doesNotMatch(source, /\.listen\s*\(/);
  assert.doesNotMatch(source, /node:http/);
  assert.match(source, /fetch\(/);
  assert.match(source, /inbound_listener:\s*false/);
});
