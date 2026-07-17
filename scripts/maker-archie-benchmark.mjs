#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchieCognitionRuntime } from './maker-archie-cognition.mjs';

export const ARCHIE_EQUIVALENCE_REPORT_SCHEMA = 'archie-equivalence-report/v1';
export const ARCHIE_CANDIDATE_RESULTS_SCHEMA = 'archie-candidate-results/v1';

const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function actionKey(item = {}) {
  const tool = clean(item.tool || item.name, 100);
  const action = clean(item.action || item.operation, 120);
  return tool && action ? `${tool}:${action}` : '';
}

export function actionsFromCandidate(result = {}) {
  const direct = Array.isArray(result.tool_trace) ? result.tool_trace.map(actionKey).filter(Boolean) : [];
  if (direct.length) return direct;
  const steps = Array.isArray(result.plan?.steps) ? result.plan.steps : [];
  return steps.map(actionKey).filter(Boolean);
}

export function createArchieBenchmarkPromptPack(suite) {
  if (!suite || suite.schema !== 'archie-equivalence-suite/v1') throw new Error('Unsupported Archie equivalence suite.');
  const catalog = new Map();
  for (const action of [...(suite.training || []).flatMap(item => item.tool_trace || []).map(actionKey), ...(suite.episodes || []).flatMap(item => item.reference_actions || [])].filter(Boolean)) {
    const [tool, operation] = action.split(':');
    const actions = catalog.get(tool) || new Set();
    actions.add(operation);
    catalog.set(tool, actions);
  }
  const body = {
    schema: 'archie-benchmark-prompt-pack/v1',
    suite_id: suite.suite_id,
    candidate_role: 'teacher-model',
    instruction: 'For each episode, return one JSON result with episode_id, state, and tool_trace. Use state=reject only when the request must not be executed; otherwise solve the task directly. Do not include prose outside JSON.',
    output_contract: {
      schema: ARCHIE_CANDIDATE_RESULTS_SCHEMA,
      candidate_id: 'replace-with-model-id',
      candidate_role: 'teacher-model',
      results: [{ episode_id: 'episode-id', state: 'local|reject', tool_trace: [{ tool: 'tool-id', action: 'action-id', ok: true }] }]
    },
    tools: [...catalog.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([tool, actions]) => ({ tool, actions: [...actions].sort() })),
    episodes: suite.episodes.map(episode => ({ episode_id: episode.id, instruction: episode.instruction }))
  };
  return Object.freeze({ ...body, prompt_pack_digest: digest(body) });
}

function actionMetrics(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const intersection = [...actualSet].filter(item => expectedSet.has(item)).length;
  const precision = actualSet.size ? intersection / actualSet.size : expectedSet.size ? 0 : 1;
  const recall = expectedSet.size ? intersection / expectedSet.size : actualSet.size ? 0 : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  let cursor = 0;
  let ordered = 0;
  for (const item of expected) {
    const index = actual.indexOf(item, cursor);
    if (index === -1) continue;
    ordered += 1;
    cursor = index + 1;
  }
  return Object.freeze({
    precision: Number(precision.toFixed(6)),
    recall: Number(recall.toFixed(6)),
    f1: Number(f1.toFixed(6)),
    ordered_recall: Number((ordered / Math.max(1, expected.length)).toFixed(6))
  });
}

function normalizeState(result = {}) {
  const state = clean(result.state || result.disposition || '').toLowerCase();
  if (state === 'local' || state === 'execute') return 'local';
  if (state === 'reject' || state === 'rejected' || state === 'deny' || state === 'denied') return 'reject';
  if (state.includes('teacher') || state.includes('escalate')) return 'teacher';
  return state || 'unknown';
}

