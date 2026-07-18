#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ARCHIE_STUDENT_QUANTIZATION_RECEIPT_SCHEMA = 'archie-student-quantization-receipt/v1';
export const GGUF_QUANTIZATION_DESIGNS = Object.freeze({
  Q4_K_M: Object.freeze({ design_id: 'gguf-q4-k-m', nominal_bits: 4 }),
  Q5_K_M: Object.freeze({ design_id: 'gguf-q5-k-m', nominal_bits: 5 }),
  Q6_K: Object.freeze({ design_id: 'gguf-q6-k', nominal_bits: 6 }),
  Q8_0: Object.freeze({ design_id: 'gguf-q8-0', nominal_bits: 8 })
});
const DEFAULT_QUANTIZATIONS = Object.freeze(['Q4_K_M', 'Q5_K_M', 'Q6_K']);
const HEX = /^[a-f0-9]{64}$/;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest('hex');
}

async function sha256(filename) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function descriptor(filename, root = path.dirname(filename), { allowEmpty = false } = {}) {
  const resolved = path.resolve(filename);
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || (!allowEmpty && stat.size < 1)) throw new Error(`Required artifact is not a ${allowEmpty ? '' : 'nonempty '}file: ${resolved}`);
  return Object.freeze({ path: path.relative(path.resolve(root), resolved) || path.basename(resolved), bytes: stat.size, sha256: await sha256(resolved) });
}

async function directoryManifest(root) {
  const base = path.resolve(root);
  const rows = [];
  async function walk(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Model directory may not contain symbolic links: ${filename}`);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) rows.push(await descriptor(filename, base));
    }
  }
  await walk(base);
  if (!rows.length) throw new Error('Model directory is empty.');
  if (!rows.some(row => /(^|\/)(?:model.*\.safetensors|pytorch_model.*\.bin)$/i.test(row.path))) {
    throw new Error('Model directory contains no Hugging Face weight artifact.');
  }
  if (!rows.some(row => /(^|\/)config\.json$/i.test(row.path))) throw new Error('Model directory is missing config.json.');
  return Object.freeze(rows);
}

function normalizeQuantizations(values) {
  const requested = values?.length ? values : DEFAULT_QUANTIZATIONS;
  const normalized = [...new Set(requested.map(value => String(value).trim().toUpperCase()).filter(Boolean))];
  if (!normalized.length) throw new Error('At least one quantization is required.');
  for (const value of normalized) if (!GGUF_QUANTIZATION_DESIGNS[value]) throw new Error(`Unsupported GGUF quantization: ${value}`);
  return Object.freeze(normalized);
}

function requireHash(value, field) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!HEX.test(normalized)) throw new Error(`${field} must be a SHA-256 digest.`);
  return normalized;
}

async function ensureFreshOutput(root) {
  const resolved = path.resolve(root);
  try {
    const entries = await fs.readdir(resolved);
    if (entries.length) throw new Error(`Refusing nonempty output directory: ${resolved}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(resolved, { recursive: true });
  }
  return resolved;
}

async function resolveExecutable(value) {
  const requested = String(value || '').trim();
  if (!requested) throw new Error('Executable path is required.');
  const hasSeparator = requested.includes('/') || requested.includes('\\');
  const candidates = hasSeparator || path.isAbsolute(requested)
    ? [path.resolve(requested)]
    : String(process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(directory => {
        if (process.platform !== 'win32') return [path.join(directory, requested)];
        const extensions = String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
        return [path.join(directory, requested), ...extensions.map(extension => path.join(directory, `${requested}${extension.toLowerCase()}`))];
      });
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return fs.realpath(candidate);
    } catch {}
  }
  throw new Error(`Executable was not found or is not runnable: ${requested}`);
}

async function absoluteFileDescriptor(filename) {
  const real = await fs.realpath(path.resolve(filename));
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size < 1) throw new Error(`Required tool file is missing or empty: ${real}`);
  return Object.freeze({ path: real, bytes: stat.size, sha256: await sha256(real) });
}

async function executableDescriptor(filename) {
  const real = await resolveExecutable(filename);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`Executable path is not a file: ${real}`);
  return Object.freeze({ path: real, bytes: stat.size, sha256: await sha256(real) });
}

