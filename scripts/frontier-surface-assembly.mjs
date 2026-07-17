#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { MakerEngine } from './maker-engine.mjs';
import { canonicalJSON, digest, readConstitution } from './frontier-world-expo.mjs';
import { clean, exactSha, identifier, relativePrefix } from './frontier-surface-core.mjs';
import { ROLE_ORDER } from './frontier-surface-kits.mjs';
import {
  FRONTIER_SURFACE_ASSEMBLY_SCHEMA,
  FRONTIER_SURFACE_REDIRECT_SCHEMA,
  buildCandidateScenario,
  createArchieSurfaceProgram,
  runSurfaceScenario,
  validateFrontierRound,
  writeExternalReceipt
} from './frontier-surface-runtime.mjs';

export { buildCandidateScenario, createArchieSurfaceProgram, validateFrontierRound } from './frontier-surface-runtime.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONSTITUTION = path.resolve(MODULE_DIR, '../design/frontier-world-expo.json');
const VERIFY_ASSEMBLY_SCRIPT = 'scripts/verify-frontier-surface-assembly.mjs';

async function writeAssemblyIndex({ root, repository, base_sha, branch, output_prefix, state_path, assembly, comparison, active_leases, clock }) {
  const owned = [`${output_prefix}/assembly.json`, `${output_prefix}/comparison-packet.json`];
  const verifierArgs = [VERIFY_ASSEMBLY_SCRIPT, '--assembly', `${output_prefix}/assembly.json`, '--comparison', `${output_prefix}/comparison-packet.json`];
  const engine = await MakerEngine.create({
    root,
    state_path,
    task: {
      repository,
      base_sha,
      branch,
      request: `Write exact frontier assembly index for ${assembly.round_id}.`,
      protect: 'Index only; candidate artifacts remain immutable and merge, deploy, publication, and promotion remain human.',
      proof: 'Exact candidate receipts, plan digests, lineage, capture state, and comparison packet.'
    },
    lease: { base_sha, branch, writer_count: 1, owned_paths: owned, authority: { merge: 'human', deploy: 'human' } },
    active_leases,
    command_policy: [{ program: 'node', args: verifierArgs }],
    clock
  });
  await engine.write(`${output_prefix}/assembly.json`, canonicalJSON(assembly));
  await engine.write(`${output_prefix}/comparison-packet.json`, canonicalJSON(comparison));
  await engine.checkpoint('frontier-assembly-index-written');
  const verification = await engine.verify([{ program: 'node', args: verifierArgs }]);
  if (!verification.ok) throw new Error('Frontier assembly index verification failed.');
  return engine.receipt();
}

export async function currentAssemblyCodeDigest() {
  const names = ['frontier-surface-assembly.mjs', 'frontier-surface-runtime.mjs', 'frontier-surface-core.mjs', 'frontier-surface-kits.mjs', 'frontier-surface-kits-a.mjs', 'frontier-surface-kits-b.mjs', 'verify-frontier-surface-candidate.mjs', 'verify-frontier-surface-assembly.mjs', 'frontier-surface-capture.mjs', 'frontier-world-expo.mjs', 'maker-engine.mjs'];
  const files = [];
  for (const name of names) {
    const bytes = await fs.readFile(path.join(MODULE_DIR, name));
    files.push({ name, bytes: bytes.length, sha256: digest(bytes) });
  }
  return digest({ schema: 'frontier-surface-assembly-code-binding/v1', files });
}

