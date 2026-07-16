#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  benchmarkModel,
  inspectModel,
  listModels,
  pullModel,
  removeModel,
  resolveArchieHome,
  runModel
} from './archie-runtime-core.mjs';

function parseArguments(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const [name, inline] = value.split('=', 2);
    if (inline !== undefined) {
      const list = flags.get(name) || [];
      list.push(inline);
      flags.set(name, list);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      const list = flags.get(name) || [];
      list.push(next);
      flags.set(name, list);
      index += 1;
    } else {
      flags.set(name, ['true']);
    }
  }
  return { positionals, flags };
}

function last(flags, name, fallback = '') {
  const values = flags.get(name);
  return values?.length ? values[values.length - 1] : fallback;
}

function has(flags, name) {
  return flags.has(name);
}

function integer(flags, name, fallback) {
  const value = last(flags, name, String(fallback));
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} requires an integer.`);
  return Number(value);
}

function number(flags, name, fallback) {
  const value = Number(last(flags, name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} requires a finite number.`);
  return value;
}

async function trustedKeys(flags) {
  const files = flags.get('--trust-key') || [];
  return Promise.all(files.map(filename => fs.readFile(path.resolve(filename), 'utf8')));
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return `Archie local model runtime

Usage:
  archie pull <manifest> --trust-key <public.pem>
  archie run <id@version> --prompt <text> [--runner <path>]
  archie inspect <id@version>
  archie benchmark <id@version> --suite <suite.json> [--runner <path>]
  archie remove <id@version>
  archie list

Global:
  --home <path>             Override ARCHIE_HOME.
  --allow-untrusted         Verify a self-signature without admitting its key as trusted.

Run:
  --prompt-file <path>      Read the prompt from a file.
  --max-tokens <n>          Default 256.
  --context <n>             Defaults to the manifest context limit.
  --temperature <n>         Default 0.
  --seed <n>                Default 0.
  --timeout-ms <n>          Default 300000.

The runtime never downloads or invokes a frontier API. The configured runner is a local process adapter.`;
}

export async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArguments(argv);
  const command = positionals[0] || (has(flags, '--help') ? 'help' : '');
  const home = path.resolve(last(flags, '--home', resolveArchieHome()));

  if (!command || command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'pull') {
    const source = positionals[1];
    if (!source) throw new Error('pull requires a manifest source.');
    const result = await pullModel(source, {
      home,
      trusted_public_keys: await trustedKeys(flags),
      allow_untrusted: has(flags, '--allow-untrusted')
    });
    print(result.receipt);
    return;
  }

  if (command === 'list') {
    print({ schema: 'archie-model-list/v1', home, models: await listModels({ home }) });
    return;
  }

  const reference = positionals[1];
  if (!reference) throw new Error(`${command} requires a model reference in id@version form.`);

  if (command === 'inspect') {
    print(await inspectModel(reference, { home }));
    return;
  }

  if (command === 'remove') {
    print(await removeModel(reference, { home }));
    return;
  }

  const runner_path = last(flags, '--runner', process.env.ARCHIE_RUNNER || 'llama-cli');
  const runOptions = {
    home,
    runner_path,
    max_tokens: integer(flags, '--max-tokens', 256),
    context: last(flags, '--context') ? integer(flags, '--context', 0) : undefined,
    temperature: number(flags, '--temperature', 0),
    seed: integer(flags, '--seed', 0),
    timeout_ms: integer(flags, '--timeout-ms', 300000)
  };

  if (command === 'run') {
    let prompt = last(flags, '--prompt');
    const promptFile = last(flags, '--prompt-file');
    if (promptFile) prompt = await fs.readFile(path.resolve(promptFile), 'utf8');
    const result = await runModel(reference, { ...runOptions, prompt });
    if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    process.stderr.write(`${JSON.stringify(result.receipt)}\n`);
    if (result.code !== 0) process.exitCode = result.code;
    return;
  }

  if (command === 'benchmark') {
    const suite = last(flags, '--suite');
    if (!suite) throw new Error('benchmark requires --suite <path-or-url>.');
    const report = await benchmarkModel(reference, suite, runOptions);
    print(report);
    if (report.summary.failed) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${command}.`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
