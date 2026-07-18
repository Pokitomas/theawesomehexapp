import http from 'node:http';
import { URL } from 'node:url';
import {
  WorkspaceAuthorityError,
  WorkspaceError,
  WorkspaceNotFoundError,
  createWorkspaceEngine
} from './archie-workspace-core.mjs';
import { SafeFileWorkspaceProvider } from './archie-workspace-file-provider.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function isLoopback(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
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

function principalHeader(request) {
  const value = request.headers['x-archie-principal'];
  return Array.isArray(value) ? value[0] : value || null;
}

function serviceDescriptor(baseUrl, { anonymousPublicRead }) {
  return {
    schema: 'archie-workspace-service/v1',
    base_url: baseUrl,
    provider: 'provider-neutral-workspace-adapter',
    anonymous_public_read: anonymousPublicRead,
    mutation_identity: anonymousPublicRead
      ? 'x-archie-principal on loopback or an injected authenticator'
      : 'injected private authenticator',
    canonical_objects: ['workspace', 'objective', 'task', 'agent', 'grant', 'lease', 'run', 'event', 'artifact', 'evidence', 'review', 'requested_change', 'approval', 'promotion', 'rollback'],
    claim_boundary: anonymousPublicRead
      ? 'Anonymous reads are allowed only for public workspaces; non-loopback mutations require an injected authenticator.'
      : 'All workspace routes require the enclosing private service policy. Read-only external access must use an explicit signed share.'
  };
}

export function createWorkspaceRequestHandler({
  engine,
  authenticate = null,
  baseUrl = 'http://127.0.0.1/',
  corsOrigin = '*',
  anonymousPublicRead = corsOrigin === '*'
}) {
  if (!engine) throw new WorkspaceError('Workspace engine is required.');

  async function resolvePrincipal(request, { mutation = false } = {}) {
    if (typeof authenticate === 'function') {
      const authenticated = await authenticate(request);
      return authenticated?.principal_id || null;
    }
    if (mutation && !isLoopback(request.socket?.remoteAddress)) return null;
    return principalHeader(request);
  }

  return async function handle(request, response) {
    if (corsOrigin) response.setHeader('access-control-allow-origin', corsOrigin);
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    response.setHeader('access-control-allow-headers', 'authorization, content-type, x-archie-principal');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const requestUrl = new URL(request.url || '/', baseUrl);
      const parts = requestUrl.pathname.split('/').filter(Boolean);

      if (request.method === 'GET' && (requestUrl.pathname === '/health' || requestUrl.pathname === '/.well-known/archie-workspace-service.json')) {
        jsonResponse(response, 200, serviceDescriptor(baseUrl, { anonymousPublicRead }));
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/v1/workspaces') {
        jsonResponse(response, 200, { schema: 'archie-public-workspace-list/v1', workspaces: await engine.listPublic() });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/v1/workspaces') {
        const principalId = await resolvePrincipal(request, { mutation: true });
        if (!principalId) throw new WorkspaceAuthorityError('Workspace creation requires a local or authenticated principal.');
        const body = await readJsonBody(request);
        if (body.owner_id && body.owner_id !== principalId) throw new WorkspaceAuthorityError('The creating principal must be the workspace owner.');
        const result = await engine.createWorkspace({ ...body, owner_id: principalId });
        jsonResponse(response, 201, { event: result.event, workspace: result.state.workspace, head_digest: result.state.head_digest });
        return;
      }

      if (parts[0] !== 'v1' || parts[1] !== 'workspaces' || !parts[2]) throw new WorkspaceNotFoundError('Route was not found.');
      const workspaceId = parts[2];
      const principalId = await resolvePrincipal(request, { mutation: request.method !== 'GET' });

      if (request.method === 'GET' && parts.length === 3) {
        jsonResponse(response, 200, await engine.inspect(workspaceId, { principalId }));
        return;
      }

      if (request.method === 'GET' && parts[3] === 'events' && parts.length === 4) {
        const events = await engine.events(workspaceId, { principalId });
        jsonResponse(response, 200, { schema: 'archie-workspace-event-stream/v1', workspace_id: workspaceId, events });
        return;
      }

      if (request.method === 'GET' && parts[3] === 'artifacts' && parts[4] && parts.length === 5) {
        const result = await engine.readArtifact(workspaceId, parts[4], { principalId });
        response.writeHead(200, {
          'content-type': result.artifact.media_type,
          'content-length': result.bytes.length,
          'cache-control': 'private, no-store',
          'x-archie-artifact-sha256': result.artifact.sha256,
          'content-disposition': `inline; filename="${result.artifact.name.replaceAll('"', '')}"`
        });
        response.end(result.bytes);
        return;
      }

      if (request.method === 'POST' && parts[3] === 'commands' && parts.length === 4) {
        if (!principalId) throw new WorkspaceAuthorityError('Workspace mutation requires a local or authenticated principal.');
        const body = await readJsonBody(request);
        const result = await engine.execute(workspaceId, principalId, body.command, body.payload || {});
        jsonResponse(response, 200, { event: result.event, state: result.state });
        return;
      }

      throw new WorkspaceNotFoundError('Route was not found.');
    } catch (error) {
      const workspaceError = error instanceof WorkspaceError
        ? error
        : new WorkspaceError(error?.message || 'Internal workspace service error.', { code: 'internal_error', status: 500 });
      jsonResponse(response, workspaceError.status, {
        schema: 'archie-workspace-service-error/v1',
        error: workspaceError.code,
        message: workspaceError.message
      });
    }
  };
}

export async function startWorkspaceService({ root, host = '127.0.0.1', port = 0, authenticate = null } = {}) {
  const provider = new SafeFileWorkspaceProvider(root);
  const engine = createWorkspaceEngine({ provider });
  const server = http.createServer(createWorkspaceRequestHandler({ engine, authenticate }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${typeof address === 'object' ? address.port : port}/`;
  return {
    schema: 'archie-workspace-service-runtime/v1',
    engine,
    provider,
    server,
    url,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
