import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileWorkspaceProvider,
  MemoryWorkspaceProvider,
  WorkspaceAuthorityError,
  WorkspaceConflictError,
  createWorkspaceEngine,
  verifyWorkspaceEventStream
} from '../archie-workspace-core.mjs';
import { startWorkspaceService } from '../archie-workspace-service.mjs';

function deterministicEngine(provider) {
  let id = 0;
  let tick = 0;
  return createWorkspaceEngine({
    provider,
    idFactory: prefix => `${prefix}_${String(++id).padStart(4, '0')}`,
    clock: () => new Date(Date.UTC(2026, 6, 17, 6, 0, tick++)).toISOString()
  });
}

async function completeJourney(engine, { visibility = 'public' } = {}) {
  const created = await engine.createWorkspace({ workspace_id: 'workspace_alpha', title: 'Native Archie workspace', visibility, owner_id: 'owner_local' });
  await engine.execute('workspace_alpha', 'owner_local', 'objective.define', {
    objective_id: 'objective_alpha',
    statement: 'Produce a reviewed result without using a source host as the canonical task database.',
    protected_reality: 'Do not expose secrets or claim unobserved execution.',
    proof_of_done: 'A repaired artifact, independent evidence, approval, publication, and rollback receipt.'
  });
  for (const agent of [
    { agent_id: 'agent_maker', label: 'Maker adapter', kind: 'service' },
    { agent_id: 'reviewer_local', label: 'Independent reviewer', kind: 'human' },
    { agent_id: 'policy_local', label: 'Promotion principal', kind: 'policy' }
  ]) await engine.execute('workspace_alpha', 'owner_local', 'agent.register', agent);
  await engine.execute('workspace_alpha', 'owner_local', 'task_graph.create', {
    objective_id: 'objective_alpha',
    tasks: [{ task_id: 'task_alpha', title: 'Build result', description: 'Create and repair the bounded result.', depends_on: [] }]
  });
  await engine.execute('workspace_alpha', 'owner_local', 'grant.issue', {
    grant_id: 'grant_agent', principal_id: 'agent_maker', task_id: 'task_alpha', capabilities: ['read', 'write', 'run']
  });
  await engine.execute('workspace_alpha', 'owner_local', 'grant.issue', {
    grant_id: 'grant_review', principal_id: 'reviewer_local', capabilities: ['read', 'review']
  });
  await engine.execute('workspace_alpha', 'owner_local', 'grant.issue', {
    grant_id: 'grant_policy', principal_id: 'policy_local', capabilities: ['read', 'approve', 'deploy']
  });
  await engine.execute('workspace_alpha', 'agent_maker', 'lease.claim', { task_id: 'task_alpha', lease_id: 'lease_alpha', ttl_ms: 3_600_000 });
  await engine.execute('workspace_alpha', 'agent_maker', 'run.start', { task_id: 'task_alpha', run_id: 'run_first' });
  await engine.execute('workspace_alpha', 'agent_maker', 'run.append_event', { run_id: 'run_first', kind: 'build', summary: 'Built the first candidate.' });
  await engine.execute('workspace_alpha', 'agent_maker', 'artifact.record', {
    run_id: 'run_first', artifact_id: 'artifact_first', name: 'result.txt', media_type: 'text/plain', content: 'first candidate'
  });
  await engine.execute('workspace_alpha', 'agent_maker', 'run.complete', { run_id: 'run_first', summary: 'First candidate complete.' });
  await engine.execute('workspace_alpha', 'reviewer_local', 'review.submit', {
    review_id: 'review_first', requested_change_id: 'change_alpha', artifact_id: 'artifact_first', decision: 'changes_requested',
    reason: 'The evidence boundary is absent.', request: 'Add the evidence boundary.'
  });
  await engine.execute('workspace_alpha', 'agent_maker', 'run.start', { task_id: 'task_alpha', run_id: 'run_repair', parent_run_id: 'run_first' });
  await engine.execute('workspace_alpha', 'agent_maker', 'run.append_event', { run_id: 'run_repair', kind: 'repair', summary: 'Added the evidence boundary.' });
  await engine.execute('workspace_alpha', 'agent_maker', 'artifact.record', {
    run_id: 'run_repair', artifact_id: 'artifact_repaired', name: 'result.txt', media_type: 'text/plain',
    content: 'repaired candidate\nclaim boundary: independent evidence is required\n'
  });
  await engine.execute('workspace_alpha', 'agent_maker', 'run.complete', { run_id: 'run_repair', summary: 'Repair complete.' });
  await engine.execute('workspace_alpha', 'agent_maker', 'change.resolve', {
    requested_change_id: 'change_alpha', resolution_artifact_id: 'artifact_repaired', reason: 'Boundary added and artifact reproduced.'
  });
  await engine.execute('workspace_alpha', 'reviewer_local', 'review.submit', {
    review_id: 'review_repair', artifact_id: 'artifact_repaired', decision: 'approved', reason: 'Requested change is satisfied.'
  });
  await engine.execute('workspace_alpha', 'reviewer_local', 'evidence.record', {
    evidence_id: 'evidence_alpha', run_id: 'run_repair', result: 'pass',
    checks: ['artifact-digest', 'change-resolution', 'claim-boundary'], summary: 'Independent checks passed.'
  });
  await engine.execute('workspace_alpha', 'policy_local', 'promotion.approve', {
    approval_id: 'approval_alpha', promotion_id: 'promotion_alpha', run_id: 'run_repair', artifact_id: 'artifact_repaired',
    reason: 'Review and evidence are complete.'
  });
  await engine.execute('workspace_alpha', 'policy_local', 'result.publish', {
    publication_id: 'publication_alpha', promotion_id: 'promotion_alpha', stable_url: 'https://archie.test/workspaces/workspace_alpha/results/latest'
  });
  const final = await engine.execute('workspace_alpha', 'policy_local', 'rollback.record', {
    rollback_id: 'rollback_alpha', publication_id: 'publication_alpha', reason: 'Rollback path independently recorded.'
  });
  return { created, final };
}

