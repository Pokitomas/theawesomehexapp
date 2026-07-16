import {
  canonical, clean, digest, identifier, noSecrets, nonNegative, positiveInt, sha256, strings
} from './archie-research-utils.mjs';

export const ARCHIE_RESEARCH_ALLOCATION_SCHEMA = 'archie-research-allocation/v1';
const WORKERS = new Set(['local_cpu', 'wsl_workstation', 'github_hosted_cpu', 'self_hosted', 'remote_http', 'burst_gpu']);

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw new Error(`${field} is required.`);
  noSecrets(value, field);
  return canonical(value);
}
function lane(input, index, evaluation = false) {
  const field = evaluation ? 'allocation.independent_evaluation' : `allocation.lanes[${index}]`;
  const workers = strings(input?.allowed_worker_kinds, `${field}.allowed_worker_kinds`);
  for (const worker of workers) if (!WORKERS.has(worker)) throw new Error(`${field} contains unknown worker ${worker}.`);
  const boundaries = object(input.promotion_boundaries, `${field}.promotion_boundaries`);
  if (!evaluation && boundaries.independent_evaluation !== true) throw new Error(`${field}.promotion_boundaries must require independent evaluation.`);
  return canonical({
    id: identifier(input.id, `${field}.id`),
    name: clean(input.name, 300),
    credits: positiveInt(input.credits, `${field}.credits`),
    task_families: strings(input.task_families, `${field}.task_families`),
    allowed_worker_kinds: workers,
    required_capabilities: strings(input.required_capabilities, `${field}.required_capabilities`),
    max_cost_usd_per_experiment: nonNegative(input.max_cost_usd_per_experiment, `${field}.max_cost_usd_per_experiment`),
    required_replications: positiveInt(input.required_replications, `${field}.required_replications`),
    stop_rules: object(input.stop_rules, `${field}.stop_rules`),
    promotion_boundaries: boundaries
  });
}

export function normalizeResearchAllocation(input, { credits = 100, evaluation_reserve = 20, campaign_id } = {}) {
  if (input?.schema !== ARCHIE_RESEARCH_ALLOCATION_SCHEMA) throw new Error(`allocation.schema must equal ${ARCHIE_RESEARCH_ALLOCATION_SCHEMA}.`);
  noSecrets(input, 'allocation');
  const campaign = identifier(input.campaign_id, 'allocation.campaign_id');
  if (campaign_id && campaign !== campaign_id) throw new Error('Allocation campaign_id mismatch.');
  const total = positiveInt(input.total_credits, 'allocation.total_credits');
  const reserve = positiveInt(input.evaluation_reserve, 'allocation.evaluation_reserve');
  const discovery = positiveInt(input.discovery_credits, 'allocation.discovery_credits');
  if (total !== Number(credits)) throw new Error(`Allocation total must equal ${credits} credits.`);
  if (reserve !== Number(evaluation_reserve)) throw new Error(`Independent evaluation reserve must equal ${evaluation_reserve} credits.`);
  if (discovery !== total - reserve) throw new Error('Discovery credits must equal total minus reserve.');
  if (!Array.isArray(input.lanes) || input.lanes.length !== 12) throw new Error('Allocation must contain exactly twelve discovery lanes.');
  const lanes = input.lanes.map((item, index) => lane(item, index));
  if (new Set(lanes.map(item => item.id)).size !== 12) throw new Error('Allocation lane ids must be unique.');
  const laneCredits = lanes.reduce((sum, item) => sum + item.credits, 0);
  if (laneCredits !== discovery) throw new Error(`Discovery lane credits must total ${discovery}; received ${laneCredits}.`);
  const evaluation = lane(input.independent_evaluation, 0, true);
  if (evaluation.credits !== reserve) throw new Error('Independent evaluation credits must equal the reserve.');
  const preference = canonical(input.owner_preference_axis || {});
  if (preference.separate_from_capability !== true || Number(preference.continuing_compute_weight) !== 0) throw new Error('Owner preference must remain separate with zero continuing-compute weight.');
  const body = canonical({
    schema: ARCHIE_RESEARCH_ALLOCATION_SCHEMA,
    campaign_id: campaign,
    policy_version: clean(input.policy_version, 200),
    total_credits: total,
    evaluation_reserve: reserve,
    discovery_credits: discovery,
    owner_preference_axis: preference,
    lanes,
    independent_evaluation: evaluation
  });
  if (!body.policy_version) throw new Error('allocation.policy_version is required.');
  const allocation_digest = sha256(body);
  if (input.allocation_digest && digest(input.allocation_digest, 'allocation.allocation_digest') !== allocation_digest) throw new Error('Allocation digest mismatch.');
  return Object.freeze({ ...body, allocation_digest });
}
