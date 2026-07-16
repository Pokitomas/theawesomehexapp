import { digest, metricPasses } from './archie-launch-shared.mjs';
import { deriveLaunchRequirements, validateLaunchTarget } from './archie-launch-target-contract.mjs';
import { validateLaunchCandidate } from './archie-launch-profile-contract.mjs';

export const ARCHIE_LAUNCH_DECISION_SCHEMA = 'archie-launch-decision/v2';

function profilePassesFloors(profile, target) {
  const failedDimensions = target.profile_search.dimensions.filter(dimension => {
    const value = profile.metrics[dimension.id];
    if (dimension.floor !== null && value < dimension.floor) return true;
    if (dimension.ceiling !== null && value > dimension.ceiling) return true;
    return false;
  }).map(dimension => dimension.id);
  const failedOutcomes = target.human_outcomes.filter(outcome => profile.outcome_scores[outcome.id] < outcome.floor).map(outcome => outcome.id);
  return Object.freeze({
    passed: failedDimensions.length === 0 && failedOutcomes.length === 0,
    failed_dimensions: Object.freeze(failedDimensions),
    failed_outcomes: Object.freeze(failedOutcomes)
  });
}

function compareValue(left, right, direction) {
  if (direction === 'maximize') return left >= right ? (left > right ? 1 : 0) : -1;
  return left <= right ? (left < right ? 1 : 0) : -1;
}

export function profileDominates(left, right, targetInput) {
  const target = validateLaunchTarget(targetInput);
  if (left.environment_id !== right.environment_id) return false;
  let strictlyBetter = false;
  for (const dimension of target.profile_search.dimensions) {
    const comparison = compareValue(left.metrics[dimension.id], right.metrics[dimension.id], dimension.direction);
    if (comparison < 0) return false;
    strictlyBetter ||= comparison > 0;
  }
  for (const outcome of target.human_outcomes) {
    const comparison = compareValue(left.outcome_scores[outcome.id], right.outcome_scores[outcome.id], 'maximize');
    if (comparison < 0) return false;
    strictlyBetter ||= comparison > 0;
  }
  return strictlyBetter;
}

function computeFrontier(profiles, target) {
  const eligible = profiles.filter(profile => profile.status === 'admitted' && profilePassesFloors(profile, target).passed);
  const dominatedBy = new Map();
  for (const profile of eligible) {
    const dominators = eligible.filter(other => other.id !== profile.id && profileDominates(other, profile, target)).map(other => other.id).sort();
    if (dominators.length) dominatedBy.set(profile.id, dominators);
  }
  return {
    eligible,
    frontier: eligible.filter(profile => !dominatedBy.has(profile.id)),
    dominatedBy
  };
}

