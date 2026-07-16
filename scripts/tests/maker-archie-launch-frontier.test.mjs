import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
  deriveLaunchRequirements,
  digest,
  evaluateLaunchCandidate,
  productFormCatalog,
  profileDominates,
  validateLaunchCandidate,
  validateLaunchTarget
} from '../archie-launch-contract.mjs';

const targetUrl = new URL('../../founder/archie-launch-target.json', import.meta.url);
const target = JSON.parse(await fs.readFile(targetUrl, 'utf8'));
const evidence = label => digest({ evidence: label });
const env = label => digest({ environment: label });

function metricSet(overrides = {}) {
  return {
    end_to_end_completion_rate: 0.82,
    interaction_bandwidth_score: 0.7,
    continuity_score: 0.72,
    availability_score: 0.7,
    proactivity_score: 0.45,
    modality_breadth_score: 0.55,
    device_reach_score: 0.6,
    user_control_score: 0.99,
    privacy_score: 0.9,
    offline_capability_score: 0.8,
    p95_interaction_latency_ms: 420,
    peak_memory_mb: 5500,
    sustained_energy_watts: 18,
    network_dependency_score: 0.2,
    interruption_burden_score: 0.2,
    ...overrides
  };
}

function outcomes(overrides = {}) {
  return {
    'objective-completion': 0.82,
    interruptibility: 0.8,
    continuity: 0.72,
    inspectability: 0.97,
    'user-control': 0.99,
    privacy: 0.9,
    ...overrides
  };
}

function profile(id, overrides = {}) {
  return {
    id,
    environment_id: 'desktop-local',
    environment_digest: env('desktop-local'),
    status: 'admitted',
    fallback_only: false,
    capabilities: ['goal-input', 'tool-use', 'artifact-inspection'],
    modalities: ['text'],
    invocation_modes: ['explicit'],
    surfaces: ['workbench'],
    metrics: metricSet(),
    outcome_scores: outcomes(),
    constraints: [
      { id: 'authority', status: 'satisfied', evidence: [evidence(`${id}:authority`)] },
      { id: 'platform', status: 'satisfied', evidence: [evidence(`${id}:platform`)] },
      { id: 'resource', status: 'satisfied', evidence: [evidence(`${id}:resource`)] },
      { id: 'latency', status: 'satisfied', evidence: [evidence(`${id}:latency`)] }
    ],
    disabled_capabilities: [],
    evidence: [evidence(`${id}:profile`)],
    ...overrides
  };
}

function candidate(profileOverrides = [], candidateOverrides = {}) {
  const profiles = profileOverrides.length ? profileOverrides : [profile('balanced-local')];
  const searchedAxes = [...target.profile_search.required_axes];
  return {
    schema: ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
    id: 'candidate-frontier-fixture',
    artifact_digest: evidence('candidate-artifact'),
    code_sha: 'a'.repeat(40),
    intelligence_report_digest: evidence('intelligence-report'),
    authority_report_digest: evidence('authority-report'),
    reproduction_receipt_digest: evidence('reproduction-receipt'),
    domains: [...target.intelligence_target.domains],
    intelligence_requirements: [...target.intelligence_target.requirements],
    metrics: {
      cross_domain_completion_rate: 0.9,
      unfamiliar_product_completion_rate: 0.82,
      failure_repair_rate: 0.88,
      calibrated_abstention_rate: 0.95,
      false_completion_rate_max: 0.002,
      terminal_evidence_rate: 0.995,
      clean_environment_reproduction_rate: 0.98,
      authority_compliance_rate: 1
    },
    profiles,
    selected_default_profile_id: profiles.length === 1 ? profiles[0].id : null,
    profile_search_receipt: {
      algorithm: 'pareto-complete-enumeration/v1',
      complete: true,
      searched_axes: searchedAxes,
      enumerated_profile_ids: profiles.map(entry => entry.id),
      search_space_digest: evidence('search-space'),
      environment_matrix_digest: evidence('environment-matrix'),
      profiles_digest: digest(profiles),
      evidence: [evidence('profile-search-receipt')]
    },
    ...candidateOverrides
  };
}

function rebindProfiles(input) {
  input.profile_search_receipt.enumerated_profile_ids = input.profiles.map(entry => entry.id);
  input.profile_search_receipt.profiles_digest = digest(input.profiles);
  return input;
}

test('the target contains no immutable chat, voice, screen, CLI, or daemon product form', () => {
  const validated = validateLaunchTarget(target);
  const derived = deriveLaunchRequirements(target);
  assert.equal(validated.launch_policy.single_canonical_interface, false);
  assert.equal(validated.launch_policy.chat_window_is_architecture, false);
  assert.equal(validated.launch_policy.voice_is_architecture, false);
  assert.equal(validated.launch_policy.always_on_daemon_is_architecture, false);
  assert.equal(validated.launch_policy.cli_is_consumer_identity, false);
  assert.deepEqual(derived.immutable_interface_assumptions, []);
  assert.deepEqual(productFormCatalog(), []);
  assert.doesNotMatch(JSON.stringify(derived), /spoken-companion|ambient-runtime|visual-workbench/);
});

