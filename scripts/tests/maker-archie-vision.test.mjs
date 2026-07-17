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

test('Founder and Foundry give biological humans powers instead of serving robot self-administration', () => {
  assert.equal(manifest.schema, 'archie-maker-vision/v2');
  assert.equal(manifest.human_power_contract.primary_operator, 'biological-human');
  assert.equal(manifest.human_power_contract.developer_expertise_required, false);
  assert.equal(manifest.human_power_contract.robot_self_administration_is_primary_use, false);
  assert.equal(manifest.human_power_contract.one_raw_utterance_may_start_a_whole_turn, true);
  assert.equal(manifest.human_power_contract.mirror_response_is_success, false);
  assert.equal(manifest.human_power_contract.ordinary_human_may_receive_development_power, true);
  assert.equal(manifest.research_model.training_dashboard_operator, 'biological-human');
  assert.equal(manifest.research_model.training_dashboard_is_for_robot_self_management, false);
  assert.match(vision, /Founder gives humans invention power/);
  assert.match(vision, /Foundry gives humans model-research power/);
});

test('research is maximally aggressive while shared capability changes remain evidence-governed', () => {
  assert.equal(manifest.research_model.maximally_aggressive_capability_research, true);
  assert.equal(manifest.research_model.speculative_research_is_encouraged, true);
  assert.equal(manifest.research_model.large_token_and_compute_subsidy_is_default_when_available, true);
  assert.equal(manifest.research_model.multiple_contradictory_candidates_remain_live_before_push, true);
  assert.equal(manifest.research_model.ordinary_product_use_is_a_training_dashboard, false);
  assert.equal(manifest.research_model.private_user_history_is_automatic_shared_training_exhaust, false);
  assert.equal(manifest.research_model.shared_capability_changes_only_by_evaluated_release, true);
  assert.equal(manifest.research_model.candidate_requires_independent_evaluation, true);
  assert.equal(manifest.research_model.intelligence_and_embodiment_admit_together, true);
  assert.match(vision, /Research should be aggressively speculative/);
  assert.match(vision, /generous token and compute subsidy/);
});

test('open probability survives until an authority-bound push', () => {
  assert.equal(manifest.probability_and_push.end_state_remains_stable, true);
  assert.equal(manifest.probability_and_push.interpretations_remain_open_before_consequence, true);
  assert.equal(manifest.probability_and_push.unfamiliar_capabilities_may_be_invented, true);
  assert.equal(manifest.probability_and_push.user_framing_may_be_rejected, true);
  assert.equal(manifest.probability_and_push.losing_branches_are_preserved, true);
  assert.ok(manifest.probability_and_push.collapse_boundaries.includes('publication'));
  assert.ok(manifest.probability_and_push.collapse_boundaries.includes('capability claim'));
  assert.deepEqual(
    manifest.probability_and_push.collapse_requires,
    ['authority', 'evidence', 'resource envelope', 'reversibility decision', 'verification plan']
  );
  assert.match(vision, /Fixed end state, open probability/);
});

test('canonical product form comes from a complete Pareto frontier rather than fixed modalities or GitHub', async () => {
  assert.equal(manifest.product_form.canonical_interface, null);
  assert.equal(manifest.product_form.chat_window_is_architecture, false);
  assert.equal(manifest.product_form.voice_is_architecture, false);
  assert.equal(manifest.product_form.screen_is_architecture, false);
  assert.equal(manifest.product_form.always_on_daemon_is_architecture, false);
  assert.equal(manifest.product_form.github_is_user_workflow, false);
  assert.equal(manifest.product_form.developer_dashboard_is_default_human_surface, false);
  assert.equal(manifest.product_form.product_form_is_selected_from_complete_evidence_bound_profiles, true);
  assert.equal(manifest.product_form.incomparable_nondominated_profiles_ship_as_adaptive_frontier, true);
  assert.equal(manifest.product_form.dominated_default_is_launchable, false);
  assert.equal(frontierTarget.schema, 'archie-launch-frontier-target/v2');
  assert.equal(frontierTarget.frontier_policy.canonical_interface, null);
  assert.equal(frontierTarget.frontier_policy.voice_is_architecture, false);
  assert.equal(frontierTarget.frontier_policy.always_on_is_architecture, false);
  assert.match(profiles, /Pareto frontier/);
  await fs.access(new URL('../archie-launch-frontier-v2.mjs', import.meta.url));
});

test('v1 fixed-faculty contracts remain available only as compatibility evidence', async () => {
  assert.equal(launchTarget.schema, 'archie-launch-target/v1');
  assert.equal(launchTarget.launch_policy.single_canonical_interface, false);
  await fs.access(new URL('../archie-launch-contract.mjs', import.meta.url));
  await fs.access(new URL('../archie-launch-profile-resolver.mjs', import.meta.url));
  await fs.access(new URL('../archie-launch-profile-admission.mjs', import.meta.url));
});

test('the impossible proof gives a non-developer a transferable delivered product', () => {
  assert.equal(manifest.first_impossible_proof.requires_clean_environment_reproduction, true);
  assert.equal(manifest.first_impossible_proof.requires_clickable_installation, true);
  assert.equal(manifest.first_impossible_proof.requires_terminal_artifact_receipts, true);
  assert.equal(manifest.first_impossible_proof.requires_unfamiliar_domain_transfer, true);
  assert.equal(manifest.first_impossible_proof.requires_no_manual_git_or_ticket_workflow, true);
  assert.ok(manifest.primary_outputs.includes('applications'));
  assert.ok(manifest.primary_outputs.includes('websites'));
  assert.ok(manifest.primary_outputs.includes('scientific-experiments'));
  assert.ok(manifest.forbidden_conflations.includes('example-program-is-system-memory'));
  assert.ok(manifest.forbidden_conflations.includes('human-interface-is-robot-dev-console'));
});

test('Archie commands expose the canonical v2 frontier', async () => {
  assert.equal(packageJson.scripts['archie:launch:frontier'], 'node scripts/archie-launch-assess.mjs frontier');
  assert.equal(packageJson.scripts['archie:launch:derive'], 'node scripts/archie-launch-assess.mjs derive');
  assert.equal(packageJson.scripts['archie:launch:evaluate'], 'node scripts/archie-launch-assess.mjs evaluate');
  assert.equal(packageJson.scripts['archie:launch:resolve'], 'node scripts/archie-launch-assess.mjs resolve');
  assert.equal(
    packageJson.scripts['archie:evaluate'],
    'node scripts/maker-archie-benchmark.mjs run --suite maker/evaluations/archie-equivalence-suite.json'
  );
  await fs.access(new URL('../maker-archie-benchmark.mjs', import.meta.url));
  await fs.access(new URL('../../maker/evaluations/archie-equivalence-suite.json', import.meta.url));
});