async function runCommand(executable, args, { cwd, environment, stdoutPath, stderrPath }) {
  const stdout = await fs.open(stdoutPath, 'wx');
  const stderr = await fs.open(stderrPath, 'wx');
  const startedAt = new Date().toISOString();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', stdout.fd, stderr.fd]
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const endedAt = new Date().toISOString();
    if (result.code !== 0) throw new Error(`Command failed with exit code ${result.code}${result.signal ? ` and signal ${result.signal}` : ''}: ${executable}`);
    return Object.freeze({ executable, args: Object.freeze([...args]), cwd, started_at: startedAt, ended_at: endedAt, exit_code: result.code, stdout: await descriptor(stdoutPath, path.dirname(stdoutPath), { allowEmpty: true }), stderr: await descriptor(stderrPath, path.dirname(stderrPath), { allowEmpty: true }) });
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

export async function runStudentQuantization(options) {
  const modelDir = path.resolve(options.modelDir);
  const converter = path.resolve(options.converter);
  const quantizer = await resolveExecutable(options.quantizer);
  const python = await resolveExecutable(options.python || 'python3');
  const outputDir = await ensureFreshOutput(options.outputDir);
  const quantizations = normalizeQuantizations(options.quantizations);
  const sourceManifest = await directoryManifest(modelDir);
  const source = Object.freeze({
    model_id: String(options.modelId || 'archie-student').trim(),
    revision_sha256: requireHash(options.modelRevisionSha256, 'modelRevisionSha256'),
    directory_digest: digest(sourceManifest),
    bytes: sourceManifest.reduce((total, row) => total + row.bytes, 0),
    files: sourceManifest
  });
  if (!source.model_id) throw new Error('modelId is required.');

  const tools = Object.freeze({
    python: await executableDescriptor(python),
    converter: await absoluteFileDescriptor(converter),
    quantizer: await executableDescriptor(quantizer)
  });
  const environment = Object.freeze({
    ...process.env,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_DATASETS_OFFLINE: '1',
    TOKENIZERS_PARALLELISM: 'false'
  });
  const receiptEnvironment = Object.freeze({
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    offline: true,
    variables: Object.freeze({ HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' })
  });

  const logsDir = path.join(outputDir, 'logs');
  await fs.mkdir(logsDir);
  const f16Path = path.join(outputDir, `${source.model_id.replace(/[^A-Za-z0-9._-]+/g, '-')}-f16.gguf`);
  const commands = [];
  commands.push(await runCommand(python, [converter, modelDir, '--outfile', f16Path, '--outtype', 'f16'], {
    cwd: outputDir,
    environment,
    stdoutPath: path.join(logsDir, 'convert.stdout.log'),
    stderrPath: path.join(logsDir, 'convert.stderr.log')
  }));
  const f16 = await descriptor(f16Path, outputDir);

  const artifacts = [];
  for (const quantization of quantizations) {
    const filename = path.join(outputDir, `${source.model_id.replace(/[^A-Za-z0-9._-]+/g, '-')}-${quantization.toLowerCase()}.gguf`);
    commands.push(await runCommand(quantizer, [f16Path, filename, quantization], {
      cwd: outputDir,
      environment,
      stdoutPath: path.join(logsDir, `${quantization.toLowerCase()}.stdout.log`),
      stderrPath: path.join(logsDir, `${quantization.toLowerCase()}.stderr.log`)
    }));
    artifacts.push(Object.freeze({
      quantization,
      ...GGUF_QUANTIZATION_DESIGNS[quantization],
      artifact: await descriptor(filename, outputDir)
    }));
  }

  const receiptBody = Object.freeze({
    schema: ARCHIE_STUDENT_QUANTIZATION_RECEIPT_SCHEMA,
    source,
    tools,
    environment: receiptEnvironment,
    intermediate: f16,
    artifacts: Object.freeze(artifacts),
    commands: Object.freeze(commands),
    source_training_receipt_sha256: options.sourceTrainingReceiptSha256 ? requireHash(options.sourceTrainingReceiptSha256, 'sourceTrainingReceiptSha256') : null,
    claim_boundary: 'These artifacts are quantized candidates only. Quantization does not admit model quality, authority safety, runtime compatibility, or iPhone readiness.'
  });
  const receipt = Object.freeze({ ...receiptBody, receipt_digest: digest(receiptBody) });
  const receiptPath = path.join(outputDir, 'quantization-receipt.json');
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return Object.freeze({ receipt, receiptPath });
}

function parseArgs(argv) {
  const options = { quantizations: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    if (key === 'quantization') options.quantizations.push(value);
    else options[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return options;
}

async function cli() {
  const [command, ...argv] = process.argv.slice(2);
  if (command !== 'run') {
    process.stderr.write('Usage: node scripts/archie-student-quantize.mjs run --model-dir <merged-hf> --model-id <id> --model-revision-sha256 <sha256> --converter <convert_hf_to_gguf.py> --quantizer <llama-quantize> --python <python> --output-dir <dir> [--quantization Q4_K_M ...]\n');
    process.exitCode = 2;
    return;
  }
  const { receiptPath, receipt } = await runStudentQuantization(parseArgs(argv));
  process.stdout.write(`${JSON.stringify({ schema: receipt.schema, receipt_digest: receipt.receipt_digest, receipt_path: receiptPath, artifacts: receipt.artifacts }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
