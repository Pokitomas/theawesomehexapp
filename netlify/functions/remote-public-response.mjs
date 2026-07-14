import {
  publicMessageProjection,
  publicTerminalReceiptProjection
} from './remote-core.mjs';

function publicRead(request) {
  if (request?.method !== 'GET') return false;
  try { return new URL(request.url).searchParams.get('public') === '1'; }
  catch { return false; }
}

function sanitizeProjectedPublicState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  return {
    protocol_version: state.protocol_version,
    session: state.session,
    generation: state.generation,
    decision: state.decision,
    head_sha: state.head_sha,
    claims: Array.isArray(state.claims) ? state.claims.map(claim => ({
      scope: claim?.scope,
      holder: claim?.holder,
      expires_at: claim?.expires_at
    })) : [],
    blocker_count: Number(state.blocker_count || 0),
    terminal: Boolean(state.terminal),
    terminal_receipt: publicTerminalReceiptProjection(state.terminal_receipt),
    summary: state.summary,
    updated_at: state.updated_at,
    updated_by: state.updated_by,
    messages: Array.isArray(state.messages) ? state.messages.map(publicMessageProjection) : []
  };
}

export async function sanitizePublicRemoteResponse(request, response) {
  if (!publicRead(request) || !response?.ok) return response;

  let body;
  try { body = await response.clone().json(); }
  catch { return response; }

  if (Array.isArray(body?.messages)) {
    body.messages = body.messages.map(publicMessageProjection);
  }
  if (body?.state && typeof body.state === 'object' && !Array.isArray(body.state)) {
    body.state = sanitizeProjectedPublicState(body.state);
  }

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
