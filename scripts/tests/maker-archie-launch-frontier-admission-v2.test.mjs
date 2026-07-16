import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { frontierDigest } from '../archie-launch-frontier-v2.mjs';
import {
  frontierEnvironmentReceiptDigest,
  resolveAdmittedLaunchFrontierV2,
  validateAdmittedFrontierManifest
} from '../archie-launch-frontier-admission-v2.mjs';

const target = JSON.parse(await fs.readFile(new URL('../../founder/archie-launch-frontier-target.json', import.meta.url), 'utf8'));
const d = label => frontierDigest({ label });
const release = {
  id: 'strict-fixture',
  model_artifact_digest: d('model'),
  checkpoint_digest: d('checkpoint'),
  intelligence_report_digest: d('intelligence'),
  authority_report_digest: d('authority'),
  reproduction_receipt_digest: d('reproduction'),
  runtime_abi: 'archie-runtime/v2',
  code_revision: 'b'.repeat(40)
};

function objectiveMetrics(overrides = {}) {
  return {
    unfamiliar_task_completion_rate: 0.82,
    failure_repair_rate: 0.84,
    false_completion_rate: 0.002,
    interaction_success_rate: 0.98,
    continuity_recovery_rate: 0.97,
    p95_interaction_latency_ms: 600,
    authority_compliance_rate: 1,
    privacy_locality_rate: 0.95,
    energy_watts_p95: 20,
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
    authority_grants: ['observe'],
    resource_budgets: { ram_bytes: 10_000 },
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
    continuity_modes: ['bounded-session'],
    required_authorities: ['observe'],
    resource_usage: { ram_bytes: 4_000 },
    objective_metrics: objectiveMetrics(),
    activation_conditions: ['user-invoked'],
    platform_constraints: [],
    ...overrides
  };
}

function manifest(environments, profiles) {
  const environmentById = new Map(environments.map(item => [item.id, item]));
  const boundProfiles = profiles.map(item => ({
    ...item,
    environment_receipt_digest: item.environment_receipt_digest
      || frontierEnvironmentReceiptDigest(environmentById.get(item.environment_id))
  }));
  return {
    schema: 'archie-launch-frontier-manifest/v2',
    target,
    release,
    environments,
    profiles: boundProfiles,
    search_receipt: {
      complete: true,
      generator_digest: d('generator'),
      candidate_space_digest: d('space'),
      enumerated_profile_ids: boundProfiles.map(item => item.id),
      excluded_candidates: []
    },
    claim_boundary: 'Strict fixture.'
  };
}

test('declared objective ranges reject impossible success rates', () => {
  const input = manifest([environment('desktop')], [
    profile('impossible', 'desktop', { objective_metrics: objectiveMetrics({ interaction_success_rate: 4 }) })
  ]);
  assert.throws(() => validateAdmittedFrontierManifest(input), /outside the declared range/);
});

test('adaptive frontier cannot smuggle one canonical default', () => {
  const input = manifest([
    environment('desktop', { requested_default_profile_id: 'text' })
  ], [profile('text', 'desktop')]);
  assert.throws(() => validateAdmittedFrontierManifest(input), /cannot request one default/);
});

test('a requested default cannot cross exact environment boundaries', () => {
  const input = manifest([
    environment('desktop', {
      selection_policy: { mode: 'lexicographic', objective_order: ['interaction_success_rate'] },
      requested_default_profile_id: 'mobile'
    }),
    environment('phone')
  ], [profile('desktop', 'desktop'), profile('mobile', 'phone')]);
  assert.throws(() => validateAdmittedFrontierManifest(input), /another environment/);
});

test('explicit default must be the profile selected by the declared policy', () => {
  const env = environment('desktop', {
    selection_policy: { mode: 'lexicographic', objective_order: ['interaction_success_rate'] },
    requested_default_profile_id: 'lower-quality'
  });
  const decision = resolveAdmittedLaunchFrontierV2(manifest([env], [
    profile('lower-quality', 'desktop', { objective_metrics: objectiveMetrics({ interaction_success_rate: 0.97, p95_interaction_latency_ms: 400 }) }),
    profile('higher-quality', 'desktop', { objective_metrics: objectiveMetrics({ interaction_success_rate: 0.99, p95_interaction_latency_ms: 800 }) })
  ]));
  assert.equal(decision.decision, 'rejected-capability-frontier');
  assert.equal(decision.environments[0].primary_profile_id, 'higher-quality');
  assert.equal(decision.environments[0].requested_default_is_not_selected, true);
  assert.equal(decision.admission_proof.exact_objective_ranges_enforced, true);
});

test('profile evidence is bound to the exact hardware, platform, authority, and budget environment', () => {
  const env = environment('desktop');
  const input = manifest([env], [profile('text', 'desktop')]);
  env.authority_grants.push('notify');
  assert.throws(() => validateAdmittedFrontierManifest(input), /environment receipt does not match/);
});

test('profiles must report every budgeted resource dimension', () => {
  const env = environment('desktop', { resource_budgets: { ram_bytes: 10_000, energy_watts: 50 } });
  const input = manifest([env], [profile('text', 'desktop', { resource_usage: { ram_bytes: 4_000 } })]);
  assert.throws(() => validateAdmittedFrontierManifest(input), /missing resource usage: energy_watts/);
});

test('excluded candidate identities cannot overlap the enumerated profile set', () => {
  const input = manifest([environment('desktop')], [profile('text', 'desktop')]);
  input.search_receipt.excluded_candidates.push({
    id: 'text',
    reasons: ['supposedly-excluded'],
    evidence_digests: [d('excluded:text')]
  });
  assert.throws(() => validateAdmittedFrontierManifest(input), /also an enumerated profile/);
});

test('admitted decision exposes exact-environment and resource-dimension proof', () => {
  const env = environment('desktop');
  const decision = resolveAdmittedLaunchFrontierV2(manifest([env], [profile('text', 'desktop')]));
  assert.equal(decision.decision, 'admitted-capability-frontier');
  assert.equal(decision.environments[0].environment_receipt_digest, frontierEnvironmentReceiptDigest(env));
  assert.equal(decision.environments[0].strongest_profile_proof.profile_environment_receipts_enforced, true);
  assert.equal(decision.environments[0].strongest_profile_proof.exact_resource_dimensions_enforced, true);
  assert.equal(decision.admission_proof.profiles_bound_to_exact_environment_receipts, true);
  assert.equal(decision.admission_proof.exact_resource_dimensions_required, true);
});