export async function assembleFrontierRound({
  root = process.cwd(), repository = 'Pokitomas/theawesomehexapp', base_sha, branch_prefix = 'agent/frontier-surface',
  round, constitution, output_prefix, state_directory, prior_assembly = null, clock
} = {}) {
  const base = exactSha(base_sha);
  const resolvedConstitution = constitution || await readConstitution(DEFAULT_CONSTITUTION);
  validateFrontierRound(round, resolvedConstitution);
  const output = relativePrefix(output_prefix || `experiments/frontier-world-expo/${identifier(round.round_id)}`);
  const states = path.resolve(state_directory || path.join(os.tmpdir(), 'frontier-surface-assembly', identifier(round.round_id)));
  const codeDigest = await currentAssemblyCodeDigest();
  const priorLosers = (prior_assembly?.candidates || []).filter(item => item.promotion_state !== 'promoted').map(item => item.candidate_id);
  const results = [];
  const activeLeases = [];
  for (const candidate of [...round.candidates].sort((left, right) => ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role))) {
    const enriched = candidate.role === 'loser-recombination' && priorLosers.length
      ? { ...candidate, described_as: `${candidate.described_as}; lineage from ${priorLosers.slice(0, 3).join(', ')}` }
      : candidate;
    const scenario = buildCandidateScenario(enriched, { round_id: round.round_id, round_digest: round.round_digest, base_sha: base, output_prefix: output });
    const branch = `${branch_prefix}/${identifier(round.round_id)}/${identifier(candidate.role)}`;
    const statePath = path.join(states, `${identifier(candidate.candidate_id)}.maker-state.json`);
    const result = await runSurfaceScenario({ root: path.resolve(root), repository, scenario, branch, state_path: statePath, active_leases: activeLeases, clock });
    activeLeases.push(result.lease);
    results.push(result);
  }
  const candidates = results.map(result => ({
    candidate_id: result.scenario.candidate_id,
    role: result.scenario.role,
    target_prefix: result.scenario.target_prefix,
    visual_grammar_id: result.scenario.visual_grammar_id,
    interaction: result.scenario.interaction,
    scenario_digest: result.scenario.scenario_digest,
    artifact_digest: result.scenario.expected_artifact_digest,
    archie_semantic_digest: result.plan.semantic_digest,
    archie_schedule_digest: result.plan.schedule_digest,
    maker_receipt_digest: result.maker_receipt.receipt_digest,
    trajectory_digest: result.trajectory.trajectory_digest,
    automation_share: result.scenario.automation_share,
    parent_candidate_id: result.scenario.parent_candidate_id,
    capture_state: 'awaiting-headless-capture',
    evidence_state: 'fixture-only',
    promotion_state: 'blocked-on-empirical-evidence'
  }));
  const body = {
    schema: FRONTIER_SURFACE_ASSEMBLY_SCHEMA,
    round_id: round.round_id,
    round_digest: round.round_digest,
    constitution_digest: round.constitution_digest,
    base_sha: base,
    code_digest: codeDigest,
    repository,
    output_prefix: output,
    automation_floor: resolvedConstitution.automation.minimum_execution_share,
    measured_automation_share: candidates.reduce((sum, item) => sum + item.automation_share, 0) / candidates.length,
    maker_only_repository_writer: true,
    candidates,
    retained_loser_ids: priorLosers,
    aggregate_score_forbidden: true,
    authority: { merge: 'human', deploy: 'human', publish: 'human', promote: 'human' },
    claim_boundary: 'Six runnable deterministic prototype fixtures assembled under isolated Maker leases; no real model, real-device, preference, or promotion claim.'
  };
  const assembly = { ...body, assembly_digest: digest(body) };
  const comparison = {
    schema: 'frontier-surface-comparison-packet/v1',
    assembly_digest: assembly.assembly_digest,
    round_id: round.round_id,
    comparison_axes: ['visual_grammar_id', 'violated_norm', 'interaction', 'offline_contract', 'automation_share', 'artifact_digest'],
    candidates: results.map(result => ({
      candidate_id: result.scenario.candidate_id,
      role: result.scenario.role,
      described_as: result.scenario.described_as,
      violated_norm: result.scenario.violated_norm,
      visual_grammar_id: result.scenario.visual_grammar_id,
      substrates: result.scenario.substrates,
      interaction: result.scenario.interaction,
      artifact_digest: result.scenario.expected_artifact_digest,
      capture: { state: 'awaiting-headless-capture', required_viewports: ['desktop-1280x900', 'phone-390x844'], real_device_claim: false }
    })),
    promotion_state: 'blocked-on-adapters-judges-and-real-device-evidence'
  };
  const indexReceipt = await writeAssemblyIndex({
    root: path.resolve(root), repository, base_sha: base, branch: `${branch_prefix}/${identifier(round.round_id)}/index`, output_prefix: output,
    state_path: path.join(states, 'assembly-index.maker-state.json'), assembly, comparison, active_leases: activeLeases, clock
  });
  return Object.freeze({
    schema: 'frontier-surface-assembly-result/v1',
    assembly,
    comparison,
    index_receipt_digest: indexReceipt.receipt_digest,
    candidate_receipt_digests: candidates.map(item => item.maker_receipt_digest),
    state_directory: states
  });
}

