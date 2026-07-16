import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { has, integer, last, number, requiredFlag } from './archie-cli-core.mjs';
import { ARCHIE_RESEARCH_ALLOCATION_SCHEMA, normalizeResearchAllocation } from './archie-research-allocation.mjs';
import {
  canonical, canonicalJSON, clean, digest, exists, gitSha, identifier, readJSON, relative,
  sha256, signed, verifySigned, without, writeExactJSON
} from './archie-research-utils.mjs';

export { canonical, canonicalJSON, sha256, normalizeResearchAllocation, ARCHIE_RESEARCH_ALLOCATION_SCHEMA };
export const ARCHIE_RESEARCH_CAMPAIGN_SCHEMA = 'archie-research-campaign/v1';
export const ARCHIE_RESEARCH_LANE_SCHEMA = 'archie-research-lane/v1';
export const ARCHIE_RESEARCH_CREATION_RECEIPT_SCHEMA = 'archie-research-campaign-creation-receipt/v1';
export const ARCHIE_RESEARCH_MATERIALIZATION_SCHEMA = 'archie-research-materialization/v1';
export const ARCHIE_GENERATION_ONE_POLICY = 'archie-generation-one-constitution/v1';
export const ARCHIE_GENERATION_ONE_SPLIT_SALT = 'archie-generation-one-hidden-v1';
export const ARCHIE_GENERATION_ONE_HOLDOUT_RATE = 0.20;

const STUDENT_PACK_SCHEMA = 'archie-student-training-pack/v1';
const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const campaignDir = (root, id) => path.join(path.resolve(root || process.cwd()), '.archie', 'campaigns', id);

export async function currentResearchCodeDigest() {
  const names = ['archie-cli-core.mjs', 'archie-research-utils.mjs', 'archie-research-allocation.mjs', 'archie-research-campaign.mjs', 'archie.mjs'];
  const files = [];
  for (const name of names) {
    const bytes = await fs.readFile(path.join(MODULE_DIR, name));
    files.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return sha256({ schema: 'archie-research-code-binding/v1', files });
}
async function currentBaseSha(root) {
  try {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(root), env: { PATH: process.env.PATH || '' }, timeout: 10_000, windowsHide: true
    });
    return gitSha(clean(result.stdout, 64), 'current base_sha');
  } catch (error) {
    throw new Error(`Unable to verify current base SHA; pass --base-sha. ${clean(error?.message || error, 300)}`);
  }
}
function codeDigest(value, baseSha) {
  return value ? digest(value, 'code_digest') : sha256({ base_sha: baseSha, campaign_engine: ARCHIE_RESEARCH_CAMPAIGN_SCHEMA });
}
function binding(campaign, { base_sha, code_digest }) {
  if (gitSha(base_sha) !== campaign.base_sha) throw new Error('Campaign base SHA drift detected.');
  if (digest(code_digest, 'code_digest') !== campaign.code_digest) throw new Error('Campaign code digest drift detected.');
}

export function buildResearchCampaignManifest({
  campaign_id, base_sha, code_digest, allocation,
  split_salt = ARCHIE_GENERATION_ONE_SPLIT_SALT,
  holdout_rate = ARCHIE_GENERATION_ONE_HOLDOUT_RATE,
  policy_version = ARCHIE_GENERATION_ONE_POLICY
} = {}) {
  const id = identifier(campaign_id, 'campaign_id');
  const base = gitSha(base_sha);
  const normalized = normalizeResearchAllocation(allocation, {
    credits: allocation?.total_credits, evaluation_reserve: allocation?.evaluation_reserve, campaign_id: id
  });
  const rate = Number(holdout_rate);
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 1) throw new Error('holdout_rate must be between 0 and 1.');
  const salt = clean(split_salt, 500);
  if (!salt) throw new Error('split_salt is required.');
  if (policy_version !== normalized.policy_version) throw new Error('Campaign policy version must match allocation.');
  return signed({
    schema: ARCHIE_RESEARCH_CAMPAIGN_SCHEMA,
    phase: 'created',
    campaign_id: id,
    policy_version,
    base_sha: base,
    code_digest: codeDigest(code_digest, base),
    allocation_digest: normalized.allocation_digest,
    credits: { total: normalized.total_credits, discovery: normalized.discovery_credits, independent_evaluation_reserve: normalized.evaluation_reserve },
    data_policy: {
      manifest_relative_path: 'data/manifest.json', pack_schema: STUDENT_PACK_SCHEMA,
      split_algorithm: 'sha256-group-threshold/v1', holdout_rate: rate,
      split_salt_digest: sha256(salt), hidden_access: 'independent-evaluation-only', mutation_policy: 'reject'
    },
    owner_preference_axis: normalized.owner_preference_axis,
    production_boundary: { candidate_production_write: false, candidate_self_promotion: false, promotion_requires_explicit_command: true },
    claim_boundary: 'Campaign constitution and deterministic materialization only; no capability or promotion claim.'
  }, 'campaign_digest');
}

