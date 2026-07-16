#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  deriveLaunchRequirements,
  evaluateLaunchCandidate
} from './archie-launch-contract.mjs';
import { resolveAdmittedLaunchProfile } from './archie-launch-profile-admission.mjs';

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

function requiredFlag(flags, name) {
  const value = flags.get(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function usage() {
  return `Archie joint launch assessor

Usage:
  node scripts/archie-launch-assess.mjs derive [--target founder/archie-launch-target.json] [--output file.json]
  node scripts/archie-launch-assess.mjs evaluate --candidate candidate.json [--target founder/archie-launch-target.json] [--output decision.json]
  node scripts/archie-launch-assess.mjs resolve --manifest launch-capability-manifest.json [--output admission.json]

derive maps human outcomes to required faculties without selecting chat, voice, a dashboard, or an always-on process as architecture.

evaluate jointly gates the model, authority, evidence, and required embodiment. It exits non-zero unless the candidate satisfies the maximal target.

resolve binds the admitted candidate to one exact machine, permissions, resources, modalities, invocation and continuity capabilities. It selects the strongest compatible profile whose aggregate resource cost fits the exact machine, preserves named fallbacks separately, and exits non-zero unless the default profile is admitted.`;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const { command, flags } = parse(argv);
  const output = flags.get('--output');

  if (command === 'resolve') {
    const admission = resolveAdmittedLaunchProfile(await readJSON(requiredFlag(flags, '--manifest')));
    await writeResult(admission, output);
    if (admission.decision !== 'admitted-maximal-machine-profile') process.exitCode = 1;
    return;
  }

  const defaultTarget = fileURLToPath(new URL('../founder/archie-launch-target.json', import.meta.url));
  const target = await readJSON(flags.get('--target') || defaultTarget);

  if (command === 'derive') {
    await writeResult(deriveLaunchRequirements(target), output);
    return;
  }
  if (command === 'evaluate') {
    const decision = evaluateLaunchCandidate(target, await readJSON(requiredFlag(flags, '--candidate')));
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
