#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REQUIRED_ROLES = [
  'familiar-control',
  'assumption-inversion',
  'eccentric-transfer',
  'loser-recombination',
  'low-resource-offline',
  'maximal-expressive-variance'
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
const canonicalJSON = value => `${JSON.stringify(canonical(value), null, 2)}\n`;
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJSON(value)).digest('hex');

function relative(value, field) {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${field} must be repository-relative.`);
  return normalized;
}

function parseFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags.set(value, true);
    else { flags.set(value, next); index += 1; }
  }
  return flags;
}

export async function verifyFrontierSurfaceAssembly({ repository_root = process.cwd(), assembly_path, comparison_path } = {}) {
  const root = path.resolve(repository_root);
  const assemblyRelative = relative(assembly_path, 'assembly path');
  const comparisonRelative = relative(comparison_path, 'comparison path');
  const assembly = JSON.parse(await fs.readFile(path.resolve(root, assemblyRelative), 'utf8'));
  const comparison = JSON.parse(await fs.readFile(path.resolve(root, comparisonRelative), 'utf8'));
  if (assembly?.schema !== 'frontier-surface-assembly/v1') throw new Error('Unsupported frontier surface assembly.');
  if (comparison?.schema !== 'frontier-surface-comparison-packet/v1') throw new Error('Unsupported frontier comparison packet.');
  const { assembly_digest: claimedDigest, ...body } = assembly;
  if (!/^[0-9a-f]{64}$/i.test(claimedDigest || '') || digest(body) !== claimedDigest) throw new Error('Frontier assembly digest mismatch.');
  if (comparison.assembly_digest !== claimedDigest) throw new Error('Comparison packet is not bound to the assembly.');
  if (!/^[0-9a-f]{40}$/i.test(assembly.base_sha || '') || !/^[0-9a-f]{64}$/i.test(assembly.code_digest || '')) throw new Error('Assembly base/code binding is incomplete.');
  if (assembly.maker_only_repository_writer !== true || assembly.authority?.merge !== 'human' || assembly.authority?.deploy !== 'human' || assembly.authority?.publish !== 'human' || assembly.authority?.promote !== 'human') {
    throw new Error('Assembly authority boundary drift detected.');
  }
  if (assembly.aggregate_score_forbidden !== true) throw new Error('Assembly must forbid aggregate-score masking.');
  if (Number(assembly.automation_floor) < 0.5 || Number(assembly.measured_automation_share) < 0.5) throw new Error('Assembly automation share is below 50%.');
  const candidates = assembly.candidates || [];
  if (candidates.length !== 6) throw new Error('Assembly requires exactly six candidate artifacts.');
  const roles = candidates.map(item => item.role);
  for (const role of REQUIRED_ROLES) if (!roles.includes(role)) throw new Error(`Assembly is missing role ${role}.`);
  if (new Set(candidates.map(item => item.candidate_id)).size !== candidates.length) throw new Error('Candidate IDs are not unique.');
  if (new Set(candidates.map(item => item.target_prefix)).size !== candidates.length) throw new Error('Candidate workspaces are not isolated.');
  if (new Set(candidates.map(item => item.visual_grammar_id)).size !== candidates.length) throw new Error('Candidate visual grammars collapsed into a shared system.');
  const comparisonById = new Map((comparison.candidates || []).map(item => [item.candidate_id, item]));
  for (const candidate of candidates) {
    if (!/^[0-9a-f]{64}$/i.test(candidate.artifact_digest || '') || !/^[0-9a-f]{64}$/i.test(candidate.maker_receipt_digest || '') || !/^[0-9a-f]{64}$/i.test(candidate.archie_semantic_digest || '')) {
      throw new Error(`Candidate receipt binding is incomplete: ${candidate.candidate_id}.`);
    }
    if (candidate.promotion_state !== 'blocked-on-empirical-evidence' || candidate.evidence_state !== 'fixture-only' || candidate.capture_state !== 'awaiting-headless-capture') {
      throw new Error(`Candidate claim boundary drift detected: ${candidate.candidate_id}.`);
    }
    const target = relative(candidate.target_prefix, 'candidate target');
    if (!target.startsWith(`${assembly.output_prefix}/`)) throw new Error(`Candidate escaped assembly output: ${candidate.candidate_id}.`);
    const manifest = JSON.parse(await fs.readFile(path.resolve(root, target, 'candidate.json'), 'utf8'));
    if (manifest.candidate_id !== candidate.candidate_id || manifest.expected_artifact_digest !== candidate.artifact_digest || manifest.visual_grammar_id !== candidate.visual_grammar_id) {
      throw new Error(`Candidate manifest binding mismatch: ${candidate.candidate_id}.`);
    }
    if (manifest.authority?.archie_direct_write !== false || manifest.authority?.maker_only_repository_writer !== true) throw new Error(`Candidate writer boundary drift: ${candidate.candidate_id}.`);
    const comparisonEntry = comparisonById.get(candidate.candidate_id);
    if (!comparisonEntry || comparisonEntry.artifact_digest !== candidate.artifact_digest || comparisonEntry.visual_grammar_id !== candidate.visual_grammar_id) {
      throw new Error(`Comparison packet candidate mismatch: ${candidate.candidate_id}.`);
    }
    if (comparisonEntry.capture?.real_device_claim !== false || comparisonEntry.capture?.state !== 'awaiting-headless-capture') throw new Error(`Comparison capture boundary drift: ${candidate.candidate_id}.`);
  }
  if (comparisonById.size !== candidates.length || comparison.promotion_state !== 'blocked-on-adapters-judges-and-real-device-evidence') throw new Error('Comparison packet is incomplete.');
  return Object.freeze({
    schema: 'frontier-surface-assembly-verification/v1',
    round_id: assembly.round_id,
    assembly_digest: claimedDigest,
    candidates: candidates.length,
    distinct_visual_grammars: new Set(candidates.map(item => item.visual_grammar_id)).size,
    isolated_workspaces: new Set(candidates.map(item => item.target_prefix)).size,
    automation_share: assembly.measured_automation_share,
    promotion_state: comparison.promotion_state,
    claim_boundary: 'Runnable fixture assembly only; no model, preference, or real-device capability claim.'
  });
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const assembly = flags.get('--assembly');
  const comparison = flags.get('--comparison');
  if (!assembly || !comparison) throw new Error('verify-frontier-surface-assembly requires --assembly and --comparison.');
  const result = await verifyFrontierSurfaceAssembly({ repository_root: flags.get('--repository-root') || process.cwd(), assembly_path: assembly, comparison_path: comparison });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
}
