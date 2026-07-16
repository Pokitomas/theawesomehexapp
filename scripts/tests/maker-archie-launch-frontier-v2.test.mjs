import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  ARCHIE_LAUNCH_FRONTIER_MANIFEST_SCHEMA,
  frontierDigest,
  profileDominates,
  resolveLaunchFrontierV2,
  validateFrontierManifest,
  validateFrontierTarget
} from '../archie-launch-frontier-v2.mjs';

const target = JSON.parse(await fs.readFile(new URL('../../founder/archie-launch-frontier-target.json', import.meta.url), 'utf8'));
const d = label => frontierDigest({ label });
const release = Object.freeze({
  id: 'archie-v2-fixture',
  model_artifact_digest: d('model'),
  checkpoint_digest: d('checkpoint'),
  intelligence_report_digest: d('intelligence'),
  authority_report_digest: d('authority'),
  reproduction_receipt_digest: d('reproduction'),
  runtime_abi: 'archie-runtime/v2',
  code_revision: 'a'.repeat(40)
});

function metrics(overrides = {}) {
  return {
    unfamiliar_task_completion_rate: 0.82,
    failure_repair_rate: 0.86,
    false_completion_rate: 0.002,
    interaction_success_rate: 0.98,
    continuity_recovery_rate: 0.98,
    p95_interaction_latency_ms: 700,
    authority_compliance_rate: 1,
    privacy_locality_rate: 0.96,
    energy_watts_p95: 18,
    ...overrides
  };
}

function environment(id, overrides = {}) {
  return {
    id,
    required_for_launch: true,
    hardware_fingerprint: d(`${id}:hardware`),
    os_fingerprint: d(`${id}:os`),
    platform_receipt_digests: [d(`${id}:platform`)],
    authority_grants: ['observe', 'notify', 'maker-effect', 'microphone'],
    resource_budgets: { ram_bytes: 16_000, energy_watts: 100, background_slots: 1 },
    selection_policy: { mode: 'adaptive-frontier', objective_order: [] },
    requested_default_profile_id: null,
    ...overrides
  };
}

function profile(id, environmentId, overrides = {}) {
  return {
    id,
    environment_id: environmentId,
    status: 'admitted',
    model_artifact_digest: release.model_artifact_digest,
    code_revision: release.code_revision,
    runtime_abi: release.runtime_abi,
    evidence_digests: [d(`${id}:evidence`)],
    modalities: ['text'],
    invocation_modes: ['explicit'],
    continuity_modes: ['foreground-session'],
    required_authorities: ['observe'],
    resource_usage: { ram_bytes: 4_000, energy_watts: 12 },
    objective_metrics: metrics(),
    activation_conditions: ['user-invoked'],
    platform_constraints: [],
    ...overrides
  };
}

function manifest(profiles, environments = [environment('desktop')], overrides = {}) {
  return {
    schema: ARCHIE_LAUNCH_FRONTIER_MANIFEST_SCHEMA,
    target,
    release,
    environments,
    profiles,
    search_receipt: {
      complete: true,
      generator_digest: d('generator'),
      candidate_space_digest: d('candidate-space'),
      enumerated_profile_ids: profiles.map(item => item.id),
      excluded_candidates: []
    },
    claim_boundary: 'Fixture only.',
    ...overrides
  };
}

test('v2 target forbids every canonical interface assumption', () => {
  const validated = validateFrontierTarget(target);
  assert.equal(validated.frontier_policy.canonical_interface, null);
  assert.equal(validated.frontier_policy.chat_is_architecture, false);
  assert.equal(validated.frontier_policy.voice_is_architecture, false);
  assert.equal(validated.frontier_policy.screen_is_architecture, false);
  assert.equal(validated.frontier_policy.always_on_is_architecture, false);
  assert.ok(validated.objectives.some(item => item.group === 'intelligence'));
  assert.ok(validated.objectives.some(item => item.group === 'embodiment'));
});

