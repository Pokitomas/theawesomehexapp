import {
  ARCHIE_LAUNCH_FRONTIER_DECISION_SCHEMA,
  frontierDigest,
  resolveLaunchFrontierV2,
  validateFrontierManifest
} from './archie-launch-frontier-v2.mjs';

const DIGEST = /^[a-f0-9]{64}$/;

function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be finite.`);
  return number;
}

function exactDigest(value, field) {
  const text = String(value ?? '').trim();
  if (!DIGEST.test(text)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return text;
}

function sortedStrings(values = []) {
  return [...values].map(value => String(value)).sort();
}

function sortedNumberMap(input = {}) {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

export function frontierEnvironmentReceiptDigest(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('Environment must be an object.');
  }
  return frontierDigest({
    id: String(environment.id ?? '').trim(),
    hardware_fingerprint: exactDigest(environment.hardware_fingerprint, 'environment.hardware_fingerprint'),
    os_fingerprint: exactDigest(environment.os_fingerprint, 'environment.os_fingerprint'),
    platform_receipt_digests: sortedStrings(environment.platform_receipt_digests).map((value, index) => exactDigest(value, `environment.platform_receipt_digests[${index}]`)),
    authority_grants: sortedStrings(environment.authority_grants),
    resource_budgets: sortedNumberMap(environment.resource_budgets)
  });
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

function validateSearchReceiptIdentity(input) {
  const profileIds = new Set((input.profiles || []).map(profile => profile.id));
  const excluded = input.search_receipt?.excluded_candidates || [];
  const excludedIds = excluded.map(candidate => candidate.id);
  if (new Set(excludedIds).size !== excludedIds.length) {
    throw new Error('search_receipt.excluded_candidates must have unique IDs.');
  }
  for (const id of excludedIds) {
    if (profileIds.has(id)) throw new Error(`Excluded candidate ${id} is also an enumerated profile.`);
  }
}

function validateProfileEnvironmentBindings(input) {
  const environments = new Map((input.environments || []).map(environment => [environment.id, environment]));
  for (const [index, profile] of (input.profiles || []).entries()) {
    const environment = environments.get(profile.environment_id);
    if (!environment) continue;
    const expectedReceipt = frontierEnvironmentReceiptDigest(environment);
    const actualReceipt = exactDigest(profile.environment_receipt_digest, `profiles[${index}].environment_receipt_digest`);
    if (actualReceipt !== expectedReceipt) {
      throw new Error(`Profile ${profile.id} environment receipt does not match exact environment ${environment.id}.`);
    }

    const budgetKeys = Object.keys(environment.resource_budgets || {}).sort();
    const usageKeys = Object.keys(profile.resource_usage || {}).sort();
    const missing = budgetKeys.filter(key => !usageKeys.includes(key));
    const unbudgeted = usageKeys.filter(key => !budgetKeys.includes(key));
    if (missing.length || unbudgeted.length) {
      const reasons = [
        missing.length ? `missing resource usage: ${missing.join(', ')}` : '',
        unbudgeted.length ? `unbudgeted resource usage: ${unbudgeted.join(', ')}` : ''
      ].filter(Boolean).join('; ');
      throw new Error(`Profile ${profile.id} must declare the exact environment resource dimensions (${reasons}).`);
    }
  }
}

export function validateAdmittedFrontierManifest(input) {
  if (!input?.target || !Array.isArray(input.target.objectives)) throw new Error('Frontier target objectives are required.');
  const bounds = validateObjectiveBounds(input.target);
  validateSearchReceiptIdentity(input);
  validateProfileEnvironmentBindings(input);
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
    const exactEnvironment = environmentById.get(environment.environment_id);
    const requested = exactEnvironment.requested_default_profile_id;
    const requestedDefaultNotSelected = Boolean(requested && environment.primary_profile_id !== requested);
    return Object.freeze({
      ...environment,
      environment_receipt_digest: frontierEnvironmentReceiptDigest(exactEnvironment),
      decision: requestedDefaultNotSelected ? 'rejected-environment-frontier' : environment.decision,
      requested_default_is_not_selected: requestedDefaultNotSelected,
      strongest_profile_proof: Object.freeze({
        ...environment.strongest_profile_proof,
        objective_ranges_enforced: true,
        requested_default_must_match_explicit_selection: true,
        profile_environment_receipts_enforced: true,
        exact_resource_dimensions_enforced: true
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
      explicit_default_must_be_selected_frontier_member: true,
      profiles_bound_to_exact_environment_receipts: true,
      exact_resource_dimensions_required: true,
      excluded_candidate_identity_disjoint: true
    }
  };
  return Object.freeze({ ...body, decision_digest: frontierDigest(body) });
}
