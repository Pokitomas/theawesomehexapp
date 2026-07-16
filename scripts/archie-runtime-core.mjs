import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const ARCHIE_MODEL_MANIFEST_SCHEMA = 'archie-model-manifest/v1';
export const ARCHIE_RUNTIME_ABI = 'archie-runtime/v1';
export const ARCHIE_PULL_RECEIPT_SCHEMA = 'archie-model-pull-receipt/v1';
export const ARCHIE_RUN_RECEIPT_SCHEMA = 'archie-model-run-receipt/v1';
export const ARCHIE_BENCHMARK_REPORT_SCHEMA = 'archie-model-benchmark-report/v1';

const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_CAPTURE = 16 * 1024 * 1024;

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function clean(value, limit = 20_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function assertSafeName(value, field) {
  const result = clean(value, 128);
  if (!SAFE_NAME.test(result)) throw new Error(`${field} must be a portable identifier.`);
  return result;
}

function assertSafeInteger(value, field, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} must be a safe integer >= ${minimum}.`);
  return value;
}

function assertDigest(value, field) {
  const result = clean(value, 64).toLowerCase();
  if (!HEX_256.test(result)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function assertSource(value, field) {
  const source = clean(value, 10_000);
  if (!source) throw new Error(`${field} is required.`);
  if (/^https?:\/\//i.test(source) || /^file:/i.test(source)) return source;
  if (path.isAbsolute(source) || source.startsWith('./') || source.startsWith('../')) return source;
  throw new Error(`${field} must be an http(s), file URL, or explicit filesystem path.`);
}

function unsignedManifestBody(manifest) {
  const { signature, manifest_digest, ...body } = manifest || {};
  return canonical(body);
}

function signedManifestBody(manifest) {
  return canonical({ ...unsignedManifestBody(manifest), manifest_digest: clean(manifest?.manifest_digest, 64) });
}

export function manifestDigest(manifest) {
  return sha256(unsignedManifestBody(manifest));
}

export function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return sha256(der);
}

export function signManifest(manifest, { private_key_pem, public_key_pem }) {
  const body = unsignedManifestBody(manifest);
  const manifest_digest = sha256(body);
  const fingerprint = publicKeyFingerprint(public_key_pem);
  const payload = stableJSONStringify({ ...body, manifest_digest });
  const signature = crypto.sign(null, Buffer.from(payload), private_key_pem).toString('base64');
  return Object.freeze({
    ...body,
    manifest_digest,
    signature: Object.freeze({
      algorithm: 'ed25519',
      key_fingerprint: fingerprint,
      public_key_pem: clean(public_key_pem, 20_000),
      value_base64: signature
    })
  });
}

function normalizeTrustedKeys(values = []) {
  const fingerprints = new Set();
  for (const value of values) {
    const text = clean(value, 50_000);
    if (!text) continue;
    if (HEX_256.test(text)) fingerprints.add(text);
    else fingerprints.add(publicKeyFingerprint(text));
  }
  return fingerprints;
}

export function validateManifestShape(manifest) {
  if (!manifest || manifest.schema !== ARCHIE_MODEL_MANIFEST_SCHEMA) throw new Error('Unsupported Archie model manifest schema.');
  const model = manifest.model || {};
  assertSafeName(model.id, 'model.id');
  assertSafeName(model.version, 'model.version');
  if (clean(model.runtime_abi, 100) !== ARCHIE_RUNTIME_ABI) throw new Error(`runtime ABI mismatch: expected ${ARCHIE_RUNTIME_ABI}.`);
  if (!clean(model.architecture, 200)) throw new Error('model.architecture is required.');
  if (!clean(model.format, 100)) throw new Error('model.format is required.');
  if (!clean(model.quantization, 100)) throw new Error('model.quantization is required.');
  assertSafeInteger(model.context_limit, 'model.context_limit', { minimum: 1 });

  const sizes = manifest.sizes || {};
  assertSafeInteger(sizes.download_bytes, 'sizes.download_bytes', { minimum: 1 });
  assertSafeInteger(sizes.installed_bytes, 'sizes.installed_bytes', { minimum: 1 });
  assertSafeInteger(manifest.hardware?.required_ram_bytes, 'hardware.required_ram_bytes');
  assertSafeInteger(manifest.hardware?.recommended_ram_bytes, 'hardware.recommended_ram_bytes');
  assertSafeInteger(manifest.hardware?.disk_bytes, 'hardware.disk_bytes', { minimum: sizes.installed_bytes });
  if (!Array.isArray(manifest.hardware?.backends) || !manifest.hardware.backends.length) throw new Error('hardware.backends must be non-empty.');

  assertDigest(manifest.artifact?.sha256, 'artifact.sha256');
  const filename = clean(manifest.artifact?.filename, 255);
  if (!filename || path.basename(filename) !== filename) throw new Error('artifact.filename must be one portable basename.');
  if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) throw new Error('chunks must be non-empty.');
  let total = 0;
  manifest.chunks.forEach((chunk, index) => {
    if (chunk.index !== index) throw new Error(`chunk index ${index} is not contiguous.`);
    assertSource(chunk.url, `chunks[${index}].url`);
    total += assertSafeInteger(chunk.bytes, `chunks[${index}].bytes`, { minimum: 1 });
    assertDigest(chunk.sha256, `chunks[${index}].sha256`);
  });
  if (total !== sizes.download_bytes) throw new Error('Chunk byte total does not equal sizes.download_bytes.');
  if (sizes.installed_bytes !== sizes.download_bytes) throw new Error('v1 direct artifacts require installed_bytes to equal download_bytes.');

  assertDigest(manifest.state?.immutable_digest, 'state.immutable_digest');
  assertDigest(manifest.state?.mutable_digest, 'state.mutable_digest');
  if (!Array.isArray(manifest.state?.mutable_regions)) throw new Error('state.mutable_regions must be an array.');
  for (const field of ['license', 'source', 'training', 'code_commit']) {
    if (!clean(manifest.provenance?.[field], 10_000)) throw new Error(`provenance.${field} is required.`);
  }
  assertDigest(manifest.benchmarks?.suite_digest, 'benchmarks.suite_digest');
  assertDigest(manifest.benchmarks?.report_digest, 'benchmarks.report_digest');
  if (!clean(manifest.benchmarks?.claim_boundary, 10_000)) throw new Error('benchmarks.claim_boundary is required.');
  if (manifest.runtime?.adapter !== 'process-template/v1') throw new Error('runtime.adapter must equal process-template/v1.');
  if (!Array.isArray(manifest.runtime?.arguments) || !manifest.runtime.arguments.length) throw new Error('runtime.arguments must be non-empty.');
  for (const argument of manifest.runtime.arguments) {
    if (typeof argument !== 'string' || argument.includes('\u0000') || argument.length > 20_000) throw new Error('runtime.arguments contains an invalid argument.');
  }

  if (!manifest.signature || manifest.signature.algorithm !== 'ed25519') throw new Error('Manifest requires an Ed25519 signature.');
  assertDigest(manifest.signature.key_fingerprint, 'signature.key_fingerprint');
  if (!clean(manifest.signature.public_key_pem, 20_000)) throw new Error('signature.public_key_pem is required.');
  if (!clean(manifest.signature.value_base64, 20_000)) throw new Error('signature.value_base64 is required.');
  assertDigest(manifest.manifest_digest, 'manifest_digest');
  return true;
}

export function verifyManifest(manifest, { trusted_public_keys = [], allow_untrusted = false } = {}) {
  validateManifestShape(manifest);
  const expectedDigest = manifestDigest(manifest);
  if (expectedDigest !== manifest.manifest_digest) throw new Error('Manifest digest mismatch.');
  const fingerprint = publicKeyFingerprint(manifest.signature.public_key_pem);
  if (fingerprint !== manifest.signature.key_fingerprint) throw new Error('Manifest signing-key fingerprint mismatch.');
  const signature = Buffer.from(manifest.signature.value_base64, 'base64');
  const valid = crypto.verify(null, Buffer.from(stableJSONStringify(signedManifestBody(manifest))), manifest.signature.public_key_pem, signature);
  if (!valid) throw new Error('Manifest signature verification failed.');
  const trusted = normalizeTrustedKeys(trusted_public_keys);
  if (!allow_untrusted && !trusted.has(fingerprint)) throw new Error(`Manifest key is not trusted: ${fingerprint}.`);
  return Object.freeze({ manifest_digest: expectedDigest, key_fingerprint: fingerprint, trust: trusted.has(fingerprint) ? 'trusted' : 'self-signed-untrusted' });
}

export function resolveArchieHome({ env = process.env, home = os.homedir() } = {}) {
  return path.resolve(clean(env.ARCHIE_HOME, 4000) || path.join(home, '.archie'));
}

function modelReference(model) {
  return `${assertSafeName(model.id, 'model.id')}@${assertSafeName(model.version, 'model.version')}`;
}

function indexPath(home) {
  return path.join(home, 'models', 'index.json');
}

async function readJSON(filename, fallback = null) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT' && fallback !== null) return fallback; throw error; }
}

async function writeJSONAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(canonical(value), null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

async function readManifestSource(source, fetchImpl = globalThis.fetch) {
  const location = assertSource(source, 'manifest source');
  if (/^https?:\/\//i.test(location)) {
    if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation is available.');
    const response = await fetchImpl(location, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Manifest download failed with HTTP ${response.status}.`);
    return JSON.parse(await response.text());
  }
  const filename = /^file:/i.test(location) ? fileURLToPath(location) : path.resolve(location);
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function sourceReadable(source, offset, fetchImpl) {
  if (/^https?:\/\//i.test(source)) {
    const headers = offset ? { Range: `bytes=${offset}-` } : {};
    const response = await fetchImpl(source, { headers, redirect: 'follow' });
    if (!response.ok) throw new Error(`Chunk download failed with HTTP ${response.status}.`);
    if (offset && response.status !== 206) return { readable: Readable.fromWeb(response.body), resumed: false };
    return { readable: Readable.fromWeb(response.body), resumed: Boolean(offset) };
  }
  const filename = /^file:/i.test(source) ? fileURLToPath(source) : path.resolve(source);
  return { readable: createReadStream(filename, offset ? { start: offset } : undefined), resumed: Boolean(offset) };
}

