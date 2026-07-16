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
  return `Archie joint launch assessor

Usage:
  node scripts/archie-launch-assess.mjs derive [--target founder/archie-launch-target.json] [--output file.json]
  node scripts/archie-launch-assess.mjs evaluate --candidate candidate.json [--target founder/archie-launch-target.json] [--output decision.json]

The assessor derives product faculties from human outcomes. It does not make chat, voice, a dashboard, or an always-on process architectural by default. Evaluate exits non-zero when either intelligence or required embodiment is not admitted.`;
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
