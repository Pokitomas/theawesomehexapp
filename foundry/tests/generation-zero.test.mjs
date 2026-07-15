import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  generationZeroGenomes,
  generationZeroMission,
  generationZeroReports,
  lawfulCorpusPlan,
  runGenerationZero,
  runGenerationZeroProxies,
  validateGenerationZeroMission
} from '../generation-zero.mjs';

const revision = 'b'.repeat(40);

test('generation-zero mission rejects disguised architecture and parameter caps', () => {
  const mission = generationZeroMission();
  assert.doesNotThrow(() => validateGenerationZeroMission(mission));
  assert.throws(() => validateGenerationZeroMission({
    ...mission,
    budget: { ...mission.budget, max_parameters: 1_000_000_000 }
  }), /precommits model design/);
  assert.throws(() => validateGenerationZeroMission({
    ...mission,
    hardware: { ...mission.hardware, tokenizer: 'plaintext-bpe' }
  }), /precommits model design/);
});

test('ideation covers ten roles, preserves contradictions, and spans language plus physics', async () => {
  const result = await runGenerationZero({
    code_revision: revision,
    clock: (() => { let value = 100; return () => value += 5; })(),
    memory_usage: (() => { let value = 1_000_000; return () => value += 256; })()
  });
  assert.equal(result.assignments.length, 10);
  assert.equal(result.reports.length, 10);
  assert.equal(result.integration.roles_present.length, 10);
  assert.ok(result.integration.contradiction_graph.edges.length >= 3);
  assert.equal(result.integration.no_winner_selected, true);
  const tags = new Set(result.integration.candidates.flatMap(candidate => candidate.novelty_tags));
  assert.ok(tags.has('language'));
  assert.ok(tags.has('physics'));
  assert.deepEqual(new Set(result.portfolio.selected.map(item => item.distance)), new Set(['conservative', 'adjacent', 'heretical']));
});

test('candidate genomes serialize non-token representations, dynamics, learning, resources, and lineage', () => {
  const genomes = generationZeroGenomes(revision);
  assert.ok(genomes.length >= 6);
  assert.ok(new Set(genomes.map(genome => genome.representation.kind)).size >= 5);
  assert.ok(genomes.some(genome => genome.representation.plaintext_tokens === 'absent-from-core'));
  assert.ok(genomes.every(genome => genome.dynamics?.kind));
  assert.ok(genomes.every(genome => genome.learning?.objectives?.length));
  assert.ok(genomes.every(genome => genome.lineage?.source_roles?.length));
  assert.ok(genomes.every(genome => genome.inference?.budget));
  assert.ok(genomes.every(genome => genome.hardware?.selection === 'runtime-detected'));
  assert.ok(genomes.every(genome => genome.seeds.length >= 2));
});

test('proxy execution retains failures and never promotes a final model', async () => {
  const genomes = generationZeroGenomes(revision).slice(0, 4);
  const results = runGenerationZeroProxies({
    genomes,
    clock: (() => { let value = 0; return () => value += 10; })(),
    memory_usage: (() => { let value = 1024; return () => value += 64; })()
  });
  assert.equal(results.length, 4);
  assert.ok(results.every(result => result.per_seed.length === 2));
  assert.ok(results.every(result => result.resource_receipt.wall_time_ms === 10));
  assert.ok(results.every(result => result.resource_receipt.external_calls === 0));
  assert.ok(results.some(result => result.status.startsWith('falsified')));

  const full = await runGenerationZero({
    code_revision: revision,
    clock: (() => { let value = 0; return () => value += 10; })(),
    memory_usage: (() => { let value = 2048; return () => value += 64; })()
  });
  assert.equal(full.receipt.winner_selected, false);
  assert.equal(full.receipt.architecture_selected, false);
  assert.equal(full.receipt.final_model_weights_trained, false);
  assert.ok(full.admissions.every(admission => admission.admitted === false));
  assert.ok(full.negative_results.retained.length > 0);
  assert.ok(full.negative_results.admission_blocks.length === full.proxy_results.length);
});

test('corpus plan is internet-scale planning, not an acquisition or plaintext-only claim', () => {
  const plan = lawfulCorpusPlan();
  assert.equal(plan.state, 'planned-not-acquired');
  assert.equal(plan.whole_internet_claim, false);
  assert.equal(plan.training_status, 'not-started');
  assert.ok(plan.source_classes.some(source => source.id === 'physical-observations'));
  assert.ok(plan.source_classes.some(source => source.id === 'teacher-agent-traces'));
  assert.match(plan.representation_policy, /not the canonical substrate/);
  assert.equal(plan.controls.paywall_and_access_control_bypass, false);
});

test('generation-zero execution writes the complete artifact set', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-generation-zero-'));
  const result = await runGenerationZero({
    out_dir: out,
    code_revision: revision,
    clock: (() => { let value = 10; return () => value += 1; })(),
    memory_usage: () => 4096
  });
  const expected = ['mission.json', 'assignments.json', 'reports.json', 'integration.json', 'portfolio.json', 'genomes.json', 'proxy-results.json', 'negative-results.json', 'corpus-plan.json', 'receipt.json'];
  for (const filename of expected) await fs.access(path.join(out, filename));
  const receipt = JSON.parse(await fs.readFile(path.join(out, 'receipt.json'), 'utf8'));
  assert.equal(receipt.code_revision, revision);
  assert.equal(receipt.winner_selected, false);
  assert.equal(receipt.final_model_weights_trained, false);
  assert.equal(result.outputs['proxy-results.json'].length, result.proxy_results.length);
});

test('report fixture itself is complete and read-only', () => {
  const reports = generationZeroReports();
  assert.equal(reports.length, 10);
  assert.ok(reports.every(report => Array.isArray(report.proposals) && report.proposals.length > 0));
  assert.ok(reports.every(report => report.external_resources.length === 0));
  assert.ok(reports.every(report => /hypotheses/.test(report.uncertainty)));
});
