#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';
import { runParallelFoundry } from './runtime.mjs';
import { stableJSONStringify } from './core.mjs';

const args = process.argv.slice(2);
const valueFor = flag => {
  const index = args.indexOf(flag);
  return index === -1 ? '' : String(args[index + 1] || '').trim();
};

const missionPath = valueFor('--mission');
const outDir = valueFor('--out');
const argvJSON = valueFor('--agent-argv') || process.env.SIDEWAYS_FOUNDRY_AGENT_ARGV || '';
const budget = valueFor('--budget');
const timeout = valueFor('--timeout-ms');

if (!missionPath || !argvJSON) {
  console.error([
    'Usage:',
    "  node foundry/run.mjs --mission foundry/example-mission.json --agent-argv '[\"codex\",\"exec\",\"--sandbox\",\"read-only\",\"-\"]' --out /tmp/foundry-run",
    '',
    'The agent command receives one assignment packet as JSON on stdin.',
    'It must return one research report as JSON on stdout and must not mutate the worktree.'
  ].join('\n'));
  process.exit(2);
}

try {
  const mission = JSON.parse(await fs.readFile(missionPath, 'utf8'));
  const result = await runParallelFoundry({
    mission,
    agent_argv: argvJSON,
    out_dir: outDir || undefined,
    budget: budget ? Number(budget) : undefined,
    timeout_ms: timeout ? Number(timeout) : undefined
  });
  console.log(stableJSONStringify({
    ok: true,
    output_dir: result.output_dir,
    assignments: result.assignments.length,
    candidates: result.integration.candidates.length,
    selected_experiments: result.portfolio.selected.length,
    receipt_digest: result.receipt.receipt_digest
  }));
} catch (error) {
  console.error(stableJSONStringify({ ok: false, error: String(error?.message || error) }));
  process.exit(1);
}