async function downloadChunk(chunk, destination, fetchImpl) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  let existing = 0;
  try { existing = (await fs.stat(destination)).size; } catch {}
  if (existing > chunk.bytes) {
    await fs.rm(destination, { force: true });
    existing = 0;
  }
  let source = await sourceReadable(chunk.url, existing, fetchImpl);
  if (existing && !source.resumed) {
    await fs.rm(destination, { force: true });
    existing = 0;
    source = await sourceReadable(chunk.url, 0, fetchImpl);
  }
  await pipeline(source.readable, createWriteStream(destination, { flags: existing ? 'a' : 'w', mode: 0o600 }));
  const stat = await fs.stat(destination);
  if (stat.size !== chunk.bytes) throw new Error(`Chunk ${chunk.index} byte mismatch: expected ${chunk.bytes}, received ${stat.size}.`);
  const digest = await hashFile(destination);
  if (digest !== chunk.sha256) throw new Error(`Chunk ${chunk.index} digest mismatch.`);
  return { index: chunk.index, bytes: stat.size, sha256: digest };
}

function receipt(schema, payload, clock = Date.now) {
  const observed_at = new Date(typeof clock === 'function' ? clock() : clock).toISOString();
  const body = { schema, observed_at, payload: canonical(payload) };
  return Object.freeze({ ...body, receipt_digest: sha256(body) });
}