test('incomparable text and voice profiles both remain on the adaptive frontier', () => {
  const text = profile('text-precision', 'desktop', {
    modalities: ['text', 'visual'],
    objective_metrics: metrics({ interaction_success_rate: 0.99, p95_interaction_latency_ms: 850, energy_watts_p95: 10 })
  });
  const voice = profile('voice-speed', 'desktop', {
    modalities: ['voice'],
    invocation_modes: ['push-to-talk'],
    required_authorities: ['observe', 'microphone'],
    objective_metrics: metrics({ interaction_success_rate: 0.97, p95_interaction_latency_ms: 420, energy_watts_p95: 24 })
  });
  const decision = resolveLaunchFrontierV2(manifest([text, voice]));
  assert.equal(decision.decision, 'admitted-capability-frontier');
  assert.deepEqual(decision.environments[0].frontier_profile_ids, ['text-precision', 'voice-speed']);
  assert.equal(decision.environments[0].primary_profile_id, null);
  assert.deepEqual(decision.environments[0].adaptive_profile_set, ['text-precision', 'voice-speed']);
});

test('a strictly dominated requested default rejects the environment', () => {
  const weak = profile('chat-weak', 'desktop', { objective_metrics: metrics({ interaction_success_rate: 0.96, p95_interaction_latency_ms: 900, energy_watts_p95: 30 }) });
  const strong = profile('integrated-strong', 'desktop', { objective_metrics: metrics({ interaction_success_rate: 0.99, p95_interaction_latency_ms: 500, energy_watts_p95: 12 }) });
  const env = environment('desktop', { requested_default_profile_id: 'chat-weak' });
  const decision = resolveLaunchFrontierV2(manifest([weak, strong], [env]));
  assert.equal(profileDominates(strong, weak, target), true);
  assert.equal(decision.decision, 'rejected-capability-frontier');
  assert.equal(decision.environments[0].requested_default_is_dominated, true);
  assert.deepEqual(decision.environments[0].frontier_profile_ids, ['integrated-strong']);
});

test('different exact environments may admit different maximal forms', () => {
  const desktop = environment('desktop');
  const mobile = environment('mobile', {
    authority_grants: ['observe', 'notify'],
    resource_budgets: { ram_bytes: 6_000, energy_watts: 20, background_slots: 0 }
  });
  const ambient = profile('ambient-desktop', 'desktop', {
    modalities: ['voice', 'visual'],
    invocation_modes: ['wake-triggered', 'event-driven'],
    continuity_modes: ['background-resumable'],
    required_authorities: ['observe', 'notify', 'microphone'],
    resource_usage: { ram_bytes: 8_000, energy_watts: 35, background_slots: 1 }
  });
  const foreground = profile('foreground-mobile', 'mobile', {
    modalities: ['text', 'voice'],
    invocation_modes: ['explicit', 'push-to-talk'],
    continuity_modes: ['bounded-session'],
    required_authorities: ['observe'],
    resource_usage: { ram_bytes: 4_000, energy_watts: 12, background_slots: 0 }
  });
  const decision = resolveLaunchFrontierV2(manifest([ambient, foreground], [desktop, mobile]));
  assert.equal(decision.decision, 'admitted-capability-frontier');
  assert.deepEqual(decision.environments.find(item => item.environment_id === 'desktop').frontier_profile_ids, ['ambient-desktop']);
  assert.deepEqual(decision.environments.find(item => item.environment_id === 'mobile').frontier_profile_ids, ['foreground-mobile']);
});

test('authority and aggregate resources fail closed with explicit reasons', () => {
  const env = environment('desktop', { authority_grants: ['observe'], resource_budgets: { ram_bytes: 5_000, energy_watts: 15 } });
  const invalid = profile('overreach', 'desktop', {
    required_authorities: ['observe', 'microphone'],
    resource_usage: { ram_bytes: 8_000, energy_watts: 20 }
  });
  const decision = resolveLaunchFrontierV2(manifest([invalid], [env]));
  assert.equal(decision.decision, 'rejected-capability-frontier');
  const reasons = decision.environments[0].rejected_profiles[0].reasons;
  assert.ok(reasons.includes('authority:microphone'));
  assert.ok(reasons.includes('resource-exceeded:ram_bytes'));
  assert.ok(reasons.includes('resource-exceeded:energy_watts'));
});

