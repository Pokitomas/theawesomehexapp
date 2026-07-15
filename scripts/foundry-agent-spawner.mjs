#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const LASSO_SCHEMA = 'sideways-foundry-maker-lasso/v1';
export const GENOME_MANIFEST_SCHEMA = 'sideways-foundry-genome-manifest/v1';
export const PEER_LEASES_SCHEMA = 'sideways-open-path-leases/v1';
export const ASSIGNMENT_TASK_SCHEMA = 'sideways-foundry-assignment-task/v1';
export const FOUNDRY_SCHEMA = 'sideways-model-foundry/v1';
const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const SECRET_KEY = /(^|_)(password|passwd|secret|token|credential|api_?key|private_?key|bearer|jwt|ssn|credit_?card)(_|$)/i;

export function clean(value, limit = 20_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

export function assertNoSecrets(value, context = 'input') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`Secret-bearing field detected at ${context}.${key}.`);
    assertNoSecrets(nested, `${context}.${key}`);
  }
}

export function requireSha40(value, label) {
  const normalized = clean(value, 80);
  if (!SHA40.test(normalized)) throw new Error(`${label} must be an exact 40-character commit SHA.`);
  return normalized.toLowerCase();
}

export function normalizeLeasePath(value) {
  let raw = clean(value, 1_000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw) throw new Error('Lease path is empty.');
  if (raw === '*' || raw === '**' || raw === '**/*') return '**';
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error(`Absolute lease path is forbidden: ${raw}`);
  const parts = raw.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error(`Traversing lease path is forbidden: ${raw}`);
  const wildcard = raw.indexOf('*');
  if (wildcard !== -1 && !raw.endsWith('/**')) throw new Error(`Only terminal /** wildcards are supported: ${raw}`);
  raw = parts.join('/');
  return raw || '**';
}

