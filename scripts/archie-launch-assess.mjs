#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  deriveLaunchRequirements,
  evaluateLaunchCandidate
} from './archie-launch-contract.mjs';

function parse(argv) {
  const command = argv[0] || 'derive';
  const flags = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}.`);
    const [name, inline] = token.split('=', 2);
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${name} requires a value.`);
    flags.set(name, next);
    index += 1;
  }
  return { command, flags };
}

async function readJSON(filename) {
  return JSON.parse(await fs.readFile(path.resolve(filename), 'utf8'));
}

async function writeResult(result, output) {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (!output) {
    process.stdout.write(text);
    return;
  }
  const filename = path.resolve(output);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, text);
  process.stdout.write(`${filename}\n`);
}

function usage() {
  return `Archie capability-frontier launch assessor

Usage:
  node scripts/archie-launch-assess.mjs derive [--target founder/archie-launch-target.json] [--output file.json]
  node scripts/archie-launch-assess.mjs evaluate --candidate candidate.json [--target founder/archie-launch-target.json] [--output decision.json]

The assessor does not derive voice, chat, a screen, a CLI, or an always-on process from static rules. Candidates submit complete evidence-bound product profiles across declared environments. The evaluator publishes the feasible nondominated frontier and rejects dominated defaults, hidden frontier profiles, incomplete search receipts, weak intelligence, and unsupported capability claims.`;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const { command, flags } = parse(argv);
  const defaultTarget = fileURLToPath(new URL('../founder/archie-launch-target.json', import.meta.url));
  const target = await readJSON(flags.get('--target') || defaultTarget);
  const output = flags.get('--output');

  if (command === 'derive') {
    await writeResult(deriveLaunchRequirements(target), output);
    return;
  }
  if (command === 'evaluate') {
    const candidatePath = flags.get('--candidate');
    if (!candidatePath) throw new Error('evaluate requires --candidate <file.json>.');
    const decision = evaluateLaunchCandidate(target, await readJSON(candidatePath));
    await writeResult(decision, output);
    if (decision.decision !== 'admitted-maximal-launch') process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command ${command}.\n\n${usage()}`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-launch-assess: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