test('profiles may use any capability vocabulary and are compared as complete bundles', () => {
  const quiet = profile('quiet', {
    capabilities: ['typed-goal', 'local-tools'],
    modalities: ['text'],
    invocation_modes: ['explicit'],
    surfaces: ['terminal'],
    metrics: metricSet({ privacy_score: 0.98, offline_capability_score: 1, p95_interaction_latency_ms: 600, interaction_bandwidth_score: 0.55 }),
    outcome_scores: outcomes({ privacy: 0.98, interruptibility: 0.72 })
  });
  const rich = profile('rich', {
    capabilities: ['gesture-loop', 'scene-grounding', 'spoken-control'],
    modalities: ['audio', 'visual'],
    invocation_modes: ['wake-triggered', 'explicit'],
    surfaces: ['wearable', 'workbench'],
    metrics: metricSet({ privacy_score: 0.86, offline_capability_score: 0.55, p95_interaction_latency_ms: 220, interaction_bandwidth_score: 0.94, modality_breadth_score: 0.95 }),
    outcome_scores: outcomes({ privacy: 0.86, interruptibility: 0.95 })
  });
  const decision = evaluateLaunchCandidate(target, candidate([quiet, rich]));
  assert.equal(decision.decision, 'admitted-maximal-launch');
  assert.deepEqual(decision.embodiment.launch_set, ['quiet', 'rich']);
  assert.equal(decision.embodiment.environments[0].adaptive, true);
  assert.equal(decision.embodiment.environments[0].default_profile_id, null);
});

test('a strictly weaker profile is excluded from the frontier and cannot be the default', () => {
  const strong = profile('strong');
  const weak = profile('weak', {
    metrics: metricSet({
      end_to_end_completion_rate: 0.75,
      interaction_bandwidth_score: 0.5,
      continuity_score: 0.65,
      availability_score: 0.62,
      proactivity_score: 0.3,
      modality_breadth_score: 0.4,
      device_reach_score: 0.5,
      user_control_score: 0.96,
      privacy_score: 0.82,
      offline_capability_score: 0.6,
      p95_interaction_latency_ms: 900,
      peak_memory_mb: 6500,
      sustained_energy_watts: 25,
      network_dependency_score: 0.4,
      interruption_burden_score: 0.35
    }),
    outcome_scores: outcomes({
      'objective-completion': 0.75,
      interruptibility: 0.72,
      continuity: 0.65,
      inspectability: 0.92,
      'user-control': 0.96,
      privacy: 0.82
    })
  });
  assert.equal(profileDominates(strong, weak, target), true);
  const input = candidate([strong, weak], { selected_default_profile_id: 'weak' });
  const decision = evaluateLaunchCandidate(target, input);
  assert.equal(decision.decision, 'rejected-incomplete-launch');
  assert.ok(decision.policy_violations.includes('dominated-default-selected'));
  assert.deepEqual(decision.embodiment.dominated_profiles, [{ id: 'weak', dominated_by: ['strong'] }]);
});

test('a weaker fallback remains visible but does not overwrite the maximal launch set', () => {
  const strong = profile('strong');
  const weakFallback = profile('weak-fallback', {
    fallback_only: true,
    metrics: metricSet({ interaction_bandwidth_score: 0.5, p95_interaction_latency_ms: 800 }),
    outcome_scores: outcomes({ interruptibility: 0.72 })
  });
  const decision = evaluateLaunchCandidate(target, candidate([strong, weakFallback], { selected_default_profile_id: 'strong' }));
  assert.equal(decision.decision, 'admitted-maximal-launch');
  assert.deepEqual(decision.embodiment.launch_set, ['strong']);
  assert.deepEqual(decision.embodiment.dominated_profiles, [{ id: 'weak-fallback', dominated_by: ['strong'] }]);
});

test('a nondominated profile cannot be hidden as a fallback', () => {
  const local = profile('local', {
    metrics: metricSet({ privacy_score: 0.99, offline_capability_score: 1, p95_interaction_latency_ms: 700, interaction_bandwidth_score: 0.5 }),
    outcome_scores: outcomes({ privacy: 0.99 })
  });
  const remote = profile('remote', {
    fallback_only: true,
    metrics: metricSet({ privacy_score: 0.82, offline_capability_score: 0.1, p95_interaction_latency_ms: 180, interaction_bandwidth_score: 0.95 }),
    outcome_scores: outcomes({ privacy: 0.82, interruptibility: 0.94 })
  });
  const decision = evaluateLaunchCandidate(target, candidate([local, remote], { selected_default_profile_id: 'local' }));
  assert.equal(decision.decision, 'rejected-incomplete-launch');
  assert.deepEqual(decision.embodiment.hidden_nondominated_fallbacks, ['remote']);
  assert.ok(decision.policy_violations.includes('nondominated-profile-hidden-as-fallback'));
});

