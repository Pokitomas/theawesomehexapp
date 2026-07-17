#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, '..');
const DEFAULT_CONSTITUTION = path.join(REPOSITORY_ROOT, 'design', 'frontier-world-expo.json');
const DEFAULT_OUTPUT_ROOT = path.join(REPOSITORY_ROOT, '.archie', 'frontier-world-expo');

const CONTROL_FORMS = [
  'commission atlas with visible tools and receipts',
  'walkable studio index with explicit entrances',
  'artifact-first workshop with a conventional inspector'
];
const INVERSION_FORMS = [
  'screenless listening procession whose state is carried by sound and touch',
  'artifact-before-interface threshold that reveals controls only after the first creation',
  'silent spatial score navigated by arrangement rather than menus',
  'single evolving object that replaces pages, tabs, and navigation'
];
const RITUALS = ['repair café', 'street procession', 'community noticeboard', 'shadow theatre', 'field notebook', 'listening circle', 'cabinet of curiosities'];
const MEDIA = ['woven score', 'paper architecture', 'radio play', 'kinetic type', 'miniature town', 'annotated map', 'branching song'];
const LOSERS = ['abandoned dashboard', 'overloaded canvas', 'too-clever command room', 'sterile infinite feed', 'opaque autonomous agent', 'decorative world map'];
const LOW_RESOURCE_FORMS = [
  'offline pocket folio rendered from one human-readable bundle',
  'local radio notebook using text, tones, and tiny bitmap plates',
  'single-file neighborhood that survives without network, account, or build step'
];
const EXPRESSIVE_FORMS = [
  'mutable relic garden whose rules, labels, scars, and sounds diverge per owner',
  'personal weather system composed from artifacts, voices, habits, and unfinished work',
  'living neighborhood dialect with user-invented materials and local physics',
  'branching house of alternate selves with visible provenance between rooms'
];
const SUBSTRATES = ['paper', 'sound', 'space', 'gesture', 'time', 'memory', 'code', 'light', 'collection', 'conversation'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function canonicalJSON(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

export function digest(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJSON(value);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashSeed(seed) {
  const hash = crypto.createHash('sha256').update(String(seed)).digest();
  return hash.readUInt32LE(0) || 1;
}

function randomSource(seed) {
  let state = hashSeed(seed);
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function pick(values, random) {
  return values[Math.floor(random() * values.length) % values.length];
}

function sample(values, count, random) {
  const remaining = [...values];
  const result = [];
  while (remaining.length && result.length < count) result.push(remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
  return result;
}

export async function readConstitution(filename = DEFAULT_CONSTITUTION) {
  const constitution = JSON.parse(await fs.readFile(path.resolve(filename), 'utf8'));
  validateConstitution(constitution);
  return constitution;
}

export function validateConstitution(constitution) {
  if (constitution?.schema !== 'frontier-world-expo/v1') throw new Error('Unsupported Frontier World Expo constitution.');
  if (constitution.ontology_policy?.fixed_surface_category !== null || constitution.ontology_policy?.categories_are_candidates !== true) {
    throw new Error('The campaign must not freeze a surface ontology.');
  }
  if (Number(constitution.automation?.minimum_execution_share) < 0.5) throw new Error('Automation floor must be at least 50%.');
  if (constitution.round_contract?.aggregate_score_forbidden !== true) throw new Error('Aggregate-score masking must remain forbidden.');
  const roles = constitution.round_contract?.required_candidate_roles || [];
  if (roles.length < 6 || new Set(roles).size !== roles.length) throw new Error('A round requires at least six distinct candidate roles.');
  const commissions = constitution.commissions || [];
  const modalities = new Set(commissions.flatMap(item => item.modalities || []));
  for (const modality of ['image', 'speech', 'audio', 'music', 'world']) {
    if (!modalities.has(modality)) throw new Error(`Missing ${modality} commission coverage.`);
  }
  for (const commission of commissions) {
    if (!commission.id || !commission.brief || commission.hidden_tests?.length < 3 || commission.metrics?.length < 4) {
      throw new Error(`Incomplete commission: ${commission.id || 'unknown'}.`);
    }
  }
  return constitution;
}

function candidateDescription(role, random) {
  if (role === 'familiar-control') return pick(CONTROL_FORMS, random);
  if (role === 'assumption-inversion') return pick(INVERSION_FORMS, random);
  if (role === 'eccentric-transfer') return `${pick(RITUALS, random)} translated through ${pick(MEDIA, random)}`;
  if (role === 'loser-recombination') {
    const [left, right] = sample(LOSERS, 2, random);
    return `${left} recombined with ${right} while preserving only their strongest surviving behaviors`;
  }
  if (role === 'low-resource-offline') return pick(LOW_RESOURCE_FORMS, random);
  if (role === 'maximal-expressive-variance') return pick(EXPRESSIVE_FORMS, random);
  throw new Error(`Unknown candidate role: ${role}`);
}

function normViolation(role) {
  return {
    'familiar-control': 'none; this is the quality control',
    'assumption-inversion': 'the primary inherited navigation or interaction assumption',
    'eccentric-transfer': 'software must borrow only from software',
    'loser-recombination': 'losing candidates should be discarded rather than mined',
    'low-resource-offline': 'frontier expression requires continuous network and large compute',
    'maximal-expressive-variance': 'consensus usability should dominate personal divergence'
  }[role];
}

function automationShare(role) {
  return {
    'familiar-control': 0.55,
    'assumption-inversion': 0.72,
    'eccentric-transfer': 0.78,
    'loser-recombination': 0.81,
    'low-resource-offline': 0.64,
    'maximal-expressive-variance': 0.69
  }[role];
}

export function deriveRound(constitution, { seed = 0, round_id = `round-${seed}` } = {}) {
  validateConstitution(constitution);
  const random = randomSource(`${round_id}:${seed}:${digest(constitution)}`);
  const roles = constitution.round_contract.required_candidate_roles;
  const candidates = roles.map((role, index) => {
    const description = candidateDescription(role, random);
    const substrates = sample(SUBSTRATES, role === 'familiar-control' ? 3 : 4, random);
    const commissionIds = sample(constitution.commissions.map(item => item.id), 4, random);
    const candidate = {
      schema: 'frontier-surface-candidate/v1',
      candidate_id: `${round_id}-${String(index + 1).padStart(2, '0')}-${digest(`${role}:${description}`).slice(0, 8)}`,
      role,
      fixed_surface_category: null,
      described_as: description,
      violated_norm: normViolation(role),
      substrates,
      commission_ids: commissionIds,
      automation_share: automationShare(role),
      human_gates: constitution.automation.human_only_boundaries,
      evidence_state: 'unmeasured',
      promotion_state: 'ineligible',
      claim_boundary: 'Derived embodiment hypothesis only; no capability, preference, or promotion claim.'
    };
    return { ...candidate, candidate_digest: digest(candidate) };
  });
  const round = {
    schema: 'frontier-world-expo-round/v1',
    round_id,
    seed: Number(seed),
    constitution_digest: digest(constitution),
    automation_floor: constitution.automation.minimum_execution_share,
    mean_automation_share: candidates.reduce((sum, item) => sum + item.automation_share, 0) / candidates.length,
    aggregate_score_forbidden: true,
    exact_operating_envelope_required: true,
    candidates,
    promotion_state: 'awaiting-evidence',
    claim_boundary: 'Deterministic candidate round only; every candidate remains unmeasured and ineligible.'
  };
  return { ...round, round_digest: digest(round) };
}

function parseFlags(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags.set(value, true);
    else {
      flags.set(value, next);
      index += 1;
    }
  }
  return { flags, positionals };
}

async function writeJSON(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, canonicalJSON(value), 'utf8');
  return filename;
}

export async function materializeRound({ constitution, round, output_directory }) {
  validateConstitution(constitution);
  if (round?.schema !== 'frontier-world-expo-round/v1') throw new Error('Unsupported round manifest.');
  if (round.constitution_digest !== digest(constitution)) throw new Error('Round constitution drift detected.');
  const directory = path.resolve(output_directory);
  const expo = {
    schema: 'frontier-world-expo-materialization/v1',
    round_id: round.round_id,
    round_digest: round.round_digest,
    constitution_digest: round.constitution_digest,
    candidates: round.candidates,
    commissions: constitution.commissions,
    frontiers: constitution.evaluation_frontiers,
    evidence_schema: constitution.evidence_envelope,
    promotion_law: constitution.promotion_law,
    state: 'awaiting-artifacts-and-receipts'
  };
  const paths = [
    await writeJSON(path.join(directory, 'round.json'), round),
    await writeJSON(path.join(directory, 'expo.json'), { ...expo, materialization_digest: digest(expo) })
  ];
  for (const candidate of round.candidates) {
    const placeholder = {
      schema: constitution.evidence_envelope.schema,
      candidate_id: candidate.candidate_id,
      exhibit_id: null,
      state: 'missing-required-evidence',
      required_fields: constitution.evidence_envelope.required,
      claim_boundary: 'Placeholder only; this is not an evidence receipt.'
    };
    paths.push(await writeJSON(path.join(directory, 'evidence', `${candidate.candidate_id}.json`), placeholder));
  }
  return {
    schema: 'frontier-world-expo-materialize-result/v1',
    output_directory: directory,
    round_id: round.round_id,
    round_digest: round.round_digest,
    candidates: round.candidates.length,
    commissions: constitution.commissions.length,
    evidence_placeholders: round.candidates.length,
    created_paths: paths
  };
}

export async function status(directory) {
  const root = path.resolve(directory);
  const expo = JSON.parse(await fs.readFile(path.join(root, 'expo.json'), 'utf8'));
  const evidenceDirectory = path.join(root, 'evidence');
  const files = await fs.readdir(evidenceDirectory);
  const evidence = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await fs.readFile(path.join(evidenceDirectory, name), 'utf8'))));
  const complete = evidence.filter(item => item.state === 'complete').length;
  return {
    schema: 'frontier-world-expo-status/v1',
    round_id: expo.round_id,
    candidates: expo.candidates.length,
    commissions: expo.commissions.length,
    complete_evidence_envelopes: complete,
    missing_evidence_envelopes: expo.candidates.length - complete,
    promotion_state: complete === expo.candidates.length ? 'eligible-for-frontier-comparison' : 'blocked-on-evidence',
    aggregate_score_forbidden: expo.promotion_law?.winner_selection === 'pareto-frontier-by-exact-operating-envelope'
  };
}