test('native object schemas are explicit and independently parseable', async () => {
  const names = ['workspace', 'objective', 'task', 'run', 'artifact', 'review', 'workspace-event'];
  for (const name of names) {
    const schema = JSON.parse(await fs.readFile(path.resolve(`maker/contracts/archie-${name}.schema.json`), 'utf8'));
    assert.match(schema.$schema, /2020-12/);
    assert.match(schema.$id, /archie-/);
    assert.equal(schema.type, 'object');
    assert.ok(schema.required.length >= 6);
  }
});

test('full local journey is append-only, reviewed, repaired, evidenced, promoted, published, and rollback-capable', async () => {
  const provider = new MemoryWorkspaceProvider();
  const engine = deterministicEngine(provider);
  const { final } = await completeJourney(engine);
  const state = final.state;

  assert.equal(state.workspace.visibility, 'public');
  assert.equal(state.tasks.task_alpha.status, 'approved');
  assert.equal(state.requested_changes.change_alpha.status, 'resolved');
  assert.equal(state.runs.run_first.status, 'completed');
  assert.equal(state.runs.run_repair.status, 'completed');
  assert.equal(state.reviews.review_first.decision, 'changes_requested');
  assert.equal(state.reviews.review_repair.decision, 'approved');
  assert.equal(state.evidence.evidence_alpha.result, 'pass');
  assert.equal(state.promotions.promotion_alpha.decision, 'approved');
  assert.equal(state.publications.publication_alpha.stable_url, 'https://archie.test/workspaces/workspace_alpha/results/latest');
  assert.match(state.rollbacks.rollback_alpha.receipt_digest, /^[a-f0-9]{64}$/);
  assert.match(state.head_digest, /^[a-f0-9]{64}$/);
  assert.ok(state.event_count >= 24);

  const events = await provider.readEvents('workspace_alpha');
  assert.equal(verifyWorkspaceEventStream(events, 'workspace_alpha').head_digest, state.head_digest);
  assert.equal(JSON.stringify(events).includes('repaired candidate'), false, 'raw artifact bytes must not enter the event stream');
  const artifact = await engine.readArtifact('workspace_alpha', 'artifact_repaired');
  assert.match(artifact.bytes.toString('utf8'), /independent evidence is required/);
});

test('single-writer leases and independent review authority fail closed', async () => {
  const provider = new MemoryWorkspaceProvider();
  const engine = deterministicEngine(provider);
  await engine.createWorkspace({ workspace_id: 'workspace_auth', title: 'Authority test', visibility: 'private', owner_id: 'owner_local' });
  await engine.execute('workspace_auth', 'owner_local', 'objective.define', { objective_id: 'objective_auth', statement: 'Test authority.' });
  await engine.execute('workspace_auth', 'owner_local', 'agent.register', { agent_id: 'agent_one', label: 'One', kind: 'model' });
  await engine.execute('workspace_auth', 'owner_local', 'agent.register', { agent_id: 'agent_two', label: 'Two', kind: 'model' });
  await engine.execute('workspace_auth', 'owner_local', 'task_graph.create', {
    objective_id: 'objective_auth', tasks: [{ task_id: 'task_auth', title: 'Task', description: 'Task' }]
  });
  for (const agent of ['agent_one', 'agent_two']) await engine.execute('workspace_auth', 'owner_local', 'grant.issue', {
    principal_id: agent, task_id: 'task_auth', capabilities: ['read', 'write', 'run']
  });
  await engine.execute('workspace_auth', 'agent_one', 'lease.claim', { task_id: 'task_auth', lease_id: 'lease_one', ttl_ms: 60_000 });
  await assert.rejects(() => engine.execute('workspace_auth', 'agent_two', 'lease.claim', { task_id: 'task_auth', ttl_ms: 60_000 }), WorkspaceConflictError);
  await assert.rejects(() => engine.inspect('workspace_auth'), WorkspaceAuthorityError);
  await assert.rejects(() => engine.execute('workspace_auth', 'agent_one', 'review.submit', {
    artifact_id: 'artifact_missing', decision: 'approved', reason: 'self review'
  }), WorkspaceAuthorityError);
});

