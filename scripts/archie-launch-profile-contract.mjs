import {
  clean,
  digest,
  evidenceDigests,
  exactDigest,
  exactGitSha,
  rangedNumber,
  stableJSONStringify,
  uniqueStrings
} from './archie-launch-shared.mjs';
import { validateLaunchTarget } from './archie-launch-target-contract.mjs';

export const ARCHIE_LAUNCH_CANDIDATE_SCHEMA = 'archie-launch-candidate/v2';
const PROFILE_STATUSES = new Set(['admitted', 'experimental', 'infeasible']);
const CONSTRAINT_STATUSES = new Set(['satisfied', 'blocked']);

function validateConstraint(entry, field) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${field} must be an object.`);
  const status = clean(entry.status, `${field}.status`, 30);
  if (!CONSTRAINT_STATUSES.has(status)) throw new Error(`${field}.status is unsupported.`);
  const reason = entry.reason === undefined ? null : clean(entry.reason, `${field}.reason`, 2000);
  if (status === 'blocked' && !reason) throw new Error(`${field}.reason is required when blocked.`);
  return Object.freeze({
    id: clean(entry.id, `${field}.id`, 200),
    status,
    evidence: Object.freeze(evidenceDigests(entry.evidence || [], `${field}.evidence`)),
    reason
  });
}

function validateDisabledCapability(entry, field) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${field} must be an object.`);
  return Object.freeze({
    id: clean(entry.id, `${field}.id`, 200),
    reason: clean(entry.reason, `${field}.reason`, 2000),
    evidence: Object.freeze(evidenceDigests(entry.evidence || [], `${field}.evidence`))
  });
}

function validateProfile(input, index, target) {
  const field = `profiles[${index}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${field} must be an object.`);
  const status = clean(input.status, `${field}.status`, 30);
  if (!PROFILE_STATUSES.has(status)) throw new Error(`${field}.status is unsupported.`);

  const metrics = {};
  for (const dimension of target.profile_search.dimensions) {
    if (!(dimension.id in (input.metrics || {}))) throw new Error(`${field}.metrics.${dimension.id} is required.`);
    metrics[dimension.id] = rangedNumber(input.metrics[dimension.id], `${field}.metrics.${dimension.id}`, dimension.range);
  }
  const extraMetricKeys = Object.keys(input.metrics || {}).filter(id => !target.profile_search.dimensions.some(dimension => dimension.id === id));
  if (extraMetricKeys.length) throw new Error(`${field}.metrics contains undeclared dimensions: ${extraMetricKeys.join(', ')}.`);

  const outcomeScores = {};
  for (const outcome of target.human_outcomes) {
    if (!(outcome.id in (input.outcome_scores || {}))) throw new Error(`${field}.outcome_scores.${outcome.id} is required.`);
    outcomeScores[outcome.id] = rangedNumber(input.outcome_scores[outcome.id], `${field}.outcome_scores.${outcome.id}`, 'unit_interval');
  }
  const extraOutcomeKeys = Object.keys(input.outcome_scores || {}).filter(id => !target.human_outcomes.some(outcome => outcome.id === id));
  if (extraOutcomeKeys.length) throw new Error(`${field}.outcome_scores contains undeclared outcomes: ${extraOutcomeKeys.join(', ')}.`);

  const constraints = Array.isArray(input.constraints) ? input.constraints.map((entry, constraintIndex) => validateConstraint(entry, `${field}.constraints[${constraintIndex}]`)) : [];
  if (!constraints.length) throw new Error(`${field}.constraints must not be empty.`);
  if (new Set(constraints.map(entry => entry.id)).size !== constraints.length) throw new Error(`${field}.constraints contains duplicate IDs.`);

  const disabledCapabilities = Array.isArray(input.disabled_capabilities)
    ? input.disabled_capabilities.map((entry, disabledIndex) => validateDisabledCapability(entry, `${field}.disabled_capabilities[${disabledIndex}]`))
    : [];
  if (new Set(disabledCapabilities.map(entry => entry.id)).size !== disabledCapabilities.length) throw new Error(`${field}.disabled_capabilities contains duplicate IDs.`);

  const capabilities = uniqueStrings(input.capabilities || [], `${field}.capabilities`);
  const contradictedDisabled = disabledCapabilities.filter(entry => capabilities.includes(entry.id));
  if (contradictedDisabled.length) throw new Error(`${field} claims disabled capabilities: ${contradictedDisabled.map(entry => entry.id).join(', ')}.`);
  if (status === 'admitted' && constraints.some(entry => entry.status !== 'satisfied')) throw new Error(`${field} cannot be admitted with blocked constraints.`);

  return Object.freeze({
    id: clean(input.id, `${field}.id`, 200),
    environment_id: clean(input.environment_id, `${field}.environment_id`, 200),
    environment_digest: exactDigest(input.environment_digest, `${field}.environment_digest`),
    status,
    fallback_only: Boolean(input.fallback_only),
    capabilities: Object.freeze(capabilities),
    modalities: Object.freeze(uniqueStrings(input.modalities || [], `${field}.modalities`)),
    invocation_modes: Object.freeze(uniqueStrings(input.invocation_modes || [], `${field}.invocation_modes`)),
    surfaces: Object.freeze(uniqueStrings(input.surfaces || [], `${field}.surfaces`)),
    metrics: Object.freeze(metrics),
    outcome_scores: Object.freeze(outcomeScores),
    constraints: Object.freeze(constraints),
    disabled_capabilities: Object.freeze(disabledCapabilities),
    evidence: Object.freeze(evidenceDigests(input.evidence || [], `${field}.evidence`))
  });
}

