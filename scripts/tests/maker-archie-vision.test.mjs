import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../../founder/archie-maker-vision.json', import.meta.url);
const launchTargetUrl = new URL('../../founder/archie-launch-target.json', import.meta.url);
const frontierTargetUrl = new URL('../../founder/archie-launch-frontier-target.json', import.meta.url);
const visionUrl = new URL('../../ARCHIE_MAKER_VISION.md', import.meta.url);
const profilesUrl = new URL('../../ARCHIE_LAUNCH_PROFILES.md', import.meta.url);
const packageUrl = new URL('../../package.json', import.meta.url);

const manifest = JSON.parse(await fs.readFile(manifestUrl, 'utf8'));
const launchTarget = JSON.parse(await fs.readFile(launchTargetUrl, 'utf8'));
const frontierTarget = JSON.parse(await fs.readFile(frontierTargetUrl, 'utf8'));
const vision = await fs.readFile(visionUrl, 'utf8');
const profiles = await fs.readFile(profilesUrl, 'utf8');
const packageJson = JSON.parse(await fs.readFile(packageUrl, 'utf8'));

test('Sideways remains an independent reference application rather than the AI product', () => {
  assert.equal(manifest.schema, 'archie-maker-vision/v1');
  assert.equal(manifest.sideways_boundary.is_ai_product, false);
  assert.equal(manifest.sideways_boundary.is_archie_memory, false);
  assert.equal(manifest.sideways_boundary.is_maker_subsystem, false);
  assert.equal(manifest.sideways_boundary.is_reference_application, true);
  assert.equal(manifest.sideways_boundary.receives_privileged_self_modification_path, false);
  assert.equal(manifest.sideways_boundary.uses_normal_maker_permissions, true);
  assert.match(vision, /Sideways is an independent application/);
  assert.match(vision, /reference customer and proving ground/);
});

test('shared intelligence changes by evaluated release rather than ambient usership', () => {
  assert.equal(manifest.release_model.ship_genius, true);
  assert.equal(manifest.release_model.ambient_shared_model_learning, false);
  assert.equal(manifest.release_model.ordinary_use_updates_shared_weights, false);
  assert.equal(manifest.release_model.private_history_is_training_exhaust, false);
  assert.equal(manifest.release_model.shared_capability_changes_only_by_signed_release, true);
  assert.equal(manifest.release_model.candidate_requires_independent_evaluation, true);
  assert.equal(manifest.release_model.intelligence_and_embodiment_admit_together, true);
  assert.equal(manifest.release_model.maximal_first_release, true);
  assert.match(vision, /Archie should be excellent when installed/);
  assert.match(vision, /not silent improvement from user activity/);
});

test('canonical product form comes from a complete Pareto frontier rather than fixed modalities', async () => {
  assert.equal(manifest.product_form.canonical_interface, null);
  assert.equal(manifest.product_form.chat_window_is_architecture, false);
  assert.equal(manifest.product_form.voice_is_architecture, false);
  assert.equal(manifest.product_form.screen_is_architecture, false);
  assert.equal(manifest.product_form.always_on_daemon_is_architecture, false);
  assert.equal(manifest.product_form.product_form_is_derived_from_human_outcomes, false);
  assert.equal(manifest.product_form.product_form_is_selected_from_complete_evidence_bound_profiles, true);
  assert.equal(manifest.product_form.incomparable_nondominated_profiles_ship_as_adaptive_frontier, true);
  assert.equal(manifest.product_form.dominated_default_is_launchable, false);
  assert.equal(manifest.product_form.incomplete_profile_search_is_launchable, false);
  assert.equal(manifest.product_form.v1_required_faculty_mapping_is_canonical, false);
  assert.equal(manifest.product_form.v1_machine_profile_resolver_may_be_backend, true);
  assert.equal(frontierTarget.schema, 'archie-launch-frontier-target/v2');
  assert.equal(frontierTarget.frontier_policy.canonical_interface, null);
  assert.equal(frontierTarget.frontier_policy.voice_is_architecture, false);
  assert.equal(frontierTarget.frontier_policy.always_on_is_architecture, false);
  assert.match(profiles, /Pareto frontier/);
  assert.match(profiles, /compatibility backend/);
  await fs.access(new URL('../archie-launch-frontier-v2.mjs', import.meta.url));
});

test('v1 fixed-faculty contracts remain available only as compatibility evidence', async () => {
  assert.equal(launchTarget.schema, 'archie-launch-target/v1');
  assert.equal(launchTarget.launch_policy.single_canonical_interface, false);
  assert.ok(manifest.product_form.compatibility_evaluators.includes('scripts/archie-launch-contract.mjs'));
  assert.ok(manifest.product_form.compatibility_evaluators.includes('scripts/archie-launch-profile-resolver.mjs'));
  assert.ok(manifest.product_form.compatibility_evaluators.includes('scripts/archie-launch-profile-admission.mjs'));
  await fs.access(new URL('../archie-launch-contract.mjs', import.meta.url));
  await fs.access(new URL('../archie-launch-profile-resolver.mjs', import.meta.url));
  await fs.access(new URL('../archie-launch-profile-admission.mjs', import.meta.url));
});

test('the impossible proof requires a delivered transferable application', () => {
  assert.equal(manifest.first_impossible_proof.requires_clean_environment_reproduction, true);
  assert.equal(manifest.first_impossible_proof.requires_clickable_installation, true);
  assert.equal(manifest.first_impossible_proof.requires_terminal_artifact_receipts, true);
  assert.equal(manifest.first_impossible_proof.sideways_may_be_one_sample, true);
  assert.equal(manifest.first_impossible_proof.requires_transfer_beyond_sideways, true);
  assert.ok(manifest.primary_outputs.includes('applications'));
  assert.ok(manifest.primary_outputs.includes('scientific-experiments'));
  assert.ok(manifest.primary_outputs.includes('civic-tools'));
});

test('Archie commands expose the canonical v2 frontier and preserve v1 compatibility paths', async () => {
  assert.equal(packageJson.scripts['archie:launch:frontier'], 'node scripts/archie-launch-assess.mjs frontier');
  assert.equal(packageJson.scripts['archie:launch:derive'], 'node scripts/archie-launch-assess.mjs derive');
  assert.equal(packageJson.scripts['archie:launch:evaluate'], 'node scripts/archie-launch-assess.mjs evaluate');
  assert.equal(packageJson.scripts['archie:launch:resolve'], 'node scripts/archie-launch-assess.mjs resolve');
  assert.equal(
    packageJson.scripts['archie:evaluate'],
    'node scripts/maker-archie-benchmark.mjs run --suite maker/evaluations/archie-equivalence-suite.json'
  );
  assert.doesNotMatch(packageJson.scripts['test:archie:evaluation'], /maker-archie-evaluation\.test\.mjs/);
  await fs.access(new URL('../maker-archie-benchmark.mjs', import.meta.url));
  await fs.access(new URL('../../maker/evaluations/archie-equivalence-suite.json', import.meta.url));
});
