import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startArchied } from '../archied.mjs';
import { executeStandaloneJourney } from '../archie-standalone-journey.mjs';
import {
  importWorkspaceBundle,
  readWorkspaceBundle,
  verifyWorkspaceBundle
} from '../archie-workspace-portable.mjs';
import { createWorkspaceEngine } from '../archie-workspace-core.mjs';
import { SafeFileWorkspaceProvider } from '../archie-workspace-file-provider.mjs';

const objective = 'Make this local workflow genuinely good on a phone while reducing work and preserving human control.';
const requestedChange = 'Add the final audit trail and preserve why the alternative hypothesis lost.';

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('standalone journey executes Maker, revision, evidence, approval, rollback, and portable restore', async t => {
  const root = await tempRoot(t, 'archie-standalone-');
  const sourceProvider = new SafeFileWorkspaceProvider(path.join(root, 'source', 'workspaces'));
  const sourceEngine = createWorkspaceEngine({ provider: sourceProvider });

  const result = await executeStandaloneJourney({
    engine: sourceEngine,
    dataRoot: path.join(root, 'source'),
    objective,
    requestedChange,
    approve: true
  });

  assert.equal(result.schema, 'archie-standalone-journey/v1');
  assert.match(result.workspace_id, /^workspace_[a-f0-9]{16}$/);
  assert.match(result.first_maker_receipt_digest, /^[a-f0-9]{64}$/);
  assert.match(result.repaired_maker_receipt_digest, /^[a-f0-9]{64}$/);
  assert.match(result.bundle_digest, /^[a-f0-9]{64}$/);
  assert.match(result.bundle_uri, /^archie-export:\/\//);

  const full = (await sourceEngine.readState(result.workspace_id)).state;
  assert.equal(full.workspace.visibility, 'private');
  assert.equal(full.tasks.task_product.status, 'approved');
  assert.equal(full.requested_changes.change_product.status, 'resolved');
  assert.equal(full.reviews.review_first.decision, 'changes_requested');
  assert.equal(full.reviews.review_repair.decision, 'approved');
  assert.equal(full.evidence.evidence_product.result, 'pass');
  assert.equal(full.promotions.promotion_product.decision, 'approved');
  assert.match(full.rollbacks.rollback_product.receipt_digest, /^[a-f0-9]{64}$/);

  const repaired = await sourceEngine.readArtifact(result.workspace_id, 'artifact_repaired', { principalId: 'owner_local' });
  const payload = JSON.parse(repaired.bytes.toString('utf8'));
  assert.equal(payload.schema, 'archie-maker-product-artifact/v1');
  assert.equal(payload.documents.candidate.audit_trail, true);
  assert.equal(payload.documents.candidate.requested_change_applied, requestedChange);
  assert.equal(payload.documents.decision.rejected_hypothesis_id, 'command_first');
  assert.deepEqual(payload.maker_receipt.changed_paths, [
    'product/baseline.json',
    'product/candidate.json',
    'product/decision.json',
    'product/hypotheses.json'
  ]);
  assert.equal(payload.maker_receipt.status, 'ready');
  assert.equal(payload.maker_receipt.lease.authority.merge, 'human');
  assert.equal(payload.maker_receipt.lease.authority.deploy, 'human');
  assert.equal(JSON.stringify(payload).includes(root), false, 'receipts must not disclose local filesystem paths');
  assert.equal(JSON.stringify(payload).toLowerCase().includes('github'), false);

  const bundle = await readWorkspaceBundle(result.bundle_path);
  assert.equal(verifyWorkspaceBundle(bundle).bundle_digest, result.bundle_digest);
  assert.equal(bundle.head_digest, result.head_digest);
  assert.equal(bundle.event_count, result.event_count);
  assert.equal(bundle.artifacts.length, 2);

  const restoredProvider = new SafeFileWorkspaceProvider(path.join(root, 'restored', 'workspaces'));
  const imported = await importWorkspaceBundle({ provider: restoredProvider, bundle });
  assert.equal(imported.bundle_digest, result.bundle_digest);
  const restoredEngine = createWorkspaceEngine({ provider: restoredProvider });
  const restored = (await restoredEngine.readState(result.workspace_id)).state;
  assert.equal(restored.head_digest, result.head_digest);
  assert.equal(restored.event_count, result.event_count);
  assert.equal(restored.grants.grant_maker.principal_id, 'agent_maker');
  assert.equal(restored.leases.lease_product.task_id, 'task_product');
  const restoredArtifact = await restoredEngine.readArtifact(result.workspace_id, 'artifact_repaired', { principalId: 'owner_local' });
  assert.equal(restoredArtifact.artifact.sha256, repaired.artifact.sha256);
  assert.deepEqual(restoredArtifact.bytes, repaired.bytes);

  const tampered = structuredClone(bundle);
  tampered.artifacts[0].content_base64 = Buffer.from('tampered').toString('base64');
  assert.throws(() => verifyWorkspaceBundle(tampered), /bundle digest mismatch|artifact digest mismatch/);
});

test('standalone journey refuses promotion without explicit approval', async t => {
  const root = await tempRoot(t, 'archie-no-approval-');
  const provider = new SafeFileWorkspaceProvider(path.join(root, 'workspaces'));
  const engine = createWorkspaceEngine({ provider });
  await assert.rejects(
    executeStandaloneJourney({ engine, dataRoot: root, objective, requestedChange, approve: false }),
    /explicit approval/
  );
  assert.deepEqual(await provider.listWorkspaceIds(), []);
});

test('archied serves one client, executes the local journey, exports it, and survives restart', async t => {
  const home = await tempRoot(t, 'archied-product-');
  const first = await startArchied({ home, host: '127.0.0.1', port: 0 });
  t.after(() => first.close().catch(() => {}));

  const clientResponse = await fetch(first.url);
  assert.equal(clientResponse.status, 200);
  const client = await clientResponse.text();
  assert.match(client, /State what should be true/);
  assert.match(client, /Run bounded local journey/);
  assert.doesNotMatch(client, /github\.com/i);

  const denied = await fetch(new URL('v1/standalone/journeys', first.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objective, requested_change: requestedChange, approve: true })
  });
  assert.equal(denied.status, 403);

  const journeyResponse = await fetch(new URL('v1/standalone/journeys', first.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-archie-principal': 'owner_local' },
    body: JSON.stringify({ objective, requested_change: requestedChange, approve: true })
  });
  assert.equal(journeyResponse.status, 201);
  const journey = await journeyResponse.json();
  assert.equal('bundle_path' in journey, false, 'HTTP receipts must not expose local paths');
  assert.match(journey.bundle_digest, /^[a-f0-9]{64}$/);

  const inspectResponse = await fetch(new URL(`v1/workspaces/${journey.workspace_id}`, first.url), {
    headers: { 'x-archie-principal': 'owner_local' }
  });
  assert.equal(inspectResponse.status, 200);
  const state = await inspectResponse.json();
  assert.equal(state.tasks.task_product.status, 'approved');
  assert.equal(state.rollbacks.rollback_product.publication_id, 'publication_product');

  const exportResponse = await fetch(new URL(`v1/standalone/workspaces/${journey.workspace_id}/export`, first.url), {
    headers: { 'x-archie-principal': 'owner_local' }
  });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-disposition'), /\.archie\.json/);
  assert.equal(exportResponse.headers.get('x-archie-bundle-digest'), journey.bundle_digest);
  const bundle = await exportResponse.json();
  assert.equal(verifyWorkspaceBundle(bundle).bundle_digest, journey.bundle_digest);
  assert.equal(JSON.stringify(bundle).includes(home), false);

  await first.close();
  const restarted = await startArchied({ home, host: '127.0.0.1', port: 0 });
  t.after(() => restarted.close().catch(() => {}));
  const afterRestart = await fetch(new URL(`v1/workspaces/${journey.workspace_id}`, restarted.url), {
    headers: { 'x-archie-principal': 'owner_local' }
  });
  assert.equal(afterRestart.status, 200);
  const restartedState = await afterRestart.json();
  assert.equal(restartedState.head_digest, journey.head_digest);
  assert.equal(restartedState.event_count, journey.event_count);
});
