import {
  clean,
  digest,
  rangedNumber,
  uniqueStrings
} from './archie-launch-shared.mjs';

export const ARCHIE_LAUNCH_TARGET_SCHEMA = 'archie-launch-target/v2';
export const ARCHIE_LAUNCH_REQUIREMENTS_SCHEMA = 'archie-launch-profile-search/v2';

const DIMENSION_DIRECTIONS = new Set(['maximize', 'minimize']);
const DIMENSION_RANGES = new Set(['unit_interval', 'nonnegative', 'finite']);

function requireBooleanFields(value, prefix, keys) {
  for (const key of keys) {
    if (typeof value[key] !== 'boolean') throw new Error(`${prefix}.${key} must be boolean.`);
  }
}

export function validateLaunchTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Launch target must be an object.');
  if (input.schema !== ARCHIE_LAUNCH_TARGET_SCHEMA) throw new Error(`Launch target schema must be ${ARCHIE_LAUNCH_TARGET_SCHEMA}.`);

  const intelligence = input.intelligence_target;
  if (!intelligence || typeof intelligence !== 'object' || Array.isArray(intelligence)) throw new Error('intelligence_target must be an object.');
  const minimumMetrics = {};
  for (const [nameInput, value] of Object.entries(intelligence.minimum_metrics || {})) {
    const name = clean(nameInput, 'intelligence_target.minimum_metrics key', 200);
    minimumMetrics[name] = rangedNumber(value, `intelligence_target.minimum_metrics.${name}`, name.includes('_rate') ? 'unit_interval' : 'finite');
  }
  if (!Object.keys(minimumMetrics).length) throw new Error('intelligence_target.minimum_metrics must be non-empty.');

  const outcomes = Array.isArray(input.human_outcomes) ? input.human_outcomes.map((outcome, index) => {
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw new Error(`human_outcomes[${index}] must be an object.`);
    return Object.freeze({
      id: clean(outcome.id, `human_outcomes[${index}].id`, 200),
      floor: rangedNumber(outcome.floor, `human_outcomes[${index}].floor`, 'unit_interval'),
      statement: clean(outcome.statement, `human_outcomes[${index}].statement`, 2000)
    });
  }) : [];
  if (!outcomes.length) throw new Error('Launch target requires at least one human outcome.');
  if (new Set(outcomes.map(outcome => outcome.id)).size !== outcomes.length) throw new Error('Launch target contains duplicate human outcome IDs.');

  const search = input.profile_search;
  if (!search || typeof search !== 'object' || Array.isArray(search)) throw new Error('profile_search must be an object.');
  const dimensions = Array.isArray(search.dimensions) ? search.dimensions.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`profile_search.dimensions[${index}] must be an object.`);
    const id = clean(entry.id, `profile_search.dimensions[${index}].id`, 200);
    const direction = clean(entry.direction, `profile_search.dimensions[${index}].direction`, 30);
    const range = clean(entry.range, `profile_search.dimensions[${index}].range`, 30);
    if (!DIMENSION_DIRECTIONS.has(direction)) throw new Error(`profile_search.dimensions[${index}].direction is unsupported.`);
    if (!DIMENSION_RANGES.has(range)) throw new Error(`profile_search.dimensions[${index}].range is unsupported.`);
    const floor = entry.floor == null ? null : rangedNumber(entry.floor, `profile_search.dimensions[${index}].floor`, range);
    const ceiling = entry.ceiling == null ? null : rangedNumber(entry.ceiling, `profile_search.dimensions[${index}].ceiling`, range);
    if (floor !== null && ceiling !== null && floor > ceiling) throw new Error(`profile_search.dimensions[${index}] floor exceeds ceiling.`);
    return Object.freeze({ id, direction, range, floor, ceiling });
  }) : [];
  if (!dimensions.length) throw new Error('profile_search.dimensions must be non-empty.');
  if (new Set(dimensions.map(entry => entry.id)).size !== dimensions.length) throw new Error('profile_search.dimensions contains duplicate IDs.');
  requireBooleanFields(search, 'profile_search', [
    'require_complete_search_receipt',
    'require_nondominated_launch_set',
    'allow_adaptive_multi_profile_launch',
    'selected_default_may_be_null'
  ]);

  const policy = input.launch_policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('launch_policy must be an object.');
  requireBooleanFields(policy, 'launch_policy', [
    'joint_intelligence_and_embodiment_admission',
    'single_canonical_interface',
    'chat_window_is_architecture',
    'voice_is_architecture',
    'always_on_daemon_is_architecture',
    'cli_is_consumer_identity',
    'dominated_default_may_launch',
    'hidden_nondominated_fallback_may_launch',
    'unsupported_capability_may_be_claimed',
    'shell_without_brain_may_launch',
    'brain_without_admitted_profile_may_launch',
    'maximal_first_release'
  ]);

  return Object.freeze({
    schema: ARCHIE_LAUNCH_TARGET_SCHEMA,
    id: clean(input.id, 'id', 200),
    claim_boundary: clean(input.claim_boundary, 'claim_boundary', 2000),
    intelligence_target: Object.freeze({
      domains: Object.freeze(uniqueStrings(intelligence.domains, 'intelligence_target.domains', { allowEmpty: false })),
      minimum_metrics: Object.freeze(minimumMetrics),
      requirements: Object.freeze(uniqueStrings(intelligence.requirements, 'intelligence_target.requirements', { allowEmpty: false }))
    }),
    human_outcomes: Object.freeze(outcomes),
    profile_search: Object.freeze({
      required_axes: Object.freeze(uniqueStrings(search.required_axes, 'profile_search.required_axes', { allowEmpty: false })),
      dimensions: Object.freeze(dimensions),
      require_complete_search_receipt: search.require_complete_search_receipt,
      require_nondominated_launch_set: search.require_nondominated_launch_set,
      allow_adaptive_multi_profile_launch: search.allow_adaptive_multi_profile_launch,
      selected_default_may_be_null: search.selected_default_may_be_null
    }),
    launch_policy: Object.freeze({ ...policy })
  });
}

export function deriveLaunchRequirements(targetInput) {
  const target = validateLaunchTarget(targetInput);
  const body = {
    schema: ARCHIE_LAUNCH_REQUIREMENTS_SCHEMA,
    target_id: target.id,
    intelligence: target.intelligence_target,
    human_outcomes: target.human_outcomes,
    profile_search: target.profile_search,
    immutable_interface_assumptions: [],
    selection_law: 'evaluate complete evidence-bound profiles per environment; publish every feasible nondominated profile; never promote a dominated default or hide a nondominated profile as fallback'
  };
  return Object.freeze({ ...body, requirements_digest: digest(body) });
}
