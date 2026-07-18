import fs from 'node:fs/promises';
import path from 'node:path';
import { renderHostedLogin } from './archie-hosted-pages.mjs';
import { generateHostedToken } from './archie-hosted-auth.mjs';
import { exportWorkspaceBundle, readWorkspaceBundle, writeWorkspaceBundle } from './archie-workspace-portable.mjs';
import { WorkspaceAuthorityError, WorkspaceError, sha256 } from './archie-workspace-core.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

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

function redirect(response, location, headers = {}) {
  response.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
  response.end();
}

function integer(value, label, { min, max }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new WorkspaceError(`${label} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function safeSegment(value, label) {
  const normalized = String(value || '').trim();
  if (!/^[a-z][a-z0-9_-]{2,127}$/.test(normalized)) throw new WorkspaceError(`${label} is invalid.`);
  return normalized;
}

async function listBackups(backupRoot) {
  let names = [];
  try {
    names = (await fs.readdir(backupRoot)).filter(name => name.endsWith('.archie.json')).sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const backups = [];
  for (const name of names) {
    const bundle = await readWorkspaceBundle(path.join(backupRoot, name));
    backups.push({
      backup_id: name.slice(0, -'.archie.json'.length),
      workspace_id: bundle.workspace_id,
      event_count: bundle.event_count,
      head_digest: bundle.head_digest,
      bundle_digest: bundle.bundle_digest,
      exported_at: bundle.exported_at
    });
  }
  return backups.sort((left, right) => right.exported_at.localeCompare(left.exported_at));
}

export function createHostedControl({
  engine,
  provider,
  dataRoot,
  auth,
  shareRegistry,
  publicBaseUrl,
  descriptor
}) {
  if (!engine || !provider || !auth || !shareRegistry) throw new WorkspaceError('Hosted control requires engine, provider, authentication, and share registry.');
  const baseUrl = new URL(publicBaseUrl);
  const backupRoot = path.join(path.resolve(dataRoot), 'backups');

  async function requireOperator(request, roles = ['founder', 'developer']) {
    return auth.requireOperator(request, roles);
  }

  async function requireOwner(request, workspaceId) {
    const identity = await requireOperator(request, ['founder']);
    const state = await engine.inspect(workspaceId, { principalId: identity.principal_id });
    if (state.workspace.owner_id !== identity.principal_id) throw new WorkspaceAuthorityError('Only the workspace owner may manage shares or backups.');
    return { identity, state };
  }

  async function handle(request, response) {
    const requestUrl = new URL(request.url || '/', baseUrl);
    const pathname = requestUrl.pathname;
    const parts = pathname.split('/').filter(Boolean);

    if (request.method === 'GET' && pathname === '/login') {
      const current = await auth.authenticate(request);
      if (current && ['founder', 'developer'].includes(current.role)) {
        redirect(response, '/');
        return true;
      }
      htmlResponse(response, renderHostedLogin({ message: requestUrl.searchParams.get('error') || '' }));
      return true;
    }

    if (request.method === 'POST' && pathname === '/auth/login') {
      const body = await readJsonBody(request);
      const identity = auth.authenticateOperatorToken(body.token);
      if (!identity) throw new WorkspaceAuthorityError('Hosted access token was rejected.');
      jsonResponse(response, 200, {
        schema: 'archie-hosted-login/v1',
        principal_id: identity.principal_id,
        role: identity.role,
        redirect: '/'
      }, { 'set-cookie': auth.operatorCookie(body.token) });
      return true;
    }

    if (request.method === 'POST' && pathname === '/auth/logout') {
      jsonResponse(response, 200, { schema: 'archie-hosted-logout/v1', logged_out: true }, { 'set-cookie': auth.clearCookies() });
      return true;
    }

    if (request.method === 'GET' && pathname === '/auth/whoami') {
      const identity = await auth.authenticate(request);
      if (!identity) throw new WorkspaceAuthorityError('Authentication is required.');
      jsonResponse(response, 200, { schema: 'archie-hosted-identity/v1', ...identity });
      return true;
    }

    if (request.method === 'GET' && parts[0] === 'share' && parts[1] && parts.length === 2) {
      const identity = await shareRegistry.authenticateToken(parts[1]);
      if (!identity) throw new WorkspaceAuthorityError('Share link is invalid, expired, or revoked.');
      redirect(response, `/w/${encodeURIComponent(identity.workspace_id)}`, { 'set-cookie': auth.shareCookie(parts[1]) });
      return true;
    }

    if (request.method === 'GET' && pathname === '/v1/hosted/status') {
      const identity = await requireOperator(request);
      const workspaceIds = typeof provider.listWorkspaceIds === 'function' ? await provider.listWorkspaceIds() : [];
      const backups = await listBackups(backupRoot);
      jsonResponse(response, 200, {
        schema: 'archie-hosted-status/v1',
        principal: { principal_id: identity.principal_id, role: identity.role },
        service: descriptor,
        workspaces: { count: workspaceIds.length },
        backups: { count: backups.length, latest: backups[0] || null },
        share_registry_digest: await shareRegistry.digest(),
        claim_boundary: 'Hosted status reports Archie-native state and backups only. It does not claim external deployment health beyond this process.'
      });
      return true;
    }

    if (request.method === 'GET' && pathname === '/v1/hosted/backups') {
      await requireOperator(request);
      jsonResponse(response, 200, { schema: 'archie-hosted-backup-list/v1', backups: await listBackups(backupRoot) });
      return true;
    }

    if (
      parts[0] === 'v1' && parts[1] === 'hosted' && parts[2] === 'workspaces' && parts[3]
      && parts[4] === 'shares' && parts.length === 5
    ) {
      const workspaceId = safeSegment(parts[3], 'workspace_id');
      if (request.method === 'GET') {
        await requireOwner(request, workspaceId);
        jsonResponse(response, 200, { schema: 'archie-hosted-share-list/v1', workspace_id: workspaceId, shares: await shareRegistry.list(workspaceId) });
        return true;
      }
      if (request.method === 'POST') {
        const { identity } = await requireOwner(request, workspaceId);
        const body = await readJsonBody(request);
        const expiresInSeconds = integer(body.expires_in_seconds ?? 86_400, 'expires_in_seconds', { min: 300, max: 30 * 86_400 });
        const token = generateHostedToken();
        const tokenDigest = sha256(token);
        const principalId = `share_${tokenDigest.slice(0, 20)}`;
        const agentId = principalId;
        const grantId = `grant_${tokenDigest.slice(0, 20)}`;
        await engine.execute(workspaceId, identity.principal_id, 'agent.register', {
          agent_id: agentId,
          label: body.label || 'Explicit read-only share',
          kind: 'service',
          provider: 'archie-hosted-share'
        });
        await engine.execute(workspaceId, identity.principal_id, 'grant.issue', {
          grant_id: grantId,
          principal_id: principalId,
          capabilities: ['read']
        });
        const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
        const record = await shareRegistry.add({
          workspaceId,
          principalId,
          token,
          expiresAt,
          createdBy: identity.principal_id
        });
        jsonResponse(response, 201, {
          schema: 'archie-hosted-share-issued/v1',
          ...record,
          url: new URL(`share/${token}`, baseUrl).href,
          token_disclosed_once: true,
          capabilities: ['read']
        });
        return true;
      }
    }

    if (
      request.method === 'POST'
      && parts[0] === 'v1' && parts[1] === 'hosted' && parts[2] === 'shares' && parts[3]
      && parts[4] === 'revoke' && parts.length === 5
    ) {
      await requireOperator(request, ['founder']);
      jsonResponse(response, 200, { schema: 'archie-hosted-share-revocation/v1', ...(await shareRegistry.revoke(parts[3])) });
      return true;
    }

    if (
      request.method === 'POST'
      && parts[0] === 'v1' && parts[1] === 'hosted' && parts[2] === 'workspaces' && parts[3]
      && parts[4] === 'backups' && parts.length === 5
    ) {
      const workspaceId = safeSegment(parts[3], 'workspace_id');
      const { identity } = await requireOwner(request, workspaceId);
      const bundle = await exportWorkspaceBundle({ engine, workspaceId, principalId: identity.principal_id });
      const backupId = `${workspaceId}-${bundle.head_digest.slice(0, 16)}`;
      await writeWorkspaceBundle(path.join(backupRoot, `${backupId}.archie.json`), bundle);
      jsonResponse(response, 201, {
        schema: 'archie-hosted-backup/v1',
        backup_id: backupId,
        workspace_id: workspaceId,
        head_digest: bundle.head_digest,
        bundle_digest: bundle.bundle_digest,
        event_count: bundle.event_count,
        exported_at: bundle.exported_at,
        restore_contract: 'archie-portable-workspace-bundle/v1'
      });
      return true;
    }

    return false;
  }

  return Object.freeze({
    handle,
    requireOperator,
    authenticate: auth.authenticate,
    backupRoot,
    descriptor: Object.freeze({
      schema: 'archie-hosted-control/v1',
      public_base_url: baseUrl.href,
      stable_workspace_url: new URL('w/{workspace_id}', baseUrl).href,
      private_authentication: true,
      explicit_read_only_shares: true,
      durable_backups: true,
      vendor_specific_dependency: false
    })
  });
}
