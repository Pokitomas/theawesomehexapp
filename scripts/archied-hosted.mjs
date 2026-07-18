#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHostedBackup, hostedBackupStatus } from './archie-hosted-backup.mjs';
import {
  EncryptedSecretStore,
  HostedShareRegistry,
  createHostedSecurity,
  deriveHostedKey,
  requireRole,
  tokenSha256
} from './archie-hosted-security.mjs';
import { WorkspaceAuthorityError, WorkspaceError } from './archie-workspace-core.mjs';
import { startArchied } from './archied.mjs';

export const ARCHIED_HOSTED_SCHEMA = 'archied-hosted-runtime/v1';
export const ARCHIED_HOSTED_VERSION = '0.2.0';
export const ARCHIED_HOSTED_MIGRATION_LEVEL = 2;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function integer(value, label, { min = 0, max = 65_535 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new WorkspaceError(`${label} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new WorkspaceError(`Expected a boolean value, received ${value}.`);
}

function absoluteHttpUrl(value, label) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new WorkspaceError(`${label} must be an absolute URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new WorkspaceError(`${label} must be a credential-free absolute HTTP(S) URL.`);
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url.href;
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
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...securityHeaders(),
    ...headers
  });
  response.end(body);
}

function htmlResponse(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...securityHeaders(),
    ...headers
  });
  response.end(body);
}