async function loadIndex(home) {
  const index = await readJSON(indexPath(home), { schema: 'archie-model-index/v1', models: {} });
  if (index.schema !== 'archie-model-index/v1' || !index.models || typeof index.models !== 'object') throw new Error('Archie model index is corrupt.');
  return index;
}

async function saveIndex(home, index) {
  await writeJSONAtomic(indexPath(home), index);
}

export async function pullModel(manifestSource, {
  home = resolveArchieHome(),
  trusted_public_keys = [],
  allow_untrusted = false,
  fetchImpl = globalThis.fetch,
  clock = Date.now
} = {}) {
  const manifest = await readManifestSource(manifestSource, fetchImpl);
  const trust = verifyManifest(manifest, { trusted_public_keys, allow_untrusted });
  const reference = modelReference(manifest.model);
  const digest = manifest.artifact.sha256;
  const target = path.join(home, 'models', manifest.model.id, manifest.model.version, digest);
  const artifactPath = path.join(target, manifest.artifact.filename);
  const staging = path.join(home, 'staging', `${manifest.model.id}-${manifest.model.version}-${crypto.randomBytes(8).toString('hex')}`);
  try {
    await fs.mkdir(path.join(staging, 'chunks'), { recursive: true });
    const chunkReceipts = [];
    for (const chunk of manifest.chunks) {
      chunkReceipts.push(await downloadChunk(chunk, path.join(staging, 'chunks', `${String(chunk.index).padStart(6, '0')}.part`), fetchImpl));
    }
    const assembled = path.join(staging, manifest.artifact.filename);
    await fs.rm(assembled, { force: true });
    for (const chunk of manifest.chunks) {
      const source = path.join(staging, 'chunks', `${String(chunk.index).padStart(6, '0')}.part`);
      await pipeline(createReadStream(source), createWriteStream(assembled, { flags: 'a', mode: 0o600 }));
    }
    const assembledStat = await fs.stat(assembled);
    if (assembledStat.size !== manifest.sizes.installed_bytes) throw new Error('Installed artifact byte count does not match the manifest.');
    const assembledDigest = await hashFile(assembled);
    if (assembledDigest !== digest) throw new Error('Assembled artifact digest mismatch.');

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await fs.rename(assembled, artifactPath);
    await writeJSONAtomic(path.join(target, 'manifest.json'), manifest);
    const pullReceipt = receipt(ARCHIE_PULL_RECEIPT_SCHEMA, {
      model_ref: reference,
      manifest_digest: trust.manifest_digest,
      artifact_digest: digest,
      exact_download_bytes: manifest.sizes.download_bytes,
      exact_installed_bytes: assembledStat.size,
      chunks: chunkReceipts,
      hardware: manifest.hardware,
      provenance: manifest.provenance,
      runtime_abi: manifest.model.runtime_abi,
      state: manifest.state,
      benchmark_digests: manifest.benchmarks,
      trust: { mode: trust.trust, key_fingerprint: trust.key_fingerprint },
      installed_path: artifactPath
    }, clock);
    await writeJSONAtomic(path.join(target, 'pull-receipt.json'), pullReceipt);
    const index = await loadIndex(home);
    index.models[reference] = { artifact_digest: digest, directory: target, installed_at: pullReceipt.observed_at };
    await saveIndex(home, index);
    return Object.freeze({ manifest, receipt: pullReceipt, artifact_path: artifactPath });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

function parseReference(reference) {
  const value = clean(reference, 300);
  const split = value.lastIndexOf('@');
  if (split <= 0 || split === value.length - 1) throw new Error('Model reference must use id@version.');
  return { id: assertSafeName(value.slice(0, split), 'model id'), version: assertSafeName(value.slice(split + 1), 'model version'), reference: value };
}

export async function loadInstalledModel(reference, { home = resolveArchieHome(), verify_artifact = true } = {}) {
  const parsed = parseReference(reference);
  const index = await loadIndex(home);
  const entry = index.models[parsed.reference];
  if (!entry) throw new Error(`Model is not installed: ${parsed.reference}.`);
  const manifest = await readJSON(path.join(entry.directory, 'manifest.json'));
  const pullReceipt = await readJSON(path.join(entry.directory, 'pull-receipt.json'));
  verifyManifest(manifest, { allow_untrusted: true });
  if (manifest.artifact.sha256 !== entry.artifact_digest) throw new Error('Installed index artifact digest mismatch.');
  const artifactPath = path.join(entry.directory, manifest.artifact.filename);
  if (verify_artifact) {
    const stat = await fs.stat(artifactPath);
    if (stat.size !== manifest.sizes.installed_bytes) throw new Error('Installed artifact size mismatch.');
    if (await hashFile(artifactPath) !== manifest.artifact.sha256) throw new Error('Installed artifact digest mismatch.');
  }
  if (pullReceipt?.schema !== ARCHIE_PULL_RECEIPT_SCHEMA || pullReceipt.receipt_digest !== sha256({ schema: pullReceipt.schema, observed_at: pullReceipt.observed_at, payload: pullReceipt.payload })) throw new Error('Pull receipt integrity failure.');
  return Object.freeze({ reference: parsed.reference, entry, manifest, pull_receipt: pullReceipt, artifact_path: artifactPath });
}

export async function inspectModel(reference, options = {}) {
  const installed = await loadInstalledModel(reference, options);
  return Object.freeze({
    model_ref: installed.reference,
    artifact_path: installed.artifact_path,
    manifest: installed.manifest,
    pull_receipt: installed.pull_receipt
  });
}

function expandArgument(argument, values) {
  return argument.replace(/\{(artifact|prompt|max_tokens|context|temperature|seed)\}/g, (_match, key) => String(values[key]));
}

function runProcess(executable, args, { cwd, env, timeout_ms }) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer;
    const append = (current, chunk) => (current + String(chunk)).slice(-MAX_CAPTURE);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const latency_ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ code: Number.isInteger(code) ? code : 1, signal: signal || null, stdout, stderr, latency_ms });
    });
    timer = setTimeout(() => child.kill('SIGKILL'), timeout_ms);
    timer.unref?.();
  });
}

