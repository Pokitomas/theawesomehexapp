import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MakerEngine, digest } from './maker-engine.mjs';
import { exportWorkspaceBundle, writeWorkspaceBundle } from './archie-workspace-portable.mjs';

export const ARCHIE_STANDALONE_JOURNEY_SCHEMA = 'archie-standalone-journey/v1';

function clean(value, limit = 20_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function identifier(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

async function ensureVerifier(filename) {
  const source = `import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const phase = process.argv[3];
const read = async name => JSON.parse(await fs.readFile(path.join(root, 'product', name), 'utf8'));
const baseline = await read('baseline.json');
const hypotheses = await read('hypotheses.json');
const candidate = await read('candidate.json');
const decision = await read('decision.json');
assert.equal(baseline.schema, 'archie-product-baseline/v1');
assert.equal(baseline.customer_value_claim, false);
assert.ok(Array.isArray(hypotheses.hypotheses));
assert.ok(hypotheses.hypotheses.length >= 2);
assert.equal(candidate.schema, 'archie-product-candidate/v1');
assert.equal(decision.schema, 'archie-product-decision/v1');
if (phase === 'first') {
  assert.equal(candidate.audit_trail, false);
  assert.equal(decision.status, 'provisional');
} else if (phase === 'repair') {
  assert.equal(candidate.audit_trail, true);
  assert.equal(decision.status, 'selected');
  assert.ok(candidate.requested_change_applied);
  assert.ok(decision.rejected_hypothesis_id);
} else {
  throw new Error('unknown verification phase');
}
process.stdout.write(JSON.stringify({ ok: true, phase, files: 4 }));
`;
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, source, { encoding: 'utf8', mode: 0o600 });
  return filename;
}

function productDocuments({ objective, requestedChange, phase }) {
  const baseline = {
    schema: 'archie-product-baseline/v1',
    objective,
    fixture_class: 'synthetic-mechanics-only',
    customer_value_claim: false,
    measures: {
      manual_steps: 7,
      correction_points: 3,
      evidence_completeness: 0.4,
      mobile_completion: false
    },
    claim_boundary: 'Synthetic values prove comparative workflow mechanics only. They are not customer evidence.'
  };
  const hypotheses = {
    schema: 'archie-product-hypotheses/v1',
    hypotheses: [
      {
        hypothesis_id: 'queue_first',
        premise: 'Show the next bounded work item and exception state before configuration.',
        expected_effect: 'Reduce navigation and uncertainty while preserving explicit review.'
      },
      {
        hypothesis_id: 'command_first',
        premise: 'Lead with one large process command and reveal queue state after submission.',
        expected_effect: 'Reduce first-action latency but risk hiding operational context.'
      }
    ]
  };
  const repaired = phase === 'repair';
  const candidate = {
    schema: 'archie-product-candidate/v1',
    selected_hypothesis_id: 'queue_first',
    surface: 'phone-first bounded work queue',
    objective,
    audit_trail: repaired,
    requested_change_applied: repaired ? requestedChange : null,
    measured_projection: repaired ? {
      manual_steps: 4,
      correction_points: 1,
      evidence_completeness: 1,
      mobile_completion: true
    } : {
      manual_steps: 4,
      correction_points: 1,
      evidence_completeness: 0.5,
      mobile_completion: true
    },
    claim_boundary: 'This candidate is a deterministic local fixture. Superiority remains unclaimed until a real workflow benchmark supplies observed evidence.'
  };
  const decision = {
    schema: 'archie-product-decision/v1',
    status: repaired ? 'selected' : 'provisional',
    selected_hypothesis_id: 'queue_first',
    rejected_hypothesis_id: repaired ? 'command_first' : null,
    reason: repaired
      ? 'Queue-first retained mobile context and the requested audit trail; command-first was deferred because it hides exception state.'
      : 'Queue-first is provisionally favored, but the first candidate lacks the required audit trail.',
    reusable_assets: ['baseline-evaluator', 'hypothesis-template', 'maker-plan', 'decision-record'],
    customer_value_claim: false
  };
  return { baseline, hypotheses, candidate, decision };
}

async function runMakerPass({ dataRoot, sandboxRoot, workspaceId, objective, requestedChange, phase }) {
  const verifierPath = await ensureVerifier(path.join(dataRoot, 'tools', 'verify-standalone-product.mjs'));
  const statePath = path.join(dataRoot, 'maker', `${workspaceId}-${phase}.json`);
  const baseSha = digest({ workspaceId, objective }).slice(0, 40);
  const branch = `workspace/${workspaceId}-${phase}`;
  const command = { program: 'node', args: [verifierPath, sandboxRoot, phase] };
  const maker = await MakerEngine.create({
    root: sandboxRoot,
    state_path: statePath,
    task: {
      repository: 'local/archie',
      base_sha: baseSha,
      branch,
      request: `Materialize the ${phase} bounded product hypothesis for ${workspaceId}.`,
      protect: 'Write only product/**. No network, contact, spending, deployment, repository metadata, or secret access.',
      proof: 'Exact file digests, allowlisted verification, append-only Maker events, and a terminal receipt.'
    },
    lease: {
      base_sha: baseSha,
      branch,
      writer_count: 1,
      owned_paths: ['product/**'],
      authority: { merge: 'human', deploy: 'human' }
    },
    command_policy: [command]
  });

  const documents = productDocuments({ objective, requestedChange, phase });
  for (const [name, value] of Object.entries(documents)) {
    await maker.write(`product/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
  }
  await maker.checkpoint(`${phase}-product-files-written`);
  const verification = await maker.verify([command]);
  if (!verification.ok) throw new Error(`Maker ${phase} verification failed.`);
  const receipt = await maker.receipt();
  return Object.freeze({
    phase,
    documents,
    receipt,
    artifact: {
      schema: 'archie-maker-product-artifact/v1',
      phase,
      documents,
      maker_receipt: receipt,
      reusable_assets: {
        evaluator: 'baseline and candidate measure comparison',
        plan: receipt.task.request,
        decision: documents.decision
      }
    }
  });
}

export async function executeStandaloneJourney({
  engine,
  dataRoot,
  objective,
  requestedChange = 'Add a complete audit trail before approval.',
  approve = false,
  visibility = 'private'
} = {}) {
  if (!engine) throw new Error('Standalone journey requires a workspace engine.');
  const statement = clean(objective, 8_000);
  if (!statement) throw new Error('Standalone journey requires an objective.');
  const revision = clean(requestedChange, 4_000);
  if (!revision) throw new Error('Standalone journey requires an explicit requested change.');
  if (approve !== true) throw new Error('Standalone journey requires explicit approval after evidence.');

  const workspaceId = identifier('workspace');
  const selectedDataRoot = path.resolve(dataRoot);
  const sandboxRoot = path.join(selectedDataRoot, 'sandboxes', workspaceId);
  await fs.mkdir(sandboxRoot, { recursive: true, mode: 0o700 });

  await engine.createWorkspace({ workspace_id: workspaceId, title: statement.slice(0, 160), visibility, owner_id: 'owner_local' });
  await engine.execute(workspaceId, 'owner_local', 'objective.define', {
    objective_id: 'objective_product',
    statement,
    protected_reality: 'No network, spending, contact, deployment, destructive writes, hidden source-host authority, or fabricated customer evidence.',
    proof_of_done: 'A real bounded Maker run, requested change, repaired artifact, independent evidence, explicit approval, rollback receipt, and portable export.'
  });
  for (const agent of [
    { agent_id: 'agent_maker', label: 'Local bounded Maker', kind: 'service', provider: 'local' },
    { agent_id: 'reviewer_local', label: 'Independent local reviewer', kind: 'human' },
    { agent_id: 'policy_local', label: 'Local approval principal', kind: 'policy' }
  ]) await engine.execute(workspaceId, 'owner_local', 'agent.register', agent);
  await engine.execute(workspaceId, 'owner_local', 'task_graph.create', {
    objective_id: 'objective_product',
    tasks: [{
      task_id: 'task_product',
      title: 'Discover, compare, implement, revise, and evidence a bounded product improvement',
      description: 'Record a baseline, produce competing hypotheses, execute one through Maker, request a change, rerun, evaluate, approve, and preserve reusable assets.',
      depends_on: []
    }]
  });
  await engine.execute(workspaceId, 'owner_local', 'grant.issue', {
    grant_id: 'grant_maker', principal_id: 'agent_maker', task_id: 'task_product', capabilities: ['read', 'write', 'run']
  });
  await engine.execute(workspaceId, 'owner_local', 'grant.issue', {
    grant_id: 'grant_review', principal_id: 'reviewer_local', capabilities: ['read', 'review']
  });
  await engine.execute(workspaceId, 'owner_local', 'grant.issue', {
    grant_id: 'grant_policy', principal_id: 'policy_local', capabilities: ['read', 'approve', 'deploy']
  });
  await engine.execute(workspaceId, 'agent_maker', 'lease.claim', {
    task_id: 'task_product', lease_id: 'lease_product', ttl_ms: 3_600_000
  });

  await engine.execute(workspaceId, 'agent_maker', 'run.start', { task_id: 'task_product', run_id: 'run_first' });
  await engine.execute(workspaceId, 'agent_maker', 'run.append_event', {
    run_id: 'run_first', kind: 'discovery', summary: 'Recorded a synthetic mechanics baseline and two materially different product hypotheses.'
  });
  const first = await runMakerPass({
    dataRoot: selectedDataRoot, sandboxRoot, workspaceId, objective: statement, requestedChange: revision, phase: 'first'
  });
  await engine.execute(workspaceId, 'agent_maker', 'run.append_event', {
    run_id: 'run_first', kind: 'maker', summary: `Maker completed the bounded first pass with receipt ${first.receipt.receipt_digest}.`
  });
  await engine.execute(workspaceId, 'agent_maker', 'artifact.record', {
    run_id: 'run_first', artifact_id: 'artifact_first', name: 'product-first.json', media_type: 'application/json',
    content: `${JSON.stringify(first.artifact, null, 2)}\n`
  });
  await engine.execute(workspaceId, 'agent_maker', 'run.complete', {
    run_id: 'run_first', summary: 'First bounded candidate completed and is awaiting independent review.'
  });
  await engine.execute(workspaceId, 'reviewer_local', 'review.submit', {
    review_id: 'review_first', requested_change_id: 'change_product', artifact_id: 'artifact_first',
    decision: 'changes_requested', reason: 'The first candidate improves mechanics but lacks the required final audit trail.', request: revision
  });

  await engine.execute(workspaceId, 'agent_maker', 'run.start', {
    task_id: 'task_product', run_id: 'run_repair', parent_run_id: 'run_first'
  });
  await engine.execute(workspaceId, 'agent_maker', 'run.append_event', {
    run_id: 'run_repair', kind: 'revision', summary: `Applying the explicit requested change: ${revision}`
  });
  const repair = await runMakerPass({
    dataRoot: selectedDataRoot, sandboxRoot, workspaceId, objective: statement, requestedChange: revision, phase: 'repair'
  });
  await engine.execute(workspaceId, 'agent_maker', 'run.append_event', {
    run_id: 'run_repair', kind: 'maker', summary: `Maker completed the repaired pass with receipt ${repair.receipt.receipt_digest}.`
  });
  await engine.execute(workspaceId, 'agent_maker', 'artifact.record', {
    run_id: 'run_repair', artifact_id: 'artifact_repaired', name: 'product-repaired.json', media_type: 'application/json',
    content: `${JSON.stringify(repair.artifact, null, 2)}\n`
  });
  await engine.execute(workspaceId, 'agent_maker', 'run.complete', {
    run_id: 'run_repair', summary: 'Repaired bounded candidate completed with audit trail and decision record.'
  });
  await engine.execute(workspaceId, 'agent_maker', 'change.resolve', {
    requested_change_id: 'change_product', resolution_artifact_id: 'artifact_repaired', reason: 'The repaired artifact applies the requested audit-trail change.'
  });
  await engine.execute(workspaceId, 'reviewer_local', 'review.submit', {
    review_id: 'review_repair', artifact_id: 'artifact_repaired', decision: 'approved', reason: 'The repaired artifact satisfies the explicit change and preserves its claim boundary.'
  });
  await engine.execute(workspaceId, 'reviewer_local', 'evidence.record', {
    evidence_id: 'evidence_product', run_id: 'run_repair', result: 'pass',
    checks: ['maker-receipt-digest', 'owned-path-boundary', 'hypothesis-count', 'requested-change', 'audit-trail', 'claim-boundary'],
    summary: 'Independent mechanics checks passed. Customer-value superiority remains unclaimed.'
  });
  await engine.execute(workspaceId, 'policy_local', 'promotion.approve', {
    approval_id: 'approval_product', promotion_id: 'promotion_product', run_id: 'run_repair', artifact_id: 'artifact_repaired',
    reason: 'Explicit user approval was supplied after passing evidence and independent review.'
  });
  await engine.execute(workspaceId, 'policy_local', 'result.publish', {
    publication_id: 'publication_product', promotion_id: 'promotion_product', stable_url: `archie://workspace/${workspaceId}/results/latest`
  });
  const final = await engine.execute(workspaceId, 'policy_local', 'rollback.record', {
    rollback_id: 'rollback_product', publication_id: 'publication_product', reason: 'A rollback point is mandatory for every promoted standalone result.'
  });

  const bundle = await exportWorkspaceBundle({ engine, workspaceId, principalId: 'owner_local' });
  const bundlePath = await writeWorkspaceBundle(path.join(selectedDataRoot, 'exports', `${workspaceId}.archie.json`), bundle);
  return Object.freeze({
    schema: ARCHIE_STANDALONE_JOURNEY_SCHEMA,
    workspace_id: workspaceId,
    objective: statement,
    requested_change: revision,
    selected_hypothesis_id: 'queue_first',
    rejected_hypothesis_id: 'command_first',
    first_maker_receipt_digest: first.receipt.receipt_digest,
    repaired_maker_receipt_digest: repair.receipt.receipt_digest,
    artifact_id: 'artifact_repaired',
    evidence_id: 'evidence_product',
    approval_id: 'approval_product',
    rollback_id: 'rollback_product',
    head_digest: final.state.head_digest,
    event_count: final.state.event_count,
    bundle_digest: bundle.bundle_digest,
    bundle_path: bundlePath,
    claim_boundary: 'The journey proves local mechanics, authority, revision, evidence, approval, rollback, and portability. It does not prove customer value, trained-model intelligence, hosted deployment, or device admission.'
  });
}
