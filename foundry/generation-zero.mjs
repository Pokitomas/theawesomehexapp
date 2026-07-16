#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  buildExperimentPortfolio,
  createAssignments,
  createReceipt,
  digest,
  evaluateAdmission,
  integrateReports,
  stableJSONStringify
} from './core.mjs';
import {
  generationZeroGenomes,
  generationZeroMission,
  generationZeroReports,
  lawfulCorpusPlan,
  validateGenerationZeroMission
} from './generation-zero-data.mjs';
import { runGenerationZeroProxies } from './generation-zero-proxy.mjs';

export { generationZeroGenomes, generationZeroMission, generationZeroReports, lawfulCorpusPlan, runGenerationZeroProxies, validateGenerationZeroMission };

const execFileAsync = promisify(execFile);
const ARTIFACT_MANIFEST = 'artifact-manifest.json';
const REQUIRED_ARTIFACTS = Object.freeze([
  'mission.json',
  'assignments.json',
  'reports.json',
  'integration.json',
  'portfolio.json',
  'genomes.json',
  'proxy-results.json',
  'negative-results.json',
  'corpus-plan.json',
  'receipt.json'
]);

function serialized(value) {
  return `${stableJSONStringify(value)}\n`;
}

function artifactDescriptor(value) {
  const text = serialized(value);
  return Object.freeze({ sha256: digest(value), bytes: Buffer.byteLength(text) });
}

function buildArtifactManifest(outputs, codeRevision) {
  const artifacts = Object.fromEntries(Object.entries(outputs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [name, artifactDescriptor(value)]));
  return Object.freeze({
    schema: 'sideways-foundry-artifact-manifest/v1',
    generation: 0,
    code_revision: codeRevision,
    complete: true,
    artifacts,
    protocol_receipt_digest: outputs['receipt.json'].receipt_digest,
    generation_receipt_digest: outputs['receipt.json'].generation_receipt_digest
  });
}

async function writeAtomicText(filename, text) {
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function writeArtifactBundle(target, outputs) {
  await fs.mkdir(target, { recursive: true });
  await fs.rm(path.join(target, ARTIFACT_MANIFEST), { force: true });
  for (const [name, value] of Object.entries(outputs).filter(([name]) => name !== ARTIFACT_MANIFEST).sort(([left], [right]) => left.localeCompare(right))) {
    await writeAtomicText(path.join(target, name), serialized(value));
  }
  await writeAtomicText(path.join(target, ARTIFACT_MANIFEST), serialized(outputs[ARTIFACT_MANIFEST]));
}

export async function verifyGenerationZeroArtifactBundle(outDir) {
  const target = path.resolve(outDir);
  const manifest = JSON.parse(await fs.readFile(path.join(target, ARTIFACT_MANIFEST), 'utf8'));
  if (manifest?.schema !== 'sideways-foundry-artifact-manifest/v1' || manifest.complete !== true) {
    throw new Error('Generation-zero artifact manifest is missing, incomplete, or unsupported.');
  }
  if (!/^[0-9a-f]{40}$/i.test(String(manifest.code_revision || ''))) {
    throw new Error('Generation-zero artifact manifest has an invalid code revision.');
  }
  for (const required of REQUIRED_ARTIFACTS) {
    if (!manifest.artifacts?.[required]) throw new Error(`Generation-zero artifact manifest is missing ${required}.`);
  }
  const verifiedFiles = [];
  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    if (path.basename(name) !== name || name === ARTIFACT_MANIFEST) throw new Error(`Unsafe generation-zero artifact name: ${name}.`);
    const text = await fs.readFile(path.join(target, name), 'utf8');
    if (Buffer.byteLength(text) !== expected.bytes) throw new Error(`Generation-zero artifact byte mismatch: ${name}.`);
    const parsed = JSON.parse(text);
    if (digest(parsed) !== expected.sha256) throw new Error(`Generation-zero artifact digest mismatch: ${name}.`);
    verifiedFiles.push(name);
  }
  const receipt = JSON.parse(await fs.readFile(path.join(target, 'receipt.json'), 'utf8'));
  if (receipt.code_revision !== manifest.code_revision) throw new Error('Generation-zero receipt and manifest revisions differ.');
  if (receipt.receipt_digest !== manifest.protocol_receipt_digest) throw new Error('Generation-zero protocol receipt digest differs from the manifest.');
  if (receipt.generation_receipt_digest !== manifest.generation_receipt_digest) throw new Error('Generation-zero full receipt digest differs from the manifest.');
  return Object.freeze({ manifest: Object.freeze(manifest), verified_files: Object.freeze(verifiedFiles.sort()) });
}

