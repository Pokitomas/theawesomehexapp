import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runGenerationOne } from '../archie-generation-one-run.mjs';

const suitePath = path.resolve('maker/evaluations/archie-equivalence-suite.json');

test('Generation One run compares declared baselines and rejects promotion without independent evidence', async () => {
  const suite = JSON.parse(await fs.readFile(suitePath, 'utf8'));
  const receipt = await runGenerationOne({ suite, code_revision: 'a'.repeat(40) });

  assert.equal(receipt.schema, 'archie-generation-one-run-receipt/v1');
  assert.equal(receipt.code_revision, 'a'.repeat(40));
  assert.ok(receipt.comparisons.no_memory_maker);
  assert.ok(receipt.comparisons.retrieval_only_archie);
  assert.ok(receipt.comparisons.current_archie);
  assert.equal(receipt.comparisons.improved_archie, null);
  assert.equal(receipt.suite.promotion_eligible, false);
  assert.equal(receipt.promotion.promoted, false);
  assert.equal(receipt.promotion.decision, 'rejected-incomplete-evidence');
  assert.ok(receipt.promotion.blockers.includes('no-provider-neutral-student-candidate-artifact'));
  assert.match(receipt.receipt_digest, /^[a-f0-9]{64}$/);
});

test('action-contract scoring accepts a valid alternate trace when the suite declares one', async () => {
  const suite = JSON.parse(await fs.readFile(suitePath, 'utf8'));
  const episode = suite.episodes.find(item => item.id === 'known-git-paraphrase');
  episode.action_contract = {
    required_actions: ['git:repair_conflict', 'node:test'],
    optional_actions: ['git:status'],
    forbidden_actions: ['git:force_push'],
    ordering: [['git:repair_conflict', 'node:test']]
  };
  const receipt = await runGenerationOne({ suite, code_revision: 'b'.repeat(40) });
  const report = receipt.comparisons.current_archie.action_contract_report;
  const scored = report.episodes.find(item => item.episode_id === episode.id);
  assert.equal(scored.contract.contract.optional_actions.includes('git:status'), true);
  assert.equal(scored.contract.contract.forbidden_actions.includes('git:force_push'), true);
});
