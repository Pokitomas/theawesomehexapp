#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startArchied } from './archied.mjs';

export const ARCHIED_HOSTED_SCHEMA = 'archied-hosted-runtime/v1';
export const ARCHIED_HOSTED_AUTH_SCHEMA = 'archied-founder-session/v1';
const COOKIE_NAME = 'archie_founder_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_LOGIN_BODY = 16 * 1024;
const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function integer(value, label, { min = 0, max = 65_535 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Expected a boolean value, received ${value}.`);
}

function secureEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function sessionKey(token) {
  return crypto.createHash('sha256').update('archie-hosted-session/v1\0').update(token).digest();
}

function signSession(token, now = Date.now()) {
  const payload = {
    schema: ARCHIED_HOSTED_AUTH_SCHEMA,
    role: 'founder',
    issued_at_ms: now,
    expires_at_ms: now + SESSION_TTL_SECONDS * 1000
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionKey(token)).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySession(value, token, now = Date.now()) {
  const [encoded, signature, extra] = String(value || '').split('.');
  if (!encoded || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', sessionKey(token)).update(encoded).digest('base64url');
  if (!secureEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.schema !== ARCHIED_HOSTED_AUTH_SCHEMA || payload.role !== 'founder') return null;
    if (!Number.isFinite(payload.expires_at_ms) || payload.expires_at_ms <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const result = {};
  for (const segment of String(header || '').split(';')) {
    const index = segment.indexOf('=');
    if (index <= 0) continue;
    const name = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (name) result[name] = value;
  }
  return result;
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

function loginPage({ error = '', returnTo = '/' } = {}) {
  const safeError = String(error).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const safeReturn = String(returnTo).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Archie founder access</title>
<style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#171714;background:#f3efe5}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(180deg,#f7f3e9,#e8dfcf)}main{width:min(430px,100%);background:#fffdf8;border:2px solid #171714;box-shadow:8px 8px 0 #171714;padding:24px}h1{margin:0 0 8px;font-size:36px;letter-spacing:-.055em}p{line-height:1.45;color:#59544a}.label{display:block;font-weight:800;margin:20px 0 7px}input{width:100%;min-height:52px;border:2px solid #171714;padding:11px 12px;background:#fff;font:inherit}button{width:100%;min-height:52px;margin-top:12px;border:2px solid #171714;background:#ef4e23;color:#fff;font:900 16px inherit;box-shadow:4px 4px 0 #171714;cursor:pointer}.error{border:1px solid #9d2513;background:#ffe6df;color:#7a1a0c;padding:10px;margin:14px 0}.meta{font:700 11px ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase;letter-spacing:.08em;color:#6c665c}</style></head>
<body><main><div class="meta">Private founder / developer workspace</div><h1>Enter Archie.</h1><p>The hosted view exposes the same workspaces, evidence, approvals, exports, and rollback state as local Archie. The access token never enters workspace receipts.</p>${safeError ? `<div class="error">${safeError}</div>` : ''}<form method="post" action="/login"><input type="hidden" name="return_to" value="${safeReturn}"><label class="label" for="token">Founder access token</label><input id="token" name="token" type="password" required autocomplete="current-password" autofocus><button type="submit">Open Archie</button></form></main></body></html>`;
}

async function readBody(request, limit = MAX_LOGIN_BODY) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeReturnPath(value) {
  const candidate = String(value || '/');
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return '/';
  return candidate.slice(0, 2048);
}

function requestAddress(request) {
  return String(request.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function removeHopByHopHeaders(headers) {
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
    result[name] = value;
  }
  return result;
}

export function resolveHostedConfig({ env = process.env, home = null, token = null, host = null, port = null, publicOrigin = null } = {}) {
  const selectedToken = String(token || env.ARCHIED_FOUNDER_TOKEN || '');
  if (selectedToken.length < 24) throw new Error('ARCHIED_FOUNDER_TOKEN must contain at least 24 characters.');
  const selectedHome = path.resolve(home || env.ARCHIE_HOME || path.join(os.homedir(), '.archie'));
  const selectedHost = host || env.ARCHIED_HOST || '0.0.0.0';
  const selectedPort = integer(port ?? env.ARCHIED_PORT ?? '8787', 'ARCHIED_PORT');
  const selectedOrigin = String(publicOrigin || env.ARCHIED_PUBLIC_ORIGIN || '').trim().replace(/\/$/, '') || null;
  if (selectedOrigin) {
    const parsed = new URL(selectedOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('ARCHIED_PUBLIC_ORIGIN must be a bare http(s) origin.');
    }
  }
  const secureCookie = boolean(env.ARCHIED_COOKIE_SECURE, selectedOrigin?.startsWith('https://') || false);
  return Object.freeze({ home: selectedHome, token: selectedToken, host: selectedHost, port: selectedPort, public_origin: selectedOrigin, secure_cookie: secureCookie });
}

export async function startHostedArchied(options = {}) {
  const config = resolveHostedConfig(options);
  const internal = await startArchied({ home: config.home, host: '127.0.0.1', port: 0, mode: 'hosted' });
  const failures = new Map();
  const server = http.createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address?.port ? address.port : config.port;
  const publicOrigin = config.public_origin || `http://127.0.0.1:${actualPort}`;
  const parsedPublicOrigin = new URL(publicOrigin);

  const descriptor = Object.freeze({
    schema: ARCHIED_HOSTED_SCHEMA,
    service_version: internal.descriptor.service_version,
    domain_contract: internal.descriptor.domain_contract,
    migration_level: internal.descriptor.migration_level,
    mode: 'hosted',
    base_url: `${publicOrigin}/`,
    authentication: {
      schema: ARCHIED_HOSTED_AUTH_SCHEMA,
      method: 'founder-token-to-http-only-session',
      session_ttl_seconds: SESSION_TTL_SECONDS,
      cookie_secure: config.secure_cookie
    },
    canonical_state: internal.descriptor.canonical_state,
    storage: {
      events: internal.descriptor.storage.events,
      artifacts: internal.descriptor.storage.artifacts,
      durable_volume: 'ARCHIE_HOME/standalone'
    },
    operator: {
      status_url: `${publicOrigin}/v1/hosted/status`,
      workspace_url_template: `${publicOrigin}/#workspace={workspace_id}`,
      portable_export_template: `${publicOrigin}/v1/standalone/workspaces/{workspace_id}/export`
    },
    source_host_required: false,
    github_required: false,
    local_runner_inbound_access_required: false,
    claim_boundary: 'Hosted Archie provides private founder/developer inspection over the same Archie-native workspace, authority, evidence, export, and rollback contracts. It does not claim an external deployment exists until an operator actually runs this image, and it does not upgrade model or device capability claims.'
  });

  function sessionFrom(request) {
    const value = parseCookies(request.headers.cookie)[COOKIE_NAME];
    return verifySession(value, config.token);
  }

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

  function cookieHeader(value, { clear = false } = {}) {
    const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (config.secure_cookie) parts.push('Secure');
    if (clear) parts.push('Max-Age=0');
    else parts.push(`Max-Age=${SESSION_TTL_SECONDS}`);
    return parts.join('; ');
  }

  async function hostedStatus() {
    const ids = await internal.provider.listWorkspaceIds();
    const workspaces = [];
    for (const workspaceId of ids) {
      const state = await internal.engine.inspect(workspaceId, { principalId: 'owner_local' });
      workspaces.push({
        workspace_id: workspaceId,
        title: state.workspace?.title || workspaceId,
        visibility: state.workspace?.visibility || 'private',
        event_count: state.event_count,
        head_digest: state.head_digest,
        task_count: Object.keys(state.tasks || {}).length,
        run_count: Object.keys(state.runs || {}).length,
        evidence_count: Object.keys(state.evidence || {}).length,
        approval_count: Object.keys(state.approvals || {}).length,
        rollback_count: Object.keys(state.rollbacks || {}).length,
        export_url: `${publicOrigin}/v1/standalone/workspaces/${workspaceId}/export`,
        inspect_url: `${publicOrigin}/v1/workspaces/${workspaceId}`
      });
    }
    return {
      schema: 'archied-hosted-status/v1',
      service: descriptor,
      workspace_count: workspaces.length,
      portable_backup_ready: true,
      workspaces
    };
  }

  function proxy(request, response) {
    const target = new URL(request.url || '/', internal.url);
    const headers = removeHopByHopHeaders(request.headers);
    headers.host = target.host;
    headers['x-archie-principal'] = 'owner_local';
    headers['x-forwarded-proto'] = parsedPublicOrigin.protocol.slice(0, -1);
    headers['x-forwarded-host'] = parsedPublicOrigin.host;

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
      const requestUrl = new URL(request.url || '/', publicOrigin);
      const pathname = requestUrl.pathname;
      const method = request.method || 'GET';

      if (method === 'GET' && pathname === '/health') {
        jsonResponse(response, 200, {
          schema: 'archied-health/v1',
          status: 'ok',
          mode: 'hosted',
          service_version: descriptor.service_version,
          migration_level: descriptor.migration_level
        });
        return;
      }

      if (method === 'GET' && pathname === '/login') {
        if (sessionFrom(request)) {
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
          jsonResponse(response, 429, { schema: 'archied-hosted-error/v1', error: 'login_rate_limited', message: 'Too many failed login attempts. Try again later.' }, { 'retry-after': String(Math.max(1, Math.ceil((state.reset_at_ms - Date.now()) / 1000))) });
          return;
        }
        const raw = await readBody(request);
        let candidate = '';
        let returnTo = '/';
        if (String(request.headers['content-type'] || '').includes('application/json')) {
          const body = JSON.parse(raw || '{}');
          candidate = String(body.token || '');
          returnTo = safeReturnPath(body.return_to);
        } else {
          const body = new URLSearchParams(raw);
          candidate = String(body.get('token') || '');
          returnTo = safeReturnPath(body.get('return_to'));
        }
        if (!secureEqual(candidate, config.token)) {
          failedLogin(ip);
          htmlResponse(response, 401, loginPage({ error: 'Access token was not accepted.', returnTo }));
          return;
        }
        failures.delete(ip);
        redirect(response, returnTo, { 'set-cookie': cookieHeader(signSession(config.token)) });
        return;
      }

      if (method === 'POST' && pathname === '/logout') {
        redirect(response, '/login', { 'set-cookie': cookieHeader('', { clear: true }) });
        return;
      }

      const session = sessionFrom(request);
      if (!session) {
        const acceptsHtml = String(request.headers.accept || '').includes('text/html');
        if (method === 'GET' && acceptsHtml) {
          redirect(response, `/login?return_to=${encodeURIComponent(safeReturnPath(`${pathname}${requestUrl.search}`))}`);
        } else {
          jsonResponse(response, 401, { schema: 'archied-hosted-error/v1', error: 'authentication_required', message: 'Founder authentication is required.' });
        }
        return;
      }

      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const fetchSite = String(request.headers['sec-fetch-site'] || '');
        const origin = String(request.headers.origin || '');
        if (fetchSite === 'cross-site' || (origin && origin !== publicOrigin)) {
          jsonResponse(response, 403, { schema: 'archied-hosted-error/v1', error: 'cross_site_mutation_denied', message: 'Cross-site mutations are not allowed.' });
          return;
        }
      }

      if (method === 'GET' && pathname === '/.well-known/archied.json') {
        jsonResponse(response, 200, descriptor);
        return;
      }

      if (method === 'GET' && pathname === '/v1/hosted/status') {
        jsonResponse(response, 200, await hostedStatus());
        return;
      }

      proxy(request, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      jsonResponse(response, error?.status || 500, {
        schema: 'archied-hosted-error/v1',
        error: error?.status === 413 ? 'body_too_large' : 'hosted_error',
        message: error?.message || 'Hosted Archie failed.'
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
    url: `${publicOrigin}/`,
    public_origin: publicOrigin,
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