function executedPortfolio(portfolio, proxyResults) {
  const resultByCandidate = new Map(proxyResults.map(result => [result.candidate_id, result]));
  return {
    ...portfolio,
    selected: portfolio.selected.map(item => {
      const result = resultByCandidate.get(item.candidate_id);
      return result ? { ...item, state: 'executed', execution_scope: 'generation-zero-proxy-only', proxy_result_id: result.result_id, proxy_status: result.status } : item;
    }),
    winner: null
  };
}

function cheapestByDistance(candidates, costFor) {
  return ['conservative', 'adjacent', 'heretical'].map(distance => candidates
    .filter(candidate => candidate.distance === distance)
    .sort((left, right) => costFor(left) - costFor(right) || left.candidate_id.localeCompare(right.candidate_id))[0]);
}

function generationZeroPortfolioBudget(integration, declaredBudget) {
  const required = cheapestByDistance(integration.candidates, candidate => candidate.cost);
  if (required.some(candidate => !candidate)) return declaredBudget;
  const calibratedRequired = required.reduce((total, candidate) => total + candidate.cost, 0);
  if (calibratedRequired <= declaredBudget) return declaredBudget;

  const rawCost = candidate => Math.min(...candidate.cost_estimates.map(estimate => estimate.raw_estimate));
  const rawRequired = cheapestByDistance(integration.candidates, rawCost)
    .reduce((total, candidate) => total + rawCost(candidate), 0);

  return rawRequired <= declaredBudget ? calibratedRequired : declaredBudget;
}

async function resolveRevision(cwd = process.cwd()) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    const value = stdout.trim();
    if (/^[0-9a-f]{40}$/i.test(value)) return value;
  } catch {}
  throw new Error('A full --code-revision is required outside a git checkout.');
}