export async function createResearchCampaign({
  root = process.cwd(), campaign_id, base_sha, code_digest,
  credits = 100, evaluation_reserve = 20, allocation_path,
  split_salt = ARCHIE_GENERATION_ONE_SPLIT_SALT,
  holdout_rate = ARCHIE_GENERATION_ONE_HOLDOUT_RATE,
  policy_version = ARCHIE_GENERATION_ONE_POLICY
} = {}) {
  const id = identifier(campaign_id, 'campaign_id');
  if (!allocation_path) throw new Error('allocation_path is required.');
  const allocation = normalizeResearchAllocation(await readJSON(path.resolve(root, allocation_path), 'allocation'), { credits, evaluation_reserve, campaign_id: id });
  const resolvedCode = code_digest ? digest(code_digest, 'code_digest') : await currentResearchCodeDigest();
  const campaign = buildResearchCampaignManifest({ campaign_id: id, base_sha, code_digest: resolvedCode, allocation, split_salt, holdout_rate, policy_version });
  const receipt = signed({
    schema: ARCHIE_RESEARCH_CREATION_RECEIPT_SCHEMA, campaign_id: id,
    campaign_digest: campaign.campaign_digest, allocation_digest: allocation.allocation_digest,
    base_sha: campaign.base_sha, code_digest: campaign.code_digest, policy_version,
    state: 'created', claim_boundary: 'Creation receipt only; data and lanes remain unbound until materialization.'
  }, 'receipt_digest');
  const directory = campaignDir(root, id);
  const writes = await Promise.all([
    writeExactJSON(path.join(directory, 'allocation.json'), allocation),
    writeExactJSON(path.join(directory, 'campaign.json'), campaign),
    writeExactJSON(path.join(directory, 'creation-receipt.json'), receipt)
  ]);
  return {
    schema: 'archie-research-create-result/v1', campaign_id: id, campaign_directory: directory,
    campaign_digest: campaign.campaign_digest, allocation_digest: allocation.allocation_digest,
    creation_receipt_digest: receipt.receipt_digest, state: 'awaiting-data',
    created_paths: writes.filter(item => item.created).map(item => item.filename)
  };
}

async function campaignState(directory) {
  const campaign = verifySigned(await readJSON(path.join(directory, 'campaign.json'), 'campaign'), 'campaign_digest', 'campaign');
  if (campaign.schema !== ARCHIE_RESEARCH_CAMPAIGN_SCHEMA || campaign.phase !== 'created') throw new Error('Unsupported campaign manifest.');
  const allocation = normalizeResearchAllocation(await readJSON(path.join(directory, 'allocation.json'), 'allocation'), {
    credits: campaign.credits.total, evaluation_reserve: campaign.credits.independent_evaluation_reserve, campaign_id: campaign.campaign_id
  });
  if (allocation.allocation_digest !== campaign.allocation_digest) throw new Error('Campaign allocation drift detected.');
  const receipt = verifySigned(await readJSON(path.join(directory, 'creation-receipt.json'), 'creation receipt'), 'receipt_digest', 'creation receipt');
  if (receipt.schema !== ARCHIE_RESEARCH_CREATION_RECEIPT_SCHEMA || receipt.campaign_digest !== campaign.campaign_digest || receipt.allocation_digest !== allocation.allocation_digest) throw new Error('Creation receipt binding mismatch.');
  return { campaign, allocation, receipt };
}

