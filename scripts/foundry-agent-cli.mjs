#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildLassoReceipt,
  lassoFiles,
  loadJson,
  resolveAllAssignmentTasks,
  resolveAssignmentTask,
  validateAssignments,
  validateGenomeManifest,
  validatePeerLeases,
  validatePortfolio
} from './foundry-agent-spawner.mjs';

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) { parsed._.push(item); continue; }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) parsed[key] = true;
    else { parsed[key] = next; i += 1; }
  }
  return parsed;
}

function requireFlag(args, name) {
  const value = args[name];
  if (!value || value === true) throw new Error(`--${name} is required.`);
  return String(value);
}

function usage() {
  return [
    'Foundry ↔ Maker adapter (read-only; stdout receipts only)',
    '',
    'lasso --portfolio FILE --genomes FILE --peer-leases FILE --base-sha SHA [--budget N]',
    'status --portfolio FILE --genomes FILE --peer-leases FILE --base-sha SHA',
    'assignment --assignments FILE --role ROLE',
    'assignments --assignments FILE',
    'validate --kind portfolio|genomes|peer-leases|assignments --file FILE [--base-sha SHA]',
    '',
    'No command writes files, creates branches, opens PRs, installs dependencies, or runs training.'
  ].join('\n');
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'lasso' || command === 'status') {
    const baseSha = requireFlag(args, 'base-sha');
    const options = {
      portfolioPath: requireFlag(args, 'portfolio'),
      genomeManifestPath: requireFlag(args, 'genomes'),
      peerLeasesPath: requireFlag(args, 'peer-leases'),
      baseSha,
      perPacketBudget: args.budget === undefined ? Infinity : Number(args.budget)
    };
    const receipt = await lassoFiles(options);
    if (command === 'status') {
      process.stdout.write(`${JSON.stringify({
        schema: receipt.schema,
        ok: receipt.ok,
        exact_base_sha: receipt.exact_base_sha,
        packets_requested: receipt.packets_requested,
        packets_ready: receipt.packets_ready,
        packet_errors: receipt.packet_errors,
        packet_collisions: receipt.packet_collisions,
        peer_collisions: receipt.peer_collisions,
        budget_exceeded: receipt.budget_exceeded,
        authority: receipt.authority
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    }
    if (!receipt.ok) process.exitCode = 1;
    return;
  }

  if (command === 'assignment' || command === 'assignments') {
    const assignments = await loadJson(requireFlag(args, 'assignments'), 'assignments');
    const result = command === 'assignments'
      ? resolveAllAssignmentTasks(assignments)
      : { ok: true, task: resolveAssignmentTask(requireFlag(args, 'role'), assignments) };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'validate') {
    const kind = requireFlag(args, 'kind');
    const value = await loadJson(requireFlag(args, 'file'), kind);
    let result;
    if (kind === 'portfolio') result = validatePortfolio(value);
    else if (kind === 'genomes') result = validateGenomeManifest(value, requireFlag(args, 'base-sha'));
    else if (kind === 'peer-leases') result = validatePeerLeases(value, requireFlag(args, 'base-sha'));
    else if (kind === 'assignments') result = validateAssignments(value);
    else throw new Error(`Unsupported validation kind: ${kind}.`);
    process.stdout.write(`${JSON.stringify({ ok: true, kind, count: Array.isArray(result) ? result.length : undefined }, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}.\n${usage()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export { buildLassoReceipt };
