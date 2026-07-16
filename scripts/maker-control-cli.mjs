#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createMakerControlPlane, createMemoryControlStore } from './maker-control-plane.mjs';
const usage = `maker-control-cli
Commands:
submit <json-or-file>
claim <worker-id> <runtime-json-or-file> [repository]
get <job-id>
view <job-id>
list [state] [repository]
watch [after-sequence]
heartbeat <job-id> <lease-token>
complete <job-id> <lease-token> <json-or-file>
fail <job-id> <lease-token> <json-or-file>
resume <job-id> [json-or-file]
retry <job-id> [json-or-file]
rollback <job-id> [json-or-file]
approve <job-id> <capability> <level> <ttl-ms> <approved-by> [justification]
cancel <job-id> [reason]
export <job-id>
import <json-or-file> [--replace]
recover
health
capabilities
events [after-sequence]
shutdown
Use @path/to/file.json for file-backed JSON arguments.
State defaults to .maker/control-plane-state.json and can be overridden with MAKER_CONTROL_STATE.
`;
async function parseJson(value, fileSystem = fs) {
if (!value) return {};
const text = value.startsWith('@') ? await fileSystem.readFile(value.slice(1), 'utf8') : value;
return JSON.parse(text);
}
async function loadStore(statePath, fileSystem = fs) {
try {
const snapshot = JSON.parse(await fileSystem.readFile(statePath, 'utf8'));
return createMemoryControlStore(snapshot);
} catch (error) {
if (error.code === 'ENOENT') return createMemoryControlStore();
throw error;
}
}
async function saveStore(store, statePath, fileSystem = fs) {
await fileSystem.mkdir(path.dirname(path.resolve(statePath)), { recursive: true });
const temporary = `${statePath}.${process.pid}.tmp`;
await fileSystem.writeFile(temporary, `${JSON.stringify(await store.snapshot(), null, 2)}\n`, 'utf8');
await fileSystem.rename(temporary, statePath);
}
export async function runMakerControlCli(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
const [command, ...args] = argv;
if (!command || command === '--help' || command === '-h') {
return { exitCode: 0, output: usage, persist: false };
}
const statePath = env.MAKER_CONTROL_STATE || '.maker/control-plane-state.json';
const fileSystem = dependencies.fs || fs;
const store = await loadStore(statePath, fileSystem);
const control = createMakerControlPlane({ store });
let value;
if (command === 'submit') value = await control.submit(await parseJson(args[0], fileSystem));
else if (command === 'claim') {
value = await control.claim({
worker_id: args[0],
runtime: await parseJson(args[1], fileSystem),
repository: args[2]
});
} else if (command === 'get') value = await control.get(args[0]);
else if (command === 'view') value = await control.view(args[0]);
else if (command === 'list') value = await control.list({ state: args[0], repository: args[1] });
else if (command === 'watch') value = await control.watch(Number(args[0]) || 0);
else if (command === 'heartbeat') value = await control.heartbeat(args[0], args[1]);
else if (command === 'complete') value = await control.complete(args[0], args[1], await parseJson(args[2], fileSystem));
else if (command === 'fail') value = await control.fail(args[0], args[1], await parseJson(args[2], fileSystem));
else if (command === 'resume') value = await control.resume(args[0], await parseJson(args[1], fileSystem));
else if (command === 'retry') value = await control.retry(args[0], await parseJson(args[1], fileSystem));
else if (command === 'rollback') value = await control.rollback(args[0], await parseJson(args[1], fileSystem));
else if (command === 'approve') {
value = await control.approveTemporaryGrant(args[0], {
capability: args[1],
level: args[2],
ttl_ms: Number(args[3]),
approved_by: args[4],
justification: args.slice(5).join(' ')
});
} else if (command === 'cancel') value = await control.cancel(args[0], args.slice(1).join(' '));
else if (command === 'export') value = await control.exportReceipt(args[0]);
else if (command === 'import') value = await control.importSnapshot(await parseJson(args[0], fileSystem), { replace: args.includes('--replace') });
else if (command === 'recover') value = await control.recoverOrphans();
else if (command === 'health') value = await control.health();
else if (command === 'capabilities') value = await control.capabilities();
else if (command === 'events') value = await control.events(Number(args[0]) || 0);
else if (command === 'shutdown') value = await control.close();
else throw new Error(`Unknown command: ${command}`);
await saveStore(store, statePath, fileSystem);
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