function redirect(response, location, headers = {}) {
  response.writeHead(303, { location, ...securityHeaders(), ...headers });
  response.end();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function loginPage({ error = '', returnTo = '/' } = {}) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Private Archie access</title>
<style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#171714;background:#f3efe5}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(180deg,#f7f3e9,#e8dfcf)}main{width:min(430px,100%);background:#fffdf8;border:2px solid #171714;box-shadow:8px 8px 0 #171714;padding:24px}h1{margin:0 0 8px;font-size:36px;letter-spacing:-.055em}p{line-height:1.45;color:#59544a}.label{display:block;font-weight:800;margin:20px 0 7px}input{width:100%;min-height:52px;border:2px solid #171714;padding:11px 12px;background:#fff;font:inherit}button{width:100%;min-height:52px;margin-top:12px;border:2px solid #171714;background:#171714;color:#fff;font:900 16px inherit;box-shadow:4px 4px 0 #b7aa93;cursor:pointer}.error{border:1px solid #9d2513;background:#ffe6df;color:#7a1a0c;padding:10px;margin:14px 0}.meta{font:700 11px ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase;letter-spacing:.08em;color:#6c665c}</style></head>
<body><main><div class="meta">Private founder / developer workspace</div><h1>Enter Archie.</h1><p>The hosted product uses the same native workspaces, evidence, approvals, exports, and rollback history as local Archie. Your token is never written into workspace receipts.</p>${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}<form method="post" action="/login"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><label class="label" for="token">Private access token</label><input id="token" name="token" type="password" required autocomplete="current-password" autofocus><button type="submit">Open Archie</button></form></main></body></html>`;
}

async function readBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new WorkspaceError('Request body exceeds 2 MiB.', { code: 'body_too_large', status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(request) {
  const raw = await readBody(request);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new WorkspaceError('Request body must be valid JSON.'); }
}

function safeReturnPath(value) {
  const candidate = String(value || '/');
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return '/';
  return candidate.slice(0, 2048);
}

function requestAddress(request) {
  return String(request.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function removeHopHeaders(headers) {
  const result = { ...headers };
  for (const name of [
    'authorization', 'cookie', 'host', 'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'forwarded',
    'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto',
    'x-archie-principal'
  ]) delete result[name];
  return result;
}

function copyProxyHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (['set-cookie', 'server', 'connection', 'keep-alive', 'transfer-encoding'].includes(lower)) continue;
    if (lower.startsWith('access-control-')) continue;
    result[name] = value;
  }
  return result;
}

export function resolveHostedConfig({
  env = process.env,
  home = null,
  host = null,
  port = null,
  publicUrl = null,
  publicOrigin = null,
  founderTokenSha256 = null,
  developerTokenSha256 = null,
  sessionKey = null,
  secretKey = null,
  allowInsecure = null,
  token = null
} = {}) {
  const selectedHome = path.resolve(home || env.ARCHIE_HOME || path.join(os.homedir(), '.archie'));
  const selectedHost = host || env.ARCHIED_HOST || '0.0.0.0';
  const selectedPort = integer(port ?? env.ARCHIED_PORT ?? '8787', 'ARCHIED_PORT');
  const selectedPublicUrl = absoluteHttpUrl(
    publicUrl || publicOrigin || env.ARCHIED_PUBLIC_URL || env.ARCHIED_PUBLIC_ORIGIN,
    'ARCHIED_PUBLIC_URL'
  );
  const legacyFounderToken = String(token || '');
  const insecureAllowed = allowInsecure === true || env.ARCHIED_ALLOW_INSECURE_HOSTED === '1' || Boolean(legacyFounderToken);
  if (new URL(selectedPublicUrl).protocol !== 'https:' && !insecureAllowed) {
    throw new WorkspaceError('Hosted Archie requires an HTTPS ARCHIED_PUBLIC_URL unless ARCHIED_ALLOW_INSECURE_HOSTED=1 is set for an isolated test environment.');
  }
  const founderHash = founderTokenSha256 || env.ARCHIED_FOUNDER_TOKEN_SHA256 || (legacyFounderToken ? tokenSha256(legacyFounderToken) : null);
  const developerHash = developerTokenSha256 || env.ARCHIED_DEVELOPER_TOKEN_SHA256 || (legacyFounderToken ? crypto.randomBytes(32).toString('hex') : null);
  const selectedSessionKey = sessionKey || env.ARCHIED_SESSION_KEY || (legacyFounderToken ? deriveHostedKey('session', legacyFounderToken) : null);
  const selectedSecretKey = secretKey || env.ARCHIED_SECRET_KEY || (legacyFounderToken ? deriveHostedKey('secret', legacyFounderToken) : null);
  const secureCookies = boolean(env.ARCHIED_COOKIE_SECURE, new URL(selectedPublicUrl).protocol === 'https:');
  return Object.freeze({
    home: selectedHome,
    host: selectedHost,
    port: selectedPort,
    public_url: selectedPublicUrl,
    founder_token_sha256: founderHash,
    developer_token_sha256: developerHash,
    session_key: selectedSessionKey,
    secret_key: selectedSecretKey,
    secure_cookies: secureCookies,
    legacy_founder_only: Boolean(legacyFounderToken && !developerTokenSha256 && !env.ARCHIED_DEVELOPER_TOKEN_SHA256)
  });
}

export async function startHostedArchied(options = {}) {
  const config = resolveHostedConfig(options);
  const security = createHostedSecurity({
    founderTokenSha256: config.founder_token_sha256,
    developerTokenSha256: config.developer_token_sha256,
    sessionKey: config.session_key,
    secureCookies: config.secure_cookies
  });
  const internal = await startArchied({ home: config.home, host: '127.0.0.1', port: 0, mode: 'local' });
  const dataRoot = internal.data_root;
  const shareRegistry = new HostedShareRegistry(dataRoot);
  const secretStore = new EncryptedSecretStore(path.join(dataRoot, 'hosted', 'secrets.enc.json'), config.secret_key);
  const failures = new Map();
  const server = http.createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address?.port ? address.port : config.port;
  const localUrl = `http://127.0.0.1:${actualPort}/`;
  const publicOriginValue = new URL(config.public_url).origin;
  const descriptor = Object.freeze({
    schema: ARCHIED_HOSTED_SCHEMA,
    service_version: ARCHIED_HOSTED_VERSION,
    domain_contract: internal.descriptor.domain_contract,
    migration_level: ARCHIED_HOSTED_MIGRATION_LEVEL,
    mode: 'hosted',
    base_url: config.public_url,
    canonical_state: internal.descriptor.canonical_state,
    product_surface: config.public_url,
    workspace_url_template: new URL('w/{workspace_id}', config.public_url).href,
    hosted_status_endpoint: new URL('v1/hosted/status', config.public_url).href,
    backup_endpoint: new URL('v1/hosted/backups', config.public_url).href,
    authentication: { ...security.descriptor, developer_enabled: !config.legacy_founder_only },
    storage: {
      events: internal.descriptor.storage.events,
      artifacts: internal.descriptor.storage.artifacts,
      durable_volume: 'ARCHIE_HOME/standalone'
    },
    source_host_required: false,
    github_required: false,
    vendor_specific_dependency: false,
    local_runner_inbound_access_required: false,
    explicit_read_only_shares: true,
    encrypted_secret_store: 'aes-256-gcm-envelope/v1',
    claim_boundary: 'Hosted Archie provides private founder/developer access over the same Archie-native workspace, authority, evidence, export, rollback, and portable ownership contracts. It does not claim an external deployment exists until an operator runs this image, and it does not upgrade model, device, or customer-value claims.'
  });

  function loginState(ip, now = Date.now()) {
    const current = failures.get(ip);
    if (!current || current.reset_at_ms <= now) {
      const next = { count: 0, reset_at_ms: now + LOGIN_WINDOW_MS };
      failures.set(ip, next);
      return next;
    }
    return current;
  }

  function failedLogin(ip) {
    const state = loginState(ip);
    state.count += 1;
    if (failures.size > 1000) {
      const now = Date.now();
      for (const [key, value] of failures) if (value.reset_at_ms <= now) failures.delete(key);
    }
    return state;
  }

  function denyCrossSiteMutation(request) {
    const method = request.method || 'GET';
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
    const fetchSite = String(request.headers['sec-fetch-site'] || '');
    const origin = String(request.headers.origin || '');
    if (fetchSite === 'cross-site' || (origin && origin !== publicOriginValue)) {
      throw new WorkspaceAuthorityError('Cross-site mutations are not allowed.');
    }
  }

  async function ownedWorkspace(identity, workspaceId) {
    const state = await internal.engine.inspect(workspaceId, { principalId: identity.principal_id });
    if (state.workspace.owner_id !== identity.principal_id) throw new WorkspaceAuthorityError('Only the workspace owner may manage hosted shares.');
    return state;
  }

  async function visibleWorkspaces(identity) {
    const results = [];
    for (const workspaceId of await internal.provider.listWorkspaceIds()) {
      try {
        const state = await internal.engine.inspect(workspaceId, { principalId: identity.principal_id });
        results.push({
          workspace_id: workspaceId,
          title: state.workspace.title,
          visibility: state.workspace.visibility,
          event_count: state.event_count,
          head_digest: state.head_digest,
          evidence_count: Object.keys(state.evidence).length,
          approval_count: Object.keys(state.approvals).length,
          rollback_count: Object.keys(state.rollbacks).length,
          workspace_url: new URL(`w/${workspaceId}`, config.public_url).href,
          export_url: new URL(`v1/standalone/workspaces/${workspaceId}/export`, config.public_url).href
        });
      } catch (error) {
        if (!(error instanceof WorkspaceAuthorityError)) throw error;
      }
    }
    return results.sort((left, right) => left.workspace_id.localeCompare(right.workspace_id));
  }

  function proxy(request, response, identity) {
    const target = new URL(request.url || '/', internal.url);
    const headers = removeHopHeaders(request.headers);
    headers.host = target.host;
    headers['x-archie-principal'] = identity.principal_id;
    const upstream = http.request(target, { method: request.method, headers }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        ...copyProxyHeaders(upstreamResponse.headers),
        ...securityHeaders(),
        'x-archie-hosted': '1'
      });
      upstreamResponse.pipe(response);
    });
    upstream.once('error', error => {
      if (!response.headersSent) jsonResponse(response, 502, { schema: 'archied-hosted-error/v1', error: 'upstream_unavailable', message: error.message });
      else response.destroy(error);
    });
    request.pipe(upstream);
  }

  server.on('request', async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', localUrl);
      const pathname = requestUrl.pathname;
      const parts = pathname.split('/').filter(Boolean);
      const method = request.method || 'GET';

      if (method === 'GET' && pathname === '/health') {
        jsonResponse(response, 200, {
          schema: 'archied-health/v1',
          status: 'ok',
          mode: 'hosted',
          service_version: ARCHIED_HOSTED_VERSION,
          migration_level: ARCHIED_HOSTED_MIGRATION_LEVEL
        });
        return;
      }

      if (method === 'GET' && pathname === '/login') {
        const current = security.authenticate(request);
        if (current) {
          redirect(response, safeReturnPath(requestUrl.searchParams.get('return_to')));
          return;
        }
        htmlResponse(response, 200, loginPage({ returnTo: safeReturnPath(requestUrl.searchParams.get('return_to')) }));
        return;
      }

      if (method === 'POST' && pathname === '/login') {
        const ip = requestAddress(request);
        const state = loginState(ip);
        if (state.count >= MAX_FAILED_LOGINS) {
          jsonResponse(response, 429, {
            schema: 'archied-hosted-error/v1',
            error: 'login_rate_limited',
            message: 'Too many failed login attempts. Try again later.'
          }, { 'retry-after': String(Math.max(1, Math.ceil((state.reset_at_ms - Date.now()) / 1000))) });
          return;
        }
        const raw = await readBody(request, 16 * 1024);
        let suppliedToken = '';
        let returnTo = '/';
        if (String(request.headers['content-type'] || '').includes('application/json')) {
          try {
            const body = JSON.parse(raw || '{}');
            suppliedToken = String(body.token || '');
            returnTo = safeReturnPath(body.return_to);
          } catch {
            throw new WorkspaceError('Login body must be valid JSON.');
          }
        } else {
          const body = new URLSearchParams(raw);
          suppliedToken = String(body.get('token') || '');
          returnTo = safeReturnPath(body.get('return_to'));
        }
        const identity = security.identityForToken(suppliedToken);
        if (!identity) {
          failedLogin(ip);
          htmlResponse(response, 401, loginPage({ error: 'Access token was not accepted.', returnTo }));
          return;
        }
        failures.delete(ip);
        redirect(response, returnTo, { 'set-cookie': security.sessionCookie(identity) });
        return;
      }

      if (method === 'POST' && pathname === '/logout') {
        denyCrossSiteMutation(request);
        redirect(response, '/login', { 'set-cookie': security.clearCookie() });
        return;
      }

      if (method === 'GET' && parts[0] === 'share' && parts[1] && parts.length === 2) {
        const share = await shareRegistry.authenticate(parts[1]);
        if (!share) throw new WorkspaceAuthorityError('Share link is invalid, expired, or revoked.');
        const workspace = await internal.engine.inspect(share.workspace_id, { principalId: share.principal_id });
        jsonResponse(response, 200, {
          schema: 'archie-hosted-read-share/v1',
          share: { share_id: share.share_id, workspace_id: share.workspace_id, capabilities: ['read'], expires_at: share.expires_at },
          workspace
        });
        return;
      }

      const identity = security.authenticate(request);
      if (!identity) {
        const acceptsHtml = String(request.headers.accept || '').includes('text/html');
        if (method === 'GET' && acceptsHtml) {
          redirect(response, `/login?return_to=${encodeURIComponent(safeReturnPath(`${pathname}${requestUrl.search}`))}`);
        } else {
          jsonResponse(response, 401, {
            schema: 'archied-hosted-error/v1',
            error: 'authentication_required',
            message: 'Private founder/developer authentication is required.'
          }, { 'www-authenticate': 'Bearer realm="Archie"' });
        }
        return;
      }

      denyCrossSiteMutation(request);

      if (method === 'GET' && pathname === '/.well-known/archied.json') {
        jsonResponse(response, 200, descriptor);
        return;
      }

      if (method === 'GET' && pathname === '/auth/whoami') {
        jsonResponse(response, 200, { schema: 'archie-hosted-identity/v1', ...identity });
        return;
      }

      if (method === 'GET' && pathname === '/v1/hosted/status') {
        const workspaces = await visibleWorkspaces(identity);
        jsonResponse(response, 200, {
          schema: 'archie-hosted-status/v1',
          service: descriptor,
          principal: identity,
          workspaces: { count: workspaces.length, items: workspaces },
          shares: await shareRegistry.status(),
          secrets: await secretStore.status({ includeNames: identity.role === 'founder' }),
          backups: await hostedBackupStatus(dataRoot),
          claim_boundary: 'Hosted status reports exact Archie-native state visible to the authenticated principal. It does not claim an external deployment or model/device admission.'
        });
        return;
      }

      if (method === 'POST' && pathname === '/v1/hosted/shares') {
        const body = await readJsonBody(request);
        await ownedWorkspace(identity, body.workspace_id);
        const duration = body.expires_in_ms === undefined ? 24 * 60 * 60 * 1000 : Number(body.expires_in_ms);
        if (!Number.isInteger(duration) || duration < 60_000 || duration > 30 * 24 * 60 * 60 * 1000) {
          throw new WorkspaceError('Share expiry must be from one minute through 30 days.');
        }
        const nonce = crypto.randomBytes(12).toString('hex');
        const principalId = `share_${nonce}`;
        const grantId = `grant_${nonce}`;
        await internal.engine.execute(body.workspace_id, identity.principal_id, 'agent.register', {
          agent_id: principalId,
          label: String(body.label || 'Explicit read-only share').slice(0, 160),
          kind: 'service',
          provider: 'archie-hosted-share'
        });
        await internal.engine.execute(body.workspace_id, identity.principal_id, 'grant.issue', {
          grant_id: grantId,
          principal_id: principalId,
          capabilities: ['read'],
          expires_at: new Date(Date.now() + duration).toISOString()
        });
        let issued;
        try {
          issued = await shareRegistry.issue({
            workspaceId: body.workspace_id,
            principalId,
            grantId,
            createdBy: identity.principal_id,
            expiresInMs: duration
          });
        } catch (error) {
          await internal.engine.execute(body.workspace_id, identity.principal_id, 'grant.revoke', { grant_id: grantId }).catch(() => {});
          throw error;
        }
        jsonResponse(response, 201, {
          schema: 'archie-hosted-share-issued/v1',
          ...issued.record,
          token_disclosed_once: true,
          capabilities: ['read'],
          share_url: new URL(`share/${issued.token}`, config.public_url).href
        });
        return;
      }

      if (
        method === 'GET' && parts[0] === 'v1' && parts[1] === 'hosted' && parts[2] === 'workspaces'
        && parts[3] && parts[4] === 'shares' && parts.length === 5
      ) {
        await ownedWorkspace(identity, parts[3]);
        jsonResponse(response, 200, { schema: 'archie-hosted-share-list/v1', workspace_id: parts[3], shares: await shareRegistry.list(parts[3]) });
        return;
      }

      if (
        method === 'POST' && parts[0] === 'v1' && parts[1] === 'hosted' && parts[2] === 'workspaces'
        && parts[3] && parts[4] === 'shares' && parts[5] && parts[6] === 'revoke' && parts.length === 7
      ) {
        await ownedWorkspace(identity, parts[3]);
        const record = (await shareRegistry.list(parts[3])).find(item => item.share_id === parts[5]);
        if (!record) throw new WorkspaceError('Hosted share was not found.', { code: 'not_found', status: 404 });
        await internal.engine.execute(parts[3], identity.principal_id, 'grant.revoke', { grant_id: record.grant_id });
        const revoked = await shareRegistry.revoke(parts[5]);
        jsonResponse(response, 200, { schema: 'archie-hosted-share-revocation/v1', ...revoked });
        return;
      }

      if (method === 'PUT' && parts[0] === 'v1' && parts[1] === 'hosted' && parts[2] === 'secrets' && parts[3] && parts.length === 4) {
        requireRole(identity, ['founder']);
        const body = await readJsonBody(request);
        jsonResponse(response, 200, { schema: 'archie-hosted-secret-write/v1', secret: await secretStore.set(parts[3], body.value) });
        return;
      }

      if (method === 'POST' && pathname === '/v1/hosted/backups') {
        requireRole(identity, ['founder']);
        const { backup } = await createHostedBackup({
          provider: internal.provider,
          secretStore,
          dataRoot,
          serviceVersion: ARCHIED_HOSTED_VERSION,
          migrationLevel: ARCHIED_HOSTED_MIGRATION_LEVEL
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

      proxy(request, response, identity);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const hostedError = error instanceof WorkspaceError
        ? error
        : new WorkspaceError(error?.message || 'Hosted Archie failed.', { code: 'hosted_error', status: 500 });
      jsonResponse(response, hostedError.status, {
        schema: 'archied-hosted-error/v1',
        error: hostedError.code,
        message: hostedError.message
      });
    }
  });

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = Promise.all([
      new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      internal.close()
    ]).then(() => undefined);
    return closing;
  }

  return Object.freeze({
    schema: ARCHIED_HOSTED_SCHEMA,
    server,
    internal,
    descriptor,
    url: localUrl,
    public_url: config.public_url,
    data_root: dataRoot,
    close
  });
}

export async function main(env = process.env) {
  const runtime = await startHostedArchied({ env });
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
    process.stderr.write(`archied-hosted: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
