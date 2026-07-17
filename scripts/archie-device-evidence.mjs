#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { digest } from './archie-launch-contract.mjs';

export const ARCHIE_DEVICE_EVIDENCE_CAMPAIGN_SCHEMA = 'archie-real-device-evidence-campaign/v1';
export const ARCHIE_DEVICE_PROBE_INPUT_SCHEMA = 'archie-real-device-probe-input/v1';
export const ARCHIE_DEVICE_PROBE_RESULT_SCHEMA = 'archie-real-device-probe-result/v1';
export const ARCHIE_DEVICE_PROBE_EXECUTION_SCHEMA = 'archie-real-device-probe-execution/v1';
export const ARCHIE_DEVICE_EVIDENCE_PACKAGE_SCHEMA = 'archie-real-device-evidence-package/v1';

const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const NETWORK = new Set(['none', 'optional', 'required']);
const SECRET_NAME = /(?:^|_)(?:API_KEY|PRIVATE_KEY|PASSWORD|SECRET|TOKEN|AUTHORIZATION|COOKIE|CREDENTIAL)(?:_|$)/i;
const SECRET_TEXT = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{12,})/i;
const OUTPUT_LIMIT = 5 * 1024 * 1024;

const clean = (value, field, limit = 10_000) => {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!text) throw new Error(`${field} is required.`);
  if (text.length > limit) throw new Error(`${field} exceeds ${limit} characters.`);
  if (SECRET_TEXT.test(text)) throw new Error(`${field} contains secret-like material.`);
  return text;
};

const object = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value;
};

const portableId = (value, field) => {
  const text = clean(value, field, 200);
  if (!SAFE_ID.test(text)) throw new Error(`${field} must be a portable identifier.`);
  return text;
};

const exactDigest = (value, field) => {
  const text = clean(value, field, 64).toLowerCase();
  if (!HEX_256.test(text)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return text;
};

const finite = (value, field, minimum = 0) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new Error(`${field} must be a finite number greater than or equal to ${minimum}.`);
  return number;
};

const integer = (value, field, minimum = 0) => {
  const number = finite(value, field, minimum);
  if (!Number.isSafeInteger(number)) throw new Error(`${field} must be a safe integer.`);
  return number;
};

const metricValue = (value, field, name) => {
  const number = finite(value, field);
  if (name.includes('_rate') && (number < 0 || number > 1)) throw new Error(`${field} must be between 0 and 1.`);
  return number;
};

const uniqueStrings = (values, field, { allowEmpty = true } = {}) => {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const output = values.map((value, index) => clean(value, `${field}[${index}]`, 500));
  if (!allowEmpty && !output.length) throw new Error(`${field} must not be empty.`);
  if (new Set(output).size !== output.length) throw new Error(`${field} contains duplicate values.`);
  return Object.freeze(output);
};

const booleanMap = (input, field) => Object.freeze(Object.fromEntries(Object.entries(object(input, field)).map(([key, value]) => {
  const name = portableId(key, `${field} key`);
  if (typeof value !== 'boolean') throw new Error(`${field}.${name} must be boolean.`);
  return [name, value];
})));

const numberMap = (input, field, { metrics = false } = {}) => Object.freeze(Object.fromEntries(Object.entries(object(input, field)).map(([keyInput, value]) => {
  const key = portableId(keyInput, `${field} key`);
  return [key, metrics ? metricValue(value, `${field}.${key}`, key) : finite(value, `${field}.${key}`)];
})));