async function studentPack(directory, policy) {
  const manifestPath = path.join(directory, relative(policy.manifest_relative_path, 'data manifest path'));
  const root = path.dirname(manifestPath);
  const manifest = await readJSON(manifestPath, 'student pack');
  if (manifest.schema !== policy.pack_schema) throw new Error('Student pack schema drift detected.');
  if (sha256(without(manifest, 'pack_digest')) !== digest(manifest.pack_digest, 'pack_digest')) throw new Error('Student pack manifest digest mismatch.');
  if (manifest.split?.algorithm !== policy.split_algorithm) throw new Error('Student pack split algorithm drift detected.');
  if (Number(manifest.split?.holdout_rate) !== policy.holdout_rate) throw new Error('Student pack holdout rate drift detected.');
  if (digest(manifest.split?.split_salt_digest, 'split_salt_digest') !== policy.split_salt_digest) throw new Error('Student pack hidden split salt drift detected.');
  const files = {};
  for (const [partition, descriptor] of Object.entries(manifest.files || {})) {
    const bytes = await fs.readFile(path.join(root, relative(descriptor.name, `${partition}.name`)));
    if (bytes.length !== Number(descriptor.bytes)) throw new Error(`Student pack byte drift detected for ${partition}.`);
    if (sha256(bytes) !== digest(descriptor.sha256, `${partition}.sha256`)) throw new Error(`Student pack digest drift detected for ${partition}.`);
    if (bytes.toString('utf8').split(/\r?\n/).filter(Boolean).length !== Number(descriptor.rows)) throw new Error(`Student pack row drift detected for ${partition}.`);
    files[partition] = canonical(descriptor);
  }
  for (const name of ['train', 'heldout', 'negative_train', 'negative_heldout']) if (!files[name]) throw new Error(`Student pack missing ${name}.`);
  return {
    pack_digest: manifest.pack_digest,
    training_data_digest: sha256({ train: files.train, negative_train: files.negative_train }),
    hidden_data_digest: sha256({ heldout: files.heldout, negative_heldout: files.negative_heldout }),
    split_digest: sha256(manifest.split)
  };
}

function boundCampaign(campaign, pack) {
  return signed({
    ...without(campaign, 'campaign_digest'), phase: 'materialized', prior_campaign_digest: campaign.campaign_digest,
    data_binding: { ...pack, split_salt_digest: campaign.data_policy.split_salt_digest, hidden_access: campaign.data_policy.hidden_access }
  }, 'campaign_digest');
}
function laneManifest(campaign, lane, kind) {
  const judge = kind === 'independent-evaluation';
  return signed({
    schema: ARCHIE_RESEARCH_LANE_SCHEMA, campaign_id: campaign.campaign_id,
    campaign_digest: campaign.campaign_digest, prior_campaign_digest: campaign.prior_campaign_digest,
    allocation_digest: campaign.allocation_digest, policy_version: campaign.policy_version,
    lane_id: lane.id, lane_name: lane.name, lane_kind: kind, credits: lane.credits, task_families: lane.task_families,
    worker_policy: { allowed_worker_kinds: lane.allowed_worker_kinds, required_capabilities: lane.required_capabilities, priority_inference_from_availability: false },
    budget: { max_cost_usd_per_experiment: lane.max_cost_usd_per_experiment, required_replications: lane.required_replications },
    stop_rules: lane.stop_rules, promotion_boundaries: lane.promotion_boundaries,
    data_binding: {
      pack_digest: campaign.data_binding.pack_digest, training_data_digest: campaign.data_binding.training_data_digest,
      hidden_data_digest: campaign.data_binding.hidden_data_digest,
      hidden_access: judge ? 'independent-judge-only' : 'digest-bound-no-content-access'
    },
    authority: { production_write: false, self_promotion: false, maker_execution_required: true, continuing_compute_requires_executable_artifact: true },
    owner_preference_axis: { separate_from_capability: true, continuing_compute_weight: 0 },
    state: 'materialized',
    claim_boundary: judge ? 'Independent evaluation reserve; hidden content and scores stay judge-only.' : 'Discovery lane; worker availability cannot change priority or credits.'
  }, 'manifest_digest');
}
function indexManifest(campaign, entries) {
  const project = entry => ({ lane_id: entry.manifest.lane_id, relative_path: entry.path, manifest_digest: entry.manifest.manifest_digest, credits: entry.manifest.credits });
  return signed({
    schema: ARCHIE_RESEARCH_MATERIALIZATION_SCHEMA, campaign_id: campaign.campaign_id,
    campaign_digest: campaign.campaign_digest, prior_campaign_digest: campaign.prior_campaign_digest,
    allocation_digest: campaign.allocation_digest, data_binding: campaign.data_binding,
    discovery_lanes: entries.filter(item => item.kind === 'discovery').map(project),
    independent_evaluation: project(entries.find(item => item.kind === 'independent-evaluation')),
    worker_requirement: 'none-for-materialization', state: 'materialized'
  }, 'materialization_digest');
}

