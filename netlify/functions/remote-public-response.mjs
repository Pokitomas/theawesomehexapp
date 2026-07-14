import { publicMessageProjection } from './remote-core.mjs';

function publicRead(request) {
  if (request?.method !== 'GET') return false;
  try { return new URL(request.url).searchParams.get('public') === '1'; }
  catch { return false; }
}

export async function sanitizePublicRemoteResponse(request, response) {
  if (!publicRead(request) || !response?.ok) return response;

  let body;
  try { body = await response.clone().json(); }
  catch { return response; }

  if (Array.isArray(body?.messages)) {
    body.messages = body.messages.map(publicMessageProjection);
  }
  if (Array.isArray(body?.state?.messages)) {
    body.state.messages = body.state.messages.map(publicMessageProjection);
  }

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
