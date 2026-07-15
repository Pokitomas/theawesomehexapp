#!/usr/bin/env node
import process from 'node:process';
import { runGenerationNext, runSprawlStatus } from './foundry-agent-spawner.mjs';

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'sprawl:status';
  if (command === 'foundry:generation:next' || command === 'generation-next') {
    const summary = await runGenerationNext(process.cwd());
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (command === 'foundry:sprawl:status' || command === 'sprawl:status') {
    const status = await runSprawlStatus(process.cwd());
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown foundry CLI command: ${command}`);
}

main().catch(error => {
  process.stderr.write(`foundry-agent-cli: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
