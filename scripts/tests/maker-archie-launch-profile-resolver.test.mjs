import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
  deriveLaunchRequirements,
  digest,
  evaluateLaunchCandidate
} from '../archie-launch-contract.mjs';
import {
  ARCHIE_LAUNCH_CAPABILITY_MANIFEST_SCHEMA,
  resolveLaunchProfile,
  validateLaunchCapabilityManifest
} from '../archie-launch-profile-resolver.mjs';

const target = JSON.parse(await fs.readFile(new URL('../../founder/archie-launch-target.json', import.meta.url), 'utf8'));
const evidence = label => digest({ evidence: label });

function passingMetrics(targetInput) {
  return Object.fromEntries(Object.entries(targetInput.intelligence_target.minimum_metrics).map(([name, threshold]) => [
    name,
    name.endsWith('_max') ? Math.max(0, threshold / 2) : Math.min(1, threshold + 0.05)
  ]));
}

function launchDecisionFor(targetInput = target) {
  const requirements = deriveLaunchRequirements(targetInput);
  const faculties = Object.fromEntries(requirements.faculties.map(item => [item.id, {
    status: 'admitted',
    evidence: [evidence(`faculty:${targetInput.id}:${item.id}`)]
  }]));
  const candidate = {
    schema: ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
    id: `candidate-${targetInput.id}`,
    artifact_digest: evidence(`artifact:${targetInput.id}`),
    intelligence_report_digest: evidence(`intelligence:${targetInput.id}`),
    authority_report_digest: evidence(`authority:${targetInput.id}`),
    reproduction_receipt_digest: evidence(`reproduction:${targetInput.id}`),
    domains: [...targetInput.intelligence_target.domains],
    intelligence_requirements: [...targetInput.intelligence_target.requirements],
    metrics: passingMetrics(targetInput),
    faculties,
    interfaces: [{
      id: 'integrated-admitted-surface',
      status: 'admitted',
      faculties: requirements.faculties.map(item => item.id),
      evidence: [evidence(`interface:${targetInput.id}`)]
    }]
  };
  return evaluateLaunchCandidate(targetInput, candidate);
}

function capability(id, faculties, overrides = {}) {
  return {
    id,
    status: 'admitted',
    families: ['interaction'],
    faculties,
    evidence_digests: [evidence(`capability:${id}`)],
    requires: [],
    conflicts: [],
    required_permissions: [],
    network: 'none',
    metrics: { p95_latency_ms: 120, quality_score: 0.95 },
    gates: { p95_latency_ms_max: 500, quality_score_min: 0.8 },
    minimum_resources: { ram_bytes: 1_000_000 },
    resource_cost: { energy_watts: 1, memory_bytes: 1_000_000 },
    ...overrides
  };
}

function fullCapabilities() {
  return [
    capability('spoken-full', ['audio-input', 'audio-output', 'duplex-turn-taking', 'streaming-response'], {
      families: ['voice', 'foreground'],
      conflicts: ['spoken-lite'],
      required_permissions: ['microphone', 'audio-output'],
      minimum_resources: { ram_bytes: 2_000_000_000, energy_watts_budget: 10 },
      resource_cost: { energy_watts: 8, memory_bytes: 600_000_000 }
    }),
    capability('spoken-lite', ['audio-input', 'audio-output'], {
      families: ['voice', 'fallback'],
      conflicts: ['spoken-full'],
      required_permissions: ['microphone', 'audio-output'],
      minimum_resources: { ram_bytes: 500_000_000, energy_watts_budget: 2 },
      resource_cost: { energy_watts: 2, memory_bytes: 150_000_000 }
    }),
    capability('ambient-runtime', [
      'durable-run-state',
      'background-execution',
      'suspend-resume-recovery',
      'user-governed-notification',
      'explicit-event-subscription',
      'interruption-policy'
    ], {
      families: ['ambient', 'continuity', 'proactive'],
      required_permissions: ['background-execution', 'notifications'],
      minimum_resources: { ram_bytes: 1_000_000_000, energy_watts_budget: 4 },
      resource_cost: { energy_watts: 3, memory_bytes: 300_000_000 }
    }),
    capability('visual-workbench', [
      'screen-context',
      'multimodal-ingestion',
      'artifact-workbench',
      'inspectable-transcript',
      'receipt-inspection',
      'unfinished-obligation-inspection'
    ], {
      families: ['visual', 'precision'],
      required_permissions: ['screen-capture'],
      minimum_resources: { ram_bytes: 2_000_000_000 },
      resource_cost: { energy_watts: 2, memory_bytes: 500_000_000 }
    }),
    capability('tool-bridge', ['connected-tool-context', 'consent-bound-sensing'], {
      families: ['tools', 'observation'],
      required_permissions: ['tool-observation'],
      resource_cost: { energy_watts: 1, memory_bytes: 100_000_000 }
    }),
    capability('device-continuity', ['authenticated-device-handoff', 'encrypted-continuity', 'capability-revocation'], {
      families: ['device', 'continuity'],
      required_permissions: ['device-sync'],
      network: 'required',
      resource_cost: { energy_watts: 1, memory_bytes: 100_000_000 }
    }),
    capability('private-local-runtime', ['local-model-execution', 'offline-core-operation', 'resource-adaptive-runtime'], {
      families: ['local', 'private'],
      minimum_resources: { ram_bytes: 8_000_000_000, disk_free_bytes: 4_000_000_000 },
      resource_cost: { energy_watts: 10, memory_bytes: 6_000_000_000 }
    }),
    capability('text-receipt-console', ['inspectable-transcript', 'receipt-inspection'], {
      families: ['text', 'audit'],
      resource_cost: { energy_watts: 0.2, memory_bytes: 50_000_000 }
    })
  ];
}

