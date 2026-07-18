#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHybridService } from './archie-hybrid-protocol.mjs';
import { WorkspaceError } from './archie-workspace-core.mjs';
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

function flagValue(argv, name, fallback = null) {
  const index = argv.lastIndexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function normalizePublicUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ARCHIE_PUBLIC_URL must use http or https.');
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  return url.href;
}

export function resolveHostedConfig({ argv = [], env = process.env } = {}) {
  const home = path.resolve(flagValue(argv, '--home', env.ARCHIE_HOME || path.join(os.homedir(), '.archie')));
  const host = flagValue(argv, '--host', env.ARCHIE_HOST || '0.0.0.0');
  const port = integer(flagValue(argv, '--port', env.ARCHIE_PORT || '8787'), '--port');
  const publicUrl = normalizePublicUrl(flagValue(argv, '--public-url', env.ARCHIE_PUBLIC_URL || null));
  const founderToken = flagValue(argv, '--founder-token', env.ARCHIE_FOUNDER_TOKEN || null);
  const secureCookies = publicUrl?.startsWith('https://') || env.ARCHIE_SECURE_COOKIES === '1';
  if (!founderToken || founderToken.length < 24) throw new Error('ARCHIE_FOUNDER_TOKEN must contain at least 24 characters.');
  return Object.freeze({ home, host, port, publicUrl, founderToken, secureCookies });
}

function parseCookies(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function json(response, status, value, headers = {}) {
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

function html(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...headers
  });
  response.end(body);
}