export function normalizeLeasePaths(values, label = 'owned_paths') {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must be a non-empty array.`);
  const normalized = [...new Set(values.map(normalizeLeasePath))].sort();
  return normalized.includes('**') ? ['**'] : normalized;
}

export function pathsOverlap(left, right) {
  const normalizeBase = item => {
    const normalized = normalizeLeasePath(item);
    return normalized.endsWith('/**') ? normalized.slice(0, -3) : normalized;
  };
  return left.some(a => right.some(b => {
    const x = normalizeBase(a);
    const y = normalizeBase(b);
    return x === '**' || y === '**' || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }));
}

export function validateAssignments(input) {
  assertNoSecrets(input, 'assignments');
  const rows = Array.isArray(input) ? input : input?.assignments;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Assignments artifact must contain at least one assignment.');
  const seenIds = new Set();
  const seenRoles = new Set();
  return rows.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`assignments[${index}] must be an object.`);
    if (item.schema !== FOUNDRY_SCHEMA) throw new Error(`assignments[${index}] has unsupported schema.`);
    const assignmentId = clean(item.assignment_id, 300);
    const role = clean(item.role, 120);
    if (!assignmentId || !role) throw new Error(`assignments[${index}] requires assignment_id and role.`);
    if (seenIds.has(assignmentId)) throw new Error(`Duplicate assignment_id: ${assignmentId}.`);
    if (seenRoles.has(role)) throw new Error(`Duplicate assignment role: ${role}.`);
    if (item.phase !== 'parallel-read-only-assessment' || item.read_only !== true) throw new Error(`assignments[${index}] is not a canonical read-only assessment assignment.`);
    seenIds.add(assignmentId);
    seenRoles.add(role);
    return Object.freeze({
      assignment_id: assignmentId,
      mission_id: clean(item.mission_id, 120),
      role,
      phase: item.phase,
      read_only: true,
      scope: clean(item.scope, 2_000),
      objective: clean(item.objective, 12_000),
      constraints: structuredClone(item.constraints || {}),
      output_contract: structuredClone(item.output_contract || {})
    });
  });
}

export function parseAssignmentTag(tag) {
  const raw = clean(tag, 300);
  const match = raw.match(/^\[?maker:foundry:([a-z0-9-]+)\]?$/i);
  return match ? match[1].toLowerCase() : raw.toLowerCase();
}

export function resolveAssignmentTask(tag, assignmentsInput) {
  const assignments = validateAssignments(assignmentsInput);
  const role = parseAssignmentTag(tag);
  const assignment = assignments.find(item => item.role.toLowerCase() === role);
  if (!assignment) throw new Error(`Unknown foundry assignment role: ${role}.`);
  return Object.freeze({
    schema: ASSIGNMENT_TASK_SCHEMA,
    assignment_id: assignment.assignment_id,
    mission_id: assignment.mission_id,
    role: assignment.role,
    phase: assignment.phase,
    read_only: true,
    scope: assignment.scope,
    objective: assignment.objective,
    constraints: assignment.constraints,
    output_contract: assignment.output_contract,
    authority: { repository_mutation: false, external_install: false, training_spend: false, merge: 'human', deploy: 'human' },
    state: 'resolved-not-executed'
  });
}

export function resolveAllAssignmentTasks(assignmentsInput) {
  const assignments = validateAssignments(assignmentsInput);
  return Object.freeze({ schema: ASSIGNMENT_TASK_SCHEMA, ok: true, count: assignments.length, tasks: assignments.map(item => resolveAssignmentTask(item.role, assignmentsInput)) });
}

export function validatePortfolio(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Portfolio must be an object.');
  assertNoSecrets(input, 'portfolio');
  if (input.schema !== FOUNDRY_SCHEMA) throw new Error(`Portfolio schema must be ${FOUNDRY_SCHEMA}.`);
  if (!Array.isArray(input.selected) || input.selected.length === 0) throw new Error('Portfolio must contain selected experiments.');
  if (!Number.isFinite(input.budget) || input.budget <= 0) throw new Error('Portfolio budget must be finite and positive.');
  if (!Number.isFinite(input.spent) || input.spent < 0 || input.spent > input.budget) throw new Error('Portfolio spent must be finite, non-negative, and no greater than budget.');
  const seen = new Set();
  const selected = input.selected.map((experiment, index) => {
    if (!experiment || typeof experiment !== 'object' || Array.isArray(experiment)) throw new Error(`selected[${index}] must be an object.`);
    assertNoSecrets(experiment, `portfolio.selected[${index}]`);
    const experimentId = clean(experiment.experiment_id, 300);
    const candidateId = clean(experiment.candidate_id, 200);
    if (!experimentId || !candidateId) throw new Error(`selected[${index}] requires experiment_id and candidate_id.`);
    if (seen.has(candidateId)) throw new Error(`Duplicate candidate_id in portfolio: ${candidateId}.`);
    seen.add(candidateId);
    const cost = Number(experiment.estimated_cost);
    if (!Number.isFinite(cost) || cost <= 0) throw new Error(`${candidateId} estimated_cost must be finite and positive.`);
    const seedCount = Number.isInteger(experiment.reproduction_seeds) ? experiment.reproduction_seeds : Array.isArray(experiment.reproduction_seeds) ? experiment.reproduction_seeds.length : 0;
    if (seedCount < 2) throw new Error(`${candidateId} requires at least two reproduction seeds.`);
    if (!clean(experiment.falsifier, 5_000)) throw new Error(`${candidateId} is missing a falsifier.`);
    if (!clean(experiment.hidden_evaluation, 5_000)) throw new Error(`${candidateId} is missing hidden_evaluation.`);
    if (!clean(experiment.matched_compute_baseline, 5_000)) throw new Error(`${candidateId} is missing matched_compute_baseline.`);
    return Object.freeze({
      experiment_id: experimentId,
      candidate_id: candidateId,
      distance: ['conservative', 'adjacent', 'heretical'].includes(experiment.distance) ? experiment.distance : 'adjacent',
      mechanism: clean(experiment.mechanism, 10_000),
      falsifier: clean(experiment.falsifier, 5_000),
      hidden_evaluation: clean(experiment.hidden_evaluation, 5_000),
      matched_compute_baseline: clean(experiment.matched_compute_baseline, 5_000),
      reproduction_seed_count: seedCount,
      expected_information_gain: Number(experiment.expected_information_gain) || 0,
      estimated_cost: cost,
      state: clean(experiment.state, 100) || 'leased-not-executed'
    });
  });
  return Object.freeze({ schema: FOUNDRY_SCHEMA, selection_policy: clean(input.selection_policy, 500) || null, budget: input.budget, spent: input.spent, selected, deferred: Array.isArray(input.deferred) ? structuredClone(input.deferred) : [], rejected: Array.isArray(input.rejected) ? structuredClone(input.rejected) : [] });
}

export function validateGenomeManifest(input, baseSha) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Genome manifest must be an object.');
  assertNoSecrets(input, 'genome_manifest');
  if (input.schema !== GENOME_MANIFEST_SCHEMA) throw new Error(`Genome manifest schema must be ${GENOME_MANIFEST_SCHEMA}.`);
  const manifestBase = requireSha40(input.base_sha, 'genome_manifest.base_sha');
  if (manifestBase !== baseSha) throw new Error('Genome manifest base_sha does not match the requested exact base.');
  if (!input.genomes || typeof input.genomes !== 'object' || Array.isArray(input.genomes)) throw new Error('Genome manifest requires a genomes object keyed by candidate_id.');
  const result = {};
  for (const [candidateId, raw] of Object.entries(input.genomes)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Genome manifest entry ${candidateId} must be an object.`);
    const genomePath = normalizeLeasePath(raw.path);
    if (!genomePath.startsWith('foundry/genomes/')) throw new Error(`Genome path for ${candidateId} must be under foundry/genomes/.`);
    if (raw.validated !== true) throw new Error(`Genome for ${candidateId} is not marked validated.`);
    const codeRevision = requireSha40(raw.code_revision, `genome ${candidateId} code_revision`);
    if (codeRevision !== baseSha) throw new Error(`Genome for ${candidateId} was validated against a different code revision.`);
    const seeds = Array.isArray(raw.seeds) ? raw.seeds : [];
    if (seeds.length < 2 || seeds.some(seed => !Number.isInteger(seed))) throw new Error(`Genome for ${candidateId} requires at least two integer seeds.`);
    if (!SHA256.test(clean(raw.genome_digest, 80))) throw new Error(`Genome for ${candidateId} requires a 64-character genome_digest.`);
    if (!SHA256.test(clean(raw.validation_receipt_digest, 80))) throw new Error(`Genome for ${candidateId} requires a 64-character validation_receipt_digest.`);
    const command = clean(raw.validation_command, 2_000);
    if (!command.startsWith('node foundry/cli.mjs validate-genome ')) throw new Error(`Genome for ${candidateId} has a non-canonical validation command.`);
    result[candidateId] = Object.freeze({ path: genomePath, genome_digest: clean(raw.genome_digest, 80).toLowerCase(), validation_receipt_digest: clean(raw.validation_receipt_digest, 80).toLowerCase(), validation_command: command, code_revision: codeRevision, seeds: [...seeds], validated: true });
  }
  return Object.freeze({ schema: GENOME_MANIFEST_SCHEMA, base_sha: manifestBase, genomes: Object.freeze(result) });
}

