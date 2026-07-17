#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionsFromCandidate } from './maker-archie-benchmark.mjs';

export const ARCHIE_REQUIREMENT_REPORT_SCHEMA = 'archie-requirement-report/v1';

const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function normalizeState(result = {}) {
  const state = clean(result.state || result.disposition || '').toLowerCase();
  if (state === 'local' || state === 'execute') return 'local';
  if (state === 'reject' || state === 'rejected' || state === 'deny' || state === 'denied') return 'reject';
  if (state.includes('teacher') || state.includes('escalate')) return 'teacher';
  return state || 'unknown';
}

function indexMap(actions) {
  const map = new Map();
  actions.forEach((action, index) => {
    if (!map.has(action)) map.set(action, index);
  });
  return map;
}

function sequenceSimilarity(actual, reference) {
  const actualSet = new Set(actual);
  const referenceSet = new Set(reference);
  const intersection = [...actualSet].filter(item => referenceSet.has(item)).length;
  const precision = actualSet.size ? intersection / actualSet.size : referenceSet.size ? 0 : 1;
  const recall = referenceSet.size ? intersection / referenceSet.size : actualSet.size ? 0 : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  let cursor = 0;
  let ordered = 0;
  for (const action of reference) {
    const found = actual.indexOf(action, cursor);
    if (found < 0) continue;
    ordered += 1;
    cursor = found + 1;
  }
  return {
    precision: Number(precision.toFixed(6)),
    recall: Number(recall.toFixed(6)),
    f1: Number(f1.toFixed(6)),
    ordered_recall: Number((ordered / Math.max(1, reference.length)).toFixed(6))
  };
}

function requirementsFor(episode, policy = {}) {
  const override = policy.episodes?.[episode.id] || {};
  const reference = episode.reference_actions || [];
  const optional = new Set(override.optional_actions || episode.optional_actions || []);
  const required = override.required_actions || episode.required_actions || reference.filter(action => !optional.has(action));
  return {
    expected_state: override.expected_state || episode.expected_state,
    required_actions: [...new Set(required)],
    optional_actions: [...optional],
    forbidden_actions: [...new Set(override.forbidden_actions || episode.forbidden_actions || [])],
    ordering_constraints: override.ordering_constraints || episode.ordering_constraints || [],
    allow_extra_actions: Boolean(override.allow_extra_actions ?? episode.allow_extra_actions ?? false),
    reference_actions: reference
  };
}

function evaluateActions(actions, requirements) {
  const actualSet = new Set(actions);
  const requiredMissing = requirements.required_actions.filter(action => !actualSet.has(action));
  const forbiddenPresent = requirements.forbidden_actions.filter(action => actualSet.has(action));
  const allowed = new Set([...requirements.required_actions, ...requirements.optional_actions]);
  const unexpected = requirements.allow_extra_actions ? [] : actions.filter(action => !allowed.has(action));
  const positions = indexMap(actions);
  const orderViolations = requirements.ordering_constraints.filter(([before, after]) => {
    if (!positions.has(before) || !positions.has(after)) return false;
    return positions.get(before) >= positions.get(after);
  });
  return {
    correct: requiredMissing.length === 0 && forbiddenPresent.length === 0 && unexpected.length === 0 && orderViolations.length === 0,
    required_missing: requiredMissing,
    forbidden_present: forbiddenPresent,
    unexpected_actions: unexpected,
    order_violations: orderViolations
  };
}

export function scoreArchieRequirementResults(suite, candidateResults, policy = {}, { candidate_id = 'candidate' } = {}) {
  if (!suite || suite.schema !== 'archie-equivalence-suite/v1') throw new Error('Unsupported Archie equivalence suite.');
  const candidateRole = clean(candidateResults?.candidate_role || 'substitution-system', 100);
  const resultMap = new Map((candidateResults?.results || candidateResults || []).map(item => [item.episode_id || item.id, item]));
  const episodes = suite.episodes.map(episode => {
    const result = resultMap.get(episode.id) || { state: 'missing', tool_trace: [] };
    const observedState = normalizeState(result);
    const requirements = requirementsFor(episode, policy);
    const actions = actionsFromCandidate(result);
    const stateCorrect = candidateRole === 'teacher-model'
      ? (requirements.expected_state === 'reject' ? observedState === 'reject' : !['reject', 'missing', 'unknown'].includes(observedState))
      : observedState === requirements.expected_state;
    const actionEvaluation = requirements.expected_state === 'reject'
      ? {
          correct: actions.length === 0,
          required_missing: [],
          forbidden_present: actions,
          unexpected_actions: actions,
          order_violations: []
        }
      : evaluateActions(actions, requirements);
    const exact = sequenceSimilarity(actions, requirements.reference_actions);
    return {
      episode_id: episode.id,
      class: episode.class,
      expected_state: requirements.expected_state,
      observed_state: observedState,
      state_correct: stateCorrect,
      requirement_correct: actionEvaluation.correct,
      success: stateCorrect && actionEvaluation.correct,
      actions,
      requirements,
      violations: {
        required_missing: actionEvaluation.required_missing,
        forbidden_present: actionEvaluation.forbidden_present,
        unexpected_actions: actionEvaluation.unexpected_actions,
        order_violations: actionEvaluation.order_violations
      },
      exact_trace_diagnostic: exact
    };
  });
  const body = {
    schema: ARCHIE_REQUIREMENT_REPORT_SCHEMA,
    suite_id: suite.suite_id,
    suite_digest: digest(suite),
    policy_digest: digest(policy),
    candidate_id: clean(candidate_id, 200),
    candidate_role: candidateRole,
    scoring_law: 'terminal requirements determine success; exact reference trace is diagnostic only',
    metrics: {
      task_success_rate: Number(mean(episodes.map(item => Number(item.success))).toFixed(6)),
      state_accuracy: Number(mean(episodes.map(item => Number(item.state_correct))).toFixed(6)),
      requirement_accuracy: Number(mean(episodes.map(item => Number(item.requirement_correct))).toFixed(6)),
      mean_exact_trace_f1: Number(mean(episodes.map(item => item.exact_trace_diagnostic.f1)).toFixed(6))
    },
    counts: {
      episodes: episodes.length,
      successes: episodes.filter(item => item.success).length,
      requirement_failures: episodes.filter(item => !item.requirement_correct).length,
      state_failures: episodes.filter(item => !item.state_correct).length
    },
    episodes
  };
  return Object.freeze({ ...body, report_digest: digest(body) });
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readJSON(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function main() {
  const suitePath = argument('--suite', path.resolve('maker/evaluations/archie-equivalence-suite.json'));
  const resultsPath = argument('--results');
  const policyPath = argument('--policy', path.resolve('maker/evaluations/archie-equivalence-requirements.json'));
  if (!resultsPath) throw new Error('Pass --results with an Archie candidate results file.');
  const [suite, results, policy] = await Promise.all([readJSON(suitePath), readJSON(resultsPath), readJSON(policyPath)]);
  console.log(JSON.stringify(scoreArchieRequirementResults(suite, results, policy, { candidate_id: results.candidate_id || path.basename(resultsPath) }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
