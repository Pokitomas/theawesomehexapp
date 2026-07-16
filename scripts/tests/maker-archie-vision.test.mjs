import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../../founder/archie-maker-vision.json', import.meta.url);
const visionUrl = new URL('../../ARCHIE_MAKER_VISION.md', import.meta.url);

const manifest = JSON.parse(await fs.readFile(manifestUrl, 'utf8'));
const vision = await fs.readFile(visionUrl, 'utf8');

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
  assert.match(vision, /Archie should be excellent when installed/);
  assert.match(vision, /not silent improvement from user activity/);
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