export async function materializeResearchCampaign({ root = process.cwd(), campaign_id, output_directory, base_sha, code_digest } = {}) {
  const id = identifier(campaign_id, 'campaign_id');
  const directory = campaignDir(root, id);
  const { campaign, allocation } = await campaignState(directory);
  binding(campaign, { base_sha: base_sha || await currentBaseSha(root), code_digest: code_digest || await currentResearchCodeDigest() });
  const pack = await studentPack(directory, campaign.data_policy);
  const bound = boundCampaign(campaign, pack);
  const output = output_directory ? path.resolve(root, output_directory) : path.join(directory, 'lanes');
  if (output !== path.join(directory, 'lanes')) throw new Error(`Research lane output must remain at ${path.join(directory, 'lanes')}.`);
  const entries = allocation.lanes.map(lane => ({ kind: 'discovery', path: `${lane.id}.json`, manifest: laneManifest(bound, lane, 'discovery') }));
  entries.push({ kind: 'independent-evaluation', path: 'independent-evaluation.json', manifest: laneManifest(bound, allocation.independent_evaluation, 'independent-evaluation') });
  const index = indexManifest(bound, entries);
  const writes = [await writeExactJSON(path.join(directory, 'campaign-bound.json'), bound)];
  for (const entry of entries) writes.push(await writeExactJSON(path.join(output, entry.path), entry.manifest));
  writes.push(await writeExactJSON(path.join(output, 'manifest-index.json'), index));
  return {
    schema: 'archie-research-materialize-result/v1', campaign_id: id,
    campaign_digest: bound.campaign_digest, prior_campaign_digest: campaign.campaign_digest,
    allocation_digest: allocation.allocation_digest, pack_digest: pack.pack_digest, split_digest: pack.split_digest,
    discovery_lanes: 12, independent_evaluation_manifests: 1, output_directory: output,
    materialization_digest: index.materialization_digest,
    created_paths: writes.filter(item => item.created).map(item => item.filename)
  };
}

async function verifyMaterialization(directory, bound, allocation) {
  verifySigned(bound, 'campaign_digest', 'bound campaign');
  const output = path.join(directory, 'lanes');
  const index = verifySigned(await readJSON(path.join(output, 'manifest-index.json'), 'materialization index'), 'materialization_digest', 'materialization index');
  if (index.schema !== ARCHIE_RESEARCH_MATERIALIZATION_SCHEMA || index.campaign_digest !== bound.campaign_digest || index.allocation_digest !== allocation.allocation_digest) throw new Error('Materialization binding mismatch.');
  const descriptors = [...(index.discovery_lanes || []), index.independent_evaluation].filter(Boolean);
  if (index.discovery_lanes?.length !== 12 || descriptors.length !== 13) throw new Error('Materialization must contain twelve discovery lanes plus evaluation.');
  let credits = 0;
  for (const descriptor of descriptors) {
    const lane = verifySigned(await readJSON(path.join(output, relative(descriptor.relative_path, 'lane path')), descriptor.lane_id), 'manifest_digest', descriptor.lane_id);
    if (lane.schema !== ARCHIE_RESEARCH_LANE_SCHEMA || lane.manifest_digest !== descriptor.manifest_digest || lane.campaign_digest !== bound.campaign_digest) throw new Error(`Lane binding mismatch for ${descriptor.lane_id}.`);
    credits += lane.credits;
  }
  if (credits !== allocation.total_credits) throw new Error('Materialized credits drifted from 100.');
  return index;
}

