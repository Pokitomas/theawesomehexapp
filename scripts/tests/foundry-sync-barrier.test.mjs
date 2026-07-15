import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { establishWritePhase, topHereticCandidates } from '../../foundry/agents/sync-barrier.mjs';

async function fixtureRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'foundry-sync-barrier-'));
}

test('sync barrier picks top 3 heretic candidates by score', () => {
  const candidates = topHereticCandidates([
    { role: 'heretic', experiment_id: 'c1', score: 0.2 },
    { role: 'heretic', experiment_id: 'c2', score: 0.9 },
    { role: 'heretic', experiment_id: 'c3', score: 0.8 },
    { role: 'heretic', experiment_id: 'c4', score: 0.1 },
    { role: 'inventor', experiment_id: 'i1', score: 0.99 }
  ]);
  assert.deepEqual(candidates.map(item => item.experiment_id), ['c2', 'c3', 'c1']);
});

test('sync barrier auto-unlocks write phase and emits established model and writer lease', async t => {
  const root = await fixtureRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await establishWritePhase({
    root,
    generation: 2,
    findings: [{ role: 'heretic', experiment_id: 'h-001', score: 1, genome: { lineage: ['g1'] } }],
    contradictions: ['contradiction-a']
  });

  const established = JSON.parse(await fs.readFile(path.join(root, 'foundry', 'generation-2', 'established-model.json'), 'utf8'));
  const lease = JSON.parse(await fs.readFile(path.join(root, 'foundry', 'generation-2', 'WRITER_LEASE.json'), 'utf8'));
  assert.equal(established.ready_for_write_phase, true);
  assert.equal(established.approval_required, false);
  assert.equal(established.first_writer_candidates[0].experiment_id, 'h-001');
  assert.equal(lease.write_access, true);
  assert.match(lease.branch, /^foundry\/g2\/h-001$/);
});