async function readBody(request, limit = MAX_LOGIN_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function loginPage(error = '') {
  const encoded = JSON.stringify(error);
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Archie founder access</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f4efe3;color:#171714}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:20px;background:linear-gradient(160deg,#f8f5ec,#e7decb)}main{width:min(440px,100%);background:#fffdf8;border:1px solid #cfc5b2;border-radius:24px;padding:24px;box-shadow:0 20px 50px #332b1d1a}h1{margin:0 0 8px;font-size:38px;letter-spacing:-.05em}p{color:#5d564b;line-height:1.5}label{display:block;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin:22px 0 7px}input{width:100%;padding:14px;border:1px solid #b9ae9a;border-radius:14px;font:inherit;background:#fff}button{width:100%;margin-top:12px;padding:14px;border:0;border-radius:14px;background:#171714;color:#fff;font:inherit;font-weight:850;cursor:pointer}.error{min-height:20px;color:#9d3026;font-size:13px;margin-top:12px}
</style>
<main><h1>Private Archie</h1><p>Founder and developer inspection of the same Archie-native workspaces, evidence, backups, and outbound runner state.</p><form id="f"><label for="token">Founder token</label><input id="token" type="password" autocomplete="current-password" required><button>Enter Archie</button><div class="error" id="e"></div></form></main>
<script>const initial=${encoded};document.querySelector('#e').textContent=initial;document.querySelector('#f').addEventListener('submit',async e=>{e.preventDefault();const response=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:document.querySelector('#token').value})});const value=await response.json().catch(()=>({}));if(!response.ok){document.querySelector('#e').textContent=value.message||'Authentication failed.';return}location.href='/';});</script>`;
}

class SessionStore {
  constructor({ founderToken, ttlSeconds = SESSION_TTL_SECONDS, clock = () => Date.now() }) {
    this.founderToken = founderToken;
    this.ttlSeconds = ttlSeconds;
    this.clock = clock;
    this.sessions = new Map();
    this.failures = new Map();
  }

  cleanup() {
    const now = this.clock();
    for (const [key, session] of this.sessions) if (session.expires_at_ms <= now) this.sessions.delete(key);
    for (const [key, failure] of this.failures) if (failure.window_started_at_ms + LOGIN_WINDOW_MS <= now) this.failures.delete(key);
  }

  verifyFounderToken(value, clientKey = 'unknown') {
    this.cleanup();
    const existing = this.failures.get(clientKey);
    if (existing && existing.count >= MAX_FAILED_LOGINS) return false;
    const ok = constantTimeEqual(value, this.founderToken);
    if (ok) {
      this.failures.delete(clientKey);
      return true;
    }
    const current = existing && existing.window_started_at_ms + LOGIN_WINDOW_MS > this.clock()
      ? existing
      : { count: 0, window_started_at_ms: this.clock() };
    current.count += 1;
    this.failures.set(clientKey, current);
    return false;
  }

  create() {
    this.cleanup();
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const createdAtMs = this.clock();
    const session = {
      schema: ARCHIED_HOSTED_AUTH_SCHEMA,
      principal_id: 'owner_local',
      session_id: sessionId,
      csrf_token: csrf,
      created_at: new Date(createdAtMs).toISOString(),
      expires_at: new Date(createdAtMs + this.ttlSeconds * 1000).toISOString(),
      expires_at_ms: createdAtMs + this.ttlSeconds * 1000
    };
    this.sessions.set(sessionId, session);
    return { ...session };
  }

  get(request) {
    this.cleanup();
    const sessionId = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  revoke(request) {
    const sessionId = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (sessionId) this.sessions.delete(sessionId);
  }
}

function sessionCookie(session, secure) {
  return `${COOKIE_NAME}=${encodeURIComponent(session.session_id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

function clearCookie(secure) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

async function proxyToInternal(request, response, targetUrl, principalId) {
  const target = new URL(request.url || '/', targetUrl);
  const headers = { ...request.headers, host: target.host, 'x-archie-principal': principalId };
  delete headers.cookie;
  delete headers['content-length'];
  const body = ['GET', 'HEAD'].includes(request.method || 'GET') ? undefined : await readBody(request, 52 * 1024 * 1024);
  const upstream = await fetch(target, { method: request.method, headers, body, redirect: 'manual' });
  const outgoing = {};
  upstream.headers.forEach((value, key) => {
    if (!['connection', 'keep-alive', 'transfer-encoding', 'set-cookie'].includes(key.toLowerCase())) outgoing[key] = value;
  });
  response.writeHead(upstream.status, outgoing);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

async function archiveBackup(runtime, session) {
  const workspaceIds = typeof runtime.internal.provider.listWorkspaceIds === 'function'
    ? await runtime.internal.provider.listWorkspaceIds()
    : [];
  const workspaces = [];
  for (const workspaceId of workspaceIds) {
    try {
      const state = await runtime.internal.engine.inspect(workspaceId, { principalId: session.principal_id });
      const events = await runtime.internal.engine.events(workspaceId, { principalId: session.principal_id });
      workspaces.push({
        workspace_id: workspaceId,
        visibility: state.workspace.visibility,
        event_count: events.length,
        head_digest: state.head_digest
      });
    } catch {}
  }
  const createdAt = new Date().toISOString();
  const receipt = {
    schema: 'archied-hosted-backup-receipt/v1',
    created_at: createdAt,
    service_version: runtime.descriptor.service_version,
    migration_level: runtime.descriptor.migration_level,
    canonical_state: runtime.descriptor.canonical_state,
    workspace_count: workspaces.length,
    workspaces,
    restore_contract: 'Use each workspace portable export; this hosted backup receipt never claims to contain artifact bytes.'
  };
  receipt.receipt_digest = crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  runtime.backups.unshift(receipt);
  if (runtime.backups.length > 20) runtime.backups.length = 20;
  return receipt;
}

function hostedError(response, error) {
  const status = error instanceof WorkspaceError ? error.status : Number(error?.status) || 500;
  json(response, status, {
    schema: 'archied-hosted-error/v1',
    error: error?.code || (status === 500 ? 'internal_error' : 'request_failed'),
    message: error?.message || 'Hosted Archie request failed.'
  });
}

export async function startHostedArchied(options = {}) {
  const config = options.config || resolveHostedConfig({ argv: options.argv || [], env: options.env || process.env });
  const internal = options.internal || await startArchied({
    home: config.home,
    host: '127.0.0.1',
    port: 0,
    mode: 'hosted'
  });
  const hybrid = options.hybrid || createHybridService({
    engine: internal.engine,
    root: path.join(config.home, 'standalone', 'hybrid')
  });
  const sessions = options.sessions || new SessionStore({ founderToken: config.founderToken });
  const backups = [];
  const server = http.createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address?.port ? address.port : config.port;
  const publicUrl = config.publicUrl || `http://127.0.0.1:${actualPort}/`;

  const descriptor = Object.freeze({
    schema: ARCHIED_HOSTED_SCHEMA,
    service_version: internal.descriptor.service_version,
    migration_level: internal.descriptor.migration_level,
    mode: 'hosted',
    public_url: publicUrl,
    stable_workspace_url_template: new URL('w/{workspace_id}', publicUrl).href,
    private_founder_authentication: true,
    session_ttl_seconds: SESSION_TTL_SECONDS,
    canonical_state: internal.descriptor.canonical_state,
    storage: internal.descriptor.storage,
    backup_contract: 'archied-hosted-backup-receipt/v1 plus portable workspace exports',
    rollback_visibility: true,
    hybrid_runner: hybrid.descriptor,
    source_host_required: false,
    github_required: false,
    vendor_specific_runtime_dependency: false,
    external_tls_terminated_by_operator: config.secureCookies,
    claim_boundary: 'Hosted mode provides authenticated founder/developer inspection of the same Archie-native workspaces and outbound-only fenced runners. It does not claim paid deployment, external TLS configuration, trained-model admission, customer superiority, or physical-device evidence.'
  });

  const runtime = {
    schema: ARCHIED_HOSTED_SCHEMA,
    server,
    internal,
    hybrid,
    sessions,
    backups,
    descriptor,
    url: `http://127.0.0.1:${actualPort}/`,
    public_url: publicUrl,
    close: async () => {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await internal.close();
    }
  };

  async function hostedStatus(session) {
    const workspaceIds = typeof internal.provider.listWorkspaceIds === 'function'
      ? await internal.provider.listWorkspaceIds()
      : [];
    const latest = backups[0] || null;
    return {
      schema: 'archied-hosted-status/v1',
      inspected_by: session.principal_id,
      service_version: descriptor.service_version,
      migration_level: descriptor.migration_level,
      canonical_state: descriptor.canonical_state,
      workspace_count: workspaceIds.length,
      stable_workspace_url_template: descriptor.stable_workspace_url_template,
      latest_backup: latest,
      hybrid_runner: await hybrid.status(),
      rollback_visibility: true,
      github_required: false
    };
  }

  server.on('request', async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', runtime.url);
      const pathname = requestUrl.pathname;
      const parts = pathname.split('/').filter(Boolean);

      if (request.method === 'GET' && pathname === '/health') {
        json(response, 200, {
          schema: 'archied-hosted-health/v1',
          status: 'ok',
          service_version: descriptor.service_version,
          migration_level: descriptor.migration_level,
          hybrid_protocol_version: descriptor.hybrid_runner.protocol_version
        });
        return;
      }

      if (parts[0] === 'v1' && parts[1] === 'hybrid' && parts[2] === 'runner') {
        if (await hybrid.handleRunner(request, response, pathname, parts)) return;
        json(response, 404, { schema: 'archied-hosted-error/v1', error: 'not_found', message: 'Hybrid runner route was not found.' });
        return;
      }

      if (request.method === 'GET' && pathname === '/auth/login') {
        html(response, 200, loginPage());
        return;
      }

      if (request.method === 'POST' && pathname === '/auth/login') {
        let payload = {};
        try { payload = JSON.parse((await readBody(request)).toString('utf8') || '{}'); }
        catch { json(response, 400, { schema: 'archied-hosted-error/v1', error: 'invalid_json', message: 'Login body must be JSON.' }); return; }
        const clientKey = request.socket.remoteAddress || 'unknown';
        if (!sessions.verifyFounderToken(payload.token, clientKey)) {
          json(response, 401, { schema: 'archied-hosted-error/v1', error: 'unauthorized', message: 'Founder token rejected.' });
          return;
        }
        const session = sessions.create();
        json(response, 200, {
          schema: ARCHIED_HOSTED_AUTH_SCHEMA,
          authenticated: true,
          principal_id: session.principal_id,
          csrf_token: session.csrf_token,
          expires_at: session.expires_at
        }, { 'set-cookie': sessionCookie(session, config.secureCookies) });
        return;
      }

      if (request.method === 'POST' && pathname === '/auth/logout') {
        sessions.revoke(request);
        json(response, 200, { schema: ARCHIED_HOSTED_AUTH_SCHEMA, authenticated: false }, { 'set-cookie': clearCookie(config.secureCookies) });
        return;
      }

      const session = sessions.get(request);
      if (!session) {
        if (request.method === 'GET' && !pathname.startsWith('/v1/')) {
          response.writeHead(303, { location: '/auth/login', 'cache-control': 'no-store' });
          response.end();
        } else json(response, 401, { schema: 'archied-hosted-error/v1', error: 'unauthorized', message: 'Founder authentication required.' });
        return;
      }

      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method || 'GET');
      if (mutating && !constantTimeEqual(request.headers['x-archie-csrf'] || '', session.csrf_token)) {
        json(response, 403, { schema: 'archied-hosted-error/v1', error: 'csrf_rejected', message: 'A valid Archie CSRF token is required.' });
        return;
      }

      if (parts[0] === 'v1' && parts[1] === 'hybrid' && parts[2] === 'founder') {
        if (await hybrid.handleFounder(request, response, pathname, parts)) return;
        json(response, 404, { schema: 'archied-hosted-error/v1', error: 'not_found', message: 'Hybrid founder route was not found.' });
        return;
      }

      if (request.method === 'GET' && pathname === '/v1/hosted/status') {
        json(response, 200, await hostedStatus(session));
        return;
      }

      if (request.method === 'POST' && pathname === '/v1/hosted/backups') {
        json(response, 201, await archiveBackup(runtime, session));
        return;
      }

      if (request.method === 'GET' && pathname === '/v1/hosted/backups') {
        json(response, 200, { schema: 'archied-hosted-backup-index/v1', backups });
        return;
      }

      const workspacePage = pathname.match(/^\/w\/([a-z][a-z0-9_-]{2,127})$/);
      if (workspacePage) {
        request.url = '/';
        await proxyToInternal(request, response, internal.url, session.principal_id);
        return;
      }

      await proxyToInternal(request, response, internal.url, session.principal_id);
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else hostedError(response, error);
    }
  });

  return Object.freeze(runtime);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`archied-hosted\n\nUsage:\n  archied-hosted --founder-token <token> [--home <path>] [--host 0.0.0.0] [--port 8787] [--public-url https://archie.example/]\n\nThe hosted service wraps the exact local archied engine, requires private founder authentication, exposes expiring outbound runner enrollment and fenced work APIs, and does not require GitHub. Terminate TLS outside the container before exposing it beyond a private network.\n`);
    return null;
  }
  const runtime = await startHostedArchied({ config: resolveHostedConfig({ argv, env }) });
  process.stdout.write(`${JSON.stringify({ ...runtime.descriptor, pid: process.pid }, null, 2)}\n`);
  const stop = async () => { await runtime.close().catch(() => {}); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise(() => {});
  return runtime;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archied-hosted: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