test('event-chain tampering is independently detectable', async () => {
  const provider = new MemoryWorkspaceProvider();
  const engine = deterministicEngine(provider);
  await engine.createWorkspace({ workspace_id: 'workspace_chain', title: 'Chain test', visibility: 'public', owner_id: 'owner_local' });
  await engine.execute('workspace_chain', 'owner_local', 'objective.define', { objective_id: 'objective_chain', statement: 'Preserve event integrity.' });
  const events = await provider.readEvents('workspace_chain');
  events[1].payload.objective.statement = 'tampered';
  assert.throws(() => verifyWorkspaceEventStream(events, 'workspace_chain'), /payload digest mismatch/);
});

test('file provider survives restart and verifies artifact bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-workspace-'));
  const provider = new FileWorkspaceProvider(root);
  const engine = deterministicEngine(provider);
  await completeJourney(engine, { visibility: 'private' });
  const restarted = deterministicEngine(new FileWorkspaceProvider(root));
  const state = await restarted.inspect('workspace_alpha', { principalId: 'owner_local' });
  assert.equal(state.publications.publication_alpha.promotion_id, 'promotion_alpha');
  const artifact = await restarted.readArtifact('workspace_alpha', 'artifact_repaired', { principalId: 'owner_local' });
  assert.equal(artifact.artifact.sha256, artifact.artifact.provider_uri.split('/').at(-1));
  assert.equal(artifact.bytes.length, artifact.artifact.size_bytes);
});

test('HTTP service allows anonymous public reads, blocks anonymous private reads, and serves digest-bound artifacts', async t => {
  const provider = new MemoryWorkspaceProvider();
  const engine = deterministicEngine(provider);
  await completeJourney(engine, { visibility: 'public' });
  await engine.createWorkspace({ workspace_id: 'workspace_private', title: 'Private workspace', visibility: 'private', owner_id: 'owner_private' });
  const runtime = await startWorkspaceService({ provider, engine, host: '127.0.0.1', port: 0 });
  t.after(() => runtime.close());

  const descriptor = await fetch(new URL('.well-known/archie-workspace-service.json', runtime.url)).then(response => response.json());
  assert.equal(descriptor.anonymous_public_read, true);
  assert.doesNotMatch(JSON.stringify(descriptor), /github/i);

  const publicResponse = await fetch(new URL('v1/workspaces/workspace_alpha', runtime.url));
  assert.equal(publicResponse.status, 200);
  const publicState = await publicResponse.json();
  assert.equal(publicState.workspace.visibility, 'public');
  assert.equal('grants' in publicState, false);
  assert.equal('leases' in publicState, false);

  const privateResponse = await fetch(new URL('v1/workspaces/workspace_private', runtime.url));
  assert.equal(privateResponse.status, 403);
  const ownerResponse = await fetch(new URL('v1/workspaces/workspace_private', runtime.url), { headers: { 'x-archie-principal': 'owner_private' } });
  assert.equal(ownerResponse.status, 200);

  const artifactResponse = await fetch(new URL('v1/workspaces/workspace_alpha/artifacts/artifact_repaired', runtime.url));
  assert.equal(artifactResponse.status, 200);
  assert.equal(artifactResponse.headers.get('x-archie-artifact-id'), 'artifact_repaired');
  assert.match(await artifactResponse.text(), /claim boundary/);

  const latest = await fetch(new URL('v1/workspaces/workspace_alpha/results/latest', runtime.url)).then(response => response.json());
  assert.equal(latest.publication.publication_id, 'publication_alpha');
  assert.equal(latest.rollback_receipts[0].rollback_id, 'rollback_alpha');
});

test('local service mutation does not require a source-host account or token', async t => {
  const provider = new MemoryWorkspaceProvider();
  const engine = deterministicEngine(provider);
  const runtime = await startWorkspaceService({ provider, engine, host: '127.0.0.1', port: 0 });
  t.after(() => runtime.close());

  const response = await fetch(new URL('v1/workspaces', runtime.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-archie-principal': 'owner_http' },
    body: JSON.stringify({ workspace_id: 'workspace_http', title: 'HTTP workspace', visibility: 'public' })
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.workspace.owner_id, 'owner_http');

  const command = await fetch(new URL('v1/workspaces/workspace_http/commands', runtime.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-archie-principal': 'owner_http' },
    body: JSON.stringify({ command: 'objective.define', payload: { objective_id: 'objective_http', statement: 'Work without a source-host login.' } })
  });
  assert.equal(command.status, 200);
  const result = await command.json();
  assert.equal(result.command, 'objective.define');
  assert.match(result.head_digest, /^[a-f0-9]{64}$/);
});