const safeRelative = (value, field, { allowDot = false } = {}) => {
  const relative = clean(value, field, 1000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (allowDot && relative === '.') return '.';
  if (relative.startsWith('/') || /^[A-Za-z]:\//.test(relative)) throw new Error(`${field} must be relative.`);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${field} contains path traversal.`);
  return parts.join('/');
};

const relativeFileDescriptor = (input, field) => {
  const value = object(input, field);
  return Object.freeze({
    path: safeRelative(value.path, `${field}.path`),
    sha256: exactDigest(value.sha256, `${field}.sha256`),
    bytes: integer(value.bytes, `${field}.bytes`, 1)
  });
};

const executableDescriptor = (input, field) => {
  const value = object(input, field);
  const filename = clean(value.path, `${field}.path`, 2000);
  return Object.freeze({
    path: filename,
    sha256: exactDigest(value.sha256, `${field}.sha256`),
    bytes: integer(value.bytes, `${field}.bytes`, 1)
  });
};

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function verifyFile(filename, descriptor, field) {
  const stat = await fs.stat(filename);
  if (!stat.isFile()) throw new Error(`${field} must reference a file.`);
  if (stat.size !== descriptor.bytes) throw new Error(`${field} byte count mismatch.`);
  const observed = await hashFile(filename);
  if (observed !== descriptor.sha256) throw new Error(`${field} digest mismatch.`);
  return Object.freeze({ path: filename, bytes: stat.size, sha256: observed });
}

function resolveWithin(root, relative, field) {
  const rootPath = path.resolve(root);
  const filename = path.resolve(rootPath, relative);
  const difference = path.relative(rootPath, filename);
  if (difference.startsWith('..') || path.isAbsolute(difference)) throw new Error(`${field} escapes the campaign root.`);
  return filename;
}

function normalizeMachine(input) {
  const value = object(input, 'machine');
  const hardware = Object.freeze({
    device_class: clean(value.hardware?.device_class, 'machine.hardware.device_class', 200),
    architecture: clean(value.hardware?.architecture, 'machine.hardware.architecture', 100),
    cpu_threads: integer(value.hardware?.cpu_threads, 'machine.hardware.cpu_threads', 1),
    ram_bytes: integer(value.hardware?.ram_bytes, 'machine.hardware.ram_bytes', 1),
    vram_bytes: integer(value.hardware?.vram_bytes ?? 0, 'machine.hardware.vram_bytes'),
    disk_free_bytes: integer(value.hardware?.disk_free_bytes, 'machine.hardware.disk_free_bytes', 1),
    accelerators: uniqueStrings(value.hardware?.accelerators || [], 'machine.hardware.accelerators'),
    energy_watts_budget: finite(value.hardware?.energy_watts_budget, 'machine.hardware.energy_watts_budget'),
    thermal_celsius_limit: finite(value.hardware?.thermal_celsius_limit, 'machine.hardware.thermal_celsius_limit')
  });
  const operatingSystem = Object.freeze({
    family: clean(value.operating_system?.family, 'machine.operating_system.family', 100),
    version: clean(value.operating_system?.version, 'machine.operating_system.version', 200),
    background_model: clean(value.operating_system?.background_model, 'machine.operating_system.background_model', 300),
    sandbox: clean(value.operating_system?.sandbox, 'machine.operating_system.sandbox', 300)
  });
  const hardwareFingerprint = exactDigest(value.hardware_fingerprint, 'machine.hardware_fingerprint');
  const osFingerprint = exactDigest(value.os_fingerprint, 'machine.os_fingerprint');
  const deviceFingerprint = exactDigest(value.device_fingerprint, 'machine.device_fingerprint');
  if (digest(hardware) !== hardwareFingerprint) throw new Error('machine.hardware_fingerprint mismatch.');
  if (digest(operatingSystem) !== osFingerprint) throw new Error('machine.os_fingerprint mismatch.');
  if (digest({ hardware_fingerprint: hardwareFingerprint, os_fingerprint: osFingerprint }) !== deviceFingerprint) throw new Error('machine.device_fingerprint mismatch.');
  return Object.freeze({
    id: portableId(value.id, 'machine.id'),
    hardware,
    operating_system: operatingSystem,
    hardware_fingerprint: hardwareFingerprint,
    os_fingerprint: osFingerprint,
    device_fingerprint: deviceFingerprint,
    permissions: booleanMap(value.permissions || {}, 'machine.permissions'),
    network_available: value.network_available === true
  });
}

function normalizeGates(input, field) {
  const output = {};
  for (const [nameInput, value] of Object.entries(object(input || {}, field))) {
    const name = portableId(nameInput, `${field} key`);
    if (!name.endsWith('_min') && !name.endsWith('_max')) throw new Error(`${field}.${name} must end in _min or _max.`);
    output[name] = finite(value, `${field}.${name}`);
  }
  return Object.freeze(output);
}

function normalizeCommand(input, index) {
  const value = object(input, `probes[${index}].command`);
  const passEnvironment = uniqueStrings(value.pass_environment || [], `probes[${index}].command.pass_environment`);
  for (const name of passEnvironment) {
    if (!ENV_NAME.test(name)) throw new Error(`probes[${index}].command.pass_environment contains invalid name ${name}.`);
    if (SECRET_NAME.test(name)) throw new Error(`probes[${index}].command.pass_environment cannot include secret-like variable ${name}.`);
  }
  return Object.freeze({
    executable: executableDescriptor(value.executable, `probes[${index}].command.executable`),
    args: uniqueStrings(value.args || [], `probes[${index}].command.args`),
    bound_files: Object.freeze((value.bound_files || []).map((entry, fileIndex) => relativeFileDescriptor(entry, `probes[${index}].command.bound_files[${fileIndex}]`))),
    cwd: safeRelative(value.cwd || '.', `probes[${index}].command.cwd`, { allowDot: true }),
    timeout_ms: integer(value.timeout_ms ?? 120_000, `probes[${index}].command.timeout_ms`, 100),
    pass_environment: passEnvironment
  });
}

function normalizeProbe(input, index) {
  const value = object(input, `probes[${index}]`);
  const network = clean(value.network || 'none', `probes[${index}].network`, 100);
  if (!NETWORK.has(network)) throw new Error(`probes[${index}].network is unsupported.`);
  const requiredPermissions = uniqueStrings(value.required_permissions || [], `probes[${index}].required_permissions`);
  const revocationPermissions = uniqueStrings(value.revocation_permissions || [], `probes[${index}].revocation_permissions`);
  for (const permission of revocationPermissions) {
    if (!requiredPermissions.includes(permission)) throw new Error(`probes[${index}] revocation permission ${permission} is not required by the probe.`);
  }
  return Object.freeze({
    id: portableId(value.id, `probes[${index}].id`),
    capability_id: portableId(value.capability_id, `probes[${index}].capability_id`),
    required_for_launch: value.required_for_launch !== false,
    families: uniqueStrings(value.families, `probes[${index}].families`, { allowEmpty: false }),
    faculties: uniqueStrings(value.faculties, `probes[${index}].faculties`, { allowEmpty: false }),
    required_events: uniqueStrings(value.required_events, `probes[${index}].required_events`, { allowEmpty: false }),
    required_permissions: requiredPermissions,
    revocation_permissions: revocationPermissions,
    network,
    requires: uniqueStrings(value.requires || [], `probes[${index}].requires`),
    conflicts: uniqueStrings(value.conflicts || [], `probes[${index}].conflicts`),
    gates: normalizeGates(value.gates || {}, `probes[${index}].gates`),
    minimum_resources: numberMap(value.minimum_resources || {}, `probes[${index}].minimum_resources`),
    command: normalizeCommand(value.command, index)
  });
}

export function validateDeviceEvidenceCampaign(input) {
  const value = object(input, 'campaign');
  if (value.schema !== ARCHIE_DEVICE_EVIDENCE_CAMPAIGN_SCHEMA) throw new Error(`campaign.schema must equal ${ARCHIE_DEVICE_EVIDENCE_CAMPAIGN_SCHEMA}.`);
  const probes = (value.probes || []).map(normalizeProbe);
  if (!probes.length) throw new Error('campaign.probes must not be empty.');
  if (new Set(probes.map(probe => probe.id)).size !== probes.length) throw new Error('campaign.probes contains duplicate probe IDs.');
  if (new Set(probes.map(probe => probe.capability_id)).size !== probes.length) throw new Error('campaign.probes contains duplicate capability IDs.');
  const capabilityIds = new Set(probes.map(probe => probe.capability_id));
  for (const probe of probes) {
    for (const required of probe.requires) if (!capabilityIds.has(required)) throw new Error(`Probe ${probe.id} requires unknown capability ${required}.`);
    for (const conflict of probe.conflicts) if (!capabilityIds.has(conflict)) throw new Error(`Probe ${probe.id} conflicts with unknown capability ${conflict}.`);
  }
  const body = {
    schema: ARCHIE_DEVICE_EVIDENCE_CAMPAIGN_SCHEMA,
    id: portableId(value.id, 'campaign.id'),
    machine: normalizeMachine(value.machine),
    probes: Object.freeze(probes),
    claim_boundary: clean(value.claim_boundary, 'campaign.claim_boundary', 3000)
  };
  return Object.freeze({ ...body, campaign_digest: digest(body) });
}

function sanitizedEnvironment(passEnvironment) {
  const output = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR']) {
    if (process.env[name] !== undefined) output[name] = process.env[name];
  }
  for (const name of passEnvironment) {
    if (process.env[name] !== undefined) output[name] = process.env[name];
  }
  output.ARCHIE_REAL_DEVICE_PROBE = '1';
  return output;
}

async function executeProbeCommand({ executable, args, cwd, env, input, timeoutMs }) {
  const started = Date.now();
  return await new Promise(resolve => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const collect = (chunks, chunk, kind) => {
      const next = kind === 'stdout' ? stdoutBytes + chunk.length : stderrBytes + chunk.length;
      if (kind === 'stdout') stdoutBytes = next;
      else stderrBytes = next;
      if (next > OUTPUT_LIMIT) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', chunk => collect(stdout, chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(stderr, chunk, 'stderr'));
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal: signal || null,
        timed_out: timedOut,
        output_overflow: overflow,
        spawn_error: spawnError ? clean(spawnError.message || String(spawnError), 'spawn_error', 1000) : null,
        started_ms: started,
        ended_ms: Date.now(),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      });
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function verifyEmbeddedDigest(value, key, field) {
  const claimed = exactDigest(value[key], `${field}.${key}`);
  const body = { ...value };
  delete body[key];
  if (digest(body) !== claimed) throw new Error(`${field}.${key} mismatch.`);
  return claimed;
}

function orderedEventsPass(events, requiredEvents) {
  let cursor = 0;
  for (const event of events) {
    if (event.id === requiredEvents[cursor]) cursor += 1;
    if (cursor === requiredEvents.length) return true;
  }
  return requiredEvents.length === 0;
}

function gatePasses(metrics, gates) {
  const failures = [];
  for (const [gate, threshold] of Object.entries(gates)) {
    const metricName = gate.replace(/_(min|max)$/, '');
    const observed = metrics[metricName];
    const passed = observed !== undefined && (gate.endsWith('_max') ? observed <= threshold : observed >= threshold);
    if (!passed) failures.push({ gate, metric: metricName, threshold, observed: observed ?? null });
  }
  return failures;
}

async function verifyResultArtifacts(root, artifacts) {
  const verified = [];
  for (const [index, artifactInput] of artifacts.entries()) {
    const descriptor = relativeFileDescriptor(artifactInput, `result.artifacts[${index}]`);
    const filename = resolveWithin(root, descriptor.path, `result.artifacts[${index}].path`);
    await verifyFile(filename, descriptor, `result.artifacts[${index}]`);
    verified.push(descriptor);
  }
  return Object.freeze(verified);
}

async function validateProbeResult({ raw, campaign, probe, nonce, root, execution }) {
  const result = object(raw, 'result');
  if (result.schema !== ARCHIE_DEVICE_PROBE_RESULT_SCHEMA) throw new Error(`result.schema must equal ${ARCHIE_DEVICE_PROBE_RESULT_SCHEMA}.`);
  const resultDigest = verifyEmbeddedDigest(result, 'result_digest', 'result');
  const checks = [];
  const add = (id, passed, detail = null) => checks.push(Object.freeze({ id, passed: Boolean(passed), detail }));
  add('campaign-bound', result.campaign_id === campaign.id);
  add('campaign-digest-bound', result.campaign_digest === campaign.campaign_digest);
  add('probe-bound', result.probe_id === probe.id);
  add('machine-bound', result.device_fingerprint === campaign.machine.device_fingerprint);
  add('nonce-bound', result.nonce === nonce);
  add('completed', result.completed === true);
  add('real-device', result.real_device === true);
  add('not-mock', result.mock === false);
  add('promotion-eligible', result.promotion_eligible === true);

  const startedAt = Date.parse(result.started_at);
  const endedAt = Date.parse(result.ended_at);
  add('timestamps-valid', Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt);
  add('timestamps-bound-to-execution', Number.isFinite(startedAt) && Number.isFinite(endedAt) && startedAt >= execution.started_ms - 5000 && endedAt <= execution.ended_ms + 5000);

  const events = (result.events || []).map((eventInput, index) => {
    const event = object(eventInput, `result.events[${index}]`);
    return Object.freeze({
      id: portableId(event.id, `result.events[${index}].id`),
      at: clean(event.at, `result.events[${index}].at`, 100),
      evidence_digest: exactDigest(event.evidence_digest, `result.events[${index}].evidence_digest`)
    });
  });
  add('events-present', events.length > 0);
  add('required-event-order', orderedEventsPass(events, probe.required_events), { required: probe.required_events, observed: events.map(event => event.id) });

  const permissions = object(result.permissions || {}, 'result.permissions');
  for (const permission of probe.required_permissions) {
    const receipt = permissions[permission];
    add(`permission:${permission}`, receipt?.granted === true && HEX_256.test(String(receipt?.evidence_digest || '')));
  }

  const revocationChecks = Array.isArray(result.revocation_checks) ? result.revocation_checks : [];
  for (const permission of probe.revocation_permissions) {
    const receipt = revocationChecks.find(item => item?.permission === permission);
    add(`revocation:${permission}`, receipt?.revoked === true && receipt?.subsequent_access_denied === true && HEX_256.test(String(receipt?.evidence_digest || '')));
  }

  const metrics = numberMap(result.metrics || {}, 'result.metrics', { metrics: true });
  for (const failure of gatePasses(metrics, probe.gates)) add(`metric:${failure.gate}`, false, failure);
  const resources = numberMap(result.resource_cost || {}, 'result.resource_cost');
  const artifacts = await verifyResultArtifacts(root, Array.isArray(result.artifacts) ? result.artifacts : []);
  add('artifacts-present', artifacts.length > 0);

  const blockers = checks.filter(check => !check.passed).map(check => check.id);
  return Object.freeze({ result, result_digest: resultDigest, checks: Object.freeze(checks), blockers: Object.freeze(blockers), events: Object.freeze(events), metrics, resources, artifacts });
}

async function prepareCommand(root, probe) {
  const executablePath = path.isAbsolute(probe.command.executable.path)
    ? path.resolve(probe.command.executable.path)
    : resolveWithin(root, safeRelative(probe.command.executable.path, 'command.executable.path'), 'command.executable.path');
  await verifyFile(executablePath, probe.command.executable, 'command.executable');
  const boundFiles = [];
  for (const [index, descriptor] of probe.command.bound_files.entries()) {
    const filename = resolveWithin(root, descriptor.path, `command.bound_files[${index}].path`);
    await verifyFile(filename, descriptor, `command.bound_files[${index}]`);
    boundFiles.push(descriptor);
  }
  const cwd = probe.command.cwd === '.' ? path.resolve(root) : resolveWithin(root, probe.command.cwd, 'command.cwd');
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) throw new Error('command.cwd must reference a directory.');
  return Object.freeze({ executablePath, boundFiles: Object.freeze(boundFiles), cwd });
}

function failureCapability(probe, blockers, executionDigest = null) {
  return Object.freeze({
    id: probe.capability_id,
    status: 'absent',
    families: probe.families,
    faculties: probe.faculties,
    evidence_digests: executionDigest ? Object.freeze([executionDigest]) : Object.freeze([]),
    requires: probe.requires,
    conflicts: probe.conflicts,
    required_permissions: probe.required_permissions,
    network: probe.network,
    metrics: Object.freeze({}),
    gates: probe.gates,
    minimum_resources: probe.minimum_resources,
    resource_cost: Object.freeze({}),
    blockers: Object.freeze(blockers)
  });
}

async function runProbe(campaign, probe, root) {
  const nonce = crypto.randomBytes(32).toString('hex');
  let command;
  try {
    command = await prepareCommand(root, probe);
  } catch (error) {
    const blocker = `command-integrity:${clean(error.message || String(error), 'command_integrity_error', 1000)}`;
    return Object.freeze({ probe_id: probe.id, required_for_launch: probe.required_for_launch, capability: failureCapability(probe, [blocker]), execution: null, result: null });
  }

  const probeInputBody = {
    schema: ARCHIE_DEVICE_PROBE_INPUT_SCHEMA,
    campaign_id: campaign.id,
    campaign_digest: campaign.campaign_digest,
    probe_id: probe.id,
    device_fingerprint: campaign.machine.device_fingerprint,
    nonce,
    required_events: probe.required_events,
    required_permissions: probe.required_permissions,
    revocation_permissions: probe.revocation_permissions,
    gates: probe.gates
  };
  const probeInput = Object.freeze({ ...probeInputBody, input_digest: digest(probeInputBody) });
  const executionRaw = await executeProbeCommand({
    executable: command.executablePath,
    args: probe.command.args,
    cwd: command.cwd,
    env: sanitizedEnvironment(probe.command.pass_environment),
    input: probeInput,
    timeoutMs: probe.command.timeout_ms
  });
  const executionBody = {
    schema: ARCHIE_DEVICE_PROBE_EXECUTION_SCHEMA,
    campaign_id: campaign.id,
    probe_id: probe.id,
    device_fingerprint: campaign.machine.device_fingerprint,
    nonce,
    executable_sha256: probe.command.executable.sha256,
    bound_file_digests: command.boundFiles.map(file => file.sha256),
    args_digest: digest(probe.command.args),
    input_digest: probeInput.input_digest,
    exit_code: executionRaw.code,
    signal: executionRaw.signal,
    timed_out: executionRaw.timed_out,
    output_overflow: executionRaw.output_overflow,
    spawn_error: executionRaw.spawn_error,
    started_at: new Date(executionRaw.started_ms).toISOString(),
    ended_at: new Date(executionRaw.ended_ms).toISOString(),
    duration_ms: executionRaw.ended_ms - executionRaw.started_ms,
    stdout_sha256: crypto.createHash('sha256').update(executionRaw.stdout).digest('hex'),
    stderr_sha256: crypto.createHash('sha256').update(executionRaw.stderr).digest('hex')
  };
  const execution = Object.freeze({ ...executionBody, execution_digest: digest(executionBody) });
  const executionBlockers = [];
  if (execution.exit_code !== 0) executionBlockers.push(`execution-exit:${execution.exit_code}`);
  if (execution.timed_out) executionBlockers.push('execution-timeout');
  if (execution.output_overflow) executionBlockers.push('execution-output-overflow');
  if (execution.spawn_error) executionBlockers.push('execution-spawn-error');

  let parsed = null;
  try {
    parsed = JSON.parse(executionRaw.stdout.toString('utf8').trim());
  } catch {
    executionBlockers.push('result-invalid-json');
  }
  if (executionBlockers.length || !parsed) {
    return Object.freeze({
      probe_id: probe.id,
      required_for_launch: probe.required_for_launch,
      capability: failureCapability(probe, executionBlockers, execution.execution_digest),
      execution,
      result: null
    });
  }

  let verified;
  try {
    verified = await validateProbeResult({ raw: parsed, campaign, probe, nonce, root, execution: executionRaw });
  } catch (error) {
    const blocker = `result-invalid:${clean(error.message || String(error), 'result_validation_error', 1000)}`;
    return Object.freeze({
      probe_id: probe.id,
      required_for_launch: probe.required_for_launch,
      capability: failureCapability(probe, [blocker], execution.execution_digest),
      execution,
      result: null
    });
  }

  const evidenceDigests = [...new Set([
    execution.execution_digest,
    verified.result_digest,
    ...verified.events.map(event => event.evidence_digest),
    ...verified.artifacts.map(artifact => artifact.sha256),
    ...Object.values(verified.result.permissions || {}).map(receipt => receipt?.evidence_digest).filter(value => HEX_256.test(String(value || ''))),
    ...(verified.result.revocation_checks || []).map(receipt => receipt?.evidence_digest).filter(value => HEX_256.test(String(value || '')))
  ])];
  const capability = Object.freeze({
    id: probe.capability_id,
    status: verified.blockers.length ? 'absent' : 'admitted',
    families: probe.families,
    faculties: probe.faculties,
    evidence_digests: Object.freeze(evidenceDigests),
    requires: probe.requires,
    conflicts: probe.conflicts,
    required_permissions: probe.required_permissions,
    network: probe.network,
    metrics: verified.metrics,
    gates: probe.gates,
    minimum_resources: probe.minimum_resources,
    resource_cost: verified.resources,
    blockers: verified.blockers
  });
  return Object.freeze({ probe_id: probe.id, required_for_launch: probe.required_for_launch, capability, execution, result: verified.result });
}

export async function runDeviceEvidenceCampaign(input, { root = '.' } = {}) {
  const campaign = validateDeviceEvidenceCampaign(input);
  const runs = [];
  for (const probe of campaign.probes) runs.push(await runProbe(campaign, probe, path.resolve(root)));
  const requiredFailures = runs.filter(run => run.required_for_launch && run.capability.status !== 'admitted');
  const body = {
    schema: ARCHIE_DEVICE_EVIDENCE_PACKAGE_SCHEMA,
    campaign_id: campaign.id,
    campaign_digest: campaign.campaign_digest,
    machine: campaign.machine,
    decision: requiredFailures.length ? 'rejected-real-device-evidence' : 'admitted-real-device-evidence',
    probes: Object.freeze(runs),
    capabilities: Object.freeze(runs.map(run => run.capability)),
    admitted_capability_ids: Object.freeze(runs.filter(run => run.capability.status === 'admitted').map(run => run.capability.id)),
    blockers: Object.freeze(requiredFailures.map(run => ({ probe_id: run.probe_id, blockers: run.capability.blockers }))),
    claim_boundary: requiredFailures.length
      ? 'No failed required probe may contribute an admitted faculty or product claim. Adapter output, mock declarations, stale receipts, and precomputed evidence cannot substitute for a fresh hash-bound real-device execution.'
      : 'These capabilities were observed through fresh nonce-bound executions of exact adapter bytes on this exact machine. The package does not prove hardware-backed attestation or admit intelligence, aggregate launch resources, or a product form by itself.'
  };
  return Object.freeze({ ...body, package_digest: digest(body) });
}

function parse(argv) {
  const command = argv[0] || 'run';
  const flags = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}.`);
    const [name, inline] = token.split('=', 2);
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${name} requires a value.`);
    flags.set(name, next);
    index += 1;
  }
  return { command, flags };
}

function usage() {
  return `Archie real-device evidence campaign\n\nUsage:\n  node scripts/archie-device-evidence.mjs run --campaign campaign.json [--output evidence-package.json]\n\nEach probe executes an exact hash-bound adapter with a fresh nonce. Only real-device, non-mock, permission-bound, event-complete, gate-passing results emit admitted launch capabilities.`;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const { command, flags } = parse(argv);
  if (command !== 'run') throw new Error(`Unknown command ${command}.\n\n${usage()}`);
  const campaignFilename = flags.get('--campaign');
  if (!campaignFilename) throw new Error('--campaign is required.');
  const resolved = path.resolve(campaignFilename);
  const campaign = JSON.parse(await fs.readFile(resolved, 'utf8'));
  const evidence = await runDeviceEvidenceCampaign(campaign, { root: path.dirname(resolved) });
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  const output = flags.get('--output');
  if (output) {
    const filename = path.resolve(output);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, text);
    process.stdout.write(`${filename}\n`);
  } else {
    process.stdout.write(text);
  }
  if (evidence.decision !== 'admitted-real-device-evidence') process.exitCode = 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-device-evidence: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