function usage() {
  return `Frontier World Expo\n\nUsage:\n  node scripts/frontier-world-expo.mjs derive [--seed 7] [--round round-7] [--constitution path] [--output path]\n  node scripts/frontier-world-expo.mjs materialize --round-file path [--constitution path] [--output directory]\n  node scripts/frontier-world-expo.mjs status --directory path\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positionals } = parseFlags(argv);
  const command = positionals[0] || 'help';
  if (command === 'help' || flags.has('--help')) {
    process.stdout.write(usage());
    return;
  }
  if (command === 'derive') {
    const constitution = await readConstitution(flags.get('--constitution') || DEFAULT_CONSTITUTION);
    const seed = Number(flags.get('--seed') || 0);
    if (!Number.isFinite(seed)) throw new Error('--seed must be numeric.');
    const round = deriveRound(constitution, { seed, round_id: flags.get('--round') || `round-${seed}` });
    if (flags.get('--output')) await writeJSON(path.resolve(flags.get('--output')), round);
    process.stdout.write(canonicalJSON(round));
    return;
  }
  if (command === 'materialize') {
    const roundFile = flags.get('--round-file');
    if (!roundFile) throw new Error('materialize requires --round-file.');
    const constitution = await readConstitution(flags.get('--constitution') || DEFAULT_CONSTITUTION);
    const round = JSON.parse(await fs.readFile(path.resolve(roundFile), 'utf8'));
    const output = flags.get('--output') || path.join(DEFAULT_OUTPUT_ROOT, round.round_id);
    process.stdout.write(canonicalJSON(await materializeRound({ constitution, round, output_directory: output })));
    return;
  }
  if (command === 'status') {
    const directory = flags.get('--directory');
    if (!directory) throw new Error('status requires --directory.');
    process.stdout.write(canonicalJSON(await status(directory)));
    return;
  }
  throw new Error(`Unknown command: ${command}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
