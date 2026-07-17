import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FOUNDRY_VERSION,
  buildCampaign,
  deriveCandidates,
  normalizeCampaign,
  stableManifest
} from '../../foundry/foundry.js';

const html = fs.readFileSync('foundry/index.html', 'utf8');
const css = fs.readFileSync('foundry/foundry.css', 'utf8');
const js = fs.readFileSync('foundry/foundry.js', 'utf8');

for (const id of [
  'research-objective',
  'subsidy',
  'candidate-count',
  'candidate-output',
  'open-field',
  'candidate-field',
  'push-campaign',
  'download-manifest',
  'reset-foundry',
  'manifest-preview',
  'status'
]) assert.ok(html.includes(`id="${id}"`), `missing Foundry control ${id}`);

assert.ok(html.includes('You are the lab now.'));
assert.ok(html.includes('A human governs the frontier.'));
assert.ok(html.includes('it does not claim a training run occurred'));
assert.match(css, /HUMAN ONLY/);
assert.match(css, /@media\s*\(max-width:\s*560px\)/);
assert.doesNotMatch(js, /fetch\s*\(/);

const candidates = deriveCandidates('invent a public-evidence investigation faculty', 24);
assert.equal(candidates.length, 24);
assert.equal(new Set(candidates.map(candidate => candidate.id)).size, 24);
assert.ok(candidates.some(candidate => candidate.lens === 'maximal'));
assert.ok(candidates.every(candidate => candidate.proposition.includes('not required to preserve its framing')));

const campaign = buildCampaign({
  objective: '  invent a public-evidence investigation faculty  ',
  subsidy: 'maximum',
  candidate_count: 32,
  lanes: ['models', 'tools', 'embodiment', 'evaluation', 'alien']
});
assert.equal(campaign.schema, FOUNDRY_VERSION);
assert.equal(campaign.objective, 'invent a public-evidence investigation faculty');
assert.equal(campaign.subsidy, 'maximum');
assert.equal(campaign.candidate_count, 32);
assert.equal(campaign.candidates.length, 32);
assert.equal(campaign.human_operator_required, true);
assert.equal(campaign.ordinary_use_is_training_data, false);
assert.equal(campaign.promotion_state, 'blocked-pending-independent-evidence');

const normalized = normalizeCampaign({
  ...campaign,
  subsidy: 'impossible',
  candidate_count: 1000,
  lanes: ['models', 'invalid']
});
assert.equal(normalized.subsidy, 'massive');
assert.equal(normalized.candidate_count, 64);
assert.deepEqual(normalized.lanes, ['models']);
assert.equal(normalized.candidates.length, 32);

const manifest = stableManifest(campaign);
assert.equal(manifest, stableManifest(JSON.parse(manifest)));
assert.ok(manifest.endsWith('\n'));
assert.ok(manifest.includes('"human_operator_required": true'));
assert.ok(manifest.includes('"ordinary_use_is_training_data": false'));
assert.ok(manifest.includes('"promotion_state": "blocked-pending-independent-evidence"'));

console.log('Foundry contract ok: humans govern aggressively subsidized speculative research and no manifest implies training or promotion occurred');