export async function runModel(reference, {
  home = resolveArchieHome(),
  prompt,
  runner_path = process.env.ARCHIE_RUNNER || 'llama-cli',
  runner_prefix_args = [],
  max_tokens = 256,
  context,
  temperature = 0,
  seed = 0,
  timeout_ms = 5 * 60_000,
  env = process.env,
  clock = Date.now
} = {}) {
  const installed = await loadInstalledModel(reference, { home });
  const input = clean(prompt, 200_000);
  if (!input) throw new Error('A non-empty prompt is required.');
  const values = {
    artifact: installed.artifact_path,
    prompt: input,
    max_tokens: assertSafeInteger(Number(max_tokens), 'max_tokens', { minimum: 1 }),
    context: assertSafeInteger(Number(context || installed.manifest.model.context_limit), 'context', { minimum: 1 }),
    temperature: Number(temperature),
    seed: Number(seed)
  };
  if (!Number.isFinite(values.temperature) || values.temperature < 0 || values.temperature > 2) throw new Error('temperature must be between 0 and 2.');
  if (!Number.isSafeInteger(values.seed)) throw new Error('seed must be a safe integer.');
  const args = [...runner_prefix_args.map(value => clean(value, 20_000)), ...installed.manifest.runtime.arguments.map(argument => expandArgument(argument, values))];
  const result = await runProcess(clean(runner_path, 4000), args, { cwd: installed.entry.directory, env, timeout_ms: assertSafeInteger(Number(timeout_ms), 'timeout_ms', { minimum: 1 }) });
  const runReceipt = receipt(ARCHIE_RUN_RECEIPT_SCHEMA, {
    model_ref: installed.reference,
    artifact_digest: installed.manifest.artifact.sha256,
    manifest_digest: installed.manifest.manifest_digest,
    runtime_abi: installed.manifest.model.runtime_abi,
    backend: installed.manifest.runtime.adapter,
    executable: path.basename(clean(runner_path, 4000)),
    arguments_digest: sha256(args),
    prompt_digest: sha256(input),
    output_digest: sha256(result.stdout),
    stderr_digest: sha256(result.stderr),
    exit_code: result.code,
    signal: result.signal,
    latency_ms: Number(result.latency_ms.toFixed(3)),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    generation: { max_tokens: values.max_tokens, context: values.context, temperature: values.temperature, seed: values.seed }
  }, clock);
  const receiptDirectory = path.join(home, 'receipts', 'runs');
  await writeJSONAtomic(path.join(receiptDirectory, `${runReceipt.receipt_digest}.json`), runReceipt);
  return Object.freeze({ ...result, receipt: runReceipt });
}

