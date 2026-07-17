#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { has, last, parseArguments, printJSON } from './archie-cli-core.mjs';
import { listModels, resolveArchieHome } from './archie-runtime-core.mjs';

const CLAIM_BOUNDARY = 'Runtime installation and artifact presence do not prove model capability.';

async function packageVersion() {
  const source = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return String(source.version || '0.0.0');
}

async function existingFile(filename) {
  try {
    return (await fs.stat(filename)).isFile();
  } catch {
    return false;
  }
}

export async function findExecutable(command, {
  env = process.env,
  platform = process.platform
} = {}) {
  const value = String(command || '').trim();
  if (!value) return '';
  if (path.isAbsolute(value) || /[\\/]/.test(value)) {
    return await existingFile(path.resolve(value)) ? path.resolve(value) : '';
  }

  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  if (platform === 'win32' && path.extname(value)) extensions.unshift('');
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${value}${extension}`);
      if (await existingFile(candidate)) return candidate;
    }
  }
  return '';
}

export async function inspectArchieFirstRun({
  home = resolveArchieHome(),
  env = process.env,
  platform = process.platform,
  nodeVersion = process.version,
  version
} = {}) {
  const models = await listModels({ home });
  const runnerCommand = String(env.ARCHIE_RUNNER || 'llama-cli');
  const runnerPath = await findExecutable(runnerCommand, { env, platform });
  const executionReady = models.length > 0 && Boolean(runnerPath);
  const nextSteps = [];

  if (models.length === 0) {
    nextSteps.push({
      id: 'model',
      label: 'Add a signed local model',
      command: 'archie pull <manifest> --trust-key <publisher-public.pem>'
    });
  }
  if (!runnerPath) {
    nextSteps.push({
      id: 'runner',
      label: 'Install llama.cpp or choose a compatible local runner',
      command: platform === 'win32'
        ? '$env:ARCHIE_RUNNER = "C:\\path\\to\\llama-cli.exe"'
        : 'export ARCHIE_RUNNER=/path/to/llama-cli'
    });
  }
  if (executionReady) {
    nextSteps.push({
      id: 'inspect',
      label: 'Inspect before running',
      command: `archie inspect ${models[0].model_ref}`
    });
  }
  nextSteps.push({ id: 'help', label: 'See every verified command', command: 'archie help' });

  return Object.freeze({
    schema: 'archie-first-run/v1',
    version: version || await packageVersion(),
    platform,
    node: nodeVersion,
    home: path.resolve(home),
    runtime_ready: true,
    installed_artifacts: models.map(model => model.model_ref),
    local_runner: Object.freeze({
      command: runnerCommand,
      available: Boolean(runnerPath),
      path: runnerPath || null
    }),
    execution_ready: executionReady,
    capability_claim: CLAIM_BOUNDARY,
    next_steps: Object.freeze(nextSteps)
  });
}

function painter(enabled) {
  const wrap = code => value => enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
  return {
    cyan: wrap('96'),
    green: wrap('92'),
    yellow: wrap('93'),
    dim: wrap('2'),
    bold: wrap('1')
  };
}

export function renderArchieFirstRun(state, { color = false } = {}) {
  const paint = painter(color);
  const ready = value => value ? paint.green('[READY]') : paint.yellow('[NEEDS SETUP]');
  const modelStatus = state.installed_artifacts.length
    ? `${state.installed_artifacts.length} installed`
    : 'none installed';
  const runnerStatus = state.local_runner.available
    ? state.local_runner.path
    : `${state.local_runner.command} not found`;
  const steps = state.next_steps
    .map((step, index) => `  ${paint.cyan(`${index + 1}.`)} ${step.label}\n     ${paint.bold(step.command)}`)
    .join('\n');

  return [
    paint.cyan('+----------------------------------------------------------+'),
    paint.cyan('| [##][##]  A R C H I E  //  LOCAL WORLD                 |'),
    paint.cyan('| [##]      BUILD LOCAL. VERIFY EVERYTHING.               |'),
    paint.cyan('+----------------------------------------------------------+'),
    '',
    `${ready(state.runtime_ready)} Runtime ${state.version} on ${state.platform} / ${state.node}`,
    `${ready(state.installed_artifacts.length > 0)} Model artifacts: ${modelStatus}`,
    `${ready(state.local_runner.available)} Local runner: ${runnerStatus}`,
    `${ready(state.execution_ready)} End-to-end local execution`,
    '',
    paint.yellow(state.capability_claim),
    paint.dim(`Archie home: ${state.home}`),
    '',
    paint.bold('BUILD YOUR FIRST LOCAL WORLD'),
    steps,
    ''
  ].join('\n');
}

export async function runArchieFirstRun(argv = process.argv.slice(2), {
  stdout = process.stdout,
  env = process.env,
  platform = process.platform,
  nodeVersion = process.version
} = {}) {
  const { flags } = parseArguments(argv);
  const home = path.resolve(last(flags, '--home', resolveArchieHome({ env })));
  const state = await inspectArchieFirstRun({ home, env, platform, nodeVersion });
  if (has(flags, '--json')) printJSON(state, stdout);
  else stdout.write(`${renderArchieFirstRun(state, {
    color: Boolean(stdout.isTTY) && !has(flags, '--no-color') && !('NO_COLOR' in env)
  })}\n`);
  return state;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  runArchieFirstRun().catch(error => {
    process.stderr.write(`archie: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
