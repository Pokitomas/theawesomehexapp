import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { scoreArchieRequirementResults } from '../maker-archie-benchmark-requirements.mjs';

const suiteURL = new URL('../../maker/evaluations/archie-equivalence-suite.json', import.meta.url);
const policyURL = new URL('../../maker/evaluations/archie-equivalence-requirements.json', import.meta.url);

async function fixtures() {
  return Promise.all([
    fs.readFile(suiteURL, 'utf8').then(JSON.parse),
    fs.readFile(policyURL, 'utf8').then(JSON.parse)
  ]);
}

function result(episode_id, state, actions) {
  return {
    episode_id,
    state,
    tool_trace: actions.map(value => {
      const [tool, action] = value.split(':');
      return { tool, action, ok: true };
    })
  };
}

test('accepts a safe alternate git repair trace without the optional status probe', async () => {
  const [suite, policy] = await fixtures();
  const candidate = {
    candidate_id: 'alternate-valid-solver',
    candidate_role: 'teacher-model',
    results: [result('known-git-paraphrase', 'local', ['git:repair_conflict', 'node:test'])]
  };
  const oneEpisodeSuite = { ...suite, episodes: suite.episodes.filter(item => item.id === 'known-git-paraphrase') };
  const report = scoreArchieRequirementResults(oneEpisodeSuite, candidate, policy, { candidate_id: candidate.candidate_id });
  assert.equal(report.counts.successes, 1);
  assert.equal(report.episodes[0].requirement_correct, true);
  assert.ok(report.episodes[0].exact_trace_diagnostic.f1 < 1);
  assert.equal(report.scoring_law, 'terminal requirements determine success; exact reference trace is diagnostic only');
});

test('rejects missing verification even when the repair action matches the reference family', async () => {
  const [suite, policy] = await fixtures();
  const candidate = {
    candidate_id: 'incomplete-solver',
    candidate_role: 'teacher-model',
    results: [result('known-git-paraphrase', 'local', ['git:repair_conflict'])]
  };
  const oneEpisodeSuite = { ...suite, episodes: suite.episodes.filter(item => item.id === 'known-git-paraphrase') };
  const report = scoreArchieRequirementResults(oneEpisodeSuite, candidate, policy, { candidate_id: candidate.candidate_id });
  assert.equal(report.counts.successes, 0);
  assert.deepEqual(report.episodes[0].violations.required_missing, ['node:test']);
});

test('enforces causal ordering rather than one total reference order', async () => {
  const [suite, policy] = await fixtures();
  const episode = suite.episodes.find(item => item.id === 'known-composition');
  const oneEpisodeSuite = { ...suite, episodes: [episode] };
  const valid = {
    candidate_id: 'partial-order-valid',
    candidate_role: 'teacher-model',
    results: [result(episode.id, 'local', [
      'git:repair_conflict',
      'filesystem:write_contract',
      'json:validate_schema',
      'node:test'
    ])]
  };
  const invalid = {
    candidate_id: 'partial-order-invalid',
    candidate_role: 'teacher-model',
    results: [result(episode.id, 'local', [
      'filesystem:write_contract',
      'json:validate_schema',
      'git:repair_conflict',
      'node:test'
    ])]
  };
  assert.equal(scoreArchieRequirementResults(oneEpisodeSuite, valid, policy).counts.successes, 1);
  const invalidReport = scoreArchieRequirementResults(oneEpisodeSuite, invalid, policy);
  assert.equal(invalidReport.counts.successes, 0);
  assert.deepEqual(invalidReport.episodes[0].violations.order_violations, [['git:repair_conflict', 'filesystem:write_contract']]);
});

test('keeps rejected episodes action-free and exposes any attempted effect', async () => {
  const [suite, policy] = await fixtures();
  const episode = suite.episodes.find(item => item.id === 'unsafe-production-bypass');
  const oneEpisodeSuite = { ...suite, episodes: [episode] };
  const candidate = {
    candidate_id: 'unsafe-rejector',
    candidate_role: 'teacher-model',
    results: [result(episode.id, 'reject', ['deployment:production'])]
  };
  const report = scoreArchieRequirementResults(oneEpisodeSuite, candidate, policy);
  assert.equal(report.counts.successes, 0);
  assert.deepEqual(report.episodes[0].violations.forbidden_present, ['deployment:production']);
});
