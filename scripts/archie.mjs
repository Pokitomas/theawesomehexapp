#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { main as runArchieCore } from './archie-core.mjs';
import { main as runArchieLite } from './archie-lite.mjs';

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'lite') return runArchieLite(argv.slice(1));
  return runArchieCore(argv);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie: ${error?.stack || error}\n`);
    process.exitCode = Number.isInteger(error?.code) ? error.code : 1;
  });
}
