import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import {
  GENOME_MANIFEST_SCHEMA, PEER_LEASES_SCHEMA, assertNoSecrets, buildLassoReceipt,
  clean, normalizeLeasePath, pathsOverlap, resolveAllAssignmentTasks, resolveAssignmentTask,
  validateAssignments, validateGenomeManifest, validatePeerLeases, validatePortfolio
} from '../foundry-agent-spawner.mjs';

const execFileAsync = promisify(execFile);
const BASE = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const experiment = (overrides = {}) => ({
  experiment_id: 'experiment:001:novel-memory', candidate_id: 'novel-memory', distance: 'heretical',
  mechanism: 'stateful local learning mechanism', falsifier: 'Fails the matched hidden comparison.',
  hidden_evaluation: 'Contamination-resistant hidden split.', matched_compute_baseline: 'Same data, time, FLOPs, and seeds.',
  reproduction_seeds: 2, expected_information_gain: 0.8, estimated_cost: 3, state: 'leased-not-executed', ...overrides
});
const portfolio = (overrides = {}) => ({ schema: 'sideways-model-foundry/v1', selection_policy: 'expected-information-gain-per-cost-with-diversity-strata', budget: 12, spent: 3, selected: [experiment()], deferred: [], rejected: [], ...overrides });
const genomes = () => ({ schema: GENOME_MANIFEST_SCHEMA, base_sha: BASE, genomes: { 'novel-memory': { path: 'foundry/genomes/novel-memory.json', genome_digest: DIGEST, validation_receipt_digest: 'c'.repeat(64), validation_command: 'node foundry/cli.mjs validate-genome foundry/genomes/novel-memory.json', code_revision: BASE, seeds: [7, 11], validated: true } } });
const peers = (open_leases = []) => ({ schema: PEER_LEASES_SCHEMA, base_sha: BASE, open_leases });
const assignments = () => [{ schema: 'sideways-model-foundry/v1', assignment_id: 'mission:assessment:01:frontier-cartographer', mission_id: 'mission', phase: 'parallel-read-only-assessment', role: 'frontier-cartographer', read_only: true, scope: 'map assumptions', objective: 'find experiments', constraints: {}, output_contract: {} }, { schema: 'sideways-model-foundry/v1', assignment_id: 'mission:assessment:02:benchmark-saboteur', mission_id: 'mission', phase: 'parallel-read-only-assessment', role: 'benchmark-saboteur', read_only: true, scope: 'attack metrics', objective: 'find false wins', constraints: {}, output_contract: {} }];

describe('input and path gates', () => {
  it('cleans and bounds text', () => assert.equal(clean(' a\0bc ', 2), 'ab'));
  it('rejects nested secret fields', () => assert.throws(() => assertNoSecrets({ meta: { api_key: 'x' } }), /Secret-bearing/));
  it('rejects traversal and ambiguous wildcards', () => {
    assert.throws(() => normalizeLeasePath('../main'), /Traversing/);
    assert.throws(() => normalizeLeasePath('src/*/x'), /terminal/);
  });
  it('detects parent overlap but not siblings', () => {
    assert.equal(pathsOverlap(['foundry/**'], ['foundry/experiments/x']), true);
    assert.equal(pathsOverlap(['src/a'], ['src/b']), false);
  });
});

describe('canonical assignment routing', () => {
  it('consumes supplied role IDs instead of a copied registry', () => assert.equal(validateAssignments(assignments()).length, 2));
  it('resolves one or every canonical assignment read-only', () => {
    assert.equal(resolveAssignmentTask('[maker:foundry:benchmark-saboteur]', assignments()).authority.repository_mutation, false);
    assert.equal(resolveAllAssignmentTasks(assignments()).count, 2);
  });
  it('rejects invented and writable roles', () => {
    assert.throws(() => resolveAssignmentTask('heretic', assignments()), /Unknown/);
    const value = assignments(); value[0].read_only = false;
    assert.throws(() => validateAssignments(value), /read-only/);
  });
});

describe('scientific and lease gates', () => {
  it('accepts canonical portfolio/genome/empty-open-lease shapes', () => {
    assert.equal(validatePortfolio(portfolio()).selected.length, 1);
    assert.equal(validateGenomeManifest(genomes(), BASE).genomes['novel-memory'].validated, true);
    assert.equal(validatePeerLeases(peers(), BASE).open_leases.length, 0);
  });
  it('rejects missing evaluation, unbounded spend, and stale genomes', () => {
    assert.throws(() => validatePortfolio(portfolio({ selected: [experiment({ hidden_evaluation: '' })] })), /hidden_evaluation/);
    assert.throws(() => validatePortfolio(portfolio({ budget: Infinity })), /finite and positive/);
    assert.throws(() => validateGenomeManifest(genomes(), 'd'.repeat(40)), /does not match/);
  });
});

describe('deterministic lasso receipt', () => {
  const input = () => ({ portfolioInput: portfolio(), genomeManifestInput: genomes(), peerLeasesInput: peers(), baseSha: BASE, perPacketBudget: 4 });
  it('is byte-identical and timestamp-free', () => {
    assert.equal(JSON.stringify(buildLassoReceipt(input())), JSON.stringify(buildLassoReceipt(input())));
    assert.doesNotMatch(JSON.stringify(buildLassoReceipt(input())), /timestamp|created_at/);
  });
  it('binds exact base, genome, branch, paths, tests, budget, rollback, and human authority', () => {
    const packet = buildLassoReceipt(input()).packets[0];
    assert.equal(packet.exact_base_sha, BASE);
    assert.equal(packet.genome.validated, true);
    assert.match(packet.proposed_branch, /^maker\/foundry-/);
    assert.deepEqual(packet.owned_paths, ['foundry/experiments/novel-memory/**', 'foundry/tests/novel-memory.test.mjs']);
    assert.equal(packet.authority.merge, 'human');
    assert.equal(packet.authority.training_spend, false);
    assert.ok(packet.rollback && packet.focused_tests.length && packet.required_outputs.length);
  });
  it('fails closed on missing genome, peer collision, and remaining-budget overflow', () => {
    const missing = buildLassoReceipt({ ...input(), portfolioInput: portfolio({ selected: [experiment({ candidate_id: 'missing' })] }) });
    assert.equal(missing.ok, false); assert.equal(missing.packets.length, 0);
    const collision = buildLassoReceipt({ ...input(), peerLeasesInput: peers([{ pr_number: 252, state: 'open', base_sha: BASE, head_sha: 'd'.repeat(40), branch: 'agent/foundry', owned_paths: ['foundry/**'] }]) });
    assert.equal(collision.ok, false); assert.equal(collision.peer_collisions[0].pr_number, 252);
    assert.equal(buildLassoReceipt({ ...input(), portfolioInput: portfolio({ spent: 11 }) }).budget_exceeded, true);
  });
});

describe('CLI mutation boundary', () => {
  it('emits to stdout and creates no receipt file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'foundry-lasso-'));
    try {
      const p = path.join(dir, 'portfolio.json'), g = path.join(dir, 'genomes.json'), l = path.join(dir, 'peers.json');
      await Promise.all([writeFile(p, JSON.stringify(portfolio())), writeFile(g, JSON.stringify(genomes())), writeFile(l, JSON.stringify(peers()))]);
      const { stdout } = await execFileAsync(process.execPath, [path.resolve('scripts/foundry-agent-cli.mjs'), 'lasso', '--portfolio', p, '--genomes', g, '--peer-leases', l, '--base-sha', BASE]);
      assert.equal(JSON.parse(stdout).ok, true);
      await assert.rejects(() => access(path.join(dir, 'receipt.json')));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
