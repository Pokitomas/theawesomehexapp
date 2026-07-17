import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCapturePlan } from '../frontier-surface-capture.mjs';
import {
  assembleFrontierRound,
  buildCandidateScenario,
  createArchieSurfaceProgram,
  redirectFrontierCandidate
} from '../frontier-surface-assembly.mjs';
import { deriveRound, readConstitution } from '../frontier-world-expo.mjs';
import { verifyFrontierSurfaceAssembly } from '../verify-frontier-surface-assembly.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'a'.repeat(40);
const read = file => fs.readFile(path.join(REPOSITORY_ROOT, file), 'utf8');

async function roundFixture(seed = 477) {
  const constitution = await readConstitution(path.join(REPOSITORY_ROOT, 'design/frontier-world-expo.json'));
  const round = deriveRound(constitution, { seed, round_id: `issue-${seed}` });
  return { constitution, round };
}

async function assemblyFixture(t, seed = 477) {
  const { constitution, round } = await roundFixture(seed);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-surface-root-'));
  const states = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-surface-state-'));
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  for (const name of ['verify-frontier-surface-candidate.mjs', 'verify-frontier-surface-assembly.mjs']) {
    await fs.copyFile(path.join(REPOSITORY_ROOT, 'scripts', name), path.join(root, 'scripts', name));
  }
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(states, { recursive: true, force: true })
  ]));
  const result = await assembleFrontierRound({
    root,
    repository: 'Pokitomas/theawesomehexapp',
    base_sha: BASE,
    branch_prefix: 'agent/test-frontier-surface',
    round,
    constitution,
    output_prefix: `experiments/frontier-world-expo/${round.round_id}`,
    state_directory: states,
    clock: (() => { let tick = 0; return () => `2026-07-17T07:00:${String(tick++).padStart(2, '0')}.000Z`; })()
  });
  return { root, states, constitution, round, result };
}

