import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runGeneration2Coordinator } from '../../foundry/generation-2/coordinator.mjs';

async function fixtureRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'foundry-generation2-'));
}

test('generation-2 coordinator spawns isolated experiment lanes and receipts', async t => {
  const root = await fixtureRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const summary = await runGeneration2Coordinator({
    root,
    findings: [
      { role: 'heretic', experiment_id: 'heretic-candidate-001', score: 0.9, genome: { lineage: ['g1-a'] } },
      { role: 'heretic', experiment_id: 'heretic-candidate-002', score: 0.8, genome: { lineage: ['g1-b'] }, force_fail: true },
      { role: 'heretic', experiment_id: 'heretic-candidate-003', score: 0.7, genome: { lineage: ['g1-c'] } }
    ],
    contradictions: ['sample contradiction']
  });

  assert.equal(summary.generation, 2);
  assert.equal(summary.experiments_started, 3);
  assert.equal(summary.retries_started, 1);

  const receipt = JSON.parse(
    await fs.readFile(
      path.join(root, 'foundry', 'generation-2', 'experiment-heretic-candidate-001', 'receipt.json'),
      'utf8'
    )
  );
  assert.equal(receipt.ready_for_merge, true);
  assert.equal(receipt.resource_receipt.nodes, 1);

  const retryReceipt = JSON.parse(
    await fs.readFile(
      path.join(root, 'foundry', 'generation-2', 'experiment-heretic-candidate-002-retry-1', 'receipt.json'),
      'utf8'
    )
  );
  assert.match(retryReceipt.experiment_id, /retry-1$/);
});
