#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ARCHIE_HYBRID_RUNNER_STATE_SCHEMA,
  ARCHIE_HYBRID_RUNNER_VERSION,
  defaultRunnerAdvertisement,
  runHybridRunnerOnce,
  main as enrolledMain
} from './archie-enrolled-hybrid-runner.mjs';

export {
  ARCHIE_HYBRID_RUNNER_STATE_SCHEMA,
  ARCHIE_HYBRID_RUNNER_VERSION,
  defaultRunnerAdvertisement,
  runHybridRunnerOnce
};

export async function main(argv = process.argv.slice(2), env = process.env) {
  return enrolledMain(argv, env);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-hybrid-runner: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
