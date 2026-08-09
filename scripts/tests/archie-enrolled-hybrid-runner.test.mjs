import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startHostedArchied } from '../archied-hosted.mjs';
import { defaultRunnerAdvertisement, runHybridRunnerOnce } from '../archie-enrolled-hybrid-runner.mjs';
import { tokenSha256 } from '../archie-hosted-security.mjs';
import { sha256 } from '../archie-workspace-core.mjs';

const founderToken = 'founder-hybrid-test-token-0123456789-abcdefghijklmnopqrstuvwxyz';
const developerToken = 'developer-hybrid-test-token-0123456789-abcdefghijklmnopqrstuvwxyz';
const capabilities = ['artifact.upload', 'directory.read', 'directory.write', 'event.stream', 'process.verify', 'resume'];

async function temporary(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function hostedOptions(home) {
  return {
    home, host: '127.0.0.1', port: 0, publicUrl: 'http://archie.test/',
    founderTokenSha256: tokenSha256(founderToken),
    developerTokenSha256: tokenSha256(developerToken),
    sessionKey: crypto.randomBytes(32).toString('base64'),
    secretKey: crypto.randomBytes(32).toString('base64'),
    allowInsecure: true, env: {}
  };
}

async function request(runtime, pathname, { method = 'GET', body = null, token = founderToken } = {}) {
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

function offer(taskId, filename, content) {
  const bytes = Buffer.from(content, 'utf8');
  return {
    workspace_id: 'workspace_hybrid', task_id: taskId, title: `Materialize ${filename}`,
    required_protocol_version: '1.0.0', required_capabilities: capabilities,
    minimum_resources: { memory_bytes: 1, disk_free_bytes: 1 }, allowed_paths: ['output/**'],
    execution: {
      schema: 'archie-hybrid-materialize-files/v1', request: `Materialize ${filename}.`,
      files: [{ path: `output/${filename}`, content_base64: bytes.toString('base64'), sha256: sha256(bytes) }]
    },
    artifact_admission: [{
      artifact_id: `artifact_${taskId}`, path: `output/${filename}`, name: filename,
      media_type: 'application/json', required: true, max_bytes: 100_000, sha256: sha256(bytes)
    }],
    lease_ttl_ms: 120_000
  };
}

async function seedWorkspace(runtime) {
  const engine = runtime.internal.engine;
  await engine.createWorkspace({ workspace_id: 'workspace_hybrid', title: 'Outbound runner', visibility: 'private', owner_id: 'owner_local' });
  await engine.execute('workspace_hybrid', 'owner_local', 'objective.define', {
    objective_id: 'objective_hybrid', statement: 'Execute bounded local work without inbound runner access.'
  });
  await engine.execute('workspace_hybrid', 'owner_local', 'task_graph.create', {
    objective_id: 'objective_hybrid', tasks: [
      { task_id: 'task_complete', title: 'Complete', description: 'Complete one bounded result.', depends_on: [] },
      { task_id: 'task_failure', title: 'Fail', description: 'Record one bounded failure.', depends_on: [] }
    ]
  });
}

test('enrolled runner resumes fenced outbound work and emits digest-bound terminal evidence', async t => {
  const home = await temporary(t, 'archie-runner-hosted-');
  const runnerRoot = await temporary(t, 'archie-runner-local-');
  const runtime = await startHostedArchied(hostedOptions(home));
  t.after(() => runtime.close().catch(() => {}));
  await seedWorkspace(runtime);

  const developerEnrollment = await request(runtime, '/v1/hybrid/founder/enrollments', {
    method: 'POST', token: developerToken,
    body: { expires_in_seconds: 600, required_protocol_version: '1.0.0', required_capabilities: capabilities }
  });
  assert.equal(developerEnrollment.response.status, 403);

  const forbidden = await request(runtime, '/v1/hybrid/founder/offers', {
    method: 'POST', body: { ...offer('task_complete', 'forbidden.json', '{"ok":false}\n'), required_capabilities: ['deploy'] }
  });
  assert.equal(forbidden.response.status, 403);

  const enrollmentResult = await request(runtime, '/v1/hybrid/founder/enrollments', {
    method: 'POST', body: { expires_in_seconds: 600, required_protocol_version: '1.0.0', required_capabilities: capabilities }
  });
  assert.equal(enrollmentResult.response.status, 201);
  const enrollment = enrollmentResult.value;
  assert.equal(enrollment.token_disclosed_once, true);

  const content = '{"schema":"hybrid-result/v1","ok":true}\n';
  assert.equal((await request(runtime, '/v1/hybrid/founder/offers', { method: 'POST', body: offer('task_complete', 'result.json', content) })).response.status, 201);

  const interrupted = await runHybridRunnerOnce({ baseUrl: runtime.url, enrollmentToken: enrollment.enrollment_token, root: runnerRoot, stopAfter: 'claimed' });
  assert.equal(interrupted.status, 'interrupted_after_claim');
  const statePath = path.join(runnerRoot, '.archie-runner', 'state.json');
  const local = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.match(local.runner_token, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(local.fence_token, /^[A-Za-z0-9_-]{32,}$/);

  const wrongFence = await fetch(new URL(`/v1/hybrid/runner/leases/${local.lease_id}/events`, runtime.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${local.runner_token}`, 'x-archie-fence': 'wrong', 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(wrongFence.status, 403);

  const completed = await runHybridRunnerOnce({ baseUrl: runtime.url, root: runnerRoot });
  assert.equal(completed.status, 'completed');
  assert.equal(await fs.readFile(path.join(runnerRoot, 'output', 'result.json'), 'utf8'), content);
  assert.match(completed.terminal_receipt_digest, /^[a-f0-9]{64}$/);

  const workspace = (await runtime.internal.engine.readState('workspace_hybrid')).state;
  const run = Object.values(workspace.runs).find(item => item.task_id === 'task_complete');
  assert.equal(run.status, 'completed');
  const terminalEntry = Object.entries(workspace.artifacts).find(([, artifact]) => artifact.name === 'hybrid-terminal-receipt.json');
  assert.ok(terminalEntry);
  const terminal = JSON.parse((await runtime.internal.engine.readArtifact('workspace_hybrid', terminalEntry[0], { principalId: 'owner_local' })).bytes.toString('utf8'));
  assert.equal(terminal.schema, 'archie-hybrid-terminal-receipt/v1');
  assert.equal(terminal.authority.deploy, false);
  assert.equal(terminal.authority.network, false);
  assert.equal(JSON.stringify(terminal).includes(runnerRoot), false);

  const registry = await fs.readFile(path.join(home, 'standalone', 'hosted', 'enrolled-hybrid', 'registry.json'), 'utf8');
  assert.equal(registry.includes(enrollment.enrollment_token), false);
  assert.equal(registry.includes(local.runner_token), false);
  assert.equal(registry.includes(local.fence_token), false);

  const reuse = await fetch(new URL('/v1/hybrid/runner/enroll', runtime.url), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enrollment_token: enrollment.enrollment_token, advertisement: await defaultRunnerAdvertisement(runnerRoot) })
  });
  assert.notEqual(reuse.status, 201);
});

test('enrolled runner records bounded failure and opens no inbound listener', async t => {
  const home = await temporary(t, 'archie-runner-fail-hosted-');
  const runnerRoot = await temporary(t, 'archie-runner-fail-local-');
  const runtime = await startHostedArchied(hostedOptions(home));
  t.after(() => runtime.close().catch(() => {}));
  await seedWorkspace(runtime);

  const enrollment = (await request(runtime, '/v1/hybrid/founder/enrollments', {
    method: 'POST', body: { expires_in_seconds: 600, required_protocol_version: '1.0.0', required_capabilities: capabilities }
  })).value;
  assert.equal((await request(runtime, '/v1/hybrid/founder/offers', {
    method: 'POST', body: offer('task_failure', 'failure.json', '{"should_not_exist":true}\n')
  })).response.status, 201);

  const failed = await runHybridRunnerOnce({ baseUrl: runtime.url, enrollmentToken: enrollment.enrollment_token, root: runnerRoot, injectFailure: true });
  assert.equal(failed.status, 'failed');
  assert.match(failed.failure_receipt_digest, /^[a-f0-9]{64}$/);
  assert.equal(await fs.stat(path.join(runnerRoot, 'output', 'failure.json')).then(() => true, () => false), false);

  const state = (await runtime.internal.engine.readState('workspace_hybrid')).state;
  assert.equal(state.tasks.task_failure.status, 'blocked');
  const source = await fs.readFile(new URL('../archie-enrolled-hybrid-runner.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createServer\s*\(|\.listen\s*\(|node:http/);
  assert.match(source, /inbound_access:\s*false/);

  const packageJson = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.bin['archie-enrolled-hybrid-runner'], 'scripts/archie-enrolled-hybrid-runner.mjs');
  assert.equal(packageJson.bin['archie-hybrid-runner'], 'scripts/archie-enrolled-hybrid-runner.mjs');
  assert.equal(packageJson.scripts['runner:enrolled'], 'node scripts/archie-enrolled-hybrid-runner.mjs');
});