function machine() {
  const hardware = {
    device_class: 'ordinary-laptop',
    architecture: 'x86_64',
    cpu_threads: 16,
    ram_bytes: 24_000_000_000,
    vram_bytes: 8_000_000_000,
    disk_free_bytes: 100_000_000_000,
    accelerators: ['gpu'],
    energy_watts_budget: 30,
    thermal_celsius_limit: 95
  };
  const operatingSystem = {
    family: 'linux',
    version: 'test-fixture',
    background_model: 'user-service',
    sandbox: 'process-and-filesystem'
  };
  const hardwareFingerprint = digest(hardware);
  const osFingerprint = digest(operatingSystem);
  return {
    id: 'fixture-laptop',
    hardware,
    operating_system: operatingSystem,
    hardware_fingerprint: hardwareFingerprint,
    os_fingerprint: osFingerprint,
    device_fingerprint: digest({ hardware_fingerprint: hardwareFingerprint, os_fingerprint: osFingerprint }),
    permissions: {
      microphone: true,
      'audio-output': true,
      'background-execution': true,
      notifications: true,
      'screen-capture': true,
      'tool-observation': true,
      'device-sync': true
    },
    network_available: true
  };
}

function manifest(overrides = {}) {
  const launchDecision = launchDecisionFor(target);
  return {
    schema: ARCHIE_LAUNCH_CAPABILITY_MANIFEST_SCHEMA,
    release: {
      id: 'archie-maximal-fixture-0.1.0',
      runtime_abi: 'archie-runtime/v1',
      code_revision: 'a'.repeat(40),
      model_artifact_digest: launchDecision.candidate_artifact_digest,
      checkpoint_digest: evidence('checkpoint')
    },
    launch_target: target,
    launch_decision: launchDecision,
    machine: machine(),
    capabilities: fullCapabilities(),
    selection_preferences: ['spoken-full', 'ambient-runtime', 'private-local-runtime', 'visual-workbench'],
    fallback_scenarios: [
      {
        id: 'low-power',
        permission_overrides: {},
        resource_overrides: { energy_watts_budget: 5 },
        network_available: true,
        reason: 'Battery saver constrains sustained power.'
      },
      {
        id: 'foreground-only',
        permission_overrides: { 'background-execution': false },
        resource_overrides: {},
        network_available: true,
        reason: 'The platform denies background execution.'
      },
      {
        id: 'offline',
        permission_overrides: {},
        resource_overrides: {},
        network_available: false,
        reason: 'The network is unavailable.'
      }
    ],
    claim_boundary: 'Fixture proving exact-machine maximal profile resolution only.',
    ...overrides
  };
}

test('manifest binds exact admitted release, machine fingerprints, permissions, resources, and evidence', () => {
  const validated = validateLaunchCapabilityManifest(manifest());
  assert.equal(validated.launch_decision.decision, 'admitted-maximal-launch');
  assert.equal(validated.release.model_artifact_digest, validated.launch_decision.candidate_artifact_digest);
  assert.equal(validated.machine.hardware_fingerprint, digest(validated.machine.hardware));
  assert.equal(validated.machine.os_fingerprint, digest(validated.machine.operating_system));
  assert.match(validated.manifest_digest, /^[a-f0-9]{64}$/);
});

