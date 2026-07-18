import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startHostedArchied } from '../archied-hosted.mjs';
import {
  defaultRunnerAdvertisement,
  runHybridRunnerOnce
} from '../archie-hybrid-runner.mjs';
import { tokenSha256 } from '../archie-hosted-security.mjs';
import { sha256, stableJSONStringify } from '../archie-workspace-core.mjs';

const founderToken = 'founder-hybrid-test-token-0123456789-abcdefghijklmnopqrstuvwxyz';
const developerToken = 'developer-hybrid-test-token-0123456789-abcdefghijklmnopqrstuvwxyz';
const capabilities = [
  'artifact.upload',
  'directory.read',
  'directory.write',
  'event.stream',
  'process.verify',
  'resume'
];

async function temporary(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function hostedOptions(home) {
  return {
    home,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://archie.test/',
    founderTokenSha256: tokenSha256(founderToken),
    developerTokenSha256: tokenSha256(developerToken),
    sessionKey: crypto.randomBytes(32).toString('base64'),
    secretKey: crypto.randomBytes(32).toString('base64'),
    allowInsecure: true,
    env: {}
  };
}

async function founderJson(runtime, pathname, { method = 'GET', body = null, token = founderToken } = {}) {
  const response = await fetch(new URL(pathname, runtime.url), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body === null ? {} : { 'content-type': 'application/json' })
    },
    body: body === null ? undefined : JSON.stringify(body)
  });
  return { response, value: await response.json().catch(() => ({})) };
}

