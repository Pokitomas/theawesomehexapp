import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
  deriveLaunchRequirements,
  digest,
  evaluateLaunchCandidate
} from '../archie-launch-contract.mjs';
import { resolveAdmittedLaunchProfile } from '../archie-launch-profile-admission.mjs';

const target = JSON.parse(await fs.readFile(new URL('../../founder/archie-launch-target.json', import.meta.url), 'utf8'));
const evidence = label => digest({ evidence: label });

function decision() {
  const requirements = deriveLaunchRequirements(target);
  return evaluateLaunchCandidate(target, {
    schema: ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
    id: 'aggregate-resource-candidate',
    artifact_digest: evidence('aggregate-artifact'),
    intelligence_report_digest: evidence('aggregate-intelligence'),
    authority_report_digest: evidence('aggregate-authority'),
    reproduction_receipt_digest: evidence('aggregate-reproduction'),
    domains: [...target.intelligence_target.domains],
    intelligence_requirements: [...target.intelligence_target.requirements],
    metrics: {
      cross_domain_completion_rate: 0.9,
      failure_repair_rate: 0.9,
      calibrated_abstention_rate: 0.9,
      false_completion_rate_max: 0.001,
      terminal_evidence_rate: 1
    },
    faculties: Object.fromEntries(requirements.faculties.map(item => [item.id, {
      status: 'admitted',
      evidence: [evidence(`faculty:${item.id}`)]
    }])),
    interfaces: [{
      id: 'integrated-surface',
      status: 'admitted',
      faculties: requirements.faculties.map(item => item.id),
      evidence: [evidence('integrated-surface')]
    }]
  });
}

function capability(id, faculties, resourceCost, conflicts = []) {
  return {
    id,
    status: 'admitted',
    families: ['fixture'],
    faculties,
    evidence_digests: [evidence(`capability:${id}`)],
    requires: [],
    conflicts,
    required_permissions: [],
    network: 'none',
    metrics: { quality_score: 1 },
    gates: { quality_score_min: 0.9 },
    minimum_resources: { ram_bytes: 1 },
    resource_cost: resourceCost
  };
}

function manifest({ ramBytes = 12_000_000_000, energyWatts = 20 } = {}) {
  const launchDecision = decision();
  const requirements = deriveLaunchRequirements(target);
  const halfway = Math.ceil(requirements.faculties.length / 2);
  const first = requirements.faculties.slice(0, halfway).map(item => item.id);
  const second = requirements.faculties.slice(halfway).map(item => item.id);
  const hardware = {
    device_class: 'aggregate-fixture',
    architecture: 'x86_64',
    cpu_threads: 8,
    ram_bytes: ramBytes,
    vram_bytes: 0,
    disk_free_bytes: 20_000_000_000,
    accelerators: [],
    energy_watts_budget: energyWatts,
    thermal_celsius_limit: 90
  };
  const operatingSystem = {
    family: 'linux',
    version: 'fixture',
    background_model: 'user-service',
    sandbox: 'process'
  };
  const hardwareFingerprint = digest(hardware);
  const osFingerprint = digest(operatingSystem);
  return {
    schema: 'archie-launch-capability-manifest/v1',
    release: {
      id: 'aggregate-release',
      runtime_abi: 'archie-runtime/v1',
      code_revision: 'c'.repeat(40),
      model_artifact_digest: launchDecision.candidate_artifact_digest,
      checkpoint_digest: evidence('aggregate-checkpoint')
    },
    launch_target: target,
    launch_decision: launchDecision,
    machine: {
      id: 'aggregate-machine',
      hardware,
      operating_system: operatingSystem,
      hardware_fingerprint: hardwareFingerprint,
      os_fingerprint: osFingerprint,
      device_fingerprint: digest({ hardware_fingerprint: hardwareFingerprint, os_fingerprint: osFingerprint }),
      permissions: {},
      network_available: false
    },
    capabilities: [
      capability('first-half', first, { memory_bytes: 7_000_000_000, energy_watts: 9 }),
      capability('second-half-heavy', second, { memory_bytes: 7_000_000_000, energy_watts: 9 }, ['second-half-lite']),
      capability('second-half-lite', second, { memory_bytes: 3_000_000_000, energy_watts: 5 }, ['second-half-heavy'])
    ],
    selection_preferences: ['second-half-heavy', 'second-half-lite'],
    fallback_scenarios: [{
      id: 'plugged-in-expanded-memory',
      permission_overrides: {},
      resource_overrides: { ram_bytes: 16_000_000_000, energy_watts_budget: 25 },
      network_available: false,
      reason: 'An explicitly measured expanded resource envelope is available.'
    }],
    claim_boundary: 'Aggregate resource fixture only.'
  };
}

test('aggregate admission rejects the preferred profile when combined memory exceeds the machine and selects the strongest feasible alternative', () => {
  const admission = resolveAdmittedLaunchProfile(manifest());
  assert.equal(admission.decision, 'admitted-maximal-machine-profile');
  assert.deepEqual(admission.default_profile.selected_profile.capabilities, ['first-half', 'second-half-lite']);
  assert.equal(admission.default_profile.selected_profile_aggregate_resources.passed, true);
  const rejected = admission.default_profile.rejected_aggregate_profiles.find(item => item.capabilities.includes('second-half-heavy'));
  assert.ok(rejected);
  assert.ok(rejected.failed_resource_checks.some(check => check.cost_name === 'memory_bytes'));
  assert.equal(admission.default_profile.strongest_profile_proof.aggregate_resource_gate_applied, true);
  assert.equal(admission.default_profile.strongest_profile_proof.selected_is_first_resource-feasible_profile, true);
});

test('named expanded-resource fallback may select a stronger profile without changing the default machine claim', () => {
  const admission = resolveAdmittedLaunchProfile(manifest());
  const expanded = admission.fallbacks.find(item => item.scenario_id === 'plugged-in-expanded-memory');
  assert.deepEqual(admission.default_profile.selected_profile.capabilities, ['first-half', 'second-half-lite']);
  assert.deepEqual(expanded.selected_profile.capabilities, ['first-half', 'second-half-heavy']);
  assert.equal(expanded.selected_profile_aggregate_resources.passed, true);
  assert.equal(admission.decision, 'admitted-maximal-machine-profile');
});

test('no aggregate-feasible full profile fails closed and reports the unmet resource budget', () => {
  const admission = resolveAdmittedLaunchProfile(manifest({ ramBytes: 8_000_000_000, energyWatts: 10 }));
  assert.equal(admission.decision, 'rejected-machine-profile');
  assert.equal(admission.default_profile.all_required_faculties_covered, false);
  assert.equal(admission.default_profile.selected_profile_aggregate_resources.passed, false);
  assert.ok(admission.default_profile.rejected_aggregate_profiles.length >= 2);
  assert.match(admission.admission_digest, /^[a-f0-9]{64}$/);
});
