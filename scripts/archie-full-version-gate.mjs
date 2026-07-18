#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const REQUIRED_FILES = Object.freeze([
  'package.json',
  'README.md',
  'INSTALL.md',
  'ARCHIE_RUNTIME.md',
  'ARCHIE_WORKSPACES.md',
  'ARCHIE_STANDALONE_MIGRATION.md',
  'ARCHIE_HOSTED.md',
  'ARCHIE_COMPATIBILITY.md',
  'Dockerfile.archie',
  'compose.yaml',
  'scripts/archied.mjs',
  'scripts/archie-hybrid-hosted.mjs',
  'scripts/archie-hybrid-runner.mjs',
  'scripts/archie-compat-import.mjs',
  'scripts/archie-training-compile.mjs',
  'foundry/archie-distill/train.py',
  'scripts/archie-student-quantize.mjs',
  'scripts/archie-student-admission.mjs',
  'scripts/archie-repository-completion.mjs'
]);

const REQUIRED_PACKAGE_SCRIPTS = Object.freeze([
  'archie:local',
  'archie:hosted',
  'archie:runner',
  'archie:migrate:local',
  'archie:student:compile',
  'archie:student:train',
  'archie:student:quantize',
  'archie:student:admit',
  'test:archie:workspace',
  'test:archie:distill',
  'test:archie:repository-completion'
]);

const REQUIRED_TRUTH_MARKERS = Object.freeze([
  ['foundry/archie-distill/train.py', 'Refusing slow full-precision CPU training'],
  ['foundry/archie-distill/train.py', '"promotion": "not-admitted"'],
  ['scripts/archie-student-admission.mjs', 'rejected-incomplete-student-evidence'],
  ['ARCHIE_COMPATIBILITY.md', 'Git metadata is an optional provenance and future import/export adapter only']
]);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function existsFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function stableDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function main() {
  const root = process.cwd();
  const missingFiles = REQUIRED_FILES.filter(file => !existsFile(path.join(root, file)));
  assert(missingFiles.length === 0, `Missing full-version files: ${missingFiles.join(', ')}`);

  const packageJson = JSON.parse(readText(path.join(root, 'package.json')));
  const scripts = packageJson.scripts || {};
  const missingScripts = REQUIRED_PACKAGE_SCRIPTS.filter(name => typeof scripts[name] !== 'string' || !scripts[name].trim());
  assert(missingScripts.length === 0, `Missing full-version package scripts: ${missingScripts.join(', ')}`);

  const missingMarkers = REQUIRED_TRUTH_MARKERS.filter(([file, marker]) => !readText(path.join(root, file)).includes(marker));
  assert(missingMarkers.length === 0, `Missing fail-closed truth markers: ${missingMarkers.map(([file, marker]) => `${file} :: ${marker}`).join('; ')}`);

  const receipt = {
    schema: 'archie-full-version-gate-receipt/v1',
    repository_contract: {
      local_first: true,
      hosted_founder_access: true,
      outbound_hybrid_runner: true,
      compatibility_import: true,
      portable_workspace_export: true,
      distillation_contracts: true
    },
    required_files: Object.fromEntries(REQUIRED_FILES.map(file => [file, { sha256: sha256File(path.join(root, file)) }])),
    required_package_scripts: Object.fromEntries(REQUIRED_PACKAGE_SCRIPTS.map(name => [name, scripts[name]])),
    truth_boundaries: {
      cuda_training_required: true,
      cpu_training_fallback_allowed: false,
      model_promotion_without_independent_admission_allowed: false,
      physical_device_claim_allowed_without_external_receipt: false,
      github_runtime_dependency_allowed: false
    },
    verification_hint: [
      'npm run test:archie:workspace',
      'npm run test:archie:distill',
      'npm run test:archie:repository-completion'
    ],
    created_at: new Date().toISOString()
  };
  receipt.receipt_digest = stableDigest(receipt);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

main();
