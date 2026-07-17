import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  deriveRound,
  materializeRound,
  readConstitution,
  status,
  validateConstitution
} from '../frontier-world-expo.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const read = file => fs.readFile(path.join(root, file), 'utf8');

test('constitution keeps ontology open and automation above the requested floor', async () => {
  const constitution = await readConstitution(path.join(root, 'design/frontier-world-expo.json'));
  assert.equal(validateConstitution(constitution), constitution);
  assert.equal(constitution.ontology_policy.fixed_surface_category, null);
  assert.equal(constitution.ontology_policy.categories_are_candidates, true);
  assert.match(constitution.ontology_policy.anti_dogma, /may be violated/i);
  assert.ok(constitution.automation.minimum_execution_share >= 0.5);
  assert.ok(constitution.automation.automated_functions.length >= 10);
  assert.ok(constitution.automation.human_only_boundaries.includes('public-publication'));
  assert.equal(constitution.round_contract.aggregate_score_forbidden, true);
});

test('frontier commissions cover visual, sound, speech, music, and persistent worlds with hidden trials', async () => {
  const constitution = await readConstitution(path.join(root, 'design/frontier-world-expo.json'));
  const modalities = new Set(constitution.commissions.flatMap(commission => commission.modalities));
  for (const modality of ['image', 'speech', 'audio', 'music', 'world']) assert.ok(modalities.has(modality));
  assert.ok(constitution.commissions.length >= 12);
  for (const commission of constitution.commissions) {
    assert.ok(commission.brief.length >= 80);
    assert.ok(commission.hidden_tests.length >= 3);
    assert.ok(commission.metrics.length >= 4);
  }
  for (const required of ['raw_trace_digest', 'human_preference_receipt', 'portable_export_digest']) {
    assert.ok(constitution.evidence_envelope.required.includes(required));
  }
});

test('each deterministic round derives six contradictory unmeasured embodiments', async () => {
  const constitution = await readConstitution(path.join(root, 'design/frontier-world-expo.json'));
  const first = deriveRound(constitution, { seed: 466, round_id: 'issue-466' });
  const repeated = deriveRound(constitution, { seed: 466, round_id: 'issue-466' });
  assert.deepEqual(first, repeated);
  assert.equal(first.candidates.length, 6);
  assert.equal(new Set(first.candidates.map(candidate => candidate.role)).size, 6);
  assert.equal(new Set(first.candidates.map(candidate => candidate.described_as)).size, 6);
  assert.ok(first.mean_automation_share >= 0.5);
  assert.equal(first.aggregate_score_forbidden, true);
  for (const candidate of first.candidates) {
    assert.equal(candidate.fixed_surface_category, null);
    assert.equal(candidate.evidence_state, 'unmeasured');
    assert.equal(candidate.promotion_state, 'ineligible');
    assert.ok(candidate.automation_share >= 0.5);
    assert.ok(candidate.commission_ids.length >= 4);
  }
});

test('materialization fails closed with explicit evidence placeholders and status', async () => {
  const constitution = await readConstitution(path.join(root, 'design/frontier-world-expo.json'));
  const round = deriveRound(constitution, { seed: 9, round_id: 'materialized-proof' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-expo-'));
  const result = await materializeRound({ constitution, round, output_directory: directory });
  assert.equal(result.candidates, 6);
  assert.equal(result.evidence_placeholders, 6);
  const report = await status(directory);
  assert.equal(report.complete_evidence_envelopes, 0);
  assert.equal(report.missing_evidence_envelopes, 6);
  assert.equal(report.promotion_state, 'blocked-on-evidence');
  assert.equal(report.aggregate_score_forbidden, true);
});

test('the live Expo is commission-shaped, portable, responsive, and not a service-tab gallery', async () => {
  const [html, css, client] = await Promise.all([
    read('world-expo/index.html'),
    read('world-expo/expo.css'),
    read('world-expo/expo.js')
  ]);
  for (const phrase of ['NO SACRED INTERFACE', 'Enter through a commission', 'Six contradictory embodiments', 'Nothing is promoted']) {
    assert.match(html, new RegExp(phrase, 'i'));
  }
  assert.doesNotMatch(html, />\s*Image Generator\s*</i);
  assert.doesNotMatch(html, />\s*Audio API\s*</i);
  assert.doesNotMatch(html, />\s*Model Playground\s*</i);
  assert.match(client, /frontier-world-expo-route\/v1/);
  assert.match(html, /Carry this route away/i);
  assert.match(client, /link\.download = `frontier-world-expo-route-/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /focus-visible/);
  assert.match(css, /min-height: 48px/);
});