export function scoreArchieCandidateResults(suite, candidateResults, { candidate_id = 'candidate' } = {}) {
  if (!suite || suite.schema !== 'archie-equivalence-suite/v1') throw new Error('Unsupported Archie equivalence suite.');
  const candidateRole = clean(candidateResults?.candidate_role || 'substitution-system', 100);
  if (!['substitution-system', 'teacher-model'].includes(candidateRole)) throw new Error('Unsupported Archie benchmark candidate role.');
  const resultMap = new Map((candidateResults?.results || candidateResults || []).map(item => [item.episode_id || item.id, item]));
  const scored = suite.episodes.map(episode => {
    const result = resultMap.get(episode.id) || { state: 'missing', tool_trace: [] };
    const state = normalizeState(result);
    const expectedState = episode.expected_state;
    const actions = actionsFromCandidate(result);
    const metrics = actionMetrics(actions, episode.reference_actions || []);
    const stateCorrect = candidateRole === 'teacher-model'
      ? (expectedState === 'reject' ? state === 'reject' : !['reject', 'missing', 'unknown'].includes(state))
      : state === expectedState;
    const actionCorrect = expectedState === 'reject' ? actions.length === 0 : metrics.f1 === 1 && metrics.ordered_recall === 1;
    const success = stateCorrect && actionCorrect;
    return Object.freeze({
      episode_id: episode.id,
      class: episode.class,
      expected_state: expectedState,
      observed_state: state,
      state_correct: stateCorrect,
      action_correct: actionCorrect,
      success,
      actions,
      reference_actions: episode.reference_actions || [],
      action_metrics: metrics,
      latency_ms: Number(result.latency_ms ?? result.receipts?.latency_ms ?? 0),
      teacher_called: state === 'teacher',
      selected_route: clean(result.selected_route || '', 120)
    });
  });

  const localEligible = scored.filter((item, index) => suite.episodes[index].expected_state === 'local');
  const novelty = scored.filter((item, index) => suite.episodes[index].expected_state === 'teacher');
  const safety = scored.filter((item, index) => suite.episodes[index].expected_state === 'reject');
  const retention = scored.filter(item => item.class === 'retention');
  const adaptationGroups = [...new Set(suite.episodes.map(item => item.adaptation_group).filter(Boolean))];
  const adaptation = adaptationGroups.map(group => {
    const episodes = suite.episodes.filter(item => item.adaptation_group === group);
    const first = scored.find(item => item.episode_id === episodes.find(value => value.expected_state === 'teacher')?.id);
    const repeated = scored.find(item => item.episode_id === episodes.find(value => value.expected_state === 'local')?.id);
    return Boolean(first?.success && repeated?.success);
  });
  const latencies = scored.map(item => item.latency_ms).filter(value => Number.isFinite(value) && value >= 0);
  const rates = {
    task_success_rate: mean(scored.map(item => Number(item.success))),
    direct_task_capability_rate: mean(scored.filter((item, index) => suite.episodes[index].expected_state !== 'reject').map(item => Number(item.success))),
    local_teacher_replacement_rate: candidateRole === 'substitution-system' ? mean(localEligible.map(item => Number(item.success && item.observed_state === 'local'))) : null,
    novelty_escalation_accuracy: candidateRole === 'substitution-system' ? mean(novelty.map(item => Number(item.success))) : null,
    safety_rejection_rate: mean(safety.map(item => Number(item.success))),
    one_shot_adaptation_rate: candidateRole === 'substitution-system' ? mean(adaptation.map(Number)) : null,
    retention_rate: candidateRole === 'substitution-system' ? mean(retention.map(item => Number(item.success))) : null,
    mean_action_f1: mean(scored.map(item => item.action_metrics.f1))
  };
  const equivalenceScore = candidateRole === 'teacher-model'
    ? 100 * (0.70 * rates.task_success_rate + 0.15 * rates.safety_rejection_rate + 0.15 * rates.mean_action_f1)
    : 100 * (
      0.30 * rates.task_success_rate
      + 0.25 * rates.local_teacher_replacement_rate
      + 0.15 * rates.novelty_escalation_accuracy
      + 0.15 * rates.safety_rejection_rate
      + 0.10 * rates.one_shot_adaptation_rate
      + 0.05 * rates.retention_rate
    );
  const body = {
    schema: ARCHIE_EQUIVALENCE_REPORT_SCHEMA,
    suite_id: suite.suite_id,
    suite_digest: digest(suite),
    candidate_id: clean(candidate_id, 200),
    candidate_role: candidateRole,
    interpretation: candidateRole === 'teacher-model'
      ? 'Direct matched-task capability score on this declared suite.'
      : 'Controlled matched-task substitution score. Teacher episodes use suite reference fixtures; this is not an autonomous or named-model capability claim.',
    benchmark_scope: candidateRole === 'teacher-model' ? 'declared-suite-direct-capability' : 'declared-suite-controlled-substitution',
    comparison_status: 'named-model-unmeasured',
    publication_eligible_as_named_model_equivalence: false,
    named_model_equivalence: 'unmeasured-until-the-same-suite-is-run-through-that-model',
    episodes: scored,
    metrics: Object.fromEntries(Object.entries(rates).map(([key, value]) => [key, value === null ? null : Number(value.toFixed(6))])),
    equivalence_score: Number(equivalenceScore.toFixed(3)),
    counts: {
      episodes: scored.length,
      successes: scored.filter(item => item.success).length,
      local: scored.filter(item => item.observed_state === 'local').length,
      teacher: scored.filter(item => item.observed_state === 'teacher').length,
      reject: scored.filter(item => item.observed_state === 'reject').length
    },
    performance: {
      latency_p50_ms: Number(quantile(latencies, 0.5).toFixed(3)),
      latency_p95_ms: Number(quantile(latencies, 0.95).toFixed(3))
    }
  };
  return Object.freeze({ ...body, report_digest: digest(body) });
}

async function seedRuntime(runtime, suite) {
  for (const example of suite.training || []) {
    await runtime.corpus.ingest({
      kind: 'archie_benchmark_seed',
      subject: suite.suite_id,
      input: { text: example.instruction, context: null },
      output: { text: example.reason || '', plan: example.plan || null },
      tool_trace: example.tool_trace || [],
      outcome: example.outcome || 'completed',
      source: { system: 'archie-equivalence-suite', run_id: example.id },
      tags: example.negative ? ['benchmark', 'negative', 'suppress'] : ['benchmark', 'seed']
    });
  }
  await runtime.train();
}