export async function benchmarkModel(reference, suiteSource, options = {}) {
  const suite = await readManifestSource(suiteSource, options.fetchImpl || globalThis.fetch);
  if (!suite || suite.schema !== 'archie-benchmark-suite/v1' || !Array.isArray(suite.cases) || !suite.cases.length) throw new Error('Unsupported or empty Archie benchmark suite.');
  const cases = [];
  for (const item of suite.cases) {
    const id = assertSafeName(item.id, 'benchmark case id');
    const run = await runModel(reference, { ...options, prompt: item.prompt, temperature: 0, seed: Number.isSafeInteger(item.seed) ? item.seed : 0 });
    const includes = Array.isArray(item.expect?.includes) ? item.expect.includes.map(value => clean(value, 10_000)) : [];
    const excludes = Array.isArray(item.expect?.excludes) ? item.expect.excludes.map(value => clean(value, 10_000)) : [];
    const passed = run.code === 0 && includes.every(value => run.stdout.includes(value)) && excludes.every(value => !run.stdout.includes(value));
    cases.push({ id, passed, exit_code: run.code, output_digest: sha256(run.stdout), run_receipt_digest: run.receipt.receipt_digest, latency_ms: run.receipt.payload.latency_ms });
  }
  const installed = await loadInstalledModel(reference, { home: options.home || resolveArchieHome() });
  const body = {
    schema: ARCHIE_BENCHMARK_REPORT_SCHEMA,
    suite: { id: clean(suite.id, 300), digest: sha256(suite) },
    model_ref: installed.reference,
    artifact_digest: installed.manifest.artifact.sha256,
    manifest_digest: installed.manifest.manifest_digest,
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    summary: { total: cases.length, passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length },
    cases
  };
  const report = Object.freeze({ ...body, report_digest: sha256(body) });
  await writeJSONAtomic(path.join(options.home || resolveArchieHome(), 'receipts', 'benchmarks', `${report.report_digest}.json`), report);
  return report;
}

export async function listModels({ home = resolveArchieHome() } = {}) {
  const index = await loadIndex(home);
  return Object.freeze(Object.entries(index.models).sort(([a], [b]) => a.localeCompare(b)).map(([model_ref, entry]) => Object.freeze({ model_ref, ...entry })));
}

export async function removeModel(reference, { home = resolveArchieHome() } = {}) {
  const parsed = parseReference(reference);
  const index = await loadIndex(home);
  const entry = index.models[parsed.reference];
  if (!entry) return Object.freeze({ removed: false, model_ref: parsed.reference });
  await fs.rm(entry.directory, { recursive: true, force: true });
  delete index.models[parsed.reference];
  await saveIndex(home, index);
  return Object.freeze({ removed: true, model_ref: parsed.reference, artifact_digest: entry.artifact_digest });
}