export function validatePeerLeases(input, baseSha) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Peer-leases snapshot must be an object.');
  assertNoSecrets(input, 'peer_leases');
  if (input.schema !== PEER_LEASES_SCHEMA) throw new Error(`Peer-leases schema must be ${PEER_LEASES_SCHEMA}.`);
  const snapshotBase = requireSha40(input.base_sha, 'peer_leases.base_sha');
  if (snapshotBase !== baseSha) throw new Error('Peer-leases snapshot base_sha does not match the requested exact base.');
  if (!Array.isArray(input.open_leases)) throw new Error('Peer-leases snapshot requires open_leases array.');
  return Object.freeze({
    schema: PEER_LEASES_SCHEMA,
    base_sha: snapshotBase,
    open_leases: input.open_leases.map((lease, index) => {
      if (!lease || typeof lease !== 'object' || Array.isArray(lease)) throw new Error(`open_leases[${index}] must be an object.`);
      if (!Number.isInteger(lease.pr_number) || lease.pr_number <= 0) throw new Error(`open_leases[${index}] requires a positive pr_number.`);
      if (lease.state !== 'open') throw new Error(`open_leases[${index}] must represent an open PR.`);
      return Object.freeze({ pr_number: lease.pr_number, base_sha: requireSha40(lease.base_sha, `open_leases[${index}].base_sha`), head_sha: requireSha40(lease.head_sha, `open_leases[${index}].head_sha`), branch: clean(lease.branch, 300), owned_paths: normalizeLeasePaths(lease.owned_paths, `open_leases[${index}].owned_paths`), state: 'open' });
    })
  });
}

