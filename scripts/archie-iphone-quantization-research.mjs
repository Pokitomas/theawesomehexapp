#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runDeviceEvidenceCampaign } from './archie-device-evidence.mjs';

export const ARCHIE_IPHONE_RESEARCH_TEMPLATE_SCHEMA = 'archie-iphone-quantization-template/v2';
export const ARCHIE_IPHONE_RESEARCH_PLAN_SCHEMA = 'archie-iphone-quantization-plan/v2';
export const ARCHIE_IPHONE_RESEARCH_RESULT_SCHEMA = 'archie-iphone-quantization-result/v2';
export const ARCHIE_IPHONE_AUTHORITY_SCHEMA = 'archie-iphone-measurement-authorities/v1';
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const IOS_BUILD = /^\d{2}[A-Z]\d{2,4}[a-z]?$/;
const gib = value => Math.round(value * 1024 ** 3);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const object = (value, field) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`); return value; };
const text = (value, field, limit = 2000) => { const out = String(value ?? '').replace(/\u0000/g, '').trim(); if (!out || out.length > limit) throw new Error(`${field} is required and must be <= ${limit} characters.`); return out; };
const id = (value, field) => { const out = text(value, field, 200); if (!ID.test(out)) throw new Error(`${field} must be a portable identifier.`); return out; };
const hash = (value, field) => { const out = text(value, field, 64).toLowerCase(); if (!HEX.test(out)) throw new Error(`${field} must be a SHA-256 digest.`); return out; };
const integer = (value, field, minimum = 0) => { const out = Number(value); if (!Number.isSafeInteger(out) || out < minimum) throw new Error(`${field} must be an integer >= ${minimum}.`); return out; };
const descriptor = (input, field) => { const value = object(input, field); return Object.freeze({ path: text(value.path, `${field}.path`, 1000), sha256: hash(value.sha256, `${field}.sha256`), bytes: integer(value.bytes, `${field}.bytes`, 1) }); };

export const CANONICAL_IPHONE_TARGET = Object.freeze({
  id: 'iphone-a15-4gb-floor-v2', os_family: 'ios', minimum_os_major: 18,
  required_device_identifiers: Object.freeze(['iphone14,6']), architecture: 'arm64', silicon: 'a15', physical_ram_bytes: gib(4),
  maximum_artifact_bytes: gib(2.2), maximum_peak_rss_bytes: gib(2.65), minimum_context_tokens: 4096,
  minimum_quality_retention: 0.94, minimum_task_success_rate: 0.80, maximum_crash_rate: 0.01,
  maximum_first_token_ms_p95: 1800, maximum_decode_ms_per_token_p95: 125, minimum_sustained_tokens_per_second_p50: 8,
  maximum_sustained_power_watts_p95: 5.5, maximum_thermal_throttle_rate: 0.08,
  minimum_sustained_duration_ms: 900000, minimum_sample_count: 40,
  required_workloads: Object.freeze(['answer', 'planning', 'tool-routing']),
  required_conditions: Object.freeze(['cold-launch', 'warm-run', 'low-power-mode', 'memory-pressure', 'background-interruption', 'offline-first-launch']),
  required_events: Object.freeze(['artifact-verified', 'runtime-loaded', 'cold-answer-completed', 'warm-answer-completed', 'thermal-sample-recorded', 'memory-pressure-observed', 'interruption-recovered', 'raw-trace-sealed'])
});
export const CANONICAL_IPHONE_TARGET_DIGEST = digest(CANONICAL_IPHONE_TARGET);

const designs = [
  ['mlx-q4-g32','mlx','grouped',4,32],['mlx-q4-g64','mlx','grouped',4,64],['mlx-q6-g32','mlx','grouped',6,32],['mlx-q6-g64','mlx','grouped',6,64],
  ['coreml-pal4-g16','coreml','palettization',4,16],['coreml-pal4-g32','coreml','palettization',4,32],['coreml-pal6-g16','coreml','palettization',6,16],['coreml-pal8-g16','coreml','palettization',8,16],
  ['coreml-linear4','coreml','linear-weight',4,null],['coreml-linear8','coreml','linear-weight',8,null],['coreml-block4-g32','coreml','per-block',4,32],['coreml-prune-pal4','coreml','prune-plus-palettize',4,32],
  ['gguf-q4-k-m','gguf','k-quantization',4,null],['gguf-q5-k-m','gguf','k-quantization',5,null],['gguf-q6-k','gguf','k-quantization',6,null],['gguf-q8-0','gguf','linear',8,null],
  ['retrieval-specialist-coreml4','system','retrieval-plus-local-specialist',4,null],['draft-main-coreml4','system','speculative-draft-main',4,null]
];
export const CANONICAL_IPHONE_DESIGNS = Object.freeze(designs.map(([id, backend, method, bits, group_size]) => Object.freeze({ id, backend, method, bits, group_size })));
export const CANONICAL_IPHONE_DESIGNS_DIGEST = digest(CANONICAL_IPHONE_DESIGNS);
const byDesign = new Map(CANONICAL_IPHONE_DESIGNS.map(value => [value.id, value]));

function normalizeCandidate(input, index) {
  const field = `candidates[${index}]`; const value = object(input, field); const design = byDesign.get(id(value.design_id, `${field}.design_id`));
  if (!design) throw new Error(`${field}.design_id is not in the canonical search matrix.`);
  const model = object(value.model, `${field}.model`); const runtime = object(value.runtime, `${field}.runtime`); const benchmark = object(value.benchmark, `${field}.benchmark`);
  return Object.freeze({
    id: id(value.id, `${field}.id`), design,
    model: Object.freeze({ id: id(model.id, `${field}.model.id`), revision_sha256: hash(model.revision_sha256, `${field}.model.revision_sha256`), artifact: descriptor(model.artifact, `${field}.model.artifact`) }),
    runtime: Object.freeze({ id: id(runtime.id, `${field}.runtime.id`), executable: descriptor(runtime.executable, `${field}.runtime.executable`), build_sha256: hash(runtime.build_sha256, `${field}.runtime.build_sha256`), dependency_lock_sha256: hash(runtime.dependency_lock_sha256, `${field}.runtime.dependency_lock_sha256`), compiler_receipt_sha256: hash(runtime.compiler_receipt_sha256, `${field}.runtime.compiler_receipt_sha256`) }),
    benchmark: Object.freeze({ hidden_split_sha256: hash(benchmark.hidden_split_sha256, `${field}.benchmark.hidden_split_sha256`), grader_sha256: hash(benchmark.grader_sha256, `${field}.benchmark.grader_sha256`), workload_set_sha256: hash(benchmark.workload_set_sha256, `${field}.benchmark.workload_set_sha256`), corpus: descriptor(benchmark.corpus, `${field}.benchmark.corpus`) }),
    binding_file: descriptor(value.binding_file, `${field}.binding_file`), evidence_campaign: descriptor(value.evidence_campaign, `${field}.evidence_campaign`), authority_id: id(value.authority_id, `${field}.authority_id`)
  });
}
export function validateIPhoneResearchPlan(input) {
  const value = object(input, 'plan');
  if (value.schema !== ARCHIE_IPHONE_RESEARCH_PLAN_SCHEMA) throw new Error(`plan.schema must equal ${ARCHIE_IPHONE_RESEARCH_PLAN_SCHEMA}.`);
  if (hash(value.target_digest, 'plan.target_digest') !== CANONICAL_IPHONE_TARGET_DIGEST) throw new Error('plan.target_digest must bind the immutable repository target.');
  if (hash(value.search_digest, 'plan.search_digest') !== CANONICAL_IPHONE_DESIGNS_DIGEST) throw new Error('plan.search_digest must bind the immutable repository search matrix.');
  if ('target' in value || 'thresholds' in value || 'required_workloads' in value) throw new Error('Plans cannot redefine the target, thresholds, or workloads.');
  const candidates = (value.candidates || []).map(normalizeCandidate);
  if (!candidates.length || new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) throw new Error('plan.candidates must be nonempty and unique.');
  const body = { schema: ARCHIE_IPHONE_RESEARCH_PLAN_SCHEMA, id: id(value.id, 'plan.id'), target_digest: CANONICAL_IPHONE_TARGET_DIGEST, search_digest: CANONICAL_IPHONE_DESIGNS_DIGEST, candidates, claim_boundary: text(value.claim_boundary || 'No model is iPhone-ready without fresh canonical device evidence and an enrolled measurement authority.', 'plan.claim_boundary') };
  return Object.freeze({ ...body, plan_digest: digest(body) });
}

async function verifyDescriptor(root, item, field) {
  const filename = path.resolve(root, item.path); const relative = path.relative(path.resolve(root), filename);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${field}.path escapes the plan root.`);
  const stat = await fs.stat(filename); if (!stat.isFile() || stat.size !== item.bytes) throw new Error(`${field} byte count mismatch.`);
  const observed = crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex'); if (observed !== item.sha256) throw new Error(`${field} digest mismatch.`);
  return filename;
}
function expectedBindings(candidate) {
  return Object.freeze({ candidate_id: candidate.id, design_id: candidate.design.id, design_digest: digest(candidate.design), model_id: candidate.model.id, model_revision_sha256: candidate.model.revision_sha256, model_artifact_sha256: candidate.model.artifact.sha256, runtime_id: candidate.runtime.id, runtime_executable_sha256: candidate.runtime.executable.sha256, runtime_build_sha256: candidate.runtime.build_sha256, dependency_lock_sha256: candidate.runtime.dependency_lock_sha256, compiler_receipt_sha256: candidate.runtime.compiler_receipt_sha256, hidden_split_sha256: candidate.benchmark.hidden_split_sha256, grader_sha256: candidate.benchmark.grader_sha256, workload_set_sha256: candidate.benchmark.workload_set_sha256, target_digest: CANONICAL_IPHONE_TARGET_DIGEST, search_digest: CANONICAL_IPHONE_DESIGNS_DIGEST });
}
function canonicalGates() {
  const t = CANONICAL_IPHONE_TARGET; return Object.freeze({ artifact_bytes_max: t.maximum_artifact_bytes, peak_rss_bytes_max: t.maximum_peak_rss_bytes, context_tokens_min: t.minimum_context_tokens, quality_retention_min: t.minimum_quality_retention, task_success_rate_min: t.minimum_task_success_rate, crash_rate_max: t.maximum_crash_rate, first_token_ms_p95_max: t.maximum_first_token_ms_p95, decode_ms_per_token_p95_max: t.maximum_decode_ms_per_token_p95, sustained_tokens_per_second_p50_min: t.minimum_sustained_tokens_per_second_p50, sustained_power_watts_p95_max: t.maximum_sustained_power_watts_p95, thermal_throttle_rate_max: t.maximum_thermal_throttle_rate, sustained_duration_ms_min: t.minimum_sustained_duration_ms, sample_count_min: t.minimum_sample_count });
}
function sameObject(a, b) { return digest(a) === digest(b); }
function assertCanonicalCampaign(candidate, campaign) {
  const machine = object(campaign.machine, 'campaign.machine');
  if (machine.hardware?.device_class !== 'iphone14,6' || machine.hardware?.architecture !== 'arm64' || machine.hardware?.ram_bytes !== CANONICAL_IPHONE_TARGET.physical_ram_bytes) throw new Error('Campaign machine is not the exact A15/4 GB floor.');
  if (String(machine.operating_system?.family).toLowerCase() !== 'ios') throw new Error('Campaign OS must be iOS.');
  const [version, build] = String(machine.operating_system?.version || '').split(' '); if (!/^\d+\.\d+(?:\.\d+)?$/.test(version) || Number(version.split('.')[0]) < 18 || !IOS_BUILD.test(build || '')) throw new Error('Campaign requires an exact iOS version and build number.');
  if (!Array.isArray(campaign.probes) || campaign.probes.length !== 1) throw new Error('Each candidate requires exactly one canonical probe.');
  const probe = campaign.probes[0]; if (probe.capability_id !== `archie-iphone-candidate:${candidate.id}`) throw new Error('Campaign capability does not bind the candidate.');
  if (!sameObject(probe.gates, canonicalGates())) throw new Error('Campaign gates differ from the immutable target.');
  if (!sameObject(probe.required_events, CANONICAL_IPHONE_TARGET.required_events)) throw new Error('Campaign events differ from the immutable target.');
  if (probe.command?.executable?.sha256 !== candidate.runtime.executable.sha256) throw new Error('Campaign executable does not bind the runtime.');
  const bound = new Set((probe.command?.bound_files || []).map(file => file.sha256));
  for (const required of [candidate.binding_file.sha256, candidate.model.artifact.sha256, candidate.benchmark.corpus.sha256]) if (!bound.has(required)) throw new Error(`Campaign omits required bound file ${required}.`);
}
async function loadAuthorities(filename) {
  const manifest = JSON.parse(await fs.readFile(filename, 'utf8')); if (manifest.schema !== ARCHIE_IPHONE_AUTHORITY_SCHEMA) throw new Error('Unsupported measurement authority manifest.');
  return manifest;
}
function attest(packageDigest, candidate, authority, privateKeyPem) {
  if (!privateKeyPem) return null;
  const publicPem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString().trim();
  if (publicPem !== String(authority.public_key_pem || '').trim()) throw new Error(`Private key does not match enrolled authority ${authority.id}.`);
  const body = { schema: 'archie-iphone-measurement-attestation/v1', authority_id: authority.id, candidate_id: candidate.id, package_digest: packageDigest, binding_digest: digest(expectedBindings(candidate)), issued_at: new Date().toISOString() };
  return Object.freeze({ ...body, signature: crypto.sign(null, Buffer.from(digest(body), 'hex'), privateKeyPem).toString('base64') });
}
function verifyAttestation(attestation, packageDigest, candidate, authority) {
  if (!attestation) return false; const body = { ...attestation }; delete body.signature;
  if (body.package_digest !== packageDigest || body.candidate_id !== candidate.id || body.binding_digest !== digest(expectedBindings(candidate))) return false;
  return crypto.verify(null, Buffer.from(digest(body), 'hex'), authority.public_key_pem, Buffer.from(attestation.signature, 'base64'));
}
function dominates(a, b) { const am = a.capability.metrics, bm = b.capability.metrics; return am.quality_retention >= bm.quality_retention && am.task_success_rate >= bm.task_success_rate && am.sustained_tokens_per_second_p50 >= bm.sustained_tokens_per_second_p50 && am.peak_rss_bytes <= bm.peak_rss_bytes && am.sustained_power_watts_p95 <= bm.sustained_power_watts_p95 && (am.quality_retention > bm.quality_retention || am.task_success_rate > bm.task_success_rate || am.sustained_tokens_per_second_p50 > bm.sustained_tokens_per_second_p50 || am.peak_rss_bytes < bm.peak_rss_bytes || am.sustained_power_watts_p95 < bm.sustained_power_watts_p95); }

