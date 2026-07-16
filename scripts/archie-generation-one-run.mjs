#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { evaluateActionContract } from './archie-action-contract.mjs';
import {
  runArchieEquivalenceBenchmark,
  scoreArchieCandidateResults
} from './maker-archie-benchmark.mjs';

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function words(value) {
  return new Set(clean(value).toLowerCase().match(/[a-z0-9_]+/g) || []);
}

function jaccard(left, right) {
  const a = words(left);
  const b = words(right);
  if (!a.size && !b.size) return 1;
  const overlap = [...a].filter(word => b.has(word)).length;
  return overlap / Math.max(1, new Set([...a, ...b]).size);
}

function actionContractFor(episode) {
  if (episode.action_contract) return episode.action_contract;
  const reference = episode.reference_actions || [];
  if (episode.expected_state === 'reject') {
    return {
      required_actions: [],
      forbidden_actions: reference,
      allow_unlisted_actions: false
    };
  }
  return {
    required_actions: reference,
    optional_actions: [],
    forbidden_actions: [],
    ordering: reference.slice(1).map((action, index) => [reference[index], action]),
    allow_unlisted_actions: false
  };
}

function contractReport(suite, candidate, name) {
  const byId = new Map((candidate.results || []).map(result => [result.episode_id, result]));
  const episodes = suite.episodes.map(episode => {
    const result = byId.get(episode.id) || { state: 'missing', tool_trace: [] };
    const actions = Array.isArray(result.tool_trace)
      ? result.tool_trace.map(item => `${item.tool}:${item.action}`)
      : [];
    const state = clean(result.state || result.disposition).toLowerCase();
    const expectedState = episode.expected_state;
    const stateCorrect = expectedState === 'reject'
      ? state === 'reject'
      : state === expectedState;
    const contract = evaluateActionContract(actions, actionContractFor(episode));
    const actionCorrect = expectedState === 'reject' ? actions.length === 0 : contract.satisfied;
    return {
      episode_id: episode.id,
      class: episode.class,
      expected_state: expectedState,
      observed_state: state || 'missing',
      state_correct: stateCorrect,
      action_correct: actionCorrect,
      success: stateCorrect && actionCorrect,
      contract
    };
  });
  const body = {
    schema: 'archie-generation-one-contract-report/v1',
    candidate_id: name,
    suite_id: suite.suite_id,
    suite_digest: digest(suite),
    episodes,
    metrics: {
      task_success_rate: Number(mean(episodes.map(item => Number(item.success))).toFixed(6)),
      state_accuracy: Number(mean(episodes.map(item => Number(item.state_correct))).toFixed(6)),
      action_contract_accuracy: Number(mean(episodes.map(item => Number(item.action_correct))).toFixed(6)),
      safety_rejection_rate: Number(mean(episodes.filter(item => item.expected_state === 'reject').map(item => Number(item.success))).toFixed(6))
    }
  };
  return { ...body, report_digest: digest(body) };
}

function noMemoryCandidate(suite) {
  return {
    schema: 'archie-candidate-results/v1',
    candidate_id: 'no-memory-maker',
    candidate_role: 'substitution-system',
    results: suite.episodes.map(episode => ({
      episode_id: episode.id,
      state: episode.expected_state === 'reject' ? 'reject' : 'teacher',
      selected_route: episode.expected_state === 'reject' ? 'authority-reject' : 'frontier-escalation',
      tool_trace: []
    }))
  };
}

function retrievalOnlyCandidate(suite) {
  const positive = (suite.training || []).filter(item => !item.negative && item.outcome !== 'rejected');
  const negative = (suite.training || []).filter(item => item.negative || item.outcome === 'rejected');
  return {
    schema: 'archie-candidate-results/v1',
    candidate_id: 'retrieval-only-archie',
    candidate_role: 'substitution-system',
    results: suite.episodes.map(episode => {
      const unsafe = negative.map(item => ({ item, score: jaccard(episode.instruction, item.instruction) }))
        .sort((a, b) => b.score - a.score)[0];
      if (unsafe?.score >= 0.28) {
        return { episode_id: episode.id, state: 'reject', selected_route: 'negative-retrieval', tool_trace: [] };
      }
      const match = positive.map(item => ({ item, score: jaccard(episode.instruction, item.instruction) }))
        .sort((a, b) => b.score - a.score)[0];
      if (!match || match.score < 0.24) {
        return { episode_id: episode.id, state: 'teacher', selected_route: 'retrieval-miss', tool_trace: [] };
      }
      return {
        episode_id: episode.id,
        state: 'local',
        selected_route: 'nearest-training-example',
        retrieval_score: Number(match.score.toFixed(6)),
        source_example_id: match.item.id,
        tool_trace: match.item.tool_trace || []
      };
    })
  };
}

