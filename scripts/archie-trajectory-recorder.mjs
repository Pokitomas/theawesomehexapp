#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createArchieLinuxCorpus } from './maker-archie-corpus.mjs';

export const MAKER_ENGINE_RECEIPT_SCHEMA = 'sideways-maker-engine-receipt/v1';
export const MAKER_ENGINE_STATE_SCHEMA = 'sideways-maker-engine-state/v1';
export const SELF_HOSTING_TRAJECTORY_SCHEMA = 'archie-self-hosting-trajectory/v1';

const clean = (value, limit = 500_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function commandTrace(commands = []) {
  return (Array.isArray(commands) ? commands : []).map(command => ({
    tool: 'maker_process',
    action: clean(command?.program || 'unknown', 200),
    input: { args: Array.isArray(command?.args) ? command.args : [] },
    output: {
      exit_code: Number.isInteger(command?.exit_code) ? command.exit_code : null,
      stdout: clean(command?.stdout, 24_000),
      stderr: clean(command?.stderr, 24_000)
    },
    ok: command?.ok === true,
    duration_ms: Number.isFinite(Number(command?.duration_ms)) ? Number(command.duration_ms) : null
  }));
}

function makerOutcome(receipt) {
  if (receipt?.schema === MAKER_ENGINE_RECEIPT_SCHEMA && receipt.status === 'ready') return 'completed';
  const status = clean(receipt?.status || 'unknown', 100).toLowerCase();
  if (['cancelled', 'rolled_back', 'rejected', 'failed', 'blocked', 'denied'].includes(status)) return status;
  return status || 'unknown';
}

function makerFailureText(receipt) {
  const failures = Array.isArray(receipt?.failures) ? receipt.failures : [];
  if (!failures.length) return `Maker terminal state: ${clean(receipt?.status || 'unknown', 100)}.`;
  return failures.map(failure => clean(failure?.evidence || failure?.failure?.message || failure?.id || 'failure', 2000)).filter(Boolean).join('\n');
}

function makerPlan(receipt, suppliedPlan) {
  if (suppliedPlan !== undefined && suppliedPlan !== null) return suppliedPlan;
  return {
    changed_paths: Array.isArray(receipt?.changed_paths) ? receipt.changed_paths : [],
    verification: (Array.isArray(receipt?.verification) ? receipt.verification : []).map(command => ({
      program: command?.program || null,
      args: Array.isArray(command?.args) ? command.args : [],
      ok: command?.ok === true
    })),
    checkpoints: Array.isArray(receipt?.checkpoints) ? receipt.checkpoints.map(item => ({ label: item?.label || '', digest: item?.digest || '' })) : []
  };
}

export async function recordMakerEngineReceipt(corpus, receipt, { plan = null, source = {} } = {}) {
  if (!corpus || typeof corpus.ingest !== 'function') throw new Error('An Archie corpus is required.');
  if (![MAKER_ENGINE_RECEIPT_SCHEMA, MAKER_ENGINE_STATE_SCHEMA].includes(receipt?.schema)) {
    throw new Error('Unsupported MakerEngine receipt or state schema.');
  }
  const outcome = makerOutcome(receipt);
  const completed = outcome === 'completed';
  const task = receipt.task || {};
  const commands = Array.isArray(receipt.commands) ? receipt.commands : [];
  const outputPlan = makerPlan(receipt, plan);
  return corpus.ingest({
    kind: 'maker_engine_trace',
    subject: clean(task.repository || 'default', 300),
    input: {
      text: clean(task.request || '', 500_000),
      context: {
        base_sha: task.base_sha || null,
        branch: task.branch || null,
        protect: task.protect || null,
        proof: task.proof || null,
        lease: receipt.lease || null,
        event_head: receipt.event_head || null,
        event_count: receipt.event_count ?? null
      }
    },
    output: {
      text: completed ? 'Maker completed the leased task and passed declared verification.' : makerFailureText(receipt),
      plan: completed ? outputPlan : null
    },
    tool_trace: completed ? commandTrace(commands) : [],
    outcome,
    source: {
      system: clean(source.system || 'maker-engine', 200),
      run_id: clean(source.run_id || receipt.receipt_digest || receipt.event_head || '', 300),
      teacher: clean(source.teacher || '', 300),
      model: clean(source.model || '', 300),
      route_digest: clean(source.route_digest || receipt.receipt_digest || receipt.event_head || '', 200),
      cost_usd: source.cost_usd ?? null
    },
    artifact_refs: (Array.isArray(receipt.changed_paths) ? receipt.changed_paths : []).map(relative => ({
      name: relative,
      media_type: 'text/x-repository-path'
    })),
    tags: completed
      ? ['maker', 'maker-engine', 'verified', 'positive']
      : ['maker', 'maker-engine', 'negative', 'suppress', outcome]
  });
}

export async function recordSelfHostingTrajectory(corpus, trajectory) {
  if (!corpus || typeof corpus.ingest !== 'function') throw new Error('An Archie corpus is required.');
  if (trajectory?.schema !== SELF_HOSTING_TRAJECTORY_SCHEMA) throw new Error('Unsupported Archie self-hosting trajectory schema.');
  const payload = trajectory.payload || {};
  const completed = payload.outcome === 'completed' && payload.training_classification === 'positive';
  const maker = payload.maker || {};
  const sideways = payload.sideways || {};
  const archie = payload.archie || {};
  const plan = completed ? {
    semantic_digest: archie.semantic_digest || null,
    schedule_digest: archie.schedule_digest || null,
    changed_paths: Array.isArray(maker.changed_paths) ? maker.changed_paths : [],
    verification: Array.isArray(maker.verification) ? maker.verification.map(command => ({
      program: command?.program || null,
      args: Array.isArray(command?.args) ? command.args : [],
      ok: command?.ok === true
    })) : []
  } : null;
  return corpus.ingest({
    kind: 'archie_self_hosting_trace',
    subject: 'Pokitomas/theawesomehexapp',
    input: {
      text: `Execute deterministic Archie self-hosting scenario ${clean(sideways.scenario_id, 300)}.`,
      context: {
        seed: sideways.seed ?? null,
        scenario_digest: sideways.scenario_digest || null,
        expected_artifact_digest: sideways.expected_artifact_digest || null,
        plan_source: archie.plan_source || null,
        direct_write_authority: archie.direct_write_authority === true
      }
    },
    output: {
      text: completed ? 'Maker completed and verified the deterministic self-hosting scenario.' : clean(payload.error || 'Self-hosting scenario failed verification.', 4000),
      plan
    },
    tool_trace: completed ? commandTrace(maker.verification || []) : [],
    outcome: completed ? 'completed' : clean(payload.outcome || 'failed', 100),
    source: {
      system: 'archie-self-hosting-sample',
      run_id: clean(sideways.scenario_id || trajectory.trajectory_digest || '', 300),
      route_digest: clean(trajectory.trajectory_digest || '', 200)
    },
    artifact_refs: (Array.isArray(maker.changed_paths) ? maker.changed_paths : []).map(relative => ({
      name: relative,
      media_type: 'text/x-repository-path'
    })),
    tags: completed
      ? ['archie', 'self-hosting', 'maker-engine', 'verified', 'positive']
      : ['archie', 'self-hosting', 'negative', 'suppress', clean(payload.outcome || 'failed', 100)]
  });
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readJSON(filename, description) {
  if (!filename) throw new Error(`Pass ${description}.`);
  return JSON.parse(await fs.readFile(path.resolve(filename), 'utf8'));
}

export async function main(argv = process.argv) {
  const command = argv[2];
  const root = argument('--root', process.env.ARCHIE_CORPUS_ROOT || '');
  if (!root) throw new Error('Pass --root or set ARCHIE_CORPUS_ROOT.');
  const corpus = createArchieLinuxCorpus({ root });
  if (command === 'ingest-maker-engine') {
    const receipt = await readJSON(argument('--file'), '--file with a MakerEngine receipt or state');
    const planFile = argument('--plan-file');
    const plan = planFile ? await readJSON(planFile, '--plan-file') : null;
    process.stdout.write(`${JSON.stringify(await recordMakerEngineReceipt(corpus, receipt, { plan }), null, 2)}\n`);
    return;
  }
  if (command === 'ingest-self-hosting') {
    const trajectory = await readJSON(argument('--file'), '--file with an Archie self-hosting trajectory');
    process.stdout.write(`${JSON.stringify(await recordSelfHostingTrajectory(corpus, trajectory), null, 2)}\n`);
    return;
  }
  throw new Error('Usage: archie-trajectory-recorder.mjs <ingest-maker-engine|ingest-self-hosting> --root <directory> --file <json> [--plan-file <json>]');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-trajectory-recorder: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
