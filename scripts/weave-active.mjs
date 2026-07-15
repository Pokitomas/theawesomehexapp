#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';
import { projectActiveWeaveState } from './weave-active-state-strict.mjs';

const args = process.argv.slice(2);
if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
  console.log('Usage: node scripts/weave-active.mjs FILE.json [--now ISO] [--head SHA]');
  process.exit(0);
}

const file = args[0];
let now = Date.now();
let head = '';
for (let index = 1; index < args.length; index += 1) {
  if (args[index] === '--now') {
    const parsed = Date.parse(args[++index] || '');
    if (!Number.isFinite(parsed)) throw new Error('--now requires a timestamp.');
    now = parsed;
  } else if (args[index] === '--head') {
    head = args[++index] || '';
  } else {
    throw new Error(`Unknown argument: ${args[index]}`);
  }
}

try {
  const input = JSON.parse(await fs.readFile(file, 'utf8'));
  const messages = Array.isArray(input) ? input : input.messages;
  if (!Array.isArray(messages)) throw new Error('Input must contain a messages array.');
  console.log(JSON.stringify(projectActiveWeaveState(messages, { now, head }), null, 2));
} catch (error) {
  console.error(`weave-active: ${error.message}`);
  process.exit(1);
}