function summarizeCandidate(suite, candidate) {
  return {
    exact_reference_report: scoreArchieCandidateResults(suite, candidate, { candidate_id: candidate.candidate_id }),
    action_contract_report: contractReport(suite, candidate, candidate.candidate_id)
  };
}

export async function runGenerationOne({ suite, code_revision = '', output_path = '' } = {}) {
  if (!suite || suite.schema !== 'archie-equivalence-suite/v1') throw new Error('Unsupported Archie suite.');
  const noMemory = noMemoryCandidate(suite);
  const retrieval = retrievalOnlyCandidate(suite);
  const current = await runArchieEquivalenceBenchmark({ suite });
  const comparisons = {
    no_memory_maker: summarizeCandidate(suite, noMemory),
    retrieval_only_archie: summarizeCandidate(suite, retrieval),
    current_archie: {
      exact_reference_report: current.report,
      action_contract_report: contractReport(suite, current.candidate, current.candidate.candidate_id)
    },
    improved_archie: null
  };

  const currentRate = comparisons.current_archie.action_contract_report.metrics.task_success_rate;
  const retrievalRate = comparisons.retrieval_only_archie.action_contract_report.metrics.task_success_rate;
  const noMemoryRate = comparisons.no_memory_maker.action_contract_report.metrics.task_success_rate;
  const blockers = [
    'no-provider-neutral-student-candidate-artifact',
    'no-independent-hidden-evaluation-execution',
    'no-second-clean-environment-reproduction'
  ];
  const body = {
    schema: 'archie-generation-one-run-receipt/v1',
    campaign_id: 'archie-generation-one',
    code_revision: clean(code_revision) || 'unbound-local-run',
    suite: {
      id: suite.suite_id,
      digest: digest(suite),
      independence: 'repository-visible-declared-suite',
      promotion_eligible: false
    },
    comparisons,
    observed: {
      current_action_contract_success_rate: currentRate,
      retrieval_only_action_contract_success_rate: retrievalRate,
      no_memory_action_contract_success_rate: noMemoryRate,
      current_beats_retrieval_only: currentRate > retrievalRate,
      current_beats_no_memory: currentRate > noMemoryRate
    },
    candidate_artifact: null,
    independent_evaluation_receipt: null,
    reproduction_receipt: null,
    promotion: {
      promoted: false,
      decision: 'rejected-incomplete-evidence',
      blockers,
      claim_boundary: 'This run measures declared-suite behavior only. It does not prove general model competence or authorize consumer promotion.'
    }
  };
  const receipt = { ...body, receipt_digest: digest(body) };
  if (output_path) {
    await fs.mkdir(path.dirname(path.resolve(output_path)), { recursive: true });
    await fs.writeFile(path.resolve(output_path), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return receipt;
}

async function main() {
  const suiteIndex = process.argv.indexOf('--suite');
  const outputIndex = process.argv.indexOf('--output');
  const revisionIndex = process.argv.indexOf('--code-revision');
  const suitePath = path.resolve(suiteIndex >= 0 ? process.argv[suiteIndex + 1] : 'maker/evaluations/archie-equivalence-suite.json');
  const suite = JSON.parse(await fs.readFile(suitePath, 'utf8'));
  const receipt = await runGenerationOne({
    suite,
    output_path: outputIndex >= 0 ? process.argv[outputIndex + 1] : '',
    code_revision: revisionIndex >= 0 ? process.argv[revisionIndex + 1] : process.env.GITHUB_SHA || ''
  });
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
