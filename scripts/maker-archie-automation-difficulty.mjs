import crypto from 'node:crypto';

export const ARCHIE_AUTOMATION_DIFFICULTY_SCHEMA = 'archie-automation-difficulty/v1';
export const ARCHIE_LAUNCH_SIZING_HYPOTHESIS_SCHEMA = 'archie-launch-sizing-hypothesis/v1';

const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function eventCount(events, types) {
  const wanted = new Set(types);
  return events.filter(event => wanted.has(clean(event?.type, 80))).length;
}

function normalizeEpisode(value, index) {
  const events = Array.isArray(value?.events) ? value.events : [];
  const toolEvents = events.filter(event => ['tool-call', 'tool-result'].includes(clean(event?.type, 80)));
  const explicit = value?.difficulty && typeof value.difficulty === 'object' ? value.difficulty : {};
  const outcome = clean(value?.outcome?.status || value?.outcome || 'unknown', 80).toLowerCase();
  const retries = finite(explicit.retries, eventCount(events, ['retry']));
  const interventions = finite(explicit.human_interventions, eventCount(events, ['user-intervention']));
  const overrides = finite(explicit.overrides, events.filter(event => clean(event?.type, 80) === 'user-intervention' && /override|correct|reject/i.test(JSON.stringify(event?.payload || {}))).length);
  const rollbacks = finite(explicit.rollbacks, eventCount(events, ['rollback']));
  const pauses = finite(explicit.pauses, eventCount(events, ['pause', 'resume']));
  const corrections = finite(explicit.corrections, eventCount(events, ['correction']));
  const steps = Math.max(1, finite(explicit.steps, events.length || value?.step_count || 1));
  const toolCount = finite(explicit.tool_calls, toolEvents.length || value?.tool_count || 0);
  const distinctTools = new Set(toolEvents.map(event => clean(event?.payload?.tool || event?.payload?.name || event?.payload?.adapter, 200)).filter(Boolean)).size;
  const contextBytes = finite(explicit.context_bytes, value?.context_bytes || JSON.stringify(value?.context || {}).length);
  const elapsedMs = finite(explicit.elapsed_ms, value?.elapsed_ms || 0);
  const environments = Math.max(1, finite(explicit.environment_count, value?.environment_count || 1));
  const ambiguity = clamp(explicit.ambiguity ?? value?.ambiguity ?? 0);
  const recurrence = clamp(explicit.recurrence ?? value?.recurrence ?? 0);
  const success = outcome === 'completed' ? 1 : outcome === 'partial' ? 0.5 : 0;
  const body = {
    id: clean(value?.trajectory_digest || value?.id || `episode-${index + 1}`, 300),
    outcome,
    success,
    steps,
    retries,
    interventions,
    overrides,
    rollbacks,
    pauses,
    corrections,
    tool_calls: toolCount,
    distinct_tools: distinctTools,
    context_bytes: contextBytes,
    elapsed_ms: elapsedMs,
    environment_count: environments,
    ambiguity,
    recurrence
  };
  return Object.freeze({ ...body, episode_digest: digest(body) });
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function normalizedLog(value, reference) {
  return clamp(Math.log1p(Math.max(0, value)) / Math.log1p(reference));
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function sizeClass(score, diversity, latencyPressure) {
  if (score >= 0.78 || (score >= 0.68 && diversity >= 0.65)) {
    return {
      class: 'heavy-mixture-or-large-dense',
      total_parameters_hypothesis: '20B-70B',
      active_parameters_hypothesis: latencyPressure >= 0.6 ? '8B-20B MoE active' : '20B-40B dense',
      minimum_context_hypothesis: 131072
    };
  }
  if (score >= 0.55) {
    return {
      class: 'mid-heavy-dense-or-sparse',
      total_parameters_hypothesis: '8B-24B',
      active_parameters_hypothesis: '8B-16B',
      minimum_context_hypothesis: 65536
    };
  }
  if (score >= 0.32) {
    return {
      class: 'compact-generalist',
      total_parameters_hypothesis: '3B-10B',
      active_parameters_hypothesis: '3B-8B',
      minimum_context_hypothesis: 32768
    };
  }
  return {
    class: 'small-specialist',
    total_parameters_hypothesis: '1B-4B',
    active_parameters_hypothesis: '1B-4B',
    minimum_context_hypothesis: 16384
  };
}

export function inferAutomationDifficulty(input, { generated_at = new Date().toISOString() } = {}) {
  const episodes = (Array.isArray(input) ? input : []).map(normalizeEpisode);
  if (!episodes.length) throw new Error('Automation difficulty inference requires at least one episode.');
  const interventionPressure = average(episodes.map(item => clamp((item.interventions + item.overrides * 1.5) / Math.max(1, item.steps * 0.25))));
  const recoveryPressure = average(episodes.map(item => clamp((item.retries + item.corrections + item.rollbacks * 2) / Math.max(1, item.steps * 0.35))));
  const horizonPressure = average(episodes.map(item => Math.max(normalizedLog(item.steps, 128), normalizedLog(item.elapsed_ms, 86_400_000))));
  const contextPressure = average(episodes.map(item => normalizedLog(item.context_bytes, 1_000_000)));
  const toolPressure = average(episodes.map(item => Math.max(normalizedLog(item.tool_calls, 64), normalizedLog(item.distinct_tools, 16))));
  const environmentPressure = average(episodes.map(item => normalizedLog(item.environment_count, 16)));
  const ambiguityPressure = average(episodes.map(item => item.ambiguity));
  const failurePressure = 1 - average(episodes.map(item => item.success));
  const recurrenceOpportunity = average(episodes.map(item => item.recurrence));
  const diversity = clamp((toolPressure + environmentPressure + ambiguityPressure) / 3);
  const difficultyScore = clamp(
    interventionPressure * 0.2
    + recoveryPressure * 0.18
    + horizonPressure * 0.16
    + contextPressure * 0.14
    + toolPressure * 0.12
    + environmentPressure * 0.08
    + ambiguityPressure * 0.07
    + failurePressure * 0.05
  );
  const latencyPressure = clamp(1 - average(episodes.map(item => normalizedLog(item.elapsed_ms, 600_000))));
  const sizing = sizeClass(difficultyScore, diversity, latencyPressure);
  const capabilityPressure = {
    uncertainty_calibration: Number(Math.max(interventionPressure, ambiguityPressure, failurePressure).toFixed(6)),
    long_horizon_planning: Number(horizonPressure.toFixed(6)),
    recovery_and_rollback: Number(recoveryPressure.toFixed(6)),
    tool_grounding: Number(toolPressure.toFixed(6)),
    working_memory: Number(contextPressure.toFixed(6)),
    cross_environment_transfer: Number(environmentPressure.toFixed(6)),
    human_intent_modeling: Number(interventionPressure.toFixed(6)),
    reusable_skill_value: Number(recurrenceOpportunity.toFixed(6))
  };
  const distillation = [
    {
      method: 'verified-trajectory-sft',
      use: 'Successful corrected trajectories with exact execution and verifier receipts.',
      weight: Number(clamp(0.35 + recurrenceOpportunity * 0.35).toFixed(6))
    },
    {
      method: 'preference-distillation',
      use: 'Human overrides and accepted corrections become chosen/rejected action or plan pairs.',
      weight: Number(interventionPressure.toFixed(6))
    },
    {
      method: 'negative-unlikelihood-and-suppression',
      use: 'Repeated failed, unsafe, rolled-back, or explicitly rejected actions remain negative knowledge.',
      weight: Number(Math.max(recoveryPressure, failurePressure).toFixed(6))
    },
    {
      method: 'process-and-verifier-distillation',
      use: 'Independent verification, stop decisions, rollback triggers, and authority checks train verifier/value heads.',
      weight: Number(Math.max(recoveryPressure, toolPressure).toFixed(6))
    },
    {
      method: 'difficulty-curriculum',
      use: 'Order examples by intervention, recovery, horizon, context, and cross-environment difficulty rather than chronology alone.',
      weight: Number(difficultyScore.toFixed(6))
    },
    {
      method: 'retrieval-and-memory-distillation',
      use: 'Long-context and recurrent automation episodes train what to retrieve, compress, retain, and forget.',
      weight: Number(Math.max(contextPressure, recurrenceOpportunity).toFixed(6))
    }
  ];
  const body = {
    schema: ARCHIE_AUTOMATION_DIFFICULTY_SCHEMA,
    generated_at,
    episode_count: episodes.length,
    episode_digests: episodes.map(item => item.episode_digest).sort(),
    aggregate: {
      difficulty_score: Number(difficultyScore.toFixed(6)),
      intervention_pressure: Number(interventionPressure.toFixed(6)),
      recovery_pressure: Number(recoveryPressure.toFixed(6)),
      horizon_pressure: Number(horizonPressure.toFixed(6)),
      context_pressure: Number(contextPressure.toFixed(6)),
      tool_pressure: Number(toolPressure.toFixed(6)),
      environment_pressure: Number(environmentPressure.toFixed(6)),
      ambiguity_pressure: Number(ambiguityPressure.toFixed(6)),
      failure_pressure: Number(failurePressure.toFixed(6)),
      recurrence_opportunity: Number(recurrenceOpportunity.toFixed(6)),
      p90_steps: percentile(episodes.map(item => item.steps), 0.9),
      p90_context_bytes: percentile(episodes.map(item => item.context_bytes), 0.9),
      p90_elapsed_ms: percentile(episodes.map(item => item.elapsed_ms), 0.9)
    },
    capability_pressure: capabilityPressure,
    distillation_methods: distillation,
    launch_sizing_hypothesis: {
      schema: ARCHIE_LAUNCH_SIZING_HYPOTHESIS_SCHEMA,
      ...sizing,
      architecture: sizing.class.includes('mixture') || diversity >= 0.65
        ? 'sparse mixture with a dense shared trunk, tool/action heads, external episodic memory, and an independent verifier/value head'
        : 'dense decoder with tool/action heads, external episodic memory, and an independent verifier/value head',
      required_nonparametric_components: [
        'provenance-bound episodic retrieval',
        'symbolic authority and execution control',
        'independent verifier/value model',
        'negative lesson store',
        'human-intervention and rollback telemetry'
      ],
      empirical_status: 'hypothesis-not-admission',
      admission_requirement: 'Train multiple candidate sizes and architectures, then select only from hidden held-out capability, intervention reduction, safety, latency, memory, cost, retention, adaptation, and device evidence.'
    }
  };
  return Object.freeze({ ...body, inference_digest: digest(body) });
}