export async function evaluateIPhoneResearch(input, { root = '.', authorityManifestPath = 'product/archie-iphone-measurement-authorities.json', authorityPrivateKeyPem = null } = {}) {
  const plan = validateIPhoneResearchPlan(input); const base = path.resolve(root); const authorities = await loadAuthorities(path.resolve(authorityManifestPath)); const evaluations = [];
  for (const candidate of plan.candidates) {
    try {
      await verifyDescriptor(base, candidate.binding_file, 'candidate.binding_file'); await verifyDescriptor(base, candidate.model.artifact, 'candidate.model.artifact'); await verifyDescriptor(base, candidate.runtime.executable, 'candidate.runtime.executable'); await verifyDescriptor(base, candidate.benchmark.corpus, 'candidate.benchmark.corpus');
      const binding = JSON.parse(await fs.readFile(path.resolve(base, candidate.binding_file.path), 'utf8')); if (!sameObject(binding, expectedBindings(candidate))) throw new Error('Candidate binding file does not match the exact candidate.');
      const campaignFile = await verifyDescriptor(base, candidate.evidence_campaign, 'candidate.evidence_campaign'); const campaign = JSON.parse(await fs.readFile(campaignFile, 'utf8')); assertCanonicalCampaign(candidate, campaign);
      const evidence = await runDeviceEvidenceCampaign(campaign, { root: path.dirname(campaignFile) }); const capability = evidence.capabilities.find(value => value.id === `archie-iphone-candidate:${candidate.id}`);
      const authority = (authorities.authorities || []).find(value => value.id === candidate.authority_id && value.status === 'active'); const attestation = authority ? attest(evidence.package_digest, candidate, authority, authorityPrivateKeyPem) : null;
      const authorityVerified = Boolean(authority && verifyAttestation(attestation, evidence.package_digest, candidate, authority)); const blockers = [];
      if (evidence.decision !== 'admitted-real-device-evidence' || capability?.status !== 'admitted') blockers.push('canonical-device-evidence-rejected');
      if (!authorityVerified) blockers.push('independent-measurement-authority-required');
      evaluations.push(Object.freeze({ candidate, capability: capability || { metrics: {} }, evidence_package_digest: evidence.package_digest, attestation, admitted: blockers.length === 0, blockers }));
    } catch (error) { evaluations.push(Object.freeze({ candidate, capability: { metrics: {} }, evidence_package_digest: null, attestation: null, admitted: false, blockers: Object.freeze([`invalid-candidate-evidence:${error.message}`]) })); }
  }
  const admitted = evaluations.filter(value => value.admitted); const frontier = admitted.filter(value => !admitted.some(other => other !== value && dominates(other, value))).sort((a, b) => b.capability.metrics.quality_retention - a.capability.metrics.quality_retention || b.capability.metrics.task_success_rate - a.capability.metrics.task_success_rate || b.capability.metrics.sustained_tokens_per_second_p50 - a.capability.metrics.sustained_tokens_per_second_p50);
  const selected = frontier[0] || null; const body = { schema: ARCHIE_IPHONE_RESEARCH_RESULT_SCHEMA, plan_id: plan.id, plan_digest: plan.plan_digest, target_digest: CANONICAL_IPHONE_TARGET_DIGEST, search_digest: CANONICAL_IPHONE_DESIGNS_DIGEST, evaluations: evaluations.map(value => ({ candidate_id: value.candidate.id, admitted: value.admitted, blockers: value.blockers, evidence_package_digest: value.evidence_package_digest, attestation: value.attestation })), admitted_candidate_ids: admitted.map(value => value.candidate.id), pareto_frontier_candidate_ids: frontier.map(value => value.candidate.id), selected_candidate: selected ? { id: selected.candidate.id, design: selected.candidate.design, model: selected.candidate.model, runtime: selected.candidate.runtime, benchmark: selected.candidate.benchmark, evidence_package_digest: selected.evidence_package_digest, attestation: selected.attestation } : null, decision: selected ? 'selected-strongest-authority-attested-iphone-candidate' : 'no-iphone-candidate-admitted', claim_boundary: selected ? 'Selection applies only to the exact bound model, runtime, benchmark, iPhone floor, fresh evidence package, and enrolled measurement authority.' : 'No model may be represented as iPhone-ready.' };
  return Object.freeze({ ...body, result_digest: digest(body) });
}
export function createIPhoneResearchTemplate() { const body = { schema: ARCHIE_IPHONE_RESEARCH_TEMPLATE_SCHEMA, target: CANONICAL_IPHONE_TARGET, target_digest: CANONICAL_IPHONE_TARGET_DIGEST, designs: CANONICAL_IPHONE_DESIGNS, search_digest: CANONICAL_IPHONE_DESIGNS_DIGEST, authority_manifest: 'product/archie-iphone-measurement-authorities.json', next_artifact: 'Create a v2 plan whose candidates bind exact model/runtime/benchmark files and fresh canonical device-evidence campaigns.', claim_boundary: 'This template selects nothing and proves no iPhone capability.' }; return Object.freeze({ ...body, template_digest: digest(body) }); }
function parse(argv) { const command = argv[0] || 'template'; const flags = new Map(); for (let i = 1; i < argv.length; i += 1) { const token = argv[i]; if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}.`); const [name, inline] = token.split('=', 2); if (inline !== undefined) flags.set(name, inline); else { const next = argv[++i]; if (!next || next.startsWith('--')) throw new Error(`${name} requires a value.`); flags.set(name, next); } } return { command, flags }; }
export async function main(argv = process.argv.slice(2)) { const { command, flags } = parse(argv); let result; if (command === 'template') result = createIPhoneResearchTemplate(); else if (command === 'evaluate') { const planFile = flags.get('--plan'); if (!planFile) throw new Error('--plan is required.'); const keyFile = flags.get('--authority-private-key'); result = await evaluateIPhoneResearch(JSON.parse(await fs.readFile(path.resolve(planFile), 'utf8')), { root: path.dirname(path.resolve(planFile)), authorityManifestPath: path.resolve(flags.get('--authority-manifest') || 'product/archie-iphone-measurement-authorities.json'), authorityPrivateKeyPem: keyFile ? await fs.readFile(path.resolve(keyFile), 'utf8') : null }); } else throw new Error('Usage: template | evaluate --plan file [--authority-manifest file] [--authority-private-key file]'); const output = `${JSON.stringify(result, null, 2)}\n`; if (flags.get('--output')) await fs.writeFile(path.resolve(flags.get('--output')), output); else process.stdout.write(output); if (command === 'evaluate' && !result.selected_candidate) process.exitCode = 1; }
const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); if (invoked) main().catch(error => { process.stderr.write(`archie-iphone-quantization-research: ${error?.stack || error}\n`); process.exitCode = 1; });
