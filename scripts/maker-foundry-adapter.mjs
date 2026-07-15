import fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from './maker-engine.mjs';

const REGISTRY_SCHEMA = 'sideways-maker-model-registry/v1';
const ADMISSION_SCHEMA = 'sideways-maker-model-admission/v1';
const PROVIDER_SCHEMA = 'sideways-maker-provider-selection/v1';
const clean = (value, limit = 4000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

async function readJSON(directory, name) {
  return JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
}

function finitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

export async function readFoundryGeneration(outDir) {
  const target = path.resolve(outDir);
  const { verifyGenerationZeroArtifactBundle } = await import('../foundry/generation-zero.mjs');
  const verified = await verifyGenerationZeroArtifactBundle(target);
  const [genomes, proxies, portfolio, negatives, receipt] = await Promise.all([
    readJSON(target, 'genomes.json'),
    readJSON(target, 'proxy-results.json'),
    readJSON(target, 'portfolio.json'),
    readJSON(target, 'negative-results.json'),
    readJSON(target, 'receipt.json')
  ]);
  return Object.freeze({ target, verified, genomes, proxies, portfolio, negatives, receipt });
}

export function evaluateNativeCheckpoint(input = {}) {
  const reasons = [];
  const checkpoint = input.checkpoint || {};
  const evaluation = input.evaluation || {};
  if (!clean(checkpoint.id, 300)) reasons.push('checkpoint id is missing');
  if (!/^[0-9a-f]{64}$/i.test(clean(checkpoint.sha256, 64))) reasons.push('checkpoint digest is missing or invalid');
  if (!/^[0-9a-f]{40}$/i.test(clean(checkpoint.code_revision, 40))) reasons.push('checkpoint code revision is missing or invalid');
  if (!finitePositive(checkpoint.weights_bytes)) reasons.push('checkpoint has no finite positive weight size');
  if (!clean(checkpoint.format, 100)) reasons.push('checkpoint format is missing');
  if (!clean(checkpoint.license, 300)) reasons.push('checkpoint license is missing');
  if (!clean(checkpoint.provenance, 1000)) reasons.push('checkpoint provenance is missing');
  if (checkpoint.reproducible !== true) reasons.push('checkpoint is not marked reproducible');
  if (evaluation.schema !== 'sideways-maker-engineering-evaluation/v1') reasons.push('engineering evaluation schema is missing or unsupported');
  if (evaluation.matched_tasks !== true) reasons.push('engineering evaluation did not use matched tasks');
  if (evaluation.hidden_evaluation_passed !== true) reasons.push('hidden engineering evaluation did not pass');
  if (evaluation.tool_use_correctness_passed !== true) reasons.push('tool-use correctness did not pass');
  if (evaluation.regression_suite_passed !== true) reasons.push('broad regression suite did not pass');
  if (Number(evaluation.reproduced_seeds || 0) < 2) reasons.push('fewer than two evaluation seeds reproduced');
  for (const field of ['wall_time_ms', 'peak_rss_bytes', 'input_bytes', 'output_bytes']) {
    if (!finitePositive(evaluation.resources?.[field])) reasons.push(`evaluation resource ${field} is missing or non-positive`);
  }
  const body = {
    schema: ADMISSION_SCHEMA,
    candidate_id: clean(input.candidate_id, 300),
    checkpoint_id: clean(checkpoint.id, 300) || null,
    admitted: reasons.length === 0,
    reasons,
    checkpoint_digest: clean(checkpoint.sha256, 64) || null,
    code_revision: clean(checkpoint.code_revision, 40) || null,
    evaluation_digest: evaluation && Object.keys(evaluation).length ? digest(evaluation) : null
  };
  return Object.freeze({ ...body, admission_digest: digest(body) });
}

export function buildMakerModelRegistry({ generation, checkpoints = [], evaluations = [] } = {}) {
  if (!generation?.receipt) throw new Error('A verified Foundry generation is required.');
  const proxyByCandidate = new Map((generation.proxies || []).map(value => [value.candidate_id, value]));
  const checkpointByCandidate = new Map(checkpoints.map(value => [value.candidate_id, value]));
  const evaluationByCandidate = new Map(evaluations.map(value => [value.candidate_id, value]));
  const candidates = (generation.genomes || []).map(genome => {
    const candidateId = genome.identity?.candidate_id;
    const proxy = proxyByCandidate.get(candidateId) || null;
    const checkpoint = checkpointByCandidate.get(candidateId) || null;
    const evaluation = evaluationByCandidate.get(candidateId) || null;
    const admission = checkpoint
      ? evaluateNativeCheckpoint({ candidate_id: candidateId, checkpoint, evaluation })
      : Object.freeze({ schema: ADMISSION_SCHEMA, candidate_id: candidateId, checkpoint_id: null, admitted: false, reasons: ['no reproducible checkpoint supplied'], checkpoint_digest: null, code_revision: null, evaluation_digest: null, admission_digest: null });
    const state = admission.admitted ? 'admitted-runnable-model' : checkpoint ? 'checkpoint-rejected' : proxy ? 'proxy-only' : 'proposal-only';
    return Object.freeze({
      candidate_id: candidateId,
      family: clean(genome.identity?.family || genome.family, 300),
      state,
      proxy_status: proxy?.status || null,
      proxy_result_id: proxy?.result_id || null,
      checkpoint_id: checkpoint?.id || null,
      admission
    });
  });
  const body = {
    schema: REGISTRY_SCHEMA,
    generation: Number(generation.receipt.generation),
    code_revision: generation.receipt.code_revision,
    artifact_manifest_digest: digest(generation.verified.manifest),
    claim_boundary: generation.receipt.claim_boundary,
    final_model_weights_trained: generation.receipt.final_model_weights_trained === true,
    candidates,
    admitted_native_models: candidates.filter(value => value.admission.admitted).map(value => value.candidate_id),
    negative_results_retained: Array.isArray(generation.negatives?.retained) ? generation.negatives.retained.length : 0
  };
  return Object.freeze({ ...body, registry_digest: digest(body) });
}

export function selectMakerProvider({ registry, requested = 'auto', providers = [] } = {}) {
  if (registry?.schema !== REGISTRY_SCHEMA) throw new Error('Maker provider selection requires a model registry.');
  const available = providers.filter(value => value?.available === true).map(value => ({
    id: clean(value.id, 200),
    kind: clean(value.kind, 80),
    model: clean(value.model, 300),
    endpoint_host: clean(value.endpoint_host, 300),
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(item => clean(item, 100)).filter(Boolean) : []
  })).filter(value => value.id);
  const native = registry.candidates.find(value => value.admission.admitted);
  let selected = null;
  let degraded = false;
  const reasons = [];
  if ((requested === 'auto' || requested === 'native') && native) {
    selected = { id: `native:${native.candidate_id}`, kind: 'native', model: native.checkpoint_id, endpoint_host: 'local', capabilities: ['engineering'] };
  } else if (requested === 'native') {
    degraded = true;
    reasons.push('no admitted native checkpoint exists');
  }
  if (!selected) {
    selected = requested === 'auto' ? available[0] : available.find(value => value.id === requested);
    if (!selected) {
      degraded = true;
      reasons.push(requested === 'auto' ? 'no configured provider is available' : `requested provider is unavailable: ${requested}`);
    } else if (!native) {
      degraded = true;
      reasons.push('using configured provider because Foundry has no admitted native checkpoint');
    }
  }
  const body = {
    schema: PROVIDER_SCHEMA,
    requested,
    selected,
    degraded,
    reasons,
    native_candidates: registry.candidates.length,
    admitted_native_models: registry.admitted_native_models
  };
  return Object.freeze({ ...body, selection_digest: digest(body) });
}

export const MAKER_MODEL_REGISTRY_SCHEMA = REGISTRY_SCHEMA;
export const MAKER_MODEL_ADMISSION_SCHEMA = ADMISSION_SCHEMA;
export const MAKER_PROVIDER_SELECTION_SCHEMA = PROVIDER_SCHEMA;