export async function runGenerationZero({
  out_dir,
  code_revision,
  mission: missionInput = generationZeroMission(),
  clock,
  memory_usage
} = {}) {
  const mission = validateGenerationZeroMission(missionInput);
  const assignments = createAssignments(mission);
  const reports = generationZeroReports(mission);
  const integration = integrateReports(reports, assignments);
  const portfolioBudget = generationZeroPortfolioBudget(integration, mission.budget.proxy_compute_units);
  const portfolio = buildExperimentPortfolio(integration, { budget: portfolioBudget, require_strata: true });
  const revision = code_revision || await resolveRevision();
  const genomes = generationZeroGenomes(revision);
  const selectedIds = new Set(portfolio.selected.map(item => item.candidate_id));
  const selectedGenomes = genomes.filter(genome => selectedIds.has(genome.identity.candidate_id));
  const proxyResults = runGenerationZeroProxies({ genomes: selectedGenomes, clock, memory_usage });
  const finalPortfolio = executedPortfolio(portfolio, proxyResults);
  const admissions = proxyResults.map(result => evaluateAdmission({ candidate_id: result.candidate_id }, {
    matched_compute: false,
    hidden_evaluation_passed: false,
    reproduced_seeds: result.per_seed.length,
    broad_regression_passed: false,
    critical_sabotage_findings: [],
    resource_receipt: result.resource_receipt,
    demonstrated_claims: [],
    unverified_claims: [
      'proxy survivor improves broad capability',
      'proxy survivor scales to internet-scale training',
      'proxy survivor is locally deployable'
    ]
  }));
  const negativeResults = {
    schema: 'sideways-foundry-negative-results/v1',
    retained: proxyResults.filter(result => result.status.startsWith('falsified')).map(result => ({
      candidate_id: result.candidate_id,
      reasons: result.reasons,
      metrics: result.metrics
    })),
    deferred: finalPortfolio.deferred,
    admission_blocks: admissions.filter(item => !item.admitted).map(item => ({ candidate_id: item.candidate_id, reasons: item.reasons })),
    deletion_policy: 'never discard a valid failed proxy solely because it is inconvenient'
  };
  const corpusPlan = lawfulCorpusPlan();
  const receipt = createReceipt({
    mission,
    assignments,
    integration,
    portfolio: finalPortfolio,
    admissions,
    commands: ['node foundry/generation-zero.mjs --out <directory> --code-revision <40-char-sha>'],
    artifacts: [...REQUIRED_ARTIFACTS, ARTIFACT_MANIFEST]
  });
  const finalReceiptBody = {
    ...receipt,
    generation: 0,
    code_revision: revision,
    proxy_survivors: proxyResults.filter(result => result.status.startsWith('survived')).map(result => result.candidate_id),
    proxy_falsified: proxyResults.filter(result => result.status.startsWith('falsified')).map(result => result.candidate_id),
    final_model_weights_trained: false,
    corpus_acquired: false,
    architecture_selected: false,
    winner_selected: false,
    claim_boundary: 'Generation zero produced an architecture-neutral portfolio and executed bounded deterministic falsification probes. It did not train or select a foundation model.'
  };
  const finalReceipt = { ...finalReceiptBody, generation_receipt_digest: digest(finalReceiptBody) };
  const baseOutputs = {
    'mission.json': mission,
    'assignments.json': assignments,
    'reports.json': reports,
    'integration.json': integration,
    'portfolio.json': finalPortfolio,
    'genomes.json': genomes,
    'proxy-results.json': proxyResults,
    'negative-results.json': negativeResults,
    'corpus-plan.json': corpusPlan,
    'receipt.json': finalReceipt
  };
  const artifactManifest = buildArtifactManifest(baseOutputs, revision);
  const outputs = { ...baseOutputs, [ARTIFACT_MANIFEST]: artifactManifest };
  if (out_dir) await writeArtifactBundle(path.resolve(out_dir), outputs);
  return Object.freeze({ mission, assignments, reports, integration, portfolio: finalPortfolio, genomes, proxy_results: proxyResults, negative_results: negativeResults, corpus_plan: corpusPlan, admissions, receipt: finalReceipt, outputs });
}

function valueFor(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? '' : String(args[index + 1] || '').trim();
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = valueFor(args, '--out') || path.join(process.cwd(), '.foundry-runs', 'generation-zero');
  const codeRevision = valueFor(args, '--code-revision') || undefined;
  const result = await runGenerationZero({ out_dir: outDir, code_revision: codeRevision });
  console.log(stableJSONStringify({
    ok: true,
    output_dir: path.resolve(outDir),
    candidates: result.integration.candidates.length,
    selected_proxies: result.proxy_results.length,
    proxy_survivors: result.receipt.proxy_survivors,
    proxy_falsified: result.receipt.proxy_falsified,
    winner_selected: false,
    final_model_weights_trained: false,
    receipt_digest: result.receipt.generation_receipt_digest,
    protocol_receipt_digest: result.receipt.receipt_digest,
    generation_receipt_digest: result.receipt.generation_receipt_digest,
    artifact_manifest_digest: digest(result.outputs[ARTIFACT_MANIFEST])
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(stableJSONStringify({ ok: false, error: String(error?.stack || error?.message || error) }));
    process.exitCode = 1;
  });
}