test('six candidate roles compile into genuinely distinct runnable offline forms', async () => {
  const { round } = await roundFixture();
  const scenarios = round.candidates.map(candidate => buildCandidateScenario(candidate, {
    round_id: round.round_id,
    round_digest: round.round_digest,
    base_sha: BASE,
    output_prefix: `experiments/frontier-world-expo/${round.round_id}`
  }));
  assert.equal(scenarios.length, 6);
  assert.equal(new Set(scenarios.map(item => item.visual_grammar_id)).size, 6);
  assert.equal(new Set(scenarios.map(item => item.target_prefix)).size, 6);
  assert.equal(new Set(scenarios.map(item => item.expected_artifact_digest)).size, 6);
  for (const scenario of scenarios) {
    assert.equal(scenario.authority.archie_direct_write, false);
    assert.equal(scenario.authority.maker_only_repository_writer, true);
    assert.equal(scenario.offline_contract.external_network_required, false);
    assert.ok(scenario.automation_share >= 0.5);
    assert.ok(scenario.runtime_files.includes('index.html'));
    assert.match(scenario.files['index.html'], new RegExp(`data-frontier-candidate="${scenario.candidate_id}"`));
    assert.doesNotMatch(scenario.files['index.html'], /https?:\/\//i);
    assert.doesNotMatch(Object.values(scenario.files).join('\n'), /shared-components|design-system\.css/i);
  }
  const pocket = scenarios.find(item => item.role === 'low-resource-offline');
  assert.deepEqual(pocket.runtime_files, ['index.html']);
  assert.match(pocket.files['index.html'], /data-offline-single-file="true"/);
});

test('Archie emits exact plans but every repository mutation remains a Maker capability', async () => {
  const { round } = await roundFixture(478);
  for (const candidate of round.candidates) {
    const scenario = buildCandidateScenario(candidate, {
      round_id: round.round_id,
      round_digest: round.round_digest,
      base_sha: BASE,
      output_prefix: `experiments/frontier-world-expo/${round.round_id}`
    });
    const plan = createArchieSurfaceProgram(scenario);
    const archie = plan.world.find(item => item.kind === 'actor' && item.id === 'archie');
    const maker = plan.world.find(item => item.kind === 'actor' && item.id === 'maker');
    const grant = plan.world.find(item => item.kind === 'grant' && item.id === 'candidatelease');
    assert.equal(archie.write_authority, false);
    assert.equal(maker.write_authority, true);
    assert.equal(grant.scope, `${scenario.target_prefix}/**`);
    assert.equal(plan.schedule.filter(item => item.kind === 'step').length, scenario.runtime_files.length + 1);
    assert.equal(plan.schedule.at(-1).id, 'stopbeforepublish');
    assert.match(plan.semantic_digest, /^[0-9a-f]{64}$/);
    assert.match(plan.schedule_digest, /^[0-9a-f]{64}$/);
  }
});

test('Maker assembles six isolated executable workspaces and an exact comparison packet', async t => {
  const { root, result } = await assemblyFixture(t);
  const assembly = result.assembly;
  assert.equal(assembly.candidates.length, 6);
  assert.equal(assembly.maker_only_repository_writer, true);
  assert.ok(assembly.measured_automation_share >= 0.5);
  assert.equal(new Set(assembly.candidates.map(item => item.visual_grammar_id)).size, 6);
  assert.equal(new Set(assembly.candidates.map(item => item.target_prefix)).size, 6);
  assert.equal(result.candidate_receipt_digests.length, 6);
  assert.match(result.index_receipt_digest, /^[0-9a-f]{64}$/);
  for (const candidate of assembly.candidates) {
    await fs.access(path.join(root, candidate.target_prefix, 'index.html'));
    await fs.access(path.join(root, candidate.target_prefix, 'candidate.json'));
    assert.equal(candidate.evidence_state, 'fixture-only');
    assert.equal(candidate.promotion_state, 'blocked-on-empirical-evidence');
  }
  const verified = await verifyFrontierSurfaceAssembly({
    repository_root: root,
    assembly_path: `${assembly.output_prefix}/assembly.json`,
    comparison_path: `${assembly.output_prefix}/comparison-packet.json`
  });
  assert.equal(verified.candidates, 6);
  assert.equal(verified.distinct_visual_grammars, 6);
  assert.equal(verified.isolated_workspaces, 6);
});

test('a live redirect creates a child branch without overwriting the parent candidate', async t => {
  const { root, states, result } = await assemblyFixture(t, 479);
  const parent = result.assembly.candidates.find(item => item.role === 'maximal-expressive-variance');
  const parentIndex = await fs.readFile(path.join(root, parent.target_prefix, 'index.html'), 'utf8');
  const redirected = await redirectFrontierCandidate({
    root,
    repository: 'Pokitomas/theawesomehexapp',
    base_sha: BASE,
    assembly: result.assembly,
    candidate_id: parent.candidate_id,
    directive: 'Turn the weather into a quiet archive of unfinished letters without removing local seasons.',
    branch: 'agent/test-redirect',
    state_directory: path.join(states, 'redirect')
  });
  assert.equal(redirected.receipt.parent_candidate_id, parent.candidate_id);
  assert.equal(redirected.receipt.prior_branch_preserved, true);
  assert.notEqual(redirected.receipt.parent_artifact_digest, redirected.receipt.redirected_artifact_digest);
  assert.equal(await fs.readFile(path.join(root, parent.target_prefix, 'index.html'), 'utf8'), parentIndex);
  const childIndex = await fs.readFile(path.join(root, redirected.scenario.target_prefix, 'index.html'), 'utf8');
  assert.match(childIndex, /quiet archive of unfinished letters/i);
  assert.equal(redirected.scenario.parent_candidate_id, parent.candidate_id);
});

test('capture planning covers desktop and phone interactions without claiming real-device proof', async () => {
  const { round } = await roundFixture(480);
  const candidates = round.candidates.map(candidate => {
    const scenario = buildCandidateScenario(candidate, {
      round_id: round.round_id,
      round_digest: round.round_digest,
      base_sha: BASE,
      output_prefix: `experiments/frontier-world-expo/${round.round_id}`
    });
    return {
      candidate_id: scenario.candidate_id,
      role: scenario.role,
      target_prefix: scenario.target_prefix,
      visual_grammar_id: scenario.visual_grammar_id,
      interaction: scenario.interaction
    };
  });
  const plan = buildCapturePlan({ schema: 'frontier-surface-assembly/v1', assembly_digest: 'b'.repeat(64), candidates });
  assert.equal(plan.entries.length, 12);
  assert.equal(new Set(plan.entries.map(item => item.viewport.id)).size, 2);
  assert.equal(plan.real_device_claim, false);
  assert.equal(plan.evidence_class, 'headless-browser-fixture');
  const captureSource = await read('scripts/frontier-surface-capture.mjs');
  assert.match(captureSource, /page\.screenshot/);
  assert.match(captureSource, /phone-390x844/);
  assert.match(captureSource, /route\(url => url\.origin !== origin/);
  assert.match(captureSource, /cannot satisfy physical-device/i);
});
