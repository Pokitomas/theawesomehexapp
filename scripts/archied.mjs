#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHostedBackup, hostedBackupStatus } from './archie-hosted-backup.mjs';
import {
  EncryptedSecretStore,
  createHostedAuthenticator,
  createReadShareAuthority
} from './archie-hosted-security.mjs';
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
export const ARCHIED_SERVICE_VERSION = '0.2.0';
export const ARCHIED_MIGRATION_LEVEL = 2;
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

function normalizedBaseUrl(value, label) {
  let url;
  try { url = new URL(value); }
  catch { throw new WorkspaceError(`${label} must be an absolute URL.`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new WorkspaceError(`${label} must use http or https.`);
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  return url.href;
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

function authenticationRequired() {
  return new WorkspaceError('Hosted Archie authentication is required.', { code: 'authentication_required', status: 401 });
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
  const requestedMode = argv.includes('--hosted') || env.ARCHIED_MODE === 'hosted'
    ? 'hosted'
    : argv.includes('--dev') || env.ARCHIED_MODE === 'development'
      ? 'development'
      : 'local';
  const selectedHome = path.resolve(flagValue(argv, '--home', home || env.ARCHIE_HOME || path.join(os.homedir(), '.archie')));
  const root = path.resolve(flagValue(argv, '--root', env.ARCHIE_DATA_ROOT || path.join(selectedHome, 'standalone', 'workspaces')));
  const host = flagValue(argv, '--host', env.ARCHIED_HOST || (requestedMode === 'hosted' ? '0.0.0.0' : '127.0.0.1'));
  const port = integer(flagValue(argv, '--port', env.ARCHIED_PORT || '8787'), '--port');
  const publicBaseUrl = requestedMode === 'hosted'
    ? normalizedBaseUrl(flagValue(argv, '--public-url', env.ARCHIED_PUBLIC_URL), 'ARCHIED_PUBLIC_URL')
    : null;
  if (requestedMode === 'hosted' && new URL(publicBaseUrl).protocol !== 'https:' && env.ARCHIED_ALLOW_INSECURE_HOSTED !== '1') {
    throw new WorkspaceError('Hosted Archie requires an HTTPS ARCHIED_PUBLIC_URL unless ARCHIED_ALLOW_INSECURE_HOSTED=1 is set for a local test environment.');
  }
  return Object.freeze({
    home: selectedHome,
    root,
    host,
    port,
    mode: requestedMode,
    publicBaseUrl,
    founderTokenSha256: env.ARCHIED_FOUNDER_TOKEN_SHA256 || null,
    developerTokenSha256: env.ARCHIED_DEVELOPER_TOKEN_SHA256 || null,
    shareKey: env.ARCHIED_SHARE_KEY || null,
    secretKey: env.ARCHIED_SECRET_KEY || null
  });
}

function descriptor({ baseUrl, publicBaseUrl, root, mode }) {
  const productBase = publicBaseUrl || baseUrl;
  const hosted = mode === 'hosted';
  return Object.freeze({
    schema: ARCHIED_RUNTIME_SCHEMA,
    service_version: ARCHIED_SERVICE_VERSION,
    domain_contract: 'archie-workspace/v1',
    migration_level: ARCHIED_MIGRATION_LEVEL,
    mode,
    base_url: productBase,
    canonical_state: 'archie-native-workspace-store',
    product_surface: productBase,
    local_journey_endpoint: new URL('v1/standalone/journeys', productBase).href,
    workspace_url_template: new URL('w/{workspace_id}', productBase).href,
    hosted_status_endpoint: hosted ? new URL('v1/hosted/status', productBase).href : null,
    backup_endpoint: hosted ? new URL('v1/hosted/backups', productBase).href : null,
    storage: {
      events: 'append-only-digest-chained-jsonl/v1',
      artifacts: 'content-addressed-sha256/v1',
      root: hosted ? 'managed-persistent-volume' : root
    },
    source_host_required: false,
    github_required: false,
    network_required_after_install: hosted,
    anonymous_public_read: !hosted,
    explicit_read_shares: hosted,
    authentication: hosted ? 'private founder/developer bearer-or-basic credentials' : 'loopback principal or injected authenticator',
    encrypted_secret_store: hosted ? 'aes-256-gcm-envelope/v1' : null,
    claim_boundary: 'This service records exact work, authority, artifacts, evidence, review, promotion, rollback, portable export, and hosted operational receipts. It does not claim trained-model quality, native-device admission, paid deployment, or customer superiority without their independent receipts.'
  });
}

export async function startArchied({
  home = path.join(os.homedir(), '.archie'),
  root = null,
  host = '127.0.0.1',
  port = 8787,
  mode = 'local',
  publicBaseUrl = null,
  founderTokenSha256 = null,
  developerTokenSha256 = null,
  shareKey = null,
  secretKey = null,
  provider = null,
  engine = null,
  authenticate = null
} = {}) {
  const hosted = mode === 'hosted';
  const selectedRoot = path.resolve(root || path.join(path.resolve(home), 'standalone', 'workspaces'));
  const standaloneRoot = path.dirname(selectedRoot);
  await fs.mkdir(selectedRoot, { recursive: true, mode: 0o700 });
  const selectedProvider = provider || new SafeFileWorkspaceProvider(selectedRoot);
  const selectedEngine = engine || createWorkspaceEngine({ provider: selectedProvider });
  const hostedAuthenticator = hosted && !authenticate
    ? createHostedAuthenticator({ founderTokenSha256, developerTokenSha256 })
    : null;
  const effectiveAuthenticate = authenticate || hostedAuthenticator;
  if (hosted && typeof effectiveAuthenticate !== 'function') throw new WorkspaceError('Hosted Archie requires an authenticator.');
  const externalBase = hosted ? normalizedBaseUrl(publicBaseUrl, 'publicBaseUrl') : null;
  const shareAuthority = hosted ? createReadShareAuthority({ secret: shareKey, publicBaseUrl: externalBase }) : null;
  const secretStore = hosted ? new EncryptedSecretStore(path.join(standaloneRoot, 'hosted', 'secrets.enc.json'), secretKey) : null;
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
  const serviceDescriptor = descriptor({ baseUrl, publicBaseUrl: externalBase, root: selectedRoot, mode });
  const workspaceHandler = createWorkspaceRequestHandler({
    engine: selectedEngine,
    authenticate: effectiveAuthenticate,
    baseUrl: externalBase || baseUrl,
    corsOrigin: hosted ? null : '*'
  });

  async function resolveIdentity(request, { mutation = false } = {}) {
    if (typeof effectiveAuthenticate === 'function') return effectiveAuthenticate(request);
    if (mutation && !isLoopback(request.socket?.remoteAddress)) return null;
    const principalId = principalHeader(request);
    return principalId ? Object.freeze({ principal_id: principalId, role: 'local', method: 'header' }) : null;
  }

  function challengeHeaders(error) {
    return error?.status === 401 ? { 'www-authenticate': 'Basic realm="Archie", charset="UTF-8"' } : {};
  }

  server.on('request', async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', externalBase || baseUrl);
      const pathname = requestUrl.pathname;
      const parts = pathname.split('/').filter(Boolean);

      if (request.method === 'GET' && pathname === '/health') {
        jsonResponse(response, 200, hosted ? {
          schema: 'archied-health/v1',
          status: 'ok',
          service_version: ARCHIED_SERVICE_VERSION,
          migration_level: ARCHIED_MIGRATION_LEVEL,
          mode
        } : serviceDescriptor);
        return;
      }

      if (request.method === 'GET' && pathname === '/.well-known/archied.json') {
        if (hosted && !(await resolveIdentity(request))) throw authenticationRequired();
        jsonResponse(response, 200, serviceDescriptor);
        return;
      }

      if (request.method === 'GET' && pathname === '/') {
        if (hosted && !(await resolveIdentity(request))) throw authenticationRequired();
        htmlResponse(response, renderStandaloneClient());
        return;
      }

      if (hosted && request.method === 'GET' && parts[0] === 'w' && parts[1] && parts.length === 2) {
        const identity = await resolveIdentity(request);
        if (!identity) throw authenticationRequired();
        jsonResponse(response, 200, await selectedEngine.inspect(parts[1], { principalId: identity.principal_id }));
        return;
      }

      if (request.method === 'POST' && pathname === '/v1/standalone/journeys') {
        const identity = await resolveIdentity(request, { mutation: true });
        if (!identity) throw authenticationRequired();
        if (identity.principal_id !== 'owner_local' || (hosted && identity.role !== 'founder')) {
          throw new WorkspaceAuthorityError('The bounded standalone journey requires founder authority.');
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
        jsonResponse(response, 201, {
          ...publicResult,
          workspace_url: new URL(`w/${result.workspace_id}`, externalBase || baseUrl).href
        });
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
        const identity = await resolveIdentity(request);
        if (!identity) throw authenticationRequired();
        const bundle = await exportWorkspaceBundle({ engine: selectedEngine, workspaceId: parts[3], principalId: identity.principal_id });
        jsonResponse(response, 200, bundle, {
          'content-disposition': `attachment; filename="${parts[3]}.archie.json"`,
          'x-archie-bundle-digest': bundle.bundle_digest
        });
        return;
      }

      if (hosted && request.method === 'POST' && pathname === '/v1/hosted/shares') {
        const identity = await resolveIdentity(request, { mutation: true });
        if (!identity) throw authenticationRequired();
        const body = await readJsonBody(request);
        await selectedEngine.inspect(body.workspace_id, { principalId: identity.principal_id });
        const share = shareAuthority.issue({
          workspaceId: body.workspace_id,
          issuedBy: identity.principal_id,
          expiresInMs: body.expires_in_ms
        });
        jsonResponse(response, 201, share);
        return;
      }

      if (hosted && request.method === 'GET' && parts[0] === 'v1' && parts[1] === 'hosted' && parts[2] === 'shares' && parts[3] && parts.length === 4) {
        const share = shareAuthority.verify(parts[3]);
        const workspace = await selectedEngine.inspect(share.workspace_id, { principalId: share.principal_id });
        jsonResponse(response, 200, {
          schema: 'archie-read-share-result/v1',
          share: { share_id: share.share_id, workspace_id: share.workspace_id, expires_at: share.expires_at, capabilities: share.capabilities },
          workspace
        });
        return;
      }

      if (hosted && request.method === 'PUT' && parts[0] === 'v1' && parts[1] === 'hosted' && parts[2] === 'secrets' && parts[3] && parts.length === 4) {
        const identity = await resolveIdentity(request, { mutation: true });
        if (!identity) throw authenticationRequired();
        if (identity.role !== 'founder') throw new WorkspaceAuthorityError('Only the founder may change encrypted secret configuration.');
        const body = await readJsonBody(request);
        jsonResponse(response, 200, { schema: 'archie-secret-write-receipt/v1', secret: await secretStore.set(parts[3], body.value) });
        return;
      }

      if (hosted && request.method === 'GET' && pathname === '/v1/hosted/status') {
        const identity = await resolveIdentity(request);
        if (!identity) throw authenticationRequired();
        jsonResponse(response, 200, {
          schema: 'archie-hosted-status/v1',
          service: serviceDescriptor,
          authenticated_role: identity.role,
          workspace_count: (await selectedProvider.listWorkspaceIds()).length,
          secrets: await secretStore.status(),
          backups: await hostedBackupStatus(standaloneRoot)
        });
        return;
      }

      if (hosted && request.method === 'POST' && pathname === '/v1/hosted/backups') {
        const identity = await resolveIdentity(request, { mutation: true });
        if (!identity) throw authenticationRequired();
        if (identity.role !== 'founder') throw new WorkspaceAuthorityError('Only the founder may create a hosted backup.');
        const { backup } = await createHostedBackup({
          provider: selectedProvider,
          secretStore,
          dataRoot: standaloneRoot,
          serviceVersion: ARCHIED_SERVICE_VERSION,
          migrationLevel: ARCHIED_MIGRATION_LEVEL
        });
        jsonResponse(response, 201, {
          schema: 'archie-hosted-backup-receipt/v1',
          created_at: backup.created_at,
          backup_digest: backup.backup_digest,
          workspace_count: backup.workspace_count,
          artifact_count: backup.artifact_count,
          migration_level: backup.migration_level
        });
        return;
      }

      if (hosted && pathname.startsWith('/v1/workspaces')) {
        if (!(await resolveIdentity(request, { mutation: request.method !== 'GET' }))) throw authenticationRequired();
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
      }, challengeHeaders(workspaceError));
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
    public_url: externalBase || baseUrl,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`archied\n\nUsage:\n  archied [--dev] [--home <path>] [--root <path>] [--host 127.0.0.1] [--port 8787]\n  archied --hosted --public-url https://archie.example/\n\nLocal state defaults to ARCHIE_HOME/standalone/workspaces. Hosted mode requires private founder/developer token hashes, a read-share key, an encrypted-secret key, and an HTTPS public URL.\n`);
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