test('default selection chooses the strongest full-coverage profile rather than the weaker conflicting voice surface', () => {
  const resolution = resolveLaunchProfile(manifest());
  assert.equal(resolution.decision, 'admitted-maximal-machine-profile');
  assert.equal(resolution.default_profile.all_required_faculties_covered, true);
  assert.ok(resolution.default_profile.selected_profile.capabilities.includes('spoken-full'));
  assert.equal(resolution.default_profile.selected_profile.capabilities.includes('spoken-lite'), false);
  assert.ok(resolution.default_profile.maximal_profiles.some(profile => profile.capabilities.includes('spoken-lite')));
  assert.ok(resolution.default_profile.selected_profile.required_faculty_coverage.length > 20);
  assert.equal(resolution.default_profile.strongest_profile_proof.no_hidden_canonical_interface, true);
  assert.match(resolution.resolution_digest, /^[a-f0-9]{64}$/);
});

test('named resource and permission constraints produce visible fallbacks without overwriting the maximal default claim', () => {
  const resolution = resolveLaunchProfile(manifest());
  const lowPower = resolution.fallbacks.find(item => item.scenario_id === 'low-power');
  const foreground = resolution.fallbacks.find(item => item.scenario_id === 'foreground-only');
  const offline = resolution.fallbacks.find(item => item.scenario_id === 'offline');

  assert.ok(lowPower.selected_profile.capabilities.includes('spoken-lite'));
  assert.equal(lowPower.selected_profile.capabilities.includes('spoken-full'), false);
  assert.ok(lowPower.disabled_capabilities.find(item => item.id === 'spoken-full').reasons.includes('resource:energy_watts_budget'));
  assert.equal(lowPower.all_required_faculties_covered, false);

  assert.ok(foreground.disabled_capabilities.find(item => item.id === 'ambient-runtime').reasons.includes('permission:background-execution'));
  assert.equal(foreground.all_required_faculties_covered, false);

  assert.ok(offline.disabled_capabilities.find(item => item.id === 'device-continuity').reasons.includes('network:unavailable'));
  assert.equal(offline.all_required_faculties_covered, false);
  assert.equal(resolution.decision, 'admitted-maximal-machine-profile');
});

test('product shape remains target-derived: a precision-only release can admit without voice or ambient capabilities', () => {
  const precisionTarget = structuredClone(target);
  precisionTarget.id = 'precision-only-launch';
  precisionTarget.human_outcomes = precisionTarget.human_outcomes.filter(item => item.id === 'inspect-exact-work-when-precision-matters');
  const launchDecision = launchDecisionFor(precisionTarget);
  const precisionManifest = manifest({
    release: {
      id: 'precision-release',
      runtime_abi: 'archie-runtime/v1',
      code_revision: 'b'.repeat(40),
      model_artifact_digest: launchDecision.candidate_artifact_digest,
      checkpoint_digest: evidence('precision-checkpoint')
    },
    launch_target: precisionTarget,
    launch_decision: launchDecision,
    capabilities: [capability('precision-surface', [
      'artifact-workbench',
      'inspectable-transcript',
      'receipt-inspection',
      'unfinished-obligation-inspection'
    ], { families: ['precision', 'text'] })],
    selection_preferences: ['precision-surface'],
    fallback_scenarios: []
  });
  const resolution = resolveLaunchProfile(precisionManifest);
  assert.equal(resolution.decision, 'admitted-maximal-machine-profile');
  assert.deepEqual(resolution.default_profile.selected_profile.capabilities, ['precision-surface']);
  assert.equal(resolution.default_profile.selected_profile.families.includes('voice'), false);
  assert.equal(resolution.default_profile.selected_profile.families.includes('ambient'), false);
});

test('unsupported capability evidence, machine fingerprints, and launch admission fail closed', () => {
  const badEvidence = manifest();
  badEvidence.capabilities[0].evidence_digests = ['looks-good'];
  assert.throws(() => validateLaunchCapabilityManifest(badEvidence), /SHA-256/);

  const badMachine = manifest();
  badMachine.machine.hardware.ram_bytes += 1;
  assert.throws(() => validateLaunchCapabilityManifest(badMachine), /hardware_fingerprint mismatch/);

  const rejected = manifest();
  const { decision_digest, ...decisionBody } = rejected.launch_decision;
  rejected.launch_decision = {
    ...decisionBody,
    decision: 'rejected-incomplete-launch'
  };
  rejected.launch_decision.decision_digest = digest(rejected.launch_decision);
  const resolution = resolveLaunchProfile(rejected);
  assert.equal(resolution.intelligence_and_authority_admitted, false);
  assert.equal(resolution.decision, 'rejected-machine-profile');
});
