#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { HybridQueue, HybridQueueError } from './archie-hybrid-queue.mjs';
import { importWorkspaceBundle, verifyWorkspaceBundle } from './archie-workspace-portable.mjs';
import { startHostedArchied } from './archied-hosted.mjs';

export const ARCHIE_HYBRID_HOSTED_SCHEMA = 'archie-hybrid-hosted-runtime/v1';
const MAX_JSON_BODY = 12 * 1024 * 1024;

function integer(value, label, { min = 0, max = 65_535 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function secureEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearer(request) {
  const header = String(request.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function securityHeaders() {
  return {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin'
  };
}

function jsonResponse(response, status, value, headers = {}) {
  const body = value === null ? '' : `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    ...(body ? { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) } : {}),
    ...securityHeaders(),
    ...headers
  });
  response.end(body);
}

async function readJson(request, limit = MAX_JSON_BODY) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('Request body is too large.'), { status: 413, code: 'body_too_large' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400, code: 'invalid_json' });
  }
}

function cleanProxyHeaders(headers) {
  const result = { ...headers };
  for (const name of [
    'authorization', 'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
    'x-forwarded-port', 'x-forwarded-proto', 'x-archie-principal'
  ]) delete result[name];
  return result;
}

function copyResponseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (['server', 'connection', 'keep-alive', 'transfer-encoding'].includes(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean).map(value => decodeURIComponent(value));
}

export function resolveHybridHostedConfig({ env = process.env, home = null, founderToken = null, runnerToken = null, host = null, port = null, publicOrigin = null } = {}) {
  const selectedFounder = String(founderToken || env.ARCHIED_FOUNDER_TOKEN || '');
  const selectedRunner = String(runnerToken || env.ARCHIED_RUNNER_TOKEN || '');
  if (selectedFounder.length < 24) throw new Error('ARCHIED_FOUNDER_TOKEN must contain at least 24 characters.');
  if (selectedRunner.length < 24) throw new Error('ARCHIED_RUNNER_TOKEN must contain at least 24 characters.');
  if (secureEqual(selectedFounder, selectedRunner)) throw new Error('Founder and runner tokens must be distinct.');
  return Object.freeze({
    schema: ARCHIE_HYBRID_HOSTED_SCHEMA,
    home: path.resolve(home || env.ARCHIE_HOME || path.join(os.homedir(), '.archie')),
    founder_token: selectedFounder,
    runner_token: selectedRunner,
    host: host || env.ARCHIED_HOST || '0.0.0.0',
    port: integer(port ?? env.ARCHIED_PORT ?? '8787', 'ARCHIED_PORT'),
    public_origin: String(publicOrigin || env.ARCHIED_PUBLIC_ORIGIN || '').trim().replace(/\/$/, '') || null,
    cookie_secure: env.ARCHIED_COOKIE_SECURE
  });
}

export async function startHybridHostedArchied(options = {}) {
  const config = resolveHybridHostedConfig(options);
  const queue = await HybridQueue.open({ root: path.join(config.home, 'standalone', 'hybrid') });
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address?.port ? address.port : config.port;
  const publicOrigin = config.public_origin || `http://127.0.0.1:${actualPort}`;
  const hosted = await startHostedArchied({
    home: config.home,
    token: config.founder_token,
    host: '127.0.0.1',
    port: 0,
    publicOrigin,
    env: { ARCHIED_COOKIE_SECURE: config.cookie_secure ?? (publicOrigin.startsWith('https://') ? 'true' : 'false') }
  });

  const descriptor = Object.freeze({
    schema: ARCHIE_HYBRID_HOSTED_SCHEMA,
    service_version: hosted.descriptor.service_version,
    base_url: `${publicOrigin}/`,
    product_surface: `${publicOrigin}/`,
    queue_status_url: `${publicOrigin}/v1/hybrid/status`,
    submit_url: `${publicOrigin}/v1/hybrid/jobs`,
    runner_lease_url: `${publicOrigin}/v1/hybrid/lease`,
    execution: {
      direction: 'local-runner-outbound-only',
      inbound_local_access_required: false,
      lease_fencing: true,
      expiring_heartbeats: true,
      portable_workspace_return: true,
      hosted_import_digest_verified: true
    },
    canonical_workspace_state: hosted.descriptor.canonical_state,
    source_host_required: false,
    github_required: false,
    claim_boundary: 'Hybrid Archie can delegate an explicitly approved bounded journey to an outbound-only local runner, import its verified portable workspace, and reject stale writers. It does not grant hosted inbound access to the local machine or imply admitted model, device, deployment, or customer-value claims.'
  });

  function requireRole(request, role) {
    const token = bearer(request);
    const expected = role === 'runner' ? config.runner_token : config.founder_token;
    if (!token || !secureEqual(token, expected)) {
      throw Object.assign(new Error(`${role === 'runner' ? 'Runner' : 'Founder'} bearer authentication is required.`), { status: 401, code: 'authentication_required' });
    }
  }

  async function importResultBundle(result) {
    const bundle = verifyWorkspaceBundle(result?.bundle);
    if (
      bundle.workspace_id !== result.workspace_id
      || bundle.bundle_digest !== result.bundle_digest
      || bundle.head_digest !== result.head_digest
      || bundle.event_count !== result.event_count
      || bundle.artifacts.length !== result.artifact_count
    ) throw new HybridQueueError('bundle_identity_mismatch', 'Returned bundle identity does not match the hybrid result envelope.');
    const existing = await hosted.internal.provider.readEvents(bundle.workspace_id);
    if (existing.length) {
      const state = await hosted.internal.engine.inspect(bundle.workspace_id, { principalId: 'owner_local' });
      if (state.head_digest !== bundle.head_digest) throw new HybridQueueError('workspace_collision', 'Hosted workspace ID already exists with a different event head.', 409);
      return Object.freeze({ workspace_id: bundle.workspace_id, bundle_digest: bundle.bundle_digest, imported: false, already_present: true });
    }
    const imported = await importWorkspaceBundle({ provider: hosted.internal.provider, bundle });
    return Object.freeze({ workspace_id: imported.workspace_id, bundle_digest: imported.bundle_digest, imported: true, already_present: false });
  }

  function proxy(request, response) {
    const target = new URL(request.url || '/', hosted.url);
    const headers = cleanProxyHeaders(request.headers);
    headers.host = target.host;
    headers['x-forwarded-proto'] = new URL(publicOrigin).protocol.slice(0, -1);
    headers['x-forwarded-host'] = new URL(publicOrigin).host;
    const upstream = http.request(target, { method: request.method, headers }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        ...copyResponseHeaders(upstreamResponse.headers),
        ...securityHeaders(),
        'x-archie-hybrid-hosted': '1'
      });
      upstreamResponse.pipe(response);
    });
    upstream.once('error', error => {
      if (!response.headersSent) jsonResponse(response, 502, { schema: 'archie-hybrid-error/v1', error: 'hosted_gateway_unavailable', message: error.message });
      else response.destroy(error);
    });
    request.pipe(upstream);
  }

  server.on('request', async (request, response) => {
    try {
      const url = new URL(request.url || '/', publicOrigin);
      const pathname = url.pathname;
      const method = request.method || 'GET';
      const parts = routeParts(pathname);

      if (method === 'GET' && pathname === '/v1/hybrid/descriptor') {
        requireRole(request, 'founder');
        jsonResponse(response, 200, descriptor);
        return;
      }

      if (method === 'GET' && pathname === '/v1/hybrid/status') {
        requireRole(request, 'founder');
        jsonResponse(response, 200, { schema: 'archie-hybrid-status/v1', service: descriptor, queue: await queue.snapshot() });
        return;
      }

      if (method === 'POST' && pathname === '/v1/hybrid/jobs') {
        requireRole(request, 'founder');
        const job = await queue.submit(await readJson(request, 32 * 1024));
        jsonResponse(response, 201, { schema: 'archie-hybrid-job-submission/v1', job });
        return;
      }

      if (parts[0] === 'v1' && parts[1] === 'hybrid' && parts[2] === 'jobs' && parts[3] && parts.length === 4 && method === 'GET') {
        requireRole(request, 'founder');
        jsonResponse(response, 200, { schema: 'archie-hybrid-job-status/v1', job: await queue.inspect(parts[3]) });
        return;
      }

      if (parts[0] === 'v1' && parts[1] === 'hybrid' && parts[2] === 'jobs' && parts[3] && parts[4] === 'cancel' && parts.length === 5 && method === 'POST') {
        requireRole(request, 'founder');
        const body = await readJson(request, 16 * 1024);
        jsonResponse(response, 200, { schema: 'archie-hybrid-job-status/v1', job: await queue.cancel(parts[3], body.reason) });
        return;
      }

      if (method === 'POST' && pathname === '/v1/hybrid/lease') {
        requireRole(request, 'runner');
        const job = await queue.lease(await readJson(request, 32 * 1024));
        if (!job) {
          jsonResponse(response, 204, null);
          return;
        }
        jsonResponse(response, 200, { schema: 'archie-hybrid-lease/v1', job });
        return;
      }

      if (parts[0] === 'v1' && parts[1] === 'hybrid' && parts[2] === 'jobs' && parts[3] && parts[4] === 'heartbeat' && parts.length === 5 && method === 'POST') {
        requireRole(request, 'runner');
        const body = await readJson(request, 32 * 1024);
        const job = await queue.heartbeat(parts[3], body, body.ttl_ms);
        jsonResponse(response, 200, { schema: 'archie-hybrid-lease/v1', job });
        return;
      }

      if (parts[0] === 'v1' && parts[1] === 'hybrid' && parts[2] === 'jobs' && parts[3] && parts[4] === 'fail' && parts.length === 5 && method === 'POST') {
        requireRole(request, 'runner');
        const body = await readJson(request, 64 * 1024);
        const job = await queue.fail(parts[3], body, body.failure);
        jsonResponse(response, 200, { schema: 'archie-hybrid-job-status/v1', job });
        return;
      }

      if (parts[0] === 'v1' && parts[1] === 'hybrid' && parts[2] === 'jobs' && parts[3] && parts[4] === 'complete' && parts.length === 5 && method === 'POST') {
        requireRole(request, 'runner');
        const body = await readJson(request);
        queue.assertLease(parts[3], body);
        const importReceipt = await importResultBundle(body.result);
        const { bundle: _bundle, ...result } = body.result || {};
        const job = await queue.complete(parts[3], body, result);
        jsonResponse(response, 200, { schema: 'archie-hybrid-completion/v1', job, import: importReceipt });
        return;
      }

      proxy(request, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      jsonResponse(response, error?.status || 500, {
        schema: 'archie-hybrid-error/v1',
        error: error?.code || (error?.status === 413 ? 'body_too_large' : 'hybrid_error'),
        message: error?.message || 'Hybrid hosted Archie failed.'
      });
    }
  });

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = Promise.all([
      new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      hosted.close()
    ]).then(() => undefined);
    return closing;
  }

  return Object.freeze({
    schema: ARCHIE_HYBRID_HOSTED_SCHEMA,
    server,
    hosted,
    queue,
    descriptor,
    url: `${publicOrigin}/`,
    close
  });
}

export async function main(env = process.env) {
  const runtime = await startHybridHostedArchied({ env });
  process.stdout.write(`${JSON.stringify({ ...runtime.descriptor, pid: process.pid }, null, 2)}\n`);
  const shutdown = async () => {
    await runtime.close().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise(() => {});
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-hybrid-hosted: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
