import { deriveLaunchRequirements, digest } from './archie-launch-contract.mjs';
import {
  ARCHIE_LAUNCH_PROFILE_RESOLUTION_SCHEMA,
  resolveLaunchProfile,
  validateLaunchCapabilityManifest
} from './archie-launch-profile-resolver.mjs';

export const ARCHIE_LAUNCH_PROFILE_ADMISSION_SCHEMA = 'archie-launch-profile-admission/v1';

const RESOURCE_ALIASES = Object.freeze({
  memory_bytes: 'ram_bytes',
  ram_bytes: 'ram_bytes',
  vram_bytes: 'vram_bytes',
  disk_bytes: 'disk_free_bytes',
  disk_free_bytes: 'disk_free_bytes',
  cpu_threads: 'cpu_threads',
  energy_watts: 'energy_watts_budget',
  energy_watts_budget: 'energy_watts_budget',
  thermal_celsius: 'thermal_celsius_limit',
  thermal_celsius_limit: 'thermal_celsius_limit'
});

function resourceBudget(manifest, scenario = null) {
  return Object.freeze({
    ...manifest.machine.hardware,
    ...(scenario?.resource_overrides || {})
  });
}

function profileResourceCheck(profile, budget) {
  const checks = Object.entries(profile.resource_cost || {}).map(([costName, observed]) => {
    const budgetName = RESOURCE_ALIASES[costName] || costName;
    const allowed = budget[budgetName];
    return Object.freeze({
      cost_name: costName,
      budget_name: budgetName,
      observed,
      allowed: allowed ?? null,
      passed: Number.isFinite(allowed) && observed <= allowed
    });
  });
  return Object.freeze({
    passed: checks.every(check => check.passed),
    checks
  });
}

function admitScenario(rawScenario, manifest, requirements, fallback = null) {
  const budget = resourceBudget(manifest, fallback);
  const candidates = rawScenario.maximal_profiles.map(profile => ({
    profile,
    aggregate_resources: profileResourceCheck(profile, budget)
  }));
  const admittedCandidate = candidates.find(candidate => candidate.aggregate_resources.passed) || null;
  const selectedProfile = admittedCandidate?.profile || Object.freeze({
    capabilities: [],
    faculties: [],
    families: [],
    required_faculty_coverage: [],
    resource_cost: {},
    profile_digest: digest({ empty_profile: true, scenario_id: rawScenario.scenario_id })
  });
  const missingFaculties = requirements.faculties
    .map(requirement => requirement.id)
    .filter(faculty => !selectedProfile.faculties.includes(faculty));
  const rejectedProfiles = candidates
    .filter(candidate => !candidate.aggregate_resources.passed)
    .map(candidate => Object.freeze({
      profile_digest: candidate.profile.profile_digest,
      capabilities: candidate.profile.capabilities,
      failed_resource_checks: candidate.aggregate_resources.checks.filter(check => !check.passed)
    }));
  return Object.freeze({
    ...rawScenario,
    selected_profile: selectedProfile,
    selected_profile_aggregate_resources: admittedCandidate?.aggregate_resources || Object.freeze({ passed: false, checks: [] }),
    rejected_aggregate_profiles: Object.freeze(rejectedProfiles),
    all_required_faculties_covered: missingFaculties.length === 0,
    missing_required_faculties: Object.freeze(missingFaculties),
    strongest_profile_proof: Object.freeze({
      ...rawScenario.strongest_profile_proof,
      selected_is_first_resource-feasible_profile: Boolean(admittedCandidate),
      aggregate_resource_budget: budget,
      aggregate_resource_gate_applied: true
    })
  });
}

export function resolveAdmittedLaunchProfile(input) {
  const manifest = validateLaunchCapabilityManifest(input);
  const raw = resolveLaunchProfile(input);
  if (raw.schema !== ARCHIE_LAUNCH_PROFILE_RESOLUTION_SCHEMA) throw new Error('Unexpected launch profile resolution schema.');
  const requirements = deriveLaunchRequirements(manifest.launch_target);
  const defaultProfile = admitScenario(raw.default_profile, manifest, requirements);
  const fallbackById = new Map(manifest.fallback_scenarios.map(scenario => [scenario.id, scenario]));
  const fallbacks = raw.fallbacks.map(profile => admitScenario(profile, manifest, requirements, fallbackById.get(profile.scenario_id)));
  const launchDecisionAdmitted = manifest.launch_decision.decision === 'admitted-maximal-launch';
  const admitted = launchDecisionAdmitted
    && defaultProfile.selected_profile_aggregate_resources.passed
    && defaultProfile.all_required_faculties_covered;
  const body = {
    schema: ARCHIE_LAUNCH_PROFILE_ADMISSION_SCHEMA,
    source_resolution_digest: raw.resolution_digest,
    manifest_digest: manifest.manifest_digest,
    release_id: manifest.release.id,
    candidate_id: manifest.launch_decision.candidate_id,
    machine: raw.machine,
    decision: admitted ? 'admitted-maximal-machine-profile' : 'rejected-machine-profile',
    intelligence_and_authority_admitted: launchDecisionAdmitted,
    default_profile: defaultProfile,
    fallbacks,
    claim_boundary: admitted
      ? 'This exact release and machine may expose the selected aggregate-resource-feasible maximal profile. Named fallbacks remain separate and cannot overwrite the maximal claim.'
      : 'This exact release or machine must not claim maximal launch. Missing faculties, evidence, authority, or aggregate resource failures remain explicit.'
  };
  return Object.freeze({ ...body, admission_digest: digest(body) });
}