function offer({ workspaceId, taskId, title, filename, content }) {
  const bytes = Buffer.from(content, 'utf8');
  return {
    workspace_id: workspaceId,
    task_id: taskId,
    title,
    required_protocol_version: '1.0.0',
    required_capabilities: capabilities,
    minimum_resources: { memory_bytes: 1, disk_free_bytes: 1 },
    allowed_paths: ['output/**'],
    execution: {
      schema: 'archie-hybrid-materialize-files/v1',
      request: `Materialize ${filename} inside the bounded local runner root.`,
      files: [{
        path: `output/${filename}`,
        content_base64: bytes.toString('base64'),
        sha256: sha256(bytes)
      }]
    },
    artifact_admission: [{
      artifact_id: `artifact_${filename.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
      path: `output/${filename}`,
      name: filename,
      media_type: 'application/json',
      required: true,
      max_bytes: 100_000,
      sha256: sha256(bytes)
    }],
    lease_ttl_ms: 120_000
  };
}

async function createWorkspace(runtime) {
  const engine = runtime.internal.engine;
  await engine.createWorkspace({
    workspace_id: 'workspace_hybrid',
    title: 'Outbound hybrid runner proof',
    visibility: 'private',
    owner_id: 'owner_local'
  });
  await engine.execute('workspace_hybrid', 'owner_local', 'objective.define', {
    objective_id: 'objective_hybrid',
    statement: 'Execute bounded local work from hosted Archie without inbound machine access.',
    protected_reality: 'No contact, spending, deployment, publishing, network task authority, credential transfer, or writes outside the leased root.',
    proof_of_done: 'Expiring identity, exact advertisement, fenced lease, digest-bound events, explicit artifact admission, interruption recovery, and terminal receipts.'
  });
  await engine.execute('workspace_hybrid', 'owner_local', 'task_graph.create', {
    objective_id: 'objective_hybrid',
    tasks: [
      { task_id: 'task_complete', title: 'Complete bounded local work', description: 'Materialize and verify one admitted JSON result.', depends_on: [] },
      { task_id: 'task_failure', title: 'Record a bounded local failure', description: 'Prove terminal failure receipt behavior.', depends_on: [] }
    ]
  });
}

test('current hosted Archie controls one enrolled outbound-only runner through exact fenced receipts', async t => {
  const home = await temporary(t, 'archie-enrolled-hybrid-hosted-');
  const runnerRoot = await temporary(t, 'archie-enrolled-hybrid-local-');
  const runtime = await startHostedArchied(hostedOptions(home));
  t.after(() => runtime.close().catch(() => {}));
  await createWorkspace(runtime);

  const developerEnrollment = await founderJson(runtime, '/v1/hybrid/founder/enrollments', {
    method: 'POST',
    token: developerToken,
    body: { expires_in_seconds: 600, required_protocol_version: '1.0.0', required_capabilities: capabilities }
  });
  assert.equal(developerEnrollment.response.status, 403);

  const forbidden = await founderJson(runtime, '/v1/hybrid/founder/offers', {
    method: 'POST',
    body: {
      ...offer({ workspaceId: 'workspace_hybrid', taskId: 'task_complete', title: 'Forbidden offer', filename: 'forbidden.json', content: '{"forbidden":true}\n' }),
      required_capabilities: ['deploy']
    }
  });
  assert.equal(forbidden.response.status, 403);
  assert.match(forbidden.value.message, /not admitted/);

  const enrollmentResult = await founderJson(runtime, '/v1/hybrid/founder/enrollments', {
    method: 'POST',
    body: { expires_in_seconds: 600, required_protocol_version: '1.0.0', required_capabilities: capabilities }
  });
  assert.equal(enrollmentResult.response.status, 201);
  const enrollment = enrollmentResult.value;
  assert.match(enrollment.enrollment_token, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(enrollment.token_disclosed_once, true);

  const completeContent = `${JSON.stringify({ schema: 'hybrid-result/v1', ok: true, source: 'bounded-local-runner' }, null, 2)}\n`;
  const offered = await founderJson(runtime, '/v1/hybrid/founder/offers', {
    method: 'POST',
    body: offer({
      workspaceId: 'workspace_hybrid',
      taskId: 'task_complete',
      title: 'Materialize exact local result',
      filename: 'result.json',
      content: completeContent
    })
  });
  assert.equal(offered.response.status, 201);
  assert.equal(offered.value.authority.contact, false);
  assert.equal(offered.value.authority.spend, false);
  assert.equal(offered.value.authority.deploy, false);
  assert.equal(offered.value.authority.network, false);

  const interrupted = await runHybridRunnerOnce({
    baseUrl: runtime.url,
    enrollmentToken: enrollment.enrollment_token,
    root: runnerRoot,
    stopAfter: 'claimed'
  });
  assert.equal(interrupted.status, 'interrupted_after_claim');
  assert.match(interrupted.lease_id, /^lease_[a-f0-9]{24}$/);

  const stateFile = path.join(runnerRoot, '.archie-runner', 'state.json');
  const localState = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(localState.lease_id, interrupted.lease_id);
  assert.match(localState.runner_token, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(localState.fence_token, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(localState.event_sequence, 1);

  const wrongFence = await fetch(new URL(`/v1/hybrid/runner/leases/${localState.lease_id}/events`, runtime.url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${localState.runner_token}`,
      'x-archie-fence': 'wrong-fence',
      'content-type': 'application/json'
    },
    body: '{}'
  });
  assert.equal(wrongFence.status, 403);

  const notAdmitted = await fetch(new URL(`/v1/hybrid/runner/leases/${localState.lease_id}/artifacts/not_admitted`, runtime.url), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${localState.runner_token}`,
      'x-archie-fence': localState.fence_token,
      'content-type': 'application/octet-stream'
    },
    body: Buffer.from('not admitted')
  });
  assert.equal(notAdmitted.status, 403);

  const tamperedEvent = {
    schema: 'archie-hybrid-run-event/v1',
    lease_id: localState.lease_id,
    sequence: 2,
    kind: 'tampered',
    summary: 'This digest is intentionally invalid.',
    occurred_at: new Date().toISOString(),
    previous_digest: localState.event_head,
    payload_digest: sha256(stableJSONStringify({ tampered: true })),
    digest: '0'.repeat(64)
  };
  const tampered = await fetch(new URL(`/v1/hybrid/runner/leases/${localState.lease_id}/events`, runtime.url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${localState.runner_token}`,
      'x-archie-fence': localState.fence_token,
      'content-type': 'application/json'
    },
    body: JSON.stringify(tamperedEvent)
  });
  assert.equal(tampered.status, 400);

  const completed = await runHybridRunnerOnce({ baseUrl: runtime.url, root: runnerRoot });
  assert.equal(completed.status, 'completed');
  assert.match(completed.terminal_receipt_digest, /^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(path.join(runnerRoot, 'output', 'result.json'), 'utf8'), completeContent);

  const workspace = (await runtime.internal.engine.readState('workspace_hybrid')).state;
  assert.equal(workspace.tasks.task_complete.status, 'completed');
  const completedRun = Object.values(workspace.runs).find(run => run.task_id === 'task_complete');
  assert.ok(completedRun);
  assert.equal(completedRun.status, 'completed');
  assert.match(completedRun.agent_id, /^runner_[a-f0-9]{24}$/);
  assert.ok(completedRun.events.length >= 4);
  assert.ok(completedRun.events.every(event => /^hybrid:/.test(event.kind)));
  const completeArtifactEntry = Object.entries(workspace.artifacts).find(([, artifact]) => artifact.name === 'result.json');
  const terminalArtifactEntry = Object.entries(workspace.artifacts).find(([, artifact]) => artifact.name === 'hybrid-terminal-receipt.json');
  assert.ok(completeArtifactEntry);
  assert.ok(terminalArtifactEntry);
  const completeArtifact = await runtime.internal.engine.readArtifact('workspace_hybrid', completeArtifactEntry[0], { principalId: 'owner_local' });
  assert.equal(completeArtifact.bytes.toString('utf8'), completeContent);
  const terminalArtifact = await runtime.internal.engine.readArtifact('workspace_hybrid', terminalArtifactEntry[0], { principalId: 'owner_local' });
  const terminalReceipt = JSON.parse(terminalArtifact.bytes.toString('utf8'));
  assert.equal(terminalReceipt.schema, 'archie-hybrid-terminal-receipt/v1');
  assert.equal(terminalReceipt.authority.contact, false);
  assert.equal(terminalReceipt.authority.spend, false);
  assert.equal(terminalReceipt.authority.deploy, false);
  assert.equal(terminalReceipt.authority.network, false);
  assert.equal(JSON.stringify(terminalReceipt).includes(runnerRoot), false);

  const registryPath = path.join(home, 'standalone', 'hosted', 'enrolled-hybrid', 'registry.json');
  const registryText = await fs.readFile(registryPath, 'utf8');
  assert.equal(registryText.includes(enrollment.enrollment_token), false);
  assert.equal(registryText.includes(localState.runner_token), false);
  assert.equal(registryText.includes(localState.fence_token), false);
  assert.equal(JSON.stringify(workspace).includes(localState.runner_token), false);
  assert.equal(JSON.stringify(workspace).includes(localState.fence_token), false);

  const usedEnrollment = await fetch(new URL('/v1/hybrid/runner/enroll', runtime.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollment_token: enrollment.enrollment_token,
      advertisement: await defaultRunnerAdvertisement(runnerRoot)
    })
  });
  assert.notEqual(usedEnrollment.status, 201);

  const failureContent = `${JSON.stringify({ schema: 'hybrid-result/v1', should_not_exist: true })}\n`;
  const failureOffer = await founderJson(runtime, '/v1/hybrid/founder/offers', {
    method: 'POST',
    body: offer({
      workspaceId: 'workspace_hybrid',
      taskId: 'task_failure',
      title: 'Prove terminal local failure',
      filename: 'failure.json',
      content: failureContent
    })
  });
  assert.equal(failureOffer.response.status, 201);

  const failed = await runHybridRunnerOnce({ baseUrl: runtime.url, root: runnerRoot, injectFailure: true });
  assert.equal(failed.status, 'failed');
  assert.match(failed.failure_receipt_digest, /^[a-f0-9]{64}$/);
  assert.equal(await fs.stat(path.join(runnerRoot, 'output', 'failure.json')).then(() => true, () => false), false);

  const finalState = (await runtime.internal.engine.readState('workspace_hybrid')).state;
  assert.equal(finalState.tasks.task_failure.status, 'blocked');
  const failedRun = Object.values(finalState.runs).find(run => run.task_id === 'task_failure');
  assert.equal(failedRun.status, 'blocked');
  const failureArtifactEntry = Object.entries(finalState.artifacts).find(([, artifact]) => artifact.name === 'hybrid-failure-receipt.json');
  assert.ok(failureArtifactEntry);
  const failureArtifact = await runtime.internal.engine.readArtifact('workspace_hybrid', failureArtifactEntry[0], { principalId: 'owner_local' });
  const failureReceipt = JSON.parse(failureArtifact.bytes.toString('utf8'));
  assert.equal(failureReceipt.schema, 'archie-hybrid-failure-receipt/v1');
  assert.equal(failureReceipt.status, 'failed');
  assert.equal(failureReceipt.authority.deploy, false);
  assert.equal(JSON.stringify(failureReceipt).includes(runnerRoot), false);

  const status = await founderJson(runtime, '/v1/hybrid/founder/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.value.completed_lease_count, 1);
  assert.equal(status.value.failed_lease_count, 1);
  assert.equal(status.value.active_lease_count, 0);
  assert.equal(status.value.inbound_runner_access_required, false);
  assert.equal(status.value.artifact_upload_policy, 'explicit_only');
});

test('the enrolled runner opens no inbound listener and has one explicit CLI', async () => {
  const source = await fs.readFile(new URL('../archie-enrolled-hybrid-runner.mjs', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /createServer\s*\(|\.listen\s*\(/);
  assert.doesNotMatch(source, /node:http/);
  assert.match(source, /inbound_access:\s*false/);
  assert.match(source, /artifact_upload:\s*'explicit_only'/);
  assert.equal(packageJson.bin['archie-enrolled-hybrid-runner'], 'scripts/archie-enrolled-hybrid-runner.mjs');
  assert.equal(packageJson.scripts['archie:runner:enrolled'], 'node scripts/archie-enrolled-hybrid-runner.mjs');
});