test('intelligence and embodiment gates are evaluated in one profile vector', () => {
  const shell = profile('polished-shell', 'desktop', {
    objective_metrics: metrics({ unfamiliar_task_completion_rate: 0.2, failure_repair_rate: 0.2 })
  });
  const brain = profile('unembodied-brain', 'desktop', {
    objective_metrics: metrics({ interaction_success_rate: 0.4, continuity_recovery_rate: 0.4, p95_interaction_latency_ms: 3000 })
  });
  const decision = resolveLaunchFrontierV2(manifest([shell, brain]));
  assert.equal(decision.decision, 'rejected-capability-frontier');
  const rejected = Object.fromEntries(decision.environments[0].rejected_profiles.map(item => [item.id, item.reasons]));
  assert.ok(rejected['polished-shell'].includes('objective:unfamiliar_task_completion_rate'));
  assert.ok(rejected['unembodied-brain'].includes('objective:interaction_success_rate'));
});

test('incomplete search cannot produce a maximal claim', () => {
  const input = manifest([profile('only-profile', 'desktop')]);
  input.search_receipt.complete = false;
  const decision = resolveLaunchFrontierV2(input);
  assert.equal(decision.decision, 'rejected-capability-frontier');
  assert.equal(decision.search_complete, false);
});

test('search receipt must enumerate the exact visible profile set', () => {
  const input = manifest([profile('one', 'desktop'), profile('two', 'desktop')]);
  input.search_receipt.enumerated_profile_ids = ['one'];
  assert.throws(() => validateFrontierManifest(input), /exactly match profiles/);
});

test('lexicographic policy explicitly selects only from the Pareto frontier', () => {
  const lowLatency = profile('low-latency', 'desktop', { objective_metrics: metrics({ p95_interaction_latency_ms: 350, interaction_success_rate: 0.96 }) });
  const highQuality = profile('high-quality', 'desktop', { objective_metrics: metrics({ p95_interaction_latency_ms: 650, interaction_success_rate: 0.995 }) });
  const env = environment('desktop', { selection_policy: { mode: 'lexicographic', objective_order: ['interaction_success_rate', 'p95_interaction_latency_ms'] } });
  const decision = resolveLaunchFrontierV2(manifest([lowLatency, highQuality], [env]));
  assert.equal(decision.decision, 'admitted-capability-frontier');
  assert.deepEqual(decision.environments[0].frontier_profile_ids, ['high-quality', 'low-latency']);
  assert.equal(decision.environments[0].primary_profile_id, 'high-quality');
});

test('experimental profile is visible but cannot enter the frontier', () => {
  const admitted = profile('admitted', 'desktop');
  const experimental = profile('experimental-voice', 'desktop', { status: 'experimental', modalities: ['voice'] });
  const decision = resolveLaunchFrontierV2(manifest([admitted, experimental]));
  assert.equal(decision.decision, 'admitted-capability-frontier');
  assert.deepEqual(decision.environments[0].frontier_profile_ids, ['admitted']);
  assert.deepEqual(decision.environments[0].rejected_profiles[0].reasons, ['status:experimental']);
});

test('decision is deterministic and demotes the fixed-faculty v1 resolver', () => {
  const input = manifest([profile('stable', 'desktop')]);
  const first = resolveLaunchFrontierV2(input);
  const second = resolveLaunchFrontierV2(structuredClone(input));
  assert.equal(first.decision_digest, second.decision_digest);
  assert.equal(first.compatibility_boundary.v1_required_faculty_resolver_is_canonical, false);
  assert.equal(first.compatibility_boundary.v1_machine_profile_resolver_may_be_used_as_backend, true);
  assert.equal(first.compatibility_boundary.v2_frontier_decision_required_for_maximal_product_claim, true);
});