test('platform-specific profiles are frontiered independently instead of forcing one universal form', () => {
  const desktop = profile('desktop', { environment_id: 'desktop', environment_digest: env('desktop') });
  const phone = profile('phone', {
    environment_id: 'phone',
    environment_digest: env('phone'),
    capabilities: ['push-to-talk', 'notification-resume'],
    modalities: ['audio', 'text'],
    invocation_modes: ['explicit', 'notification'],
    surfaces: ['phone'],
    disabled_capabilities: [{ id: 'ambient-microphone', reason: 'platform permission and background execution boundary', evidence: [evidence('phone:ambient-microphone-disabled')] }],
    metrics: metricSet({ peak_memory_mb: 3200, sustained_energy_watts: 8, continuity_score: 0.64 }),
    outcome_scores: outcomes({ continuity: 0.64 })
  });
  const decision = evaluateLaunchCandidate(target, candidate([desktop, phone]));
  assert.equal(decision.decision, 'admitted-maximal-launch');
  assert.deepEqual(decision.embodiment.environments.map(entry => entry.environment_id), ['desktop', 'phone']);
  assert.ok(decision.embodiment.environments.every(entry => entry.frontier_profile_ids.length === 1));
});

test('incomplete search receipts and omitted axes fail closed', () => {
  const input = candidate();
  input.profile_search_receipt.complete = false;
  input.profile_search_receipt.searched_axes = input.profile_search_receipt.searched_axes.filter(axis => axis !== 'modality');
  const decision = evaluateLaunchCandidate(target, input);
  assert.equal(decision.decision, 'rejected-incomplete-launch');
  assert.equal(decision.embodiment.search_receipt.passed, false);
  assert.deepEqual(decision.embodiment.search_receipt.missing_axes, ['modality']);
});

test('the profile receipt binds the exact enumerated profile set', () => {
  const input = candidate();
  input.profiles.push(profile('unbound'));
  assert.throws(() => validateLaunchCandidate(input, target), /profiles_digest/);
  rebindProfiles(input);
  assert.doesNotThrow(() => validateLaunchCandidate(input, target));
});

test('a powerful interface bundle without admitted intelligence cannot launch', () => {
  const input = candidate([], {
    domains: ['software'],
    intelligence_requirements: [],
    metrics: {
      cross_domain_completion_rate: 0.1,
      unfamiliar_product_completion_rate: 0.1,
      failure_repair_rate: 0.1,
      calibrated_abstention_rate: 0.1,
      false_completion_rate_max: 0.5,
      terminal_evidence_rate: 0.2,
      clean_environment_reproduction_rate: 0.1,
      authority_compliance_rate: 0.5
    }
  });
  const decision = evaluateLaunchCandidate(target, input);
  assert.equal(decision.intelligence.passed, false);
  assert.equal(decision.embodiment.passed, true);
  assert.equal(decision.decision, 'rejected-incomplete-launch');
});

test('an intelligent model with no admitted feasible profile cannot launch', () => {
  const blocked = profile('blocked', {
    status: 'infeasible',
    constraints: [{ id: 'platform', status: 'blocked', reason: 'unsupported background runtime', evidence: [evidence('blocked:platform')] }]
  });
  const decision = evaluateLaunchCandidate(target, candidate([blocked], { selected_default_profile_id: null }));
  assert.equal(decision.intelligence.passed, true);
  assert.equal(decision.embodiment.passed, false);
  assert.ok(decision.policy_violations.includes('no-feasible-nondominated-profile'));
});

test('evidence, Git SHAs, ranges, and blocked constraints fail closed', () => {
  assert.throws(() => validateLaunchCandidate({ ...candidate(), code_sha: 'main' }, target), /Git SHA/);
  const badMetric = candidate();
  badMetric.profiles[0].metrics.privacy_score = 4;
  rebindProfiles(badMetric);
  assert.throws(() => validateLaunchCandidate(badMetric, target), /between 0 and 1/);
  const blocked = candidate();
  blocked.profiles[0].constraints[0] = { id: 'authority', status: 'blocked', reason: 'denied', evidence: [evidence('denied')] };
  rebindProfiles(blocked);
  assert.throws(() => validateLaunchCandidate(blocked, target), /cannot be admitted with blocked constraints/);
});
