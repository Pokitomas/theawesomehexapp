#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ARCHIE_HYBRID_RUNNER_STATE_SCHEMA,
  ARCHIE_HYBRID_RUNNER_VERSION,
  defaultRunnerAdvertisement,
  runHybridRunnerOnce as runEnrolledHybridRunnerOnce
} from './archie-enrolled-hybrid-runner.mjs';
import { executeStandaloneJourney } from './archie-standalone-journey.mjs';
import { exportWorkspaceBundle } from './archie-workspace-portable.mjs';
import { createWorkspaceEngine } from './archie-workspace-core.mjs';
import { SafeFileWorkspaceProvider } from './archie-workspace-file-provider.mjs';

export const ARCHIE_HYBRID_RUNNER_SCHEMA = 'archie-hybrid-runner/v1';
const DEFAULT_CAPABILITIES = Object.freeze(['maker', 'portable_workspace']);

function integer(value, label, { min, max } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
    throw new Error(`${label} must be an integer${min !== undefined ? ` >= ${min}` : ''}${max !== undefined ? ` and <= ${max}` : ''}.`);
  }
  return parsed;
}

function clean(value, limit = 2_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function normalizeUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('ARCHIED_HYBRID_URL must be an http(s) URL without embedded credentials.');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

export function resolveHybridRunnerConfig({ env = process.env, home = null } = {}) {
  const token = String(env.ARCHIED_RUNNER_TOKEN || '');
  if (token.length < 24) throw new Error('ARCHIED_RUNNER_TOKEN must contain at least 24 characters.');
  const endpoint = normalizeUrl(env.ARCHIED_HYBRID_URL || 'http://127.0.0.1:8787');
  const selectedHome = path.resolve(home || env.ARCHIE_HOME || path.join(os.homedir(), '.archie'));
  const runnerId = clean(env.ARCHIED_RUNNER_ID || `${os.hostname()}-${process.platform}-${process.arch}`, 160).replace(/[^a-zA-Z0-9_.-]/g, '-');
  if (runnerId.length < 3) throw new Error('ARCHIED_RUNNER_ID is invalid.');
  return Object.freeze({
    schema: ARCHIE_HYBRID_RUNNER_SCHEMA,
    endpoint,
    token,
    home: selectedHome,
    runner_id: runnerId,
    poll_interval_ms: integer(env.ARCHIED_RUNNER_POLL_MS || 5_000, 'ARCHIED_RUNNER_POLL_MS', { min: 1_000, max: 300_000 }),
    lease_ttl_ms: integer(env.ARCHIED_RUNNER_LEASE_MS || 120_000, 'ARCHIED_RUNNER_LEASE_MS', { min: 15_000, max: 30 * 60_000 }),
    capabilities: DEFAULT_CAPABILITIES
  });
}

async function request(config, pathname, { method = 'GET', body = null, signal = null } = {}) {
  const url = new URL(pathname, `${config.endpoint.href}/`);
  const response = await fetch(url, {
    method,
    signal,
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : null
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text }; }
  if (!response.ok) {
    const error = new Error(payload?.message || `Hybrid service returned HTTP ${response.status}.`);
    error.status = response.status;
    error.code = payload?.error || 'hybrid_http_error';
    throw error;
  }
  return payload;
}

export async function executeHybridJob(job, { home } = {}) {
  if (job?.kind !== 'standalone_product_journey') throw new Error(`Unsupported hybrid job kind: ${job?.kind || 'missing'}.`);
  const dataRoot = path.join(path.resolve(home), 'standalone');
  const provider = new SafeFileWorkspaceProvider(path.join(dataRoot, 'workspaces'));
  const engine = createWorkspaceEngine({ provider });
  const result = await executeStandaloneJourney({
    engine,
    dataRoot,
    objective: job.objective,
    requestedChange: job.requested_change,
    approve: job.approve === true,
    visibility: job.visibility || 'private'
  });
  const bundle = await exportWorkspaceBundle({ engine, workspaceId: result.workspace_id, principalId: 'owner_local' });
  return Object.freeze({
    schema: 'archie-hybrid-runner-result/v1',
    workspace_id: bundle.workspace_id,
    bundle_digest: bundle.bundle_digest,
    head_digest: bundle.head_digest,
    event_count: bundle.event_count,
    artifact_count: bundle.artifacts.length,
    bundle,
    claim_boundary: 'A local outbound-only runner executed the bounded Maker journey and returned an integrity-checked portable workspace. The result does not prove external deployment, model quality, native-device admission, or customer value.'
  });
}

export async function runHybridOnce(configInput = {}) {
  const config = configInput.schema === ARCHIE_HYBRID_RUNNER_SCHEMA ? configInput : resolveHybridRunnerConfig(configInput);
  const leased = await request(config, '/v1/hybrid/lease', {
    method: 'POST',
    body: {
      runner_id: config.runner_id,
      capabilities: config.capabilities,
      ttl_ms: config.lease_ttl_ms
    }
  });
  if (!leased?.job) return Object.freeze({ schema: ARCHIE_HYBRID_RUNNER_SCHEMA, status: 'idle', runner_id: config.runner_id });

  const job = leased.job;
  const lease = job.lease;
  let heartbeatFailure = null;
  const heartbeat = setInterval(() => {
    request(config, `/v1/hybrid/jobs/${encodeURIComponent(job.job_id)}/heartbeat`, {
      method: 'POST',
      body: { ...lease, ttl_ms: config.lease_ttl_ms }
    }).catch(error => { heartbeatFailure = error; });
  }, Math.max(5_000, Math.floor(config.lease_ttl_ms / 3)));
  heartbeat.unref?.();

  try {
    const result = await executeHybridJob(job, config);
    if (heartbeatFailure) throw heartbeatFailure;
    const completed = await request(config, `/v1/hybrid/jobs/${encodeURIComponent(job.job_id)}/complete`, {
      method: 'POST',
      body: { ...lease, result }
    });
    return Object.freeze({
      schema: ARCHIE_HYBRID_RUNNER_SCHEMA,
      status: 'completed',
      runner_id: config.runner_id,
      job_id: job.job_id,
      workspace_id: completed.job.result.workspace_id,
      bundle_digest: completed.job.result.bundle_digest
    });
  } catch (error) {
    await request(config, `/v1/hybrid/jobs/${encodeURIComponent(job.job_id)}/fail`, {
      method: 'POST',
      body: {
        ...lease,
        failure: {
          code: clean(error?.code || 'runner_failed', 100),
          message: clean(error?.message || 'Hybrid runner failed.', 2_000),
          retryable: ![400, 401, 403, 409].includes(error?.status)
        }
      }
    }).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function runHybridRunnerOnce(options = {}) {
  const result = await runEnrolledHybridRunnerOnce(options);
  if (result?.status === 'failed' && options.injectFailure !== true) {
    const error = new Error(result.message || 'Enrolled hybrid runner failed unexpectedly.');
    error.code = 'enrolled_runner_failed';
    error.result = result;
    throw error;
  }
  return result;
}

export async function main(env = process.env) {
  const config = resolveHybridRunnerConfig({ env });
  process.stdout.write(`${JSON.stringify({
    schema: ARCHIE_HYBRID_RUNNER_SCHEMA,
    runner_id: config.runner_id,
    endpoint: config.endpoint.origin,
    capabilities: config.capabilities,
    inbound_listener: false,
    claim_boundary: 'This process makes outbound requests only. It does not open a listening port or grant the hosted service inbound access to the local machine.'
  }, null, 2)}\n`);
  while (true) {
    try {
      const result = await runHybridOnce(config);
      if (result.status === 'completed') process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stderr.write(`archie-hybrid-runner: ${error?.message || error}\n`);
    }
    await sleep(config.poll_interval_ms);
  }
}

export {
  ARCHIE_HYBRID_RUNNER_STATE_SCHEMA,
  ARCHIE_HYBRID_RUNNER_VERSION,
  defaultRunnerAdvertisement
};

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-hybrid-runner: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
