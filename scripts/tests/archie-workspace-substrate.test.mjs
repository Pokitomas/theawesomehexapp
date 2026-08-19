import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MemoryWorkspaceProvider,
  WorkspaceAuthorityError,
  WorkspaceConflictError,
  createWorkspaceEngine,
  verifyWorkspaceEventStream
} from '../archie-workspace-core.mjs';
import { SafeFileWorkspaceProvider } from '../archie-workspace-file-provider.mjs';
import { startWorkspaceService } from '../archie-workspace-service.mjs';

function engine(provider) {
  let id = 0;
  let tick = 0;
  return createWorkspaceEngine({
    provider,
    idFactory: prefix => `${prefix}_${String(++id).padStart(4, '0')}`,
    clock: () => new Date(Date.UTC(2026, 7, 8, 20, 0, tick++)).toISOString()
  });
}

async function seed(runtime, workspaceId = 'workspace_alpha', visibility = 'public') {
  await runtime.createWorkspace({ workspace_id: workspaceId, title: 'ARCHIE workspace', visibility, owner_id: 'owner_local' });
  await runtime.execute(workspaceId, 'owner_local', 'objective.define', {
    objective_id: 'objective_alpha', statement: 'Produce one digest-bound result.'
  });
  await runtime.execute(workspaceId, 'owner_local', 'agent.register', { agent_id: 'worker_local', label: 'Worker', kind: 'service' });
  await runtime.execute(workspaceId, 'owner_local', 'task_graph.create', {
    objective_id: 'objective_alpha', tasks: [{ task_id: 'task_alpha', title: 'Build', description: 'Build one result.', depends_on: [] }]
  });
  await runtime.execute(workspaceId, 'owner_local', 'grant.issue', {
    grant_id: 'grant_worker', principal_id: 'worker_local', task_id: 'task_alpha', capabilities: ['read', 'write', 'run']
  });
  await runtime.execute(workspaceId, 'worker_local', 'lease.claim', { task_id: 'task_alpha', lease_id: 'lease_alpha', ttl_ms: 60_000 });
  await runtime.execute(workspaceId, 'worker_local', 'run.start', { task_id: 'task_alpha', run_id: 'run_alpha' });
  await runtime.execute(workspaceId, 'worker_local', 'artifact.record', {
    run_id: 'run_alpha', artifact_id: 'artifact_alpha', name: 'result.txt', media_type: 'text/plain', content: 'verified result\n'
  });
  return runtime.execute(workspaceId, 'worker_local', 'run.complete', { run_id: 'run_alpha', summary: 'Done.' });
}

test('workspace events are digest chained and raw artifact bytes stay outside the event stream', async () => {
  const provider = new MemoryWorkspaceProvider();
  const runtime = engine(provider);
  const final = await seed(runtime);
  const events = await provider.readEvents('workspace_alpha');
  assert.equal(verifyWorkspaceEventStream(events, 'workspace_alpha').head_digest, final.state.head_digest);
  assert.equal(JSON.stringify(events).includes('verified result'), false);
  const artifact = await runtime.readArtifact('workspace_alpha', 'artifact_alpha');
  assert.equal(artifact.bytes.toString('utf8'), 'verified result\n');

  const tampered = structuredClone(events);
  tampered[1].payload.objective.statement = 'tampered';
  assert.throws(() => verifyWorkspaceEventStream(tampered, 'workspace_alpha'), /payload digest mismatch/);
});

test('single-writer lease and principal scope fail closed', async () => {
  const runtime = engine(new MemoryWorkspaceProvider());
  await runtime.createWorkspace({ workspace_id: 'workspace_scope', title: 'Scope', visibility: 'private', owner_id: 'owner_local' });
  await runtime.execute('workspace_scope', 'owner_local', 'objective.define', { objective_id: 'objective_scope', statement: 'Test scope.' });
  for (const worker of ['worker_one', 'worker_two']) {
    await runtime.execute('workspace_scope', 'owner_local', 'agent.register', { agent_id: worker, label: worker, kind: 'service' });
  }
  await runtime.execute('workspace_scope', 'owner_local', 'task_graph.create', {
    objective_id: 'objective_scope', tasks: [{ task_id: 'task_scope', title: 'Task', description: 'Task', depends_on: [] }]
  });
  for (const worker of ['worker_one', 'worker_two']) {
    await runtime.execute('workspace_scope', 'owner_local', 'grant.issue', {
      principal_id: worker, task_id: 'task_scope', capabilities: ['read', 'write', 'run']
    });
  }
  await runtime.execute('workspace_scope', 'worker_one', 'lease.claim', { task_id: 'task_scope', lease_id: 'lease_one', ttl_ms: 60_000 });
  await assert.rejects(() => runtime.execute('workspace_scope', 'worker_two', 'lease.claim', { task_id: 'task_scope', ttl_ms: 60_000 }), WorkspaceConflictError);
  await assert.rejects(() => runtime.inspect('workspace_scope'), WorkspaceAuthorityError);
});

test('file provider survives restart without leaking local paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = engine(new SafeFileWorkspaceProvider(root));
  await seed(first);
  const restarted = engine(new SafeFileWorkspaceProvider(root));
  const state = await restarted.inspect('workspace_alpha');
  const artifact = await restarted.readArtifact('workspace_alpha', 'artifact_alpha');
  assert.equal(artifact.artifact.provider_uri, `archie-artifact://workspace_alpha/${artifact.artifact.sha256}`);
  assert.equal(JSON.stringify(state).includes(root), false);
  assert.doesNotMatch(JSON.stringify(state), /file:\/\//i);
});

test('HTTP service separates public reads from private reads and keeps mutation local-principal scoped', async t => {
  const provider = new MemoryWorkspaceProvider();
  const runtime = engine(provider);
  await seed(runtime, 'workspace_alpha', 'public');
  await runtime.createWorkspace({ workspace_id: 'workspace_private', title: 'Private', visibility: 'private', owner_id: 'owner_private' });
  const service = await startWorkspaceService({ provider, engine: runtime, host: '127.0.0.1', port: 0 });
  t.after(() => service.close());

  assert.equal((await fetch(new URL('v1/workspaces/workspace_alpha', service.url))).status, 200);
  assert.equal((await fetch(new URL('v1/workspaces/workspace_private', service.url))).status, 403);
  assert.equal((await fetch(new URL('v1/workspaces/workspace_private', service.url), { headers: { 'x-archie-principal': 'owner_private' } })).status, 200);

  const artifact = await fetch(new URL('v1/workspaces/workspace_alpha/artifacts/artifact_alpha', service.url));
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get('x-archie-artifact-id'), 'artifact_alpha');
  assert.equal(await artifact.text(), 'verified result\n');
});
