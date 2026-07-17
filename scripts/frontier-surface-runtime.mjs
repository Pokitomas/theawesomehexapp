import fs from 'node:fs/promises';
import path from 'node:path';
import { compileArchieProgram, parseArchieLanguage } from '../foundry/archie-neural/archie-language.mjs';
import { MakerEngine, digest as makerDigest, verifyEventChain } from './maker-engine.mjs';
import { canonicalJSON, digest } from './frontier-world-expo.mjs';
import { exactSha, identifier, relativePrefix, clean } from './frontier-surface-core.mjs';
import { buildSurfaceKit, ROLE_ORDER } from './frontier-surface-kits.mjs';

export const FRONTIER_SURFACE_SCENARIO_SCHEMA = 'frontier-surface-scenario/v1';
export const FRONTIER_SURFACE_ASSEMBLY_SCHEMA = 'frontier-surface-assembly/v1';
export const FRONTIER_SURFACE_TRAJECTORY_SCHEMA = 'frontier-surface-trajectory/v1';
export const FRONTIER_SURFACE_REDIRECT_SCHEMA = 'frontier-surface-redirect/v1';

const VERIFY_SCRIPT = 'scripts/verify-frontier-surface-candidate.mjs';

export function validateFrontierRound(round, constitution) {
  if (round?.schema !== 'frontier-world-expo-round/v1') throw new Error('Unsupported Frontier World Expo round.');
  if (round.constitution_digest !== digest(constitution)) throw new Error('Frontier round constitution drift detected.');
  if (round.aggregate_score_forbidden !== true) throw new Error('Frontier round must forbid aggregate-score masking.');
  const roles = round.candidates?.map(candidate => candidate.role) || [];
  if (roles.length !== ROLE_ORDER.length || ROLE_ORDER.some(role => !roles.includes(role))) throw new Error('Frontier round must contain all six required candidate roles.');
  if (new Set(round.candidates.map(candidate => candidate.candidate_id)).size !== round.candidates.length) throw new Error('Frontier round candidate IDs must be unique.');
  return round;
}

export function buildCandidateScenario(candidate, { round_id, round_digest, base_sha, output_prefix, redirect_directive = null, parent_candidate_id = null } = {}) {
  const base = exactSha(base_sha);
  const rootPrefix = relativePrefix(output_prefix);
  const candidateId = identifier(candidate.candidate_id, 'candidate_id');
  const target = `${rootPrefix}/${candidateId}`;
  const context = { round_id: identifier(round_id, 'round_id'), redirect_directive: clean(redirect_directive, 2000) || null };
  const kit = buildSurfaceKit(candidate.role, candidate, context);
  const runtimeFiles = Object.freeze({ ...kit.files });
  const fileDigests = Object.fromEntries(Object.entries(runtimeFiles).sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => [name, makerDigest(content)]));
  const body = {
    schema: FRONTIER_SURFACE_SCENARIO_SCHEMA,
    candidate_id: candidateId,
    parent_candidate_id: parent_candidate_id || null,
    role: candidate.role,
    round_id: context.round_id,
    round_digest: clean(round_digest, 64),
    candidate_digest: clean(candidate.candidate_digest, 64),
    base_sha: base,
    target_prefix: target,
    visual_grammar_id: kit.visual_grammar_id,
    described_as: clean(candidate.described_as, 2000),
    violated_norm: clean(candidate.violated_norm, 2000),
    substrates: candidate.substrates || [],
    commission_ids: candidate.commission_ids || [],
    automation_share: Number(candidate.automation_share),
    interaction: kit.interaction,
    redirect_directive: context.redirect_directive,
    runtime_files: Object.keys(runtimeFiles).sort(),
    file_digests: fileDigests,
    offline_contract: {
      external_network_required: false,
      external_asset_urls_allowed: false,
      human_readable_source: true,
      standalone_index_required: true
    },
    authority: {
      archie_direct_write: false,
      maker_only_repository_writer: true,
      merge: 'human',
      deploy: 'human',
      public_publish: 'human'
    },
    claim_boundary: 'Runnable prototype fixture only; headless capture is not real-device or model-capability evidence.'
  };
  const scenario = { ...body, scenario_digest: digest(body), expected_artifact_digest: digest({ target_prefix: target, files: runtimeFiles }) };
  const candidateManifest = canonicalJSON({
    ...scenario,
    schema: 'frontier-surface-candidate-manifest/v1',
    files: fileDigests
  });
  return Object.freeze({ ...scenario, files: Object.freeze({ ...runtimeFiles, 'candidate.json': candidateManifest }) });
}

