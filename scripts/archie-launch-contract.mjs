export {
  digest,
  stableJSONStringify
} from './archie-launch-shared.mjs';
export {
  ARCHIE_LAUNCH_TARGET_SCHEMA,
  ARCHIE_LAUNCH_REQUIREMENTS_SCHEMA,
  deriveLaunchRequirements,
  validateLaunchTarget
} from './archie-launch-target-contract.mjs';
export {
  ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
  validateLaunchCandidate
} from './archie-launch-profile-contract.mjs';
export {
  ARCHIE_LAUNCH_DECISION_SCHEMA,
  evaluateLaunchCandidate,
  profileDominates
} from './archie-launch-frontier.mjs';

export function productFormCatalog() {
  return [];
}
