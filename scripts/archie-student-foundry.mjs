#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createArchieLinuxCorpus } from './maker-archie-corpus.mjs';

const execFileAsync = promisify(execFile);

export const ARCHIE_STUDENT_PACK_SCHEMA = 'archie-student-training-pack/v1';
export const ARCHIE_STUDENT_TRAINER_SCHEMA = 'archie-student-trainer/v1';
export const ARCHIE_STUDENT_TRAINING_RECEIPT_SCHEMA = 'archie-student-training-receipt/v1';

const EXAMPLE_SCHEMA = 'archie-distillation-example/v1';
const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_KEY = /(?:^|[_-])(api[_-]?key|private[_-]?key|password|secret|access[_-]?token|authorization|cookie|credential)(?:$|[_-])/i;
const SECRET_TEXT = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{12,})/i;

const clean = (value, limit = 500_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}

export function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

function assertNoSecrets(value, trail = 'input', depth = 0) {
  if (depth > 18) throw new Error(`${trail} exceeds the supported nesting depth.`);
  if (typeof value === 'string') {
    if (SECRET_TEXT.test(value)) throw new Error(`${trail} contains secret or private-key material.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${trail}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`${trail}.${key} is a secret-like field.`);
    assertNoSecrets(child, `${trail}.${key}`, depth + 1);
  }
}

function assertDigest(value, field) {
  const digest = clean(value, 64).toLowerCase();
  if (!HEX_256.test(digest)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return digest;
}

function assertPortableName(value, field) {
  const normalized = clean(value, 128);
  if (!SAFE_NAME.test(normalized)) throw new Error(`${field} must be a portable identifier.`);
  return normalized;
}

function safeRelative(value, field) {
  const normalized = clean(value, 1000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) throw new Error(`${field} must be repository-relative.`);
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${field} contains traversal.`);
  return parts.join('/');
}

async function exists(filename) {
  try {
    await fs.stat(filename);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeExclusiveDirectory(destination, writer) {
  const target = path.resolve(destination);
  if (await exists(target)) throw new Error(`Output directory already exists: ${target}.`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const result = await writer(temporary);
    await fs.rename(temporary, target);
    return { ...result, output_directory: target };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function sourceGroup(example) {
  return clean(example.source_record_id || example.source_digest || example.example_id || example.example_digest, 300);
}

function normalizedExample(example) {
  if (example?.schema !== EXAMPLE_SCHEMA) throw new Error('Training corpus contains an unsupported example schema.');
  assertNoSecrets(example, `example.${clean(example.example_id || 'unknown', 100)}`);
  const exampleDigest = assertDigest(example.example_digest || sha256({ ...example, example_digest: undefined }), 'example.example_digest');
  const instruction = clean(example.instruction, 500_000);
  if (!instruction) throw new Error(`Example ${exampleDigest} has no instruction.`);
  const negative = example.negative === true || example.outcome !== 'completed';
  if (!negative && (example.target === null || example.target === undefined || !clean(typeof example.target === 'string' ? example.target : stableJSONStringify(example.target)))) {
    throw new Error(`Positive example ${exampleDigest} has no target.`);
  }
  return Object.freeze({ ...canonical(example), example_digest: exampleDigest, instruction, negative, group: sourceGroup(example) || exampleDigest });
}

function splitGroups(examples, holdoutRate, salt) {
  const groups = new Map();
  for (const example of examples) {
    const list = groups.get(example.group) || [];
    list.push(example);
    groups.set(example.group, list);
  }
  const assignments = [...groups.entries()].map(([group, rows]) => {
    const score = Number.parseInt(sha256(`${salt}:${group}`).slice(0, 8), 16) / 0xffffffff;
    return { group, rows, score, split: score < holdoutRate ? 'heldout' : 'train' };
  }).sort((left, right) => left.group.localeCompare(right.group));

  if (assignments.length >= 2 && assignments.every(item => item.split === 'train')) assignments.at(-1).split = 'heldout';
  if (assignments.length >= 2 && assignments.every(item => item.split === 'heldout')) assignments[0].split = 'train';
  return assignments;
}

function positiveRow(example, systemPrompt) {
  return canonical({
    schema: 'archie-student-supervised-example/v1',
    example_id: example.example_id || `ex_${example.example_digest.slice(0, 24)}`,
    source_digest: example.source_digest || example.example_digest,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: stableJSONStringify({ instruction: example.instruction, context: example.compact_context ?? null }) },
      { role: 'assistant', content: typeof example.target === 'string' ? example.target : stableJSONStringify(example.target) }
    ],
    tool_trace: Array.isArray(example.tool_trace) ? example.tool_trace : [],
    teacher_evidence: example.teacher_evidence || null,
    artifact_refs: Array.isArray(example.artifact_refs) ? example.artifact_refs : []
  });
}

function negativeRow(example) {
  return canonical({
    schema: 'archie-student-negative-example/v1',
    example_id: example.example_id || `ex_${example.example_digest.slice(0, 24)}`,
    source_digest: example.source_digest || example.example_digest,
    instruction: example.instruction,
    compact_context: example.compact_context ?? null,
    rejected_reason: clean(example.reason || example.outcome || 'rejected', 20_000),
    tags: Array.isArray(example.tags) ? example.tags : [],
    teacher_evidence: example.teacher_evidence || null,
    artifact_refs: Array.isArray(example.artifact_refs) ? example.artifact_refs : []
  });
}

function jsonLines(rows) {
  return rows.map(row => stableJSONStringify(row)).join('\n') + (rows.length ? '\n' : '');
}

function fileDescriptor(name, content, rows) {
  const bytes = Buffer.byteLength(content);
  return Object.freeze({ name, bytes, rows: rows.length, sha256: sha256(content) });
}

export async function prepareStudentTrainingPack({
  corpus_root,
  output_directory,
  holdout_rate = 0.2,
  split_salt = 'archie-student-pack/v1',
  system_prompt = 'Produce a bounded typed plan, preserve authority, and retain negative lessons.',
  limit = 100_000,
  clock = Date.now
} = {}) {
  if (!corpus_root) throw new Error('corpus_root is required.');
  if (!output_directory) throw new Error('output_directory is required.');
  const rate = Number(holdout_rate);
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 1) throw new Error('holdout_rate must be greater than 0 and less than 1.');
  const salt = clean(split_salt, 500);
  if (!salt) throw new Error('split_salt is required.');
  const prompt = clean(system_prompt, 20_000);
  if (!prompt) throw new Error('system_prompt is required.');
  assertNoSecrets(prompt, 'system_prompt');

  const corpus = createArchieLinuxCorpus({ root: corpus_root });
  const examples = (await corpus.examples({ limit })).map(normalizedExample).sort((left, right) => left.example_digest.localeCompare(right.example_digest));
  if (!examples.length) throw new Error('The Archie corpus contains no distillation examples.');
  const assignments = splitGroups(examples, rate, salt);
  const partitions = {
    train: [],
    heldout: [],
    negative_train: [],
    negative_heldout: []
  };
  for (const assignment of assignments) {
    for (const example of assignment.rows) {
      const key = example.negative
        ? assignment.split === 'heldout' ? 'negative_heldout' : 'negative_train'
        : assignment.split;
      partitions[key].push(example.negative ? negativeRow(example) : positiveRow(example, prompt));
    }
  }
  for (const rows of Object.values(partitions)) rows.sort((left, right) => left.example_id.localeCompare(right.example_id));
  if (!partitions.train.length) throw new Error('Student pack requires at least one positive training example.');
  if (!partitions.heldout.length && examples.filter(example => !example.negative).length >= 2) throw new Error('Student pack could not produce a positive held-out split.');

  return writeExclusiveDirectory(output_directory, async temporary => {
    const files = {};
    for (const [partition, rows] of Object.entries(partitions)) {
      const name = `${partition.replaceAll('_', '-')}.jsonl`;
      const content = jsonLines(rows);
      await fs.writeFile(path.join(temporary, name), content, { encoding: 'utf8', mode: 0o600 });
      files[partition] = fileDescriptor(name, content, rows);
    }
    const observedAt = new Date(typeof clock === 'function' ? clock() : clock).toISOString();
    const sourceGroups = assignments.map(item => ({ group_digest: sha256(item.group), split: item.split, examples: item.rows.length }));
    const body = canonical({
      schema: ARCHIE_STUDENT_PACK_SCHEMA,
      created_at: observedAt,
      source: {
        corpus_root_digest: sha256(path.resolve(corpus_root)),
        examples: examples.length,
        source_groups: assignments.length
      },
      split: {
        algorithm: 'sha256-group-threshold/v1',
        holdout_rate: rate,
        split_salt_digest: sha256(salt),
        source_groups: sourceGroups
      },
      prompt_digest: sha256(prompt),
      files,
      claim_boundary: 'Deterministic training-data packaging only; no model capability claim.'
    });
    const manifest = Object.freeze({ ...body, pack_digest: sha256(body) });
    await fs.writeFile(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { manifest, manifest_path: path.join(path.resolve(output_directory), 'manifest.json') };
  });
}

async function readJSONLines(filename) {
  const content = await fs.readFile(filename, 'utf8');
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSONL at ${filename}:${index + 1}.`);
    }
  });
}

export async function inspectStudentTrainingPack(pack_directory) {
  const root = path.resolve(pack_directory);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest?.schema !== ARCHIE_STUDENT_PACK_SCHEMA) throw new Error('Unsupported Archie student pack schema.');
  const claimed = assertDigest(manifest.pack_digest, 'manifest.pack_digest');
  const body = { ...manifest };
  delete body.pack_digest;
  if (sha256(body) !== claimed) throw new Error('Student pack manifest digest mismatch.');
  const partitions = {};
  for (const [partition, descriptor] of Object.entries(manifest.files || {})) {
    const relative = safeRelative(descriptor.name, `manifest.files.${partition}.name`);
    const filename = path.join(root, relative);
    const content = await fs.readFile(filename, 'utf8');
    if (Buffer.byteLength(content) !== descriptor.bytes) throw new Error(`Student pack byte mismatch for ${partition}.`);
    if (sha256(content) !== descriptor.sha256) throw new Error(`Student pack digest mismatch for ${partition}.`);
    const rows = await readJSONLines(filename);
    if (rows.length !== descriptor.rows) throw new Error(`Student pack row-count mismatch for ${partition}.`);
    rows.forEach((row, index) => assertNoSecrets(row, `${partition}[${index}]`));
    partitions[partition] = Object.freeze({ filename, rows });
  }
  return Object.freeze({ root, manifest, partitions });
}

function normalizeTrainerConfig(input) {
  if (input?.schema !== ARCHIE_STUDENT_TRAINER_SCHEMA) throw new Error(`trainer.schema must equal ${ARCHIE_STUDENT_TRAINER_SCHEMA}.`);
  assertNoSecrets(input, 'trainer');
  const program = clean(input.program, 200);
  if (!program || program.includes('/') || program.includes('\\')) throw new Error('Trainer program must be a PATH executable name.');
  const args = Array.isArray(input.args) ? input.args.map((value, index) => {
    const arg = clean(value, 4000);
    if (!arg || /[\u0000\r\n]/.test(arg)) throw new Error(`trainer.args[${index}] is invalid.`);
    return arg;
  }) : [];
  const placeholders = new Set(['{train_jsonl}', '{heldout_jsonl}', '{negative_train_jsonl}', '{negative_heldout_jsonl}', '{output_dir}', '{base_model_id}', '{seed}']);
  for (const arg of args) {
    for (const match of arg.matchAll(/\{[^}]+\}/g)) if (!placeholders.has(match[0])) throw new Error(`Unsupported trainer placeholder: ${match[0]}.`);
  }
  const baseModel = input.base_model || {};
  const base_model = Object.freeze({
    id: assertPortableName(baseModel.id, 'trainer.base_model.id'),
    digest: assertDigest(baseModel.digest, 'trainer.base_model.digest')
  });
  const output_artifact = safeRelative(input.output_artifact || 'student.gguf', 'trainer.output_artifact');
  const metrics_file = safeRelative(input.metrics_file || 'metrics.json', 'trainer.metrics_file');
  const seed = Number(input.seed ?? 0);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('trainer.seed must be a non-negative safe integer.');
  const timeout_ms = Number(input.timeout_ms ?? 3_600_000);
  if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 1000 || timeout_ms > 7 * 24 * 60 * 60 * 1000) throw new Error('trainer.timeout_ms is outside the admitted range.');
  const optimizer = canonical(input.optimizer || {});
  if (!Object.keys(optimizer).length) throw new Error('trainer.optimizer is required.');
  const teacher_ids = [...new Set((Array.isArray(input.teacher_ids) ? input.teacher_ids : []).map(value => clean(value, 300)).filter(Boolean))].sort();
  return Object.freeze({
    schema: ARCHIE_STUDENT_TRAINER_SCHEMA,
    program,
    args,
    base_model,
    output_artifact,
    metrics_file,
    seed,
    timeout_ms,
    optimizer,
    teacher_ids
  });
}

function interpolateArgs(config, pack, outputDirectory) {
  const values = {
    '{train_jsonl}': pack.partitions.train?.filename || '',
    '{heldout_jsonl}': pack.partitions.heldout?.filename || '',
    '{negative_train_jsonl}': pack.partitions.negative_train?.filename || '',
    '{negative_heldout_jsonl}': pack.partitions.negative_heldout?.filename || '',
    '{output_dir}': outputDirectory,
    '{base_model_id}': config.base_model.id,
    '{seed}': String(config.seed)
  };
  return config.args.map(arg => Object.entries(values).reduce((value, [placeholder, replacement]) => value.replaceAll(placeholder, replacement), arg));
}

function trainingDataDigest(manifest) {
  return sha256({ train: manifest.files.train, negative_train: manifest.files.negative_train });
}

function heldoutDataDigest(manifest) {
  return sha256({ heldout: manifest.files.heldout, negative_heldout: manifest.files.negative_heldout });
}

async function writeTrainingReceipt(directory, receipt) {
  const filename = path.join(directory, 'training-receipt.json');
  await fs.writeFile(filename, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return filename;
}

export async function runStudentTrainer({
  pack_directory,
  trainer,
  output_directory,
  exec_file = execFileAsync,
  clock_ms = Date.now
} = {}) {
  if (!pack_directory) throw new Error('pack_directory is required.');
  if (!output_directory) throw new Error('output_directory is required.');
  const pack = await inspectStudentTrainingPack(pack_directory);
  const config = normalizeTrainerConfig(trainer);
  const target = path.resolve(output_directory);
  if (await exists(target)) throw new Error(`Output directory already exists: ${target}.`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  const args = interpolateArgs(config, pack, temporary);
  const started = typeof clock_ms === 'function' ? clock_ms() : clock_ms;
  const environment = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || os.homedir(),
    CI: '1',
    NODE_ENV: 'production',
    NO_COLOR: '1',
    ARCHIE_TRAINING_OFFLINE: '1'
  };
  let commandResult;
  try {
    const result = await exec_file(config.program, args, {
      cwd: temporary,
      env: environment,
      timeout: config.timeout_ms,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    commandResult = { ok: true, exit_code: 0, stdout: clean(result.stdout, 100_000), stderr: clean(result.stderr, 100_000) };
  } catch (error) {
    commandResult = {
      ok: false,
      exit_code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: clean(error?.stdout, 100_000),
      stderr: clean(error?.stderr || error?.message || error, 100_000)
    };
  }
  assertNoSecrets(commandResult, 'trainer_result');
  const finished = typeof clock_ms === 'function' ? clock_ms() : Date.now();
  const common = {
    schema: ARCHIE_STUDENT_TRAINING_RECEIPT_SCHEMA,
    observed_at: new Date(finished).toISOString(),
    duration_ms: Math.max(0, Number(finished) - Number(started)),
    pack_digest: pack.manifest.pack_digest,
    training_data_digest: trainingDataDigest(pack.manifest),
    heldout_data_digest: heldoutDataDigest(pack.manifest),
    training_config_digest: sha256(config),
    optimizer_digest: sha256(config.optimizer),
    seed: config.seed,
    teacher_ids: config.teacher_ids,
    base_model: config.base_model,
    command: { program: config.program, args, command_digest: sha256({ program: config.program, args }) },
    result: commandResult,
    claim_boundary: 'Trainer execution and artifact integrity receipt only; capability promotion requires independent held-out evaluation.'
  };

  if (!commandResult.ok) {
    const body = canonical({ ...common, status: 'failed', artifact: null, metrics: null, evaluation_receipt_digest: null });
    const receipt = Object.freeze({ ...body, receipt_digest: sha256(body) });
    const receiptPath = await writeTrainingReceipt(temporary, receipt);
    const failedTarget = `${target}.failed-${receipt.receipt_digest.slice(0, 12)}`;
    await fs.rename(temporary, failedTarget);
    const error = new Error(`Archie student trainer failed with exit code ${commandResult.exit_code}.`);
    error.training_receipt = receipt;
    error.training_receipt_path = path.join(failedTarget, path.basename(receiptPath));
    error.failed_output_directory = failedTarget;
    throw error;
  }

  const artifactPath = path.join(temporary, config.output_artifact);
  const metricsPath = path.join(temporary, config.metrics_file);
  const artifactBytes = await fs.readFile(artifactPath).catch(error => {
    if (error?.code === 'ENOENT') throw new Error(`Trainer did not produce ${config.output_artifact}.`);
    throw error;
  });
  if (!artifactBytes.length) throw new Error('Trainer produced an empty artifact.');
  const metrics = JSON.parse(await fs.readFile(metricsPath, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') throw new Error(`Trainer did not produce ${config.metrics_file}.`);
    throw error;
  }));
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) throw new Error('Trainer metrics must be a JSON object.');
  assertNoSecrets(metrics, 'trainer_metrics');
  const evaluationReceiptDigest = sha256({ heldout_data_digest: heldoutDataDigest(pack.manifest), metrics });
  const body = canonical({
    ...common,
    status: 'completed',
    artifact: {
      relative_path: config.output_artifact,
      bytes: artifactBytes.length,
      sha256: sha256(artifactBytes)
    },
    metrics: {
      relative_path: config.metrics_file,
      digest: sha256(metrics),
      value: metrics
    },
    evaluation_receipt_digest: evaluationReceiptDigest
  });
  const receipt = Object.freeze({ ...body, receipt_digest: sha256(body) });
  const receiptPath = await writeTrainingReceipt(temporary, receipt);
  await fs.rename(temporary, target);
  return Object.freeze({
    receipt,
    receipt_path: path.join(target, path.basename(receiptPath)),
    artifact_path: path.join(target, config.output_artifact),
    metrics_path: path.join(target, config.metrics_file),
    output_directory: target
  });
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readJSON(filename, description) {
  if (!filename) throw new Error(`Pass ${description}.`);
  return JSON.parse(await fs.readFile(path.resolve(filename), 'utf8'));
}

export async function main(argv = process.argv) {
  const command = argv[2];
  if (command === 'prepare') {
    const result = await prepareStudentTrainingPack({
      corpus_root: argument('--corpus-root', process.env.ARCHIE_CORPUS_ROOT || ''),
      output_directory: argument('--output-dir'),
      holdout_rate: Number(argument('--holdout-rate', '0.2')),
      split_salt: argument('--split-salt', 'archie-student-pack/v1'),
      limit: Number(argument('--limit', '100000'))
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'inspect-pack') {
    const result = await inspectStudentTrainingPack(argument('--pack'));
    process.stdout.write(`${JSON.stringify({ manifest: result.manifest, root: result.root }, null, 2)}\n`);
    return;
  }
  if (command === 'train') {
    const trainer = await readJSON(argument('--config'), '--config with an Archie student trainer contract');
    const result = await runStudentTrainer({
      pack_directory: argument('--pack'),
      trainer,
      output_directory: argument('--output-dir')
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error('Usage: archie-student-foundry.mjs <prepare|inspect-pack|train> [options]');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-student-foundry: ${error?.stack || error}\n`);
    if (error?.training_receipt_path) process.stderr.write(`training_receipt=${error.training_receipt_path}\n`);
    process.exitCode = 1;
  });
}