export function evaluateLaunchCandidate(targetInput, candidateInput) {
  const target = validateLaunchTarget(targetInput);
  const candidate = validateLaunchCandidate(candidateInput, target);
  const requirements = deriveLaunchRequirements(target);

  const missingDomains = target.intelligence_target.domains.filter(domain => !candidate.domains.includes(domain));
  const missingRequirements = target.intelligence_target.requirements.filter(requirement => !candidate.intelligence_requirements.includes(requirement));
  const metricResults = Object.entries(target.intelligence_target.minimum_metrics).map(([name, threshold]) => {
    const observed = candidate.metrics[name];
    return Object.freeze({ name, threshold, observed: observed ?? null, passed: observed !== undefined && metricPasses(name, threshold, observed) });
  });
  const intelligencePassed = missingDomains.length === 0 && missingRequirements.length === 0 && metricResults.every(result => result.passed);

  const missingAxes = target.profile_search.required_axes.filter(axis => !candidate.profile_search_receipt.searched_axes.includes(axis));
  const searchPassed = (!target.profile_search.require_complete_search_receipt || candidate.profile_search_receipt.complete) && missingAxes.length === 0;
  const profileResults = candidate.profiles.map(profile => Object.freeze({
    id: profile.id,
    environment_id: profile.environment_id,
    status: profile.status,
    fallback_only: profile.fallback_only,
    capabilities: profile.capabilities,
    modalities: profile.modalities,
    invocation_modes: profile.invocation_modes,
    surfaces: profile.surfaces,
    constraints: profile.constraints,
    disabled_capabilities: profile.disabled_capabilities,
    constraints_passed: profile.constraints.every(entry => entry.status === 'satisfied'),
    floors: profilePassesFloors(profile, target)
  }));

  const { eligible, frontier, dominatedBy } = computeFrontier(candidate.profiles, target);
  const frontierIds = new Set(frontier.map(profile => profile.id));
  const hiddenFallbacks = frontier.filter(profile => profile.fallback_only).map(profile => profile.id).sort();
  const launchFrontier = frontier.filter(profile => !profile.fallback_only);
  const defaultProfile = candidate.selected_default_profile_id == null ? null : candidate.profiles.find(profile => profile.id === candidate.selected_default_profile_id) || null;
  const defaultMissing = candidate.selected_default_profile_id !== null && !defaultProfile;
  const defaultDominated = Boolean(defaultProfile && !frontierIds.has(defaultProfile.id));
  const defaultFallback = Boolean(defaultProfile?.fallback_only);
  const adaptiveRequired = launchFrontier.length > 1;
  const selectionPassed = !defaultMissing
    && !defaultDominated
    && !defaultFallback
    && (candidate.selected_default_profile_id !== null || target.profile_search.selected_default_may_be_null)
    && (!adaptiveRequired || target.profile_search.allow_adaptive_multi_profile_launch || candidate.selected_default_profile_id !== null);

  const policyViolations = [];
  if (!target.launch_policy.joint_intelligence_and_embodiment_admission) policyViolations.push('joint-admission-disabled');
  if (target.launch_policy.single_canonical_interface) policyViolations.push('single-interface-precommitted');
  if (target.launch_policy.chat_window_is_architecture) policyViolations.push('chat-window-precommitted');
  if (target.launch_policy.voice_is_architecture) policyViolations.push('voice-precommitted');
  if (target.launch_policy.always_on_daemon_is_architecture) policyViolations.push('daemon-precommitted');
  if (target.launch_policy.cli_is_consumer_identity) policyViolations.push('cli-precommitted');
  if (target.launch_policy.dominated_default_may_launch) policyViolations.push('dominated-default-allowed');
  if (target.launch_policy.hidden_nondominated_fallback_may_launch) policyViolations.push('hidden-frontier-allowed');
  if (target.launch_policy.unsupported_capability_may_be_claimed) policyViolations.push('unsupported-capability-claim-allowed');
  if (target.launch_policy.shell_without_brain_may_launch) policyViolations.push('shell-without-brain-allowed');
  if (target.launch_policy.brain_without_admitted_profile_may_launch) policyViolations.push('brain-without-profile-allowed');
  if (!target.launch_policy.maximal_first_release) policyViolations.push('maximal-first-release-disabled');
  if (defaultDominated) policyViolations.push('dominated-default-selected');
  if (defaultFallback) policyViolations.push('fallback-selected-as-default');
  if (hiddenFallbacks.length) policyViolations.push('nondominated-profile-hidden-as-fallback');
  if (target.profile_search.require_nondominated_launch_set && launchFrontier.length === 0) policyViolations.push('no-feasible-nondominated-profile');

  const embodimentPassed = searchPassed && selectionPassed && launchFrontier.length > 0 && hiddenFallbacks.length === 0;
  const admitted = intelligencePassed && embodimentPassed && policyViolations.length === 0;
  const environments = [...new Set(candidate.profiles.map(profile => profile.environment_id))].sort().map(environmentId => {
    const ids = launchFrontier.filter(profile => profile.environment_id === environmentId).map(profile => profile.id).sort();
    return Object.freeze({
      environment_id: environmentId,
      frontier_profile_ids: Object.freeze(ids),
      default_profile_id: candidate.selected_default_profile_id && ids.includes(candidate.selected_default_profile_id)
        ? candidate.selected_default_profile_id
        : ids.length === 1 ? ids[0] : null,
      adaptive: ids.length > 1
    });
  });

  const body = {
    schema: ARCHIE_LAUNCH_DECISION_SCHEMA,
    target_id: target.id,
    candidate_id: candidate.id,
    candidate_artifact_digest: candidate.artifact_digest,
    candidate_code_sha: candidate.code_sha,
    intelligence_report_digest: candidate.intelligence_report_digest,
    authority_report_digest: candidate.authority_report_digest,
    reproduction_receipt_digest: candidate.reproduction_receipt_digest,
    requirements_digest: requirements.requirements_digest,
    decision: admitted ? 'admitted-maximal-launch' : 'rejected-incomplete-launch',
    intelligence: {
      passed: intelligencePassed,
      missing_domains: missingDomains,
      missing_requirements: missingRequirements,
      metrics: metricResults
    },
    embodiment: {
      passed: embodimentPassed,
      search_receipt: {
        passed: searchPassed,
        complete: candidate.profile_search_receipt.complete,
        missing_axes: missingAxes,
        profiles_digest: candidate.profile_search_receipt.profiles_digest
      },
      profiles: profileResults,
      eligible_profile_ids: eligible.map(profile => profile.id).sort(),
      dominated_profiles: [...dominatedBy.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, dominators]) => ({ id, dominated_by: dominators })),
      hidden_nondominated_fallbacks: hiddenFallbacks,
      environments,
      launch_set: launchFrontier.map(profile => profile.id).sort(),
      selected_default_profile_id: candidate.selected_default_profile_id,
      selection_passed: selectionPassed,
      selection_law: requirements.selection_law
    },
    policy_violations: policyViolations,
    claim_boundary: admitted
      ? 'The exact candidate and complete profile search admit this nondominated launch set for the declared environments; untested capability remains outside the claim.'
      : 'The candidate must not launch as maximal Archie or imply unsupported intelligence, embodiment, continuity, modality, or autonomy.'
  };
  return Object.freeze({ ...body, decision_digest: digest(body) });
}