export async function researchCampaignStatus({ root = process.cwd(), campaign_id, base_sha, code_digest, watch = false } = {}) {
  if (watch) throw new Error('POK-47 status is non-watching; omit --watch.');
  const id = identifier(campaign_id, 'campaign_id');
  const directory = campaignDir(root, id);
  const { campaign, allocation, receipt } = await campaignState(directory);
  binding(campaign, { base_sha: base_sha || await currentBaseSha(root), code_digest: code_digest || await currentResearchCodeDigest() });
  const boundPath = path.join(directory, 'campaign-bound.json');
  if (!(await exists(boundPath))) return {
    schema: 'archie-research-status/v1', campaign_id: id, state: 'awaiting-data',
    campaign_digest: campaign.campaign_digest, allocation_digest: allocation.allocation_digest,
    creation_receipt_digest: receipt.receipt_digest, discovery_lanes: 12,
    independent_evaluation_reserve: allocation.evaluation_reserve, workers_required: false
  };
  const bound = await readJSON(boundPath, 'bound campaign');
  if (bound.schema !== ARCHIE_RESEARCH_CAMPAIGN_SCHEMA || bound.phase !== 'materialized' || bound.prior_campaign_digest !== campaign.campaign_digest) throw new Error('Bound campaign mismatch.');
  const pack = await studentPack(directory, campaign.data_policy);
  for (const key of ['pack_digest', 'split_digest', 'hidden_data_digest']) if (bound.data_binding?.[key] !== pack[key]) throw new Error('Bound campaign data drift detected.');
  const index = await verifyMaterialization(directory, bound, allocation);
  return {
    schema: 'archie-research-status/v1', campaign_id: id, state: 'materialized',
    campaign_digest: bound.campaign_digest, prior_campaign_digest: campaign.campaign_digest,
    allocation_digest: allocation.allocation_digest, pack_digest: pack.pack_digest, split_digest: pack.split_digest,
    materialization_digest: index.materialization_digest, discovery_lanes: 12,
    independent_evaluation_reserve: index.independent_evaluation.credits,
    workers_required: false, hidden_scores_exposed: false
  };
}

export async function runResearchCommand({ positionals, flags, root = process.cwd() } = {}) {
  const action = positionals[1] || '';
  const repositoryRoot = path.resolve(last(flags, '--root', root));
  if (action === 'create') return createResearchCampaign({
    root: repositoryRoot, campaign_id: positionals[2] || requiredFlag(flags, '--campaign'),
    base_sha: requiredFlag(flags, '--base-sha'), code_digest: last(flags, '--code-digest'),
    credits: integer(flags, '--credits', 100), evaluation_reserve: integer(flags, '--evaluation-reserve', 20),
    allocation_path: requiredFlag(flags, '--allocation'), split_salt: last(flags, '--split-salt', ARCHIE_GENERATION_ONE_SPLIT_SALT),
    holdout_rate: number(flags, '--holdout-rate', ARCHIE_GENERATION_ONE_HOLDOUT_RATE), policy_version: last(flags, '--policy-version', ARCHIE_GENERATION_ONE_POLICY)
  });
  if (action === 'materialize') return materializeResearchCampaign({
    root: repositoryRoot, campaign_id: requiredFlag(flags, '--campaign'), output_directory: last(flags, '--output'),
    base_sha: last(flags, '--base-sha'), code_digest: last(flags, '--code-digest')
  });
  if (action === 'status') return researchCampaignStatus({
    root: repositoryRoot, campaign_id: requiredFlag(flags, '--campaign'), base_sha: last(flags, '--base-sha'),
    code_digest: last(flags, '--code-digest'), watch: has(flags, '--watch')
  });
  throw new Error('Usage: archie research <create|materialize|status> [options]');
}
