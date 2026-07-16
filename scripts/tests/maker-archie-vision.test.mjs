import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../../founder/archie-maker-vision.json', import.meta.url);
const launchTargetUrl = new URL('../../founder/archie-launch-target.json', import.meta.url);
const visionUrl = new URL('../../ARCHIE_MAKER_VISION.md', import.meta.url);
const packageUrl = new URL('../../package.json', import.meta.url);

const manifest = JSON.parse(await fs.readFile(manifestUrl, 'utf8'));
const launchTarget = JSON.parse(await fs.readFile(launchTargetUrl, 'utf8'));
const vision = await fs.readFile(visionUrl, 'utf8');
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

test('product form is derived from ambition rather than frozen as chat, voice, or one daemon', async () => {
  assert.equal(manifest.product_form.canonical_interface, null);
  assert.equal(manifest.product_form.chat_window_is_architecture, false);
  assert.equal(manifest.product_form.voice_is_architecture, false);
  assert.equal(manifest.product_form.always_on_daemon_is_architecture, false);
  assert.equal(manifest.product_form.product_form_is_derived_from_human_outcomes, true);
  assert.equal(manifest.product_form.strongest_admitted_surfaces_ship_together, true);
  assert.equal(manifest.product_form.shell_without_brain_is_launchable, false);
  assert.equal(manifest.product_form.brain_without_required_access_is_launchable, false);
  assert.match(vision, /The product must not be designed backward from a familiar interface/);
  assert.match(vision, /Intelligence and embodiment must pass one joint admission contract/);
  await fs.access(new URL('../archie-launch-contract.mjs', import.meta.url));
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

test('the launch target requires both admitted intelligence and usable embodiment', () => {
  assert.equal(launchTarget.schema, 'archie-launch-target/v1');
  assert.match(launchTarget.claim_boundary, /not a claim that the current runtime satisfies it/);
  assert.equal(launchTarget.launch_policy.joint_intelligence_and_embodiment_admission, true);
  assert.equal(launchTarget.launch_policy.single_canonical_interface, false);
  assert.equal(launchTarget.launch_policy.chat_window_is_architecture, false);
  assert.equal(launchTarget.launch_policy.voice_is_architecture, false);
  assert.equal(launchTarget.launch_policy.always_on_daemon_is_architecture, false);
  assert.equal(launchTarget.launch_policy.shell_without_brain_may_launch, false);
  assert.equal(launchTarget.launch_policy.brain_without_required_access_may_launch, false);
  assert.equal(launchTarget.launch_policy.all_critical_outcomes_required, true);
  assert.equal(launchTarget.launch_policy.maximal_first_release, true);
  assert.ok(launchTarget.intelligence_target.minimum_metrics.false_completion_rate_max <= 0.01);
  assert.ok(launchTarget.intelligence_target.minimum_metrics.terminal_evidence_rate >= 0.95);
  assert.ok(launchTarget.human_outcomes.every(outcome => outcome.critical === true));
});

test('Archie evaluation commands point at admitted executable surfaces', async () => {
  assert.equal(
    packageJson.scripts['archie:evaluate'],
    'node scripts/maker-archie-benchmark.mjs run --suite maker/evaluations/archie-equivalence-suite.json'
  );
  assert.doesNotMatch(packageJson.scripts['test:archie:evaluation'], /maker-archie-evaluation\.test\.mjs/);
  await fs.access(new URL('../maker-archie-benchmark.mjs', import.meta.url));
  await fs.access(new URL('../../maker/evaluations/archie-equivalence-suite.json', import.meta.url));
});
