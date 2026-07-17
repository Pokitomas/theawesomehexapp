#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { has, integer, last, parseArguments, printJSON, requiredFlag } from './archie-cli-core.mjs';
import { FileWorkspaceProvider, createWorkspaceEngine } from './archie-workspace-core.mjs';
import { startWorkspaceService } from './archie-workspace-service.mjs';

function defaultRoot(home = path.join(os.homedir(), '.archie')) {
  return path.join(home, 'workspaces');
}

async function payloadFromFlags(flags) {
  const file = last(flags, '--payload-file');
  const inline = last(flags, '--payload-json', '{}');
  const raw = file ? await fs.readFile(path.resolve(file), 'utf8') : inline;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Workspace payload must be valid JSON.');
  }
}

async function demo(engine, { title = 'Archie native workspace demonstration', visibility = 'public' } = {}) {
  const created = await engine.createWorkspace({ title, visibility, owner_id: 'owner_local' });
  const workspaceId = created.state.workspace_id;
  const objective = await engine.execute(workspaceId, 'owner_local', 'objective.define', {
    statement: 'Produce a reviewed, evidence-bound local result without GitHub as the canonical task database.',
    protected_reality: 'Do not expose credentials, invent execution, or bypass independent review.',
    proof_of_done: 'A repaired artifact, independent passing evidence, approved promotion, stable result URL, and rollback receipt.'
  });
  const objectiveId = Object.keys(objective.state.objectives)[0];
  await engine.execute(workspaceId, 'owner_local', 'agent.register', { agent_id: 'agent_maker', label: 'Local Maker adapter', kind: 'service', provider: 'local' });
  await engine.execute(workspaceId, 'owner_local', 'agent.register', { agent_id: 'reviewer_local', label: 'Independent local reviewer', kind: 'human' });
  await engine.execute(workspaceId, 'owner_local', 'agent.register', { agent_id: 'policy_local', label: 'Local promotion principal', kind: 'policy' });
  const graph = await engine.execute(workspaceId, 'owner_local', 'task_graph.create', {
    objective_id: objectiveId,
    tasks: [{ task_id: 'task_result', title: 'Produce the bounded result', description: 'Create, review, repair, verify, approve, publish, and retain rollback.' }]
  });
  await engine.execute(workspaceId, 'owner_local', 'grant.issue', { principal_id: 'agent_maker', task_id: 'task_result', capabilities: ['read', 'write', 'run'] });
  await engine.execute(workspaceId, 'owner_local', 'grant.issue', { principal_id: 'reviewer_local', capabilities: ['read', 'review'] });
  await engine.execute(workspaceId, 'owner_local', 'grant.issue', { principal_id: 'policy_local', capabilities: ['read', 'approve', 'deploy'] });
  await engine.execute(workspaceId, 'agent_maker', 'lease.claim', { task_id: 'task_result', ttl_ms: 3_600_000 });
  const firstRun = await engine.execute(workspaceId, 'agent_maker', 'run.start', { task_id: 'task_result' });
  const firstRunId = Object.keys(firstRun.state.runs)[0];
  await engine.execute(workspaceId, 'agent_maker', 'run.append_event', { run_id: firstRunId, kind: 'build', summary: 'Produced the first bounded candidate.' });
  const firstArtifactResult = await engine.execute(workspaceId, 'agent_maker', 'artifact.record', {
    run_id: firstRunId,
    artifact_id: 'artifact_first',
    name: 'result.txt',
    media_type: 'text/plain; charset=utf-8',
    content: 'candidate v1'
  });
  await engine.execute(workspaceId, 'agent_maker', 'run.complete', { run_id: firstRunId, summary: 'First candidate ready for review.' });
  const requested = await engine.execute(workspaceId, 'reviewer_local', 'review.submit', {
    artifact_id: 'artifact_first',
    decision: 'changes_requested',
    reason: 'The candidate does not include its evidence boundary.',
    request: 'Add the explicit evidence boundary and reproduce the artifact.'
  });
  const requestedChangeId = Object.keys(requested.state.requested_changes)[0];
  const repairRun = await engine.execute(workspaceId, 'agent_maker', 'run.start', { task_id: 'task_result', parent_run_id: firstRunId });
  const repairRunId = Object.keys(repairRun.state.runs).find(runId => runId !== firstRunId);
  await engine.execute(workspaceId, 'agent_maker', 'run.append_event', { run_id: repairRunId, kind: 'repair', summary: 'Added the requested evidence boundary.' });
  await engine.execute(workspaceId, 'agent_maker', 'artifact.record', {
    run_id: repairRunId,
    artifact_id: 'artifact_repaired',
    name: 'result.txt',
    media_type: 'text/plain; charset=utf-8',
    content: 'candidate v2\nclaim boundary: this artifact records work; promotion depends on independent receipts.\n'
  });
  await engine.execute(workspaceId, 'agent_maker', 'run.complete', { run_id: repairRunId, summary: 'Repaired candidate ready for independent review.' });
  await engine.execute(workspaceId, 'agent_maker', 'change.resolve', {
    requested_change_id: requestedChangeId,
    resolution_artifact_id: 'artifact_repaired',
    reason: 'The requested boundary is present in the reproduced artifact.'
  });
  await engine.execute(workspaceId, 'reviewer_local', 'review.submit', {
    artifact_id: 'artifact_repaired',
    decision: 'approved',
    reason: 'The repaired artifact is bounded and satisfies the requested change.'
  });
  await engine.execute(workspaceId, 'reviewer_local', 'evidence.record', {
    run_id: repairRunId,
    result: 'pass',
    checks: ['artifact-digest', 'requested-change-resolution', 'claim-boundary'],
    summary: 'Independent local checks passed.'
  });
  const promoted = await engine.execute(workspaceId, 'policy_local', 'promotion.approve', {
    run_id: repairRunId,
    artifact_id: 'artifact_repaired',
    reason: 'Independent review and evidence are complete.'
  });
  const promotionId = Object.keys(promoted.state.promotions)[0];
  const published = await engine.execute(workspaceId, 'policy_local', 'result.publish', { promotion_id: promotionId });
  const publicationId = Object.keys(published.state.publications)[0];
  const rolledBack = await engine.execute(workspaceId, 'policy_local', 'rollback.record', {
    publication_id: publicationId,
    reason: 'Demonstrate that every publication carries a rollback receipt.'
  });
  return {
    schema: 'archie-workspace-demo-result/v1',
    workspace_id: workspaceId,
    objective_id: objectiveId,
    task_id: 'task_result',
    repaired_run_id: repairRunId,
    artifact_id: 'artifact_repaired',
    promotion_id: promotionId,
    publication_id: publicationId,
    rollback_id: Object.keys(rolledBack.state.rollbacks)[0],
    stable_url: rolledBack.state.publications[publicationId].stable_url,
    event_count: rolledBack.state.event_count,
    head_digest: rolledBack.state.head_digest,
    first_artifact_sha256: firstArtifactResult.state.artifacts.artifact_first.sha256,
    claim_boundary: rolledBack.state.claim_boundary
  };
}

