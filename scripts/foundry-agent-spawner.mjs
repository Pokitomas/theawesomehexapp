import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { runGeneration2Coordinator } from '../foundry/generation-2/coordinator.mjs';
import { readJSON } from '../foundry/agents/runtime.mjs';

export async function runGenerationNext(root = process.cwd()) {
  const findingsPath = path.join(root, 'foundry', 'generation-1', 'grouping-findings.json');
  const findings = await readJSON(findingsPath, [
    { role: 'heretic', experiment_id: 'heretic-candidate-001', score: 0.91, genome: { lineage: ['generation-1'], architecture: 'dense-attn-v1' } },
    { role: 'heretic', experiment_id: 'heretic-candidate-002', score: 0.84, genome: { lineage: ['generation-1'], architecture: 'sparse-attn-v2' } },
    { role: 'heretic', experiment_id: 'heretic-candidate-003', score: 0.77, genome: { lineage: ['generation-1'], architecture: 'residual-mixer-v1' } }
  ]);
  const contradictions = await readJSON(path.join(root, 'foundry', 'generation-1', 'contradictions.json'), []);
  return runGeneration2Coordinator({ root, findings, contradictions });
}

export async function runSprawlStatus(root = process.cwd()) {
  const summary = await readJSON(path.join(root, 'foundry', 'generation-2', 'coordinator-summary.json'), null);
  return {
    schema: 'sideways-foundry-sprawl-status/v1',
    generation: 2,
    ready: Boolean(summary),
    summary
  };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'status';
  if (command === 'generation-next') {
    const result = await runGenerationNext(process.cwd());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'status') {
    const result = await runSprawlStatus(process.cwd());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown foundry command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`foundry-agent-spawner: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