export function slug(value) {
  return clean(value, 300).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'candidate';
}

export function packetPaths(candidateId) {
  const id = slug(candidateId);
  return [`foundry/experiments/${id}/**`, `foundry/tests/${id}.test.mjs`];
}

export function convertExperimentToPacket(experiment, genome, { baseSha, perPacketBudget = Infinity } = {}) {
  if (!experiment || !genome) throw new Error('Experiment and validated genome are required.');
  const exactBase = requireSha40(baseSha, 'base_sha');
  if (!Number.isFinite(perPacketBudget) && perPacketBudget !== Infinity) throw new Error('Per-packet budget must be finite or Infinity.');
  if (experiment.estimated_cost > perPacketBudget) throw new Error(`${experiment.candidate_id} exceeds the per-packet budget cap.`);
  const id = slug(experiment.candidate_id);
  const ownedPaths = packetPaths(experiment.candidate_id);
  return Object.freeze({
    schema: LASSO_SCHEMA,
    experiment_id: experiment.experiment_id,
    candidate_id: experiment.candidate_id,
    distance: experiment.distance,
    mechanism: experiment.mechanism,
    exact_base_sha: exactBase,
    proposed_branch: `maker/foundry-${id}`,
    owned_paths: ownedPaths,
    focused_tests: [`node --test foundry/tests/${id}.test.mjs`],
    required_outputs: [`foundry/experiments/${id}/implementation-receipt.json`, `foundry/experiments/${id}/resource-receipt.json`, `foundry/experiments/${id}/admission-evidence.json`],
    genome,
    experiment_contract: { falsifier: experiment.falsifier, hidden_evaluation: experiment.hidden_evaluation, matched_compute_baseline: experiment.matched_compute_baseline, reproduction_seed_count: experiment.reproduction_seed_count },
    budget: { proxy_compute_units: experiment.estimated_cost, max_wall_seconds: 3_600, external_install_authority: false, training_spend_authority: false },
    rollback: 'Draft branch only. Human must review exact-head evidence before merge; rollback is git revert of the admitted merge commit.',
    authority: { merge: 'human', deploy: 'human', external_install: false, training_spend: false, secrets: 'never' },
    state: 'packet-ready-not-executed'
  });
}

export function detectPacketOverlaps(packets) {
  const collisions = [];
  for (let i = 0; i < packets.length; i += 1) for (let j = i + 1; j < packets.length; j += 1) if (pathsOverlap(packets[i].owned_paths, packets[j].owned_paths)) collisions.push({ left: packets[i].experiment_id, right: packets[j].experiment_id });
  return collisions;
}