export async function redirectFrontierCandidate({
  root = process.cwd(), repository = 'Pokitomas/theawesomehexapp', base_sha, assembly, candidate_id, directive,
  branch = 'agent/frontier-surface-redirect', state_directory, clock
} = {}) {
  const base = exactSha(base_sha);
  if (assembly?.schema !== FRONTIER_SURFACE_ASSEMBLY_SCHEMA) throw new Error('Unsupported frontier surface assembly.');
  if (assembly.base_sha !== base) throw new Error('Redirect base SHA differs from assembly base.');
  const parent = assembly.candidates.find(item => item.candidate_id === candidate_id);
  if (!parent) throw new Error(`Unknown candidate for redirect: ${candidate_id}.`);
  const instruction = clean(directive, 2000);
  if (!instruction) throw new Error('Redirect requires a non-empty directive.');
  const candidateManifest = JSON.parse(await fs.readFile(path.resolve(root, parent.target_prefix, 'candidate.json'), 'utf8'));
  const branchId = `${identifier(parent.candidate_id)}-redirect-${digest(instruction).slice(0, 10)}`;
  const redirectedCandidate = {
    candidate_id: branchId,
    candidate_digest: digest({ parent: parent.candidate_id, directive: instruction, original: candidateManifest.candidate_digest }),
    role: parent.role,
    described_as: `${candidateManifest.described_as}; redirected: ${instruction}`,
    violated_norm: candidateManifest.violated_norm,
    substrates: candidateManifest.substrates,
    commission_ids: candidateManifest.commission_ids,
    automation_share: candidateManifest.automation_share
  };
  const redirectRoot = `${assembly.output_prefix}/redirects`;
  const scenario = buildCandidateScenario(redirectedCandidate, {
    round_id: assembly.round_id,
    round_digest: assembly.round_digest,
    base_sha: base,
    output_prefix: redirectRoot,
    redirect_directive: instruction,
    parent_candidate_id: parent.candidate_id
  });
  const states = path.resolve(state_directory || path.join(os.tmpdir(), 'frontier-surface-redirect', branchId));
  const result = await runSurfaceScenario({
    root: path.resolve(root), repository, scenario, branch: `${branch}/${branchId}`,
    state_path: path.join(states, `${branchId}.maker-state.json`), active_leases: [], clock
  });
  const receipt = {
    schema: FRONTIER_SURFACE_REDIRECT_SCHEMA,
    parent_candidate_id: parent.candidate_id,
    redirected_candidate_id: scenario.candidate_id,
    directive_digest: digest(instruction),
    parent_artifact_digest: parent.artifact_digest,
    redirected_artifact_digest: scenario.expected_artifact_digest,
    maker_receipt_digest: result.maker_receipt.receipt_digest,
    prior_branch_preserved: true,
    publication_state: 'not-published',
    promotion_state: 'blocked-on-empirical-evidence'
  };
  await writeExternalReceipt(path.join(states, 'redirect-receipt.json'), receipt);
  return Object.freeze({ receipt, scenario, maker_receipt: result.maker_receipt, trajectory: result.trajectory });
}

function parseFlags(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags.set(value, true);
    else { flags.set(value, next); index += 1; }
  }
  return { flags, positionals };
}

async function readJSON(filename) {
  return JSON.parse(await fs.readFile(path.resolve(filename), 'utf8'));
}

function usage() {
  return `Frontier surface assembly\n\nUsage:\n  node scripts/frontier-surface-assembly.mjs assemble --round-file <round.json> --base-sha <sha> [--output-prefix path] [--branch-prefix branch] [--state-dir path]\n  node scripts/frontier-surface-assembly.mjs redirect --assembly-file <assembly.json> --candidate <id> --directive <text> --base-sha <sha> [--branch branch] [--state-dir path]\n`;
}

export async function runFrontierSurfaceCommand({ positionals = [], flags = new Map(), root = process.cwd() } = {}) {
  const offset = positionals[0] === 'frontier' ? 1 : 0;
  const command = positionals[offset] || 'help';
  if (command === 'help' || flags.has('--help')) return { schema: 'frontier-surface-help/v1', usage: usage() };
  if (command === 'assemble') {
    const roundFile = flags.get('--round-file');
    const baseSha = flags.get('--base-sha');
    if (!roundFile || !baseSha) throw new Error('assemble requires --round-file and --base-sha.');
    const constitution = await readConstitution(flags.get('--constitution') || DEFAULT_CONSTITUTION);
    return assembleFrontierRound({
      root: path.resolve(flags.get('--root') || root),
      repository: flags.get('--repository') || 'Pokitomas/theawesomehexapp',
      base_sha: baseSha,
      branch_prefix: flags.get('--branch-prefix') || 'agent/frontier-surface',
      round: await readJSON(roundFile),
      constitution,
      output_prefix: flags.get('--output-prefix'),
      state_directory: flags.get('--state-dir'),
      prior_assembly: flags.get('--prior-assembly') ? await readJSON(flags.get('--prior-assembly')) : null
    });
  }
  if (command === 'redirect') {
    const assemblyFile = flags.get('--assembly-file');
    const candidate = flags.get('--candidate');
    const directive = flags.get('--directive') || (flags.get('--directive-file') ? await fs.readFile(path.resolve(flags.get('--directive-file')), 'utf8') : '');
    if (!assemblyFile || !candidate || !flags.get('--base-sha') || !directive) throw new Error('redirect requires --assembly-file, --candidate, --directive, and --base-sha.');
    return redirectFrontierCandidate({
      root: path.resolve(flags.get('--root') || root),
      repository: flags.get('--repository') || 'Pokitomas/theawesomehexapp',
      base_sha: flags.get('--base-sha'),
      assembly: await readJSON(assemblyFile),
      candidate_id: candidate,
      directive,
      branch: flags.get('--branch') || 'agent/frontier-surface-redirect',
      state_directory: flags.get('--state-dir')
    });
  }
  throw new Error(`Unknown frontier surface command: ${command}.`);
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positionals } = parseFlags(argv);
  const result = await runFrontierSurfaceCommand({ positionals, flags, root: process.cwd() });
  if (result?.schema === 'frontier-surface-help/v1') process.stdout.write(result.usage);
  else process.stdout.write(canonicalJSON(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
}