export async function runWorkspaceCommand({ positionals, flags, home = path.join(os.homedir(), '.archie'), output = process.stdout }) {
  const subcommand = positionals[1] || 'help';
  const root = path.resolve(last(flags, '--root', defaultRoot(home)));
  const provider = new FileWorkspaceProvider(root);
  const engine = createWorkspaceEngine({ provider });

  if (subcommand === 'help') {
    return {
      schema: 'archie-workspace-help/v1',
      usage: [
        'archie workspace init --title <title> [--visibility public|private|locally_sealed] [--owner owner_local]',
        'archie workspace list',
        'archie workspace inspect <workspace_id> [--principal <id>]',
        'archie workspace command <workspace_id> --principal <id> --type <command> --payload-json <json>',
        'archie workspace serve [--host 127.0.0.1] [--port 8787]',
        'archie workspace demo [--title <title>] [--visibility public|private|locally_sealed]'
      ],
      root
    };
  }

  if (subcommand === 'init') {
    const result = await engine.createWorkspace({
      workspace_id: last(flags, '--workspace-id') || undefined,
      title: requiredFlag(flags, '--title'),
      visibility: last(flags, '--visibility', 'private'),
      owner_id: last(flags, '--owner', 'owner_local')
    });
    return { workspace: result.state.workspace, head_digest: result.state.head_digest, root };
  }

  if (subcommand === 'list') {
    return { schema: 'archie-public-workspace-list/v1', workspaces: await engine.listPublic(), root };
  }

  if (subcommand === 'inspect') {
    const workspaceId = positionals[2];
    if (!workspaceId) throw new Error('workspace inspect requires <workspace_id>.');
    return engine.inspect(workspaceId, { principalId: last(flags, '--principal') || null });
  }

  if (subcommand === 'command') {
    const workspaceId = positionals[2];
    if (!workspaceId) throw new Error('workspace command requires <workspace_id>.');
    const result = await engine.execute(
      workspaceId,
      requiredFlag(flags, '--principal'),
      requiredFlag(flags, '--type'),
      await payloadFromFlags(flags)
    );
    return { schema: 'archie-workspace-command-result/v1', event: result.event, head_digest: result.state.head_digest, event_count: result.state.event_count };
  }

  if (subcommand === 'demo') {
    return demo(engine, { title: last(flags, '--title') || undefined, visibility: last(flags, '--visibility', 'public') });
  }

  if (subcommand === 'serve') {
    const runtime = await startWorkspaceService({
      root,
      host: last(flags, '--host', '127.0.0.1'),
      port: integer(flags, '--port', 8787),
      provider,
      engine
    });
    printJSON({ ...runtime.descriptor, root }, output);
    const shutdown = async () => {
      await runtime.close().catch(() => {});
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await new Promise(() => {});
    return null;
  }

  throw new Error(`Unknown workspace command: ${subcommand}.`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  const parsed = parseArguments(process.argv.slice(2));
  runWorkspaceCommand({ positionals: ['workspace', ...parsed.positionals], flags: parsed.flags })
    .then(result => { if (result) printJSON(result); })
    .catch(error => {
      process.stderr.write(`archie-workspace: ${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
