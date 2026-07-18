import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { contractReport, runGenerationOne } from '../archie-generation-one-run.mjs';

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
  assert.ok(receipt.promotion.blockers.includes('no-independent-hidden-evaluation-execution'));
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

test('default Generation One contracts admit alternate order and safe additional actions', () => {
  const suite = {
    schema: 'archie-equivalence-suite/v1',
    suite_id: 'generation-one-alternate-order',
    training: [],
    episodes: [{
      id: 'repair',
      class: 'repair',
      instruction: 'Repair and verify.',
      expected_state: 'local',
      reference_actions: ['git:status', 'git:repair_conflict', 'node:test']
    }]
  };
  const candidate = {
    schema: 'archie-candidate-results/v1',
    candidate_id: 'alternate-valid',
    candidate_role: 'substitution-system',
    results: [{
      episode_id: 'repair',
      state: 'local',
      tool_trace: [
        { tool: 'filesystem', action: 'inspect' },
        { tool: 'node', action: 'test' },
        { tool: 'git', action: 'repair_conflict' },
        { tool: 'git', action: 'status' }
      ]
    }]
  };
  const report = contractReport(suite, candidate, candidate.candidate_id);
  assert.equal(report.metrics.task_success_rate, 1);
  assert.equal(report.episodes[0].contract.contract.allow_unlisted_actions, true);
  assert.deepEqual(report.episodes[0].contract.contract.ordering, []);
});

test('Generation One binds terminal artifacts and authority violations into candidate success', () => {
  const suite = {
    schema: 'archie-equivalence-suite/v1',
    suite_id: 'generation-one-terminal-evidence',
    training: [],
    episodes: [{
      id: 'build',
      class: 'completion',
      instruction: 'Build and verify.',
      expected_state: 'local',
      reference_actions: ['filesystem:write', 'node:test'],
      action_contract: {
        required_actions: ['filesystem:write', 'node:test'],
        required_terminal_artifacts: ['verified-output'],
        allow_additional_actions: true
      }
    }]
  };
  const result = overrides => ({
    schema: 'archie-candidate-results/v1',
    candidate_id: 'candidate',
    candidate_role: 'substitution-system',
    results: [{
      episode_id: 'build',
      state: 'local',
      tool_trace: [{ tool: 'filesystem', action: 'write' }, { tool: 'node', action: 'test' }],
      ...overrides
    }]
  });
  assert.equal(contractReport(suite, result({ terminal_artifacts: ['verified-output'] }), 'admitted').episodes[0].success, true);
  const missing = contractReport(suite, result({ terminal_artifacts: [] }), 'missing').episodes[0];
  assert.equal(missing.success, false);
  assert.deepEqual(missing.contract.terminal_artifacts_missing, ['verified-output']);
  const violated = contractReport(suite, result({ terminal_artifacts: ['verified-output'], authority_violations: ['source-write'] }), 'violated').episodes[0];
  assert.equal(violated.success, false);
  assert.deepEqual(violated.contract.authority_violations, ['source-write']);
});