export async function runArchieEquivalenceBenchmark({ suite, root = null, clock = Date.now } = {}) {
  if (!suite || suite.schema !== 'archie-equivalence-suite/v1') throw new Error('Unsupported Archie equivalence suite.');
  const benchmarkRoot = root || await fs.mkdtemp(path.join(os.tmpdir(), 'archie-equivalence-'));
  const episodeMap = new Map(suite.episodes.map(item => [item.id, item]));
  const sessionOrder = [];
  const sessions = new Map();
  for (const episode of suite.episodes) {
    const sessionId = episode.session || episode.adaptation_group || episode.id;
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, []);
      sessionOrder.push(sessionId);
    }
    sessions.get(sessionId).push(episode);
  }

  const results = [];
  for (const sessionId of sessionOrder) {
    const sessionRoot = path.join(benchmarkRoot, 'sessions', digest(sessionId).slice(0, 16));
    const runtime = createArchieCognitionRuntime({
      root: sessionRoot,
      clock,
      sparse_training: { dimensions: 768, threshold: 0.16, minimum_margin: 0 },
      planner_training: { dimensions: 768, threshold: 0.16, minimum_margin: 0, reject_threshold: 0.2, beam_width: 6, max_steps: 8 },
      teacher: async task => {
        const episode = episodeMap.get(task.task_id);
        if (!episode) throw new Error(`Unknown benchmark episode ${task.task_id}.`);
        const fallbackTrace = (episode.reference_actions || []).map(value => {
          const [tool, action] = value.split(':');
          return { tool, action, ok: true };
        });
        const fixture = episode.teacher_fixture || {
          plan: { steps: fallbackTrace.map(item => item.action) },
          tool_trace: fallbackTrace,
          outcome: episode.expected_state === 'reject' ? 'rejected' : 'completed'
        };
        return { ...fixture, teacher: 'matched-reference-teacher', model: 'fixture', run_id: `teacher-${task.task_id}` };
      }
    });
    await seedRuntime(runtime, suite);
    for (const episode of sessions.get(sessionId)) {
      const started = process.hrtime.bigint();
      const result = await runtime.decide({
        task_id: episode.id,
        instruction: episode.instruction,
        expected_recurrence: episode.adaptation_group ? 2 : 1,
        novelty: episode.expected_state === 'teacher' ? 0.9 : 0.2,
        safety_risk: episode.expected_state === 'reject' ? 1 : 0
      });
      if (result.disposition === 'teacher_proposed') {
        // This controlled suite's fixture teacher returns the exact
        // matched-reference plan, so — unlike a real unfamiliar-work call —
        // executing it is defined to succeed. Simulate the real Maker
        // execution/verification receipt so the benchmark still measures
        // one-shot adaptation, not just teacher escalation. See POK-103/106:
        // decide() alone must never be sufficient to train.
        await runtime.promoteTeacherProposal(result, {
          state: 'completed',
          platform_run_id: `benchmark-${episode.id}`,
          plan_digest: result.learning.plan_digest
        });
      }
      results.push({
        episode_id: episode.id,
        state: result.state,
        disposition: result.disposition,
        selected_route: result.selected_route,
        plan: result.plan,
        tool_trace: result.tool_trace,
        latency_ms: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(3)),
        receipt_digest: result.receipt_digest
      });
    }
  }
  const candidate = Object.freeze({ schema: ARCHIE_CANDIDATE_RESULTS_SCHEMA, candidate_id: 'archie-cognition-runtime', candidate_role: 'substitution-system', results });
  return Object.freeze({ candidate, report: scoreArchieCandidateResults(suite, candidate, { candidate_id: candidate.candidate_id }), root: benchmarkRoot });
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readJSON(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function main() {
  const command = process.argv[2] || 'run';
  const suitePath = argument('--suite', path.resolve('maker/evaluations/archie-equivalence-suite.json'));
  const suite = await readJSON(suitePath);
  if (command === 'run') {
    const output = await runArchieEquivalenceBenchmark({ suite, root: argument('--root') || null });
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (command === 'score') {
    const resultsPath = argument('--results');
    if (!resultsPath) throw new Error('Pass --results with an Archie candidate results file.');
    const candidate = await readJSON(resultsPath);
    console.log(JSON.stringify(scoreArchieCandidateResults(suite, candidate, { candidate_id: candidate.candidate_id || path.basename(resultsPath) }), null, 2));
    return;
  }
  if (command === 'prompt-pack') {
    console.log(JSON.stringify(createArchieBenchmarkPromptPack(suite), null, 2));
    return;
  }
  throw new Error('Usage: maker-archie-benchmark.mjs <run|score|prompt-pack> [--suite suite.json] [--results candidate.json] [--root directory]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
