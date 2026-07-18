#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  has,
  integer,
  last,
  number,
  parseArguments,
  printJSON
} from './archie-cli-core.mjs';
import {
  planLiteModel,
  runLiteModel
} from './archie-lite-core.mjs';
import { resolveArchieHome } from './archie-runtime-core.mjs';

function usage() {
  return `Archie low-compute GGUF runtime

Usage:
  archie-lite plan <id@version> [options]
  archie-lite run <id@version> --prompt <text> [options]
  archie-lite <id@version> --prompt <text> [options]

The identical command is also exposed as archie_lite.

Options:
  --home <path>                 Override ARCHIE_HOME.
  --runner <path>               llama.cpp executable. Defaults to ARCHIE_RUNNER or llama-cli.
  --prompt <text>               Prompt for run mode.
  --prompt-file <path>          Read the prompt from a file.
  --context <tokens>            Requested context before RAM, manifest, and GGUF caps.
  --max-tokens <tokens>         Default 256.
  --temperature <number>        Default 0.
  --seed <integer>              Default 0.
  --timeout-ms <milliseconds>   Default 300000.
  --kv-element-bytes <n>        KV element width: 1, 2, 4, or 8. Default 2.
  --kv-safety-factor <number>   KV budgeting multiplier. Default 1.10.
  --reserve-ratio <number>      Fraction of total RAM reserved for the OS. Default 0.25.
  --reserve-bytes <n>           Absolute RAM reserve floor. Default 0.
  --runtime-overhead-bytes <n>  Override conservative runtime overhead estimate.
  --free-ram-utilization <n>    Maximum fraction of currently free RAM to consume. Default 0.90.
  --minimum-context <tokens>    Fail closed below this context. Default 256.
  --dry-run                     Alias for plan mode.
  --help                        Show this message.

Archie lite reads GGUF metadata, estimates KV-cache bytes per token, caps context to
current machine RAM, and forces llama.cpp CPU execution with zero GPU layers. It does
not claim model quality, training, neural improvement, or production admission.`;
}

function optionalInteger(flags, name) {
  return has(flags, name) ? integer(flags, name, 0) : undefined;
}

function planningOptions(flags) {
  return {
    home: path.resolve(last(flags, '--home', resolveArchieHome())),
    requested_context: optionalInteger(flags, '--context'),
    kv_element_bytes: integer(flags, '--kv-element-bytes', 2),
    kv_safety_factor: number(flags, '--kv-safety-factor', 1.10),
    reserve_ratio: number(flags, '--reserve-ratio', 0.25),
    reserve_bytes: integer(flags, '--reserve-bytes', 0),
    runtime_overhead_bytes: optionalInteger(flags, '--runtime-overhead-bytes'),
    free_ram_utilization: number(flags, '--free-ram-utilization', 0.90),
    minimum_context: integer(flags, '--minimum-context', 256)
  };
}

async function readPrompt(flags) {
  const filename = last(flags, '--prompt-file');
  if (filename) return fs.readFile(path.resolve(filename), 'utf8');
  return last(flags, '--prompt');
}

export async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArguments(argv);
  if (has(flags, '--help') || positionals[0] === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const explicitMode = positionals[0] === 'plan' || positionals[0] === 'run';
  const mode = has(flags, '--dry-run') ? 'plan' : explicitMode ? positionals[0] : 'run';
  const reference = explicitMode ? positionals[1] : positionals[0];
  if (!reference) throw new Error(`${mode} requires a model reference in id@version form.`);
  if (positionals.length > (explicitMode ? 2 : 1)) throw new Error('Unexpected positional arguments.');

  const planOptions = planningOptions(flags);
  if (mode === 'plan') {
    const result = await planLiteModel(reference, planOptions);
    printJSON({
      schema: 'archie-lite-plan-result/v1',
      plan: result.plan,
      receipt: result.receipt,
      receipt_path: result.receipt_path
    });
    return;
  }

  const prompt = await readPrompt(flags);
  if (!String(prompt || '').trim()) throw new Error('run requires --prompt <text> or --prompt-file <path>.');
  const result = await runLiteModel(reference, {
    ...planOptions,
    prompt,
    runner_path: last(flags, '--runner', process.env.ARCHIE_RUNNER || 'llama-cli'),
    max_tokens: integer(flags, '--max-tokens', 256),
    temperature: number(flags, '--temperature', 0),
    seed: integer(flags, '--seed', 0),
    timeout_ms: integer(flags, '--timeout-ms', 300000)
  });
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  process.stderr.write(`${JSON.stringify({
    schema: 'archie-lite-run-result/v1',
    plan_receipt_digest: result.lite_plan_receipt.receipt_digest,
    run_receipt_digest: result.receipt.receipt_digest,
    lite_receipt: result.lite_receipt,
    selected_context: result.lite_plan.context.selected_context,
    cpu_enforcement: result.lite_plan.cpu_enforcement
  })}\n`);
  if (result.code !== 0) process.exitCode = result.code;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    const details = error?.details ? `\n${JSON.stringify(error.details, null, 2)}` : '';
    process.stderr.write(`archie-lite: ${error?.stack || error}${details}\n`);
    process.exitCode = 1;
  });
}
