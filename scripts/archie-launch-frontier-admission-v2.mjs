import {
  ARCHIE_LAUNCH_FRONTIER_DECISION_SCHEMA,
  frontierDigest,
  resolveLaunchFrontierV2,
  validateFrontierManifest
} from './archie-launch-frontier-v2.mjs';

function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be finite.`);
  return number;
}

function validateObjectiveBounds(target) {
  const byId = new Map();
  for (const [index, objective] of target.objectives.entries()) {
    const minimum = finite(objective.minimum, `target.objectives[${index}].minimum`);
    const maximum = finite(objective.maximum, `target.objectives[${index}].maximum`);
    const gate = finite(objective.gate, `target.objectives[${index}].gate`);
    if (minimum > maximum) throw new Error(`target.objectives[${index}] minimum exceeds maximum.`);
    if (gate < minimum || gate > maximum) throw new Error(`target.objectives[${index}].gate is outside the declared range.`);
    byId.set(objective.id, Object.freeze({ minimum, maximum }));
  }
  return byId;
}

export function validateAdmittedFrontierManifest(input) {
  if (!input?.target || !Array.isArray(input.target.objectives)) throw new Error('Frontier target objectives are required.');
  const bounds = validateObjectiveBounds(input.target);
  const manifest = validateFrontierManifest(input);
  const profileById = new Map(manifest.profiles.map(profile => [profile.id, profile]));

  for (const profile of manifest.profiles) {
    for (const [id, range] of bounds) {
      const observed = profile.objective_metrics[id];
      if (observed < range.minimum || observed > range.maximum) {
        throw new Error(`Profile ${profile.id} objective ${id} is outside the declared range.`);
      }
    }
  }

  for (const environment of manifest.environments) {
    const requested = environment.requested_default_profile_id;
    if (environment.selection_policy.mode === 'adaptive-frontier' && requested !== null) {
      throw new Error(`Environment ${environment.id} cannot request one default in adaptive-frontier mode.`);
    }
    if (requested && profileById.get(requested)?.environment_id !== environment.id) {
      throw new Error(`Environment ${environment.id} requests a default profile from another environment.`);
    }
  }

  return manifest;
}

export function resolveAdmittedLaunchFrontierV2(input) {
  const manifest = validateAdmittedFrontierManifest(input);
  const raw = resolveLaunchFrontierV2(input);
  if (raw.schema !== ARCHIE_LAUNCH_FRONTIER_DECISION_SCHEMA) throw new Error('Unexpected frontier decision schema.');
  const environmentById = new Map(manifest.environments.map(environment => [environment.id, environment]));
  const environments = raw.environments.map(environment => {
    const requested = environmentById.get(environment.environment_id).requested_default_profile_id;
    const requestedDefaultNotSelected = Boolean(requested && environment.primary_profile_id !== requested);
    return Object.freeze({
      ...environment,
      decision: requestedDefaultNotSelected ? 'rejected-environment-frontier' : environment.decision,
      requested_default_is_not_selected: requestedDefaultNotSelected,
      strongest_profile_proof: Object.freeze({
        ...environment.strongest_profile_proof,
        objective_ranges_enforced: true,
        requested_default_must_match_explicit_selection: true
      })
    });
  });
  const requiredEnvironmentsPass = environments
    .filter(environment => environment.required_for_launch)
    .every(environment => environment.decision === 'admitted-environment-frontier');
  const admitted = raw.search_complete && requiredEnvironmentsPass;
  const { decision_digest: _ignored, ...rawBody } = raw;
  const body = {
    ...rawBody,
    decision: admitted ? 'admitted-capability-frontier' : 'rejected-capability-frontier',
    environments,
    admission_proof: {
      exact_objective_ranges_enforced: true,
      cross_environment_defaults_rejected: true,
      adaptive_mode_has_no_single_default: true,
      explicit_default_must_be_selected_frontier_member: true
    }
  };
  return Object.freeze({ ...body, decision_digest: frontierDigest(body) });
}