export function validateLaunchCandidate(input, targetInput) {
  const target = validateLaunchTarget(targetInput);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Launch candidate must be an object.');
  if (input.schema !== ARCHIE_LAUNCH_CANDIDATE_SCHEMA) throw new Error(`Launch candidate schema must be ${ARCHIE_LAUNCH_CANDIDATE_SCHEMA}.`);

  const metrics = {};
  for (const [nameInput, value] of Object.entries(input.metrics || {})) {
    const name = clean(nameInput, 'metric name', 200);
    metrics[name] = rangedNumber(value, `metrics.${name}`, name.includes('_rate') ? 'unit_interval' : 'finite');
  }

  const profiles = Array.isArray(input.profiles) ? input.profiles.map((entry, index) => validateProfile(entry, index, target)) : [];
  if (!profiles.length) throw new Error('candidate.profiles must not be empty.');
  if (new Set(profiles.map(entry => entry.id)).size !== profiles.length) throw new Error('Candidate contains duplicate profile IDs.');

  const search = input.profile_search_receipt;
  if (!search || typeof search !== 'object' || Array.isArray(search)) throw new Error('candidate.profile_search_receipt must be an object.');
  const searchedAxes = uniqueStrings(search.searched_axes, 'candidate.profile_search_receipt.searched_axes', { allowEmpty: false });
  const enumeratedProfileIds = uniqueStrings(search.enumerated_profile_ids, 'candidate.profile_search_receipt.enumerated_profile_ids', { allowEmpty: false });
  const profilesDigest = exactDigest(search.profiles_digest, 'candidate.profile_search_receipt.profiles_digest');
  if (profilesDigest !== digest(input.profiles)) throw new Error('candidate.profile_search_receipt.profiles_digest does not bind candidate.profiles.');
  if (stableJSONStringify([...enumeratedProfileIds].sort()) !== stableJSONStringify(profiles.map(profile => profile.id).sort())) {
    throw new Error('candidate.profile_search_receipt.enumerated_profile_ids must exactly match candidate.profiles.');
  }

  return Object.freeze({
    schema: ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
    id: clean(input.id, 'candidate.id', 200),
    artifact_digest: exactDigest(input.artifact_digest, 'candidate.artifact_digest'),
    code_sha: exactGitSha(input.code_sha, 'candidate.code_sha'),
    intelligence_report_digest: exactDigest(input.intelligence_report_digest, 'candidate.intelligence_report_digest'),
    authority_report_digest: exactDigest(input.authority_report_digest, 'candidate.authority_report_digest'),
    reproduction_receipt_digest: exactDigest(input.reproduction_receipt_digest, 'candidate.reproduction_receipt_digest'),
    domains: Object.freeze(uniqueStrings(input.domains, 'candidate.domains')),
    intelligence_requirements: Object.freeze(uniqueStrings(input.intelligence_requirements, 'candidate.intelligence_requirements')),
    metrics: Object.freeze(metrics),
    profiles: Object.freeze(profiles),
    selected_default_profile_id: input.selected_default_profile_id == null ? null : clean(input.selected_default_profile_id, 'candidate.selected_default_profile_id', 200),
    profile_search_receipt: Object.freeze({
      algorithm: clean(search.algorithm, 'candidate.profile_search_receipt.algorithm', 200),
      complete: search.complete === true,
      searched_axes: Object.freeze(searchedAxes),
      enumerated_profile_ids: Object.freeze(enumeratedProfileIds),
      search_space_digest: exactDigest(search.search_space_digest, 'candidate.profile_search_receipt.search_space_digest'),
      environment_matrix_digest: exactDigest(search.environment_matrix_digest, 'candidate.profile_search_receipt.environment_matrix_digest'),
      profiles_digest: profilesDigest,
      evidence: Object.freeze(evidenceDigests(search.evidence || [], 'candidate.profile_search_receipt.evidence'))
    })
  });
}
