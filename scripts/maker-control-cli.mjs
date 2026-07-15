#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createMakerControlPlane, createMemoryControlStore } from './maker-control-plane.mjs';

const usage = `maker-control-cli

Commands:
  submit <json-or-file>
  claim <worker-id> [repository]
  get <job-id>
  heartbeat <job-id> <lease-token>
  complete <job-id> <lease-token> <json-or-file>
  fail <job-id> <lease-token> <json-or-file>
  cancel <job-id> [reason]
  events [after-sequence]

State defaults to .maker/control-plane-state.json and can be overridden with MAKER_CONTROL_STATE.
`;

async function parseJson(value) {
  if (!value) return {};
  const text = value.startsWith('@') ? await fs.readFile(value.slice(1), 'utf8') : value;
  return JSON.parse(text);
}

async function loadStore(statePath) {
  try {
    const snapshot = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return createMemoryControlStore(snapshot);
  } catch (error) {
    if (error.code === 'ENOENT') return createMemoryControlStore();
    throw error;
  }
}

async function saveStore(store, statePath) {
  await fs.mkdir(new URL('.', pathToFileURL(statePath)), { recursive: true }).catch(async () => {
    const slash = Math.max(statePath.lastIndexOf('/'), statePath.lastIndexOf('\\'));
    if (slash > 0) await fs.mkdir(statePath.slice(0, slash), { recursive: true });
  });
  await fs.writeFile(statePath, `${JSON.stringify(await store.snapshot(), null, 2)}\n`, 'utf8');
}

export async function runMakerControlCli(argv = process.argv.slice(2), env = process.env) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h') return { exitCode: 0, output: usage, persist: false };
  const statePath = env.MAKER_CONTROL_STATE || '.maker/control-plane-state.json';
  const store = await loadStore(statePath);
  const control = createMakerControlPlane({ store });
  let value;
  if (command === 'submit') value = await control.submit(await parseJson(args[0]));
  else if (command === 'claim') value = await control.claim({ worker_id: args[0], repository: args[1] });
  else if (command === 'get') value = await control.get(args[0]);
  else if (command === 'heartbeat') value = await control.heartbeat(args[0], args[1]);
  else if (command === 'complete') value = await control.complete(args[0], args[1], await parseJson(args[2]));
  else if (command === 'fail') value = await control.fail(args[0], args[1], await parseJson(args[2]));
  else if (command === 'cancel') value = await control.cancel(args[0], args.slice(1).join(' '));
  else if (command === 'events') value = await control.events(Number(args[0]) || 0);
  else throw new Error(`Unknown command: ${command}`);
  await saveStore(store, statePath);
  return { exitCode: 0, output: `${JSON.stringify(value, null, 2)}\n`, persist: true };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runMakerControlCli().then(result => {
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  }).catch(error => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  });
}
