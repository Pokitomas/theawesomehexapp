#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function canonicalJSON(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJSON(value)).digest('hex');
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

function relative(value, field) {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${field} must be repository-relative.`);
  return normalized;
}

async function exists(filename) {
  try { await fs.stat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function verifyFrontierSurfaceCandidate({ repository_root = process.cwd(), root, manifest, expected_digest } = {}) {
  const repository = path.resolve(repository_root);
  const candidateRoot = relative(root, 'root');
  const manifestPath = relative(manifest, 'manifest');
  if (manifestPath !== `${candidateRoot}/candidate.json`) throw new Error('Candidate manifest must live inside the leased candidate root.');
  const absoluteRoot = path.resolve(repository, candidateRoot);
  const absoluteManifest = path.resolve(repository, manifestPath);
  if (!absoluteRoot.startsWith(`${repository}${path.sep}`) || !absoluteManifest.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error('Candidate path escapes repository root.');
  const descriptor = JSON.parse(await fs.readFile(absoluteManifest, 'utf8'));
  if (descriptor?.schema !== 'frontier-surface-candidate-manifest/v1') throw new Error('Unsupported frontier candidate manifest.');
  if (descriptor.target_prefix !== candidateRoot) throw new Error('Candidate target prefix drift detected.');
  if (descriptor.authority?.archie_direct_write !== false || descriptor.authority?.maker_only_repository_writer !== true) throw new Error('Candidate authority boundary drift detected.');
  if (descriptor.authority?.merge !== 'human' || descriptor.authority?.deploy !== 'human' || descriptor.authority?.public_publish !== 'human') throw new Error('Candidate human gates are incomplete.');
  if (descriptor.offline_contract?.external_network_required !== false || descriptor.offline_contract?.external_asset_urls_allowed !== false) throw new Error('Candidate offline contract drift detected.');
  if (!descriptor.visual_grammar_id || !descriptor.interaction?.selector) throw new Error('Candidate requires a distinct visual grammar and interaction contract.');
  const names = descriptor.runtime_files || [];
  if (!names.includes('index.html') || new Set(names).size !== names.length) throw new Error('Candidate runtime files must contain one unique index.html entry.');
  const files = {};
  const externalReferences = [];
  for (const name of names) {
    const safeName = relative(name, 'runtime file');
    if (safeName.includes('/')) throw new Error('Candidate runtime files must remain at the candidate root.');
    const filename = path.join(absoluteRoot, safeName);
    if (!await exists(filename)) throw new Error(`Candidate runtime file is missing: ${safeName}.`);
    const text = await fs.readFile(filename, 'utf8');
    const expected = descriptor.files?.[safeName];
    if (!/^[0-9a-f]{64}$/i.test(expected || '') || digest(text) !== expected) throw new Error(`Candidate runtime digest mismatch: ${safeName}.`);
    if (/\bhttps?:\/\//i.test(text) || /(?:src|href)=["']\/\//i.test(text)) externalReferences.push(safeName);
    if (/shared(?:-|_)surface|shared-components|design-system\.css/i.test(text)) throw new Error(`Candidate imports a shared surface grammar: ${safeName}.`);
    files[safeName] = text;
  }
  if (externalReferences.length) throw new Error(`Candidate requires external network assets: ${externalReferences.join(', ')}.`);
  const html = files['index.html'];
  if (!html.includes(`data-frontier-candidate="${descriptor.candidate_id}"`) || !html.includes(`data-frontier-role="${descriptor.role}"`)) throw new Error('Candidate identity markers are missing.');
  if (!html.includes(descriptor.interaction.selector.replace(/^[.#]/, '').split(/[\[\s]/)[0]) && descriptor.interaction.selector.startsWith('#')) {
    throw new Error('Candidate interaction selector is not represented in index.html.');
  }
  const artifactDigest = digest({ target_prefix: candidateRoot, files });
  const claimed = String(expected_digest || descriptor.expected_artifact_digest || '');
  if (!/^[0-9a-f]{64}$/i.test(claimed) || artifactDigest !== claimed || artifactDigest !== descriptor.expected_artifact_digest) throw new Error('Candidate artifact digest mismatch.');
  return Object.freeze({
    schema: 'frontier-surface-verification/v1',
    candidate_id: descriptor.candidate_id,
    role: descriptor.role,
    target_prefix: candidateRoot,
    runtime_files: names.length,
    visual_grammar_id: descriptor.visual_grammar_id,
    artifact_digest: artifactDigest,
    offline: true,
    external_references: 0,
    authority: descriptor.authority,
    claim_boundary: 'Static deterministic prototype verification only; not a model, preference, or real-device result.'
  });
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const root = flags.get('--root');
  const manifest = flags.get('--manifest');
  if (!root || !manifest) throw new Error('verify-frontier-surface-candidate requires --root and --manifest.');
  const result = await verifyFrontierSurfaceCandidate({ repository_root: flags.get('--repository-root') || process.cwd(), root, manifest, expected_digest: flags.get('--expected-digest') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
}
