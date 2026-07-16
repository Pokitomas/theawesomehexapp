#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createDistillingChamber } from './archie-distilling-chamber.mjs';

const [command = 'run', inputPath = '-'] = process.argv.slice(2);
const readInput = async () => inputPath === '-' ? await new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
}) : fs.readFile(inputPath, 'utf8');

try {
  if (command !== 'run') throw new Error(`unsupported command: ${command}`);
  const source = await readInput();
  const task = JSON.parse(source || '{}');
  if (!task.id) throw new Error('task.id is required');
  const chamber = createDistillingChamber();
  const result = await chamber.runEpisode(task);
  process.stdout.write(JSON.stringify({ result, status: chamber.status(), events: chamber.events(0, 1000) }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.code || 'cli_error', message: String(error.message || error) }) + '\n');
  process.exitCode = 1;
}