export function buildLassoReceipt({ portfolioInput, genomeManifestInput, peerLeasesInput, baseSha, perPacketBudget = Infinity }) {
  const exactBase = requireSha40(baseSha, 'base_sha');
  const portfolio = validatePortfolio(portfolioInput);
  const genomeManifest = validateGenomeManifest(genomeManifestInput, exactBase);
  const peers = validatePeerLeases(peerLeasesInput, exactBase);
  const errors = [];
  const packets = [];
  for (const experiment of portfolio.selected) {
    const genome = genomeManifest.genomes[experiment.candidate_id];
    if (!genome) { errors.push({ candidate_id: experiment.candidate_id, reason: 'missing-validated-genome' }); continue; }
    try { packets.push(convertExperimentToPacket(experiment, genome, { baseSha: exactBase, perPacketBudget })); }
    catch (error) { errors.push({ candidate_id: experiment.candidate_id, reason: error.message }); }
  }
  const packetCollisions = detectPacketOverlaps(packets);
  const peerCollisions = [];
  for (const packet of packets) for (const lease of peers.open_leases) if (pathsOverlap(packet.owned_paths, lease.owned_paths)) peerCollisions.push({ experiment_id: packet.experiment_id, pr_number: lease.pr_number, overlapping_packet_paths: packet.owned_paths, peer_paths: lease.owned_paths });
  const selectedCost = packets.reduce((sum, packet) => sum + packet.budget.proxy_compute_units, 0);
  const remainingBudget = portfolio.budget - portfolio.spent;
  const budgetExceeded = selectedCost > remainingBudget;
  const ok = errors.length === 0 && packetCollisions.length === 0 && peerCollisions.length === 0 && !budgetExceeded;
  return Object.freeze({
    schema: LASSO_SCHEMA,
    ok,
    exact_base_sha: exactBase,
    selection_policy: portfolio.selection_policy,
    portfolio_budget: portfolio.budget,
    portfolio_spent: portfolio.spent,
    portfolio_remaining_budget: remainingBudget,
    packet_cost_total: selectedCost,
    budget_exceeded: budgetExceeded,
    packets_requested: portfolio.selected.length,
    packets_ready: ok ? packets.length : 0,
    packet_errors: errors,
    packet_collisions: packetCollisions,
    peer_collisions: peerCollisions,
    packets: ok ? packets : [],
    deferred: portfolio.deferred,
    rejected_by_foundry: portfolio.rejected,
    authority: { repository_mutation: false, merge: 'human', deploy: 'human', training_spend: false, external_install: false }
  });
}

export async function loadJson(filePath, label) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) { throw new Error(`${label} could not be loaded from ${filePath}: ${error.message}`); }
}

export async function lassoFiles({ portfolioPath, genomeManifestPath, peerLeasesPath, baseSha, perPacketBudget = Infinity }) {
  if (!portfolioPath || !genomeManifestPath || !peerLeasesPath) throw new Error('portfolio, genome manifest, and peer-leases paths are required.');
  return buildLassoReceipt({ portfolioInput: await loadJson(portfolioPath, 'portfolio'), genomeManifestInput: await loadJson(genomeManifestPath, 'genome manifest'), peerLeasesInput: await loadJson(peerLeasesPath, 'peer-leases snapshot'), baseSha, perPacketBudget });
}

async function main() {
  const [command = 'help', ...argv] = process.argv.slice(2);
  if (command === 'help' || command === '--help') { process.stdout.write('Use scripts/foundry-agent-cli.mjs for the supported read-only interface.\n'); return; }
  if (command !== 'validate-portfolio') throw new Error(`Unsupported direct command: ${command}.`);
  const portfolio = validatePortfolio(await loadJson(argv[0], 'portfolio'));
  process.stdout.write(`${JSON.stringify({ ok: true, selected: portfolio.selected.length, budget: portfolio.budget })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); process.exitCode = 1; });
