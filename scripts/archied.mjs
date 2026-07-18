#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { renderStandaloneClient } from './archie-standalone-client.mjs';
import { executeStandaloneJourney } from './archie-standalone-journey.mjs';
import { exportWorkspaceBundle } from './archie-workspace-portable.mjs';
import {
  WorkspaceAuthorityError,
  WorkspaceError,
  createWorkspaceEngine
} from './archie-workspace-core.mjs';
import { SafeFileWorkspaceProvider } from './archie-workspace-file-provider.mjs';
import { createWorkspaceRequestHandler } from './archie-workspace-service.mjs';

export const ARCHIED_RUNTIME_SCHEMA = 'archied-runtime/v1';
export const ARCHIED_SERVICE_VERSION = '0.1.0';
export const ARCHIED_MIGRATION_LEVEL = 1;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function flagValue(argv, name, fallback = null) {
  const index = argv.lastIndexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function integer(value, label, { min = 0, max = 65_535 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function isLoopback(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

function principalHeader(request) {
  const value = request.headers['x-archie-principal'];
  return Array.isArray(value) ? value[0] : value || null;
}

function jsonResponse(response, status, value, headers = {}) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  response.end(body);
}

function htmlResponse(response, html) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  });
  response.end(html);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new WorkspaceError('Request body exceeds 2 MiB.', { code: 'body_too_large', status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new WorkspaceError('Request body must be valid JSON.');
  }
}

export function resolveArchiedConfig({ argv = [], env = process.env, home = null } = {}) {
  const selectedHome = path.resolve(flagValue(argv, '--home', home || env.ARCHIE_HOME || path.join(os.homedir(), '.archie')));
  const root = path.resolve(flagValue(argv, '--root', env.ARCHIE_DATA_ROOT || path.join(selectedHome, 'standalone', 'workspaces')));
  const host = flagValue(argv, '--host', env.ARCHIED_HOST || '127.0.0.1');
  const port = integer(flagValue(argv, '--port', env.ARCHIED_PORT || '8787'), '--port');
  const mode = argv.includes('--dev') || env.ARCHIED_MODE === 'development' ? 'development' : 'local';
  return Object.freeze({ home: selectedHome, root, host, port, mode });
}

function descriptor({ baseUrl, root, mode }) {
  return Object.freeze({
    schema: ARCHIED_RUNTIME_SCHEMA,
    service_version: ARCHIED_SERVICE_VERSION,
    domain_contract: 'archie-workspace/v1',
    migration_level: ARCHIED_MIGRATION_LEVEL,
    mode,
    base_url: baseUrl,
    canonical_state: 'archie-native-workspace-store',
    product_surface: baseUrl,
    local_journey_endpoint: new URL('v1/standalone/journeys', baseUrl).href,
    storage: {
      events: 'append-only-digest-chained-jsonl/v1',
      artifacts: 'content-addressed-sha256/v1',
      root
    },
    source_host_required: false,
    github_required: false,
    network_required_after_install: false,
    anonymous_public_read: true,
    mutation_identity: 'loopback principal or injected authenticator',
    claim_boundary: 'This service records exact local work, authority, artifacts, evidence, review, promotion, rollback, and portable export. It does not claim trained-model quality, native-device admission, external deployment, or customer superiority without their independent receipts.'
  });
}

export async function startArchied({
  home = path.join(os.homedir(), '.archie'),
  root = null,
  host = '127.0.0.1',
  port = 8787,
  mode = 'local',
  provider = null,
  engine = null,
  authenticate = null
} = {}) {
  const selectedRoot = path.resolve(root || path.join(path.resolve(home), 'standalone', 'workspaces'));
  const standaloneRoot = path.dirname(selectedRoot);
  await fs.mkdir(selectedRoot, { recursive: true, mode: 0o700 });
  const selectedProvider = provider || new SafeFileWorkspaceProvider(selectedRoot);
  const selectedEngine = engine || createWorkspaceEngine({ provider: selectedProvider });
  const server = http.createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const actualHost = typeof address === 'object' && address?.address ? address.address : host;
  const actualPort = typeof address === 'object' && address?.port ? address.port : port;
  const displayHost = actualHost === '::' || actualHost === '0.0.0.0' ? '127.0.0.1' : actualHost;
  const baseUrl = `http://${displayHost}:${actualPort}/`;
  const serviceDescriptor = descriptor({ baseUrl, root: selectedRoot, mode });
  const workspaceHandler = createWorkspaceRequestHandler({ engine: selectedEngine, authenticate, baseUrl });

  async function resolvePrincipal(request, { mutation = false } = {}) {
    if (typeof authenticate === 'function') {
      const authenticated = await authenticate(request);
      return authenticated?.principal_id || null;
    }
    if (mutation && !isLoopback(request.socket?.remoteAddress)) return null;
    return principalHeader(request);
  }

  server.on('request', async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', baseUrl);
      const pathname = requestUrl.pathname;
      const parts = pathname.split('/').filter(Boolean);

      if (request.method === 'GET' && pathname === '/') {
        htmlResponse(response, renderStandaloneClient());
        return;
      }

      if (request.method === 'GET' && (pathname === '/health' || pathname === '/.well-known/archied.json')) {
        jsonResponse(response, 200, serviceDescriptor);
        return;
      }

      if (request.method === 'POST' && pathname === '/v1/standalone/journeys') {
        const principalId = await resolvePrincipal(request, { mutation: true });
        if (principalId !== 'owner_local') {
          throw new WorkspaceAuthorityError('The first local journey requires the loopback owner_local principal.');
        }
        const body = await readJsonBody(request);
        const result = await executeStandaloneJourney({
          engine: selectedEngine,
          dataRoot: standaloneRoot,
          objective: body.objective,
          requestedChange: body.requested_change,
          approve: body.approve === true,
          visibility: body.visibility || 'private'
        });
        const { bundle_path: _privateBundlePath, ...publicResult } = result;
        jsonResponse(response, 201, publicResult);
        return;
      }

      if (
        request.method === 'GET'
        && parts[0] === 'v1'
        && parts[1] === 'standalone'
        && parts[2] === 'workspaces'
        && parts[3]
        && parts[4] === 'export'
        && parts.length === 5
      ) {
        const principalId = await resolvePrincipal(request);
        if (!principalId) throw new WorkspaceAuthorityError('Workspace export requires a principal identity.');
        const bundle = await exportWorkspaceBundle({ engine: selectedEngine, workspaceId: parts[3], principalId });
        jsonResponse(response, 200, bundle, {
          'content-disposition': `attachment; filename="${parts[3]}.archie.json"`,
          'x-archie-bundle-digest': bundle.bundle_digest
        });
        return;
      }

      await workspaceHandler(request, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const workspaceError = error instanceof WorkspaceError
        ? error
        : new WorkspaceError(error?.message || 'Internal archied error.', { code: 'internal_error', status: 500 });
      jsonResponse(response, workspaceError.status, {
        schema: 'archied-error/v1',
        error: workspaceError.code,
        message: workspaceError.message
      });
    }
  });

  return Object.freeze({
    schema: ARCHIED_RUNTIME_SCHEMA,
    server,
    engine: selectedEngine,
    provider: selectedProvider,
    descriptor: serviceDescriptor,
    root: selectedRoot,
    data_root: standaloneRoot,
    url: baseUrl,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`archied\n\nUsage:\n  archied [--dev] [--home <path>] [--root <path>] [--host 127.0.0.1] [--port 8787]\n\nThe canonical data root defaults to ARCHIE_HOME/standalone/workspaces and does not require GitHub, a remote, credentials, or network access.\n`);
    return null;
  }
  const config = resolveArchiedConfig({ argv, env });
  const runtime = await startArchied(config);
  process.stdout.write(`${JSON.stringify({ ...runtime.descriptor, pid: process.pid }, null, 2)}\n`);

  const shutdown = async signal => {
    await runtime.close().catch(() => {});
    if (signal) process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  await new Promise(() => {});
  return runtime;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archied: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
