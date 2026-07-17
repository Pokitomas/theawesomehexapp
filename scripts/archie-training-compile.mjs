#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileArchieTrainingPlan } from '../foundry/archie-neural/archie-training-compiler.mjs';

const clean = value => String(value ?? '').trim();
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJSON = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}.`);
    const key = token.slice(2).replace(/-/g, '_');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    args[key] = value;
    index += 1;
  }
  if (!args.config || !args.output) throw new Error('Usage: archie-training-compile --config <config.json> --output <directory>');
  return args;
}

function resolveFrom(base, value) {
  const text = clean(value);
  if (!text) throw new Error('A required file path is empty.');
  return path.resolve(base, text);
}

function loadConfig(configPath) {
  const filename = path.resolve(configPath);
  const base = path.dirname(filename);
  const config = readJSON(filename);
  const profilePath = resolveFrom(base, config.profile);
  const statePath = resolveFrom(base, config.state_contract);
  const sidepus = (Array.isArray(config.sidepus) ? config.sidepus : []).map((item, index) => {
    const manifestPath = resolveFrom(base, item.manifest);
    const receiptPath = resolveFrom(base, item.export_receipt);
    const exportPath = resolveFrom(base, item.export_jsonl);
    const manifestBytes = fs.readFileSync(manifestPath);
    return {
      manifest: JSON.parse(manifestBytes.toString('utf8')),
      manifest_file_sha256: sha256(manifestBytes),
      export_receipt: readJSON(receiptPath),
      export_bytes: fs.readFileSync(exportPath),
      source_paths: { manifest: manifestPath, export_receipt: receiptPath, export_jsonl: exportPath },
      index
    };
  });
  const trajectory_sources = (Array.isArray(config.trajectory_batches) ? config.trajectory_batches : []).map(item => {
    const sourcePath = resolveFrom(base, item);
    const bytes = fs.readFileSync(sourcePath);
    return { path: sourcePath, sha256: sha256(bytes), bytes: bytes.length, value: JSON.parse(bytes.toString('utf8')) };
  });
  const trajectory_batches = trajectory_sources.map(item => item.value);
  const distillation_examples = [];
  const distillation_sources = [];
  for (const item of Array.isArray(config.distillation_jsonl) ? config.distillation_jsonl : []) {
    const sourcePath = resolveFrom(base, item);
    const bytes = fs.readFileSync(sourcePath);
    const sourceDigest = sha256(bytes);
    distillation_sources.push({ path: sourcePath, sha256: sourceDigest, bytes: bytes.length });
    const rows = bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
      try { return { ...JSON.parse(line), source_file_sha256: sourceDigest }; }
      catch { throw new Error(`Invalid JSON in ${sourcePath} at line ${index + 1}.`); }
    });
    distillation_examples.push(...rows);
  }
  return {
    config_path: filename,
    config_sha256: sha256(fs.readFileSync(filename)),
    profile: readJSON(profilePath),
    profile_path: profilePath,
    state_contract: readJSON(statePath),
    state_contract_path: statePath,
    sidepus,
    trajectory_batches,
    trajectory_sources,
    distillation_examples,
    distillation_sources,
    code_commit: config.code_commit
  };
}

function writeAtomically(output, compiled, source) {
  const destination = path.resolve(output);
  if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite existing training workspace ${destination}.`);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = `${destination}.partial-${process.pid}-${Date.now()}`;
  fs.mkdirSync(temporary, { recursive: false });
  try {
    for (const [relative, text] of Object.entries(compiled.files)) {
      const filename = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, text, 'utf8');
    }
    fs.mkdirSync(path.join(temporary, 'inputs'), { recursive: true });
    fs.writeFileSync(path.join(temporary, 'inputs', 'resolved-profile.json'), `${JSON.stringify(source.profile, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(temporary, 'inputs', 'state-contract.json'), `${JSON.stringify(source.state_contract, null, 2)}\n`, 'utf8');
    const sourceIndex = {
      schema: 'archie-training-source-index/v1',
      config: { path: source.config_path, sha256: source.config_sha256 },
      profile: { path: source.profile_path, sha256: sha256(fs.readFileSync(source.profile_path)), bytes: fs.statSync(source.profile_path).size },
      state_contract: { path: source.state_contract_path, sha256: sha256(fs.readFileSync(source.state_contract_path)), bytes: fs.statSync(source.state_contract_path).size },
      sidepus: source.sidepus.map(item => ({
        manifest: { path: item.source_paths.manifest, sha256: item.manifest_file_sha256, bytes: fs.statSync(item.source_paths.manifest).size },
        export_receipt: { path: item.source_paths.export_receipt, sha256: sha256(fs.readFileSync(item.source_paths.export_receipt)), bytes: fs.statSync(item.source_paths.export_receipt).size },
        export_jsonl: { path: item.source_paths.export_jsonl, sha256: sha256(item.export_bytes), bytes: item.export_bytes.length }
      })),
      trajectory_batches: source.trajectory_sources.map(({ value, ...item }) => item),
      distillation_jsonl: source.distillation_sources
    };
    fs.writeFileSync(path.join(temporary, 'inputs', 'source-index.json'), `${JSON.stringify(sourceIndex, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(temporary, 'training-plan.json'), `${JSON.stringify(compiled.plan, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(temporary, 'input-receipt.json'), `${JSON.stringify({ ...compiled.input_receipt, config_path: source.config_path, config_sha256: source.config_sha256 }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return destination;
}

export function compileFromConfig(configPath, output) {
  const source = loadConfig(configPath);
  const compiled = compileArchieTrainingPlan(source);
  const destination = writeAtomically(output, compiled, source);
  return { ...compiled.input_receipt, workspace: destination };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const receipt = compileFromConfig(args.config, args.output);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