export function createArchieSurfaceProgram(scenario) {
  if (scenario?.schema !== FRONTIER_SURFACE_SCENARIO_SCHEMA) throw new Error('Unsupported frontier surface scenario.');
  const runtimeNames = scenario.runtime_files;
  const rows = [
    'AIL/1',
    `world frontier ${JSON.stringify({ round_id: scenario.round_id, candidate_id: scenario.candidate_id, fixed_surface_category: null })}`,
    `actor archie ${JSON.stringify({ role: 'surface-planner', write_authority: false })}`,
    `actor maker ${JSON.stringify({ role: 'leased-prototype-executor', write_authority: true })}`,
    `goal runnable ${JSON.stringify({ expr: 'assemble one runnable visibly distinct frontier surface candidate', priority: 1 })}`,
    `protect authority ${JSON.stringify({ expr: 'only Maker writes; merge deploy publication and promotion remain human gated' })}`,
    `fact normbreak ${JSON.stringify({ expr: scenario.violated_norm || 'candidate breaks an inherited interface assumption', evidence: [] })}`,
    `capability writecandidate ${JSON.stringify({ operation: 'maker.write', effect: 'local-write' })}`,
    `grant candidatelease ${JSON.stringify({ actor: 'maker', capability: 'writecandidate', scope: `${scenario.target_prefix}/**` })}`
  ];
  runtimeNames.forEach((name, index) => {
    const id = `write${String(index + 1).padStart(2, '0')}`;
    const after = index ? [`write${String(index).padStart(2, '0')}`] : [];
    rows.push(`step ${id} ${JSON.stringify({ operation: 'writecandidate', after, requires: ['candidatelease'], expect: [scenario.file_digests[name]] })}`);
  });
  const prior = `write${String(runtimeNames.length).padStart(2, '0')}`;
  rows.push(`step writemanifest ${JSON.stringify({ operation: 'writecandidate', after: [prior], requires: ['candidatelease'], expect: [makerDigest(scenario.files['candidate.json'])] })}`);
  rows.push(`verify verifycandidate ${JSON.stringify({ expr: 'independent verifier accepts exact files, offline bounds, unique grammar, and interaction contract', after: ['writemanifest'], evidence: [] })}`);
  rows.push(`learn retaincandidate ${JSON.stringify({ from: ['verifycandidate'], after: ['verifycandidate'], skill: `frontier-surface-${scenario.role}`, outcome: 'accepted' })}`);
  rows.push(`halt stopbeforepublish ${JSON.stringify({ expr: 'stop after receipt and capture plan; do not merge deploy publish or promote', after: ['retaincandidate'] })}`);
  rows.push(`presentation prototype ${JSON.stringify({ shell: 'frontier surface candidate' })}`);
  return compileArchieProgram(parseArchieLanguage(`${rows.join('\n')}\n`));
}

function trajectoryReceipt(payload, clock) {
  const body = { schema: FRONTIER_SURFACE_TRAJECTORY_SCHEMA, observed_at: (clock || (() => new Date().toISOString()))(), payload };
  return Object.freeze({ ...body, trajectory_digest: digest(body) });
}

export async function writeExternalReceipt(filename, receipt) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, canonicalJSON(receipt), { mode: 0o600 });
  return filename;
}

export async function runSurfaceScenario({ root, repository, scenario, branch, state_path, active_leases = [], clock } = {}) {
  const plan = createArchieSurfaceProgram(scenario);
  const verifierArgs = [VERIFY_SCRIPT, '--root', scenario.target_prefix, '--manifest', `${scenario.target_prefix}/candidate.json`, '--expected-digest', scenario.expected_artifact_digest];
  const lease = {
    base_sha: scenario.base_sha,
    branch,
    writer_count: 1,
    owned_paths: [`${scenario.target_prefix}/**`],
    authority: { merge: 'human', deploy: 'human' }
  };
  const engine = await MakerEngine.create({
    root,
    state_path,
    task: {
      repository,
      base_sha: scenario.base_sha,
      branch,
      request: `Assemble frontier surface candidate ${scenario.candidate_id} for round ${scenario.round_id}.`,
      protect: 'Archie plans without direct write authority. Maker owns only the candidate lease. Merge, deploy, publication, and promotion remain human.',
      proof: 'Exact runtime file digests, offline verifier, event chain, branch identity, interaction contract, and terminal Maker receipt.'
    },
    lease,
    active_leases,
    command_policy: [{ program: 'node', args: verifierArgs }],
    clock
  });
  let verification = null;
  try {
    for (const [name, content] of Object.entries(scenario.files).sort(([left], [right]) => left.localeCompare(right))) {
      await engine.write(`${scenario.target_prefix}/${name}`, content);
    }
    await engine.checkpoint('frontier-candidate-files-written');
    verification = await engine.verify([{ program: 'node', args: verifierArgs }]);
    if (!verification.ok) throw new Error(`Frontier candidate verification failed: ${scenario.candidate_id}.`);
    const makerReceipt = await engine.receipt();
    verifyEventChain(engine.snapshot().events);
    const trajectory = trajectoryReceipt({
      outcome: 'completed',
      training_classification: 'positive',
      round_id: scenario.round_id,
      candidate_id: scenario.candidate_id,
      scenario_digest: scenario.scenario_digest,
      expected_artifact_digest: scenario.expected_artifact_digest,
      archie: { semantic_digest: plan.semantic_digest, schedule_digest: plan.schedule_digest, direct_write_authority: false },
      maker: { receipt_digest: makerReceipt.receipt_digest, changed_paths: makerReceipt.changed_paths, verification: makerReceipt.verification, human_gates: makerReceipt.human_gates },
      capture: { state: 'awaiting-headless-capture', real_device_claim: false }
    }, clock);
    const trajectoryPath = await writeExternalReceipt(`${state_path}.trajectory.json`, trajectory);
    return Object.freeze({ scenario, plan, maker_receipt: makerReceipt, trajectory, trajectory_path: trajectoryPath, lease });
  } catch (error) {
    const snapshot = engine.snapshot();
    const trajectory = trajectoryReceipt({
      outcome: 'failed',
      training_classification: 'negative',
      error: clean(error?.message || error, 4000),
      round_id: scenario.round_id,
      candidate_id: scenario.candidate_id,
      scenario_digest: scenario.scenario_digest,
      archie: { semantic_digest: plan.semantic_digest, schedule_digest: plan.schedule_digest, direct_write_authority: false },
      maker: { status: snapshot.status, changed_paths: snapshot.changed_paths, failures: snapshot.failures, verification }
    }, clock);
    await writeExternalReceipt(`${state_path}.trajectory.json`, trajectory);
    throw error;
  }
}
