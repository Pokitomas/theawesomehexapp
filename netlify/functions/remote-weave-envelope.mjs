import { normalizePersistedWeaveMessage } from '../../scripts/weave-replay-integrity.mjs';

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();

export function advertisedWeavePayload(input) {
  return Boolean(input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) && input.payload.weave);
}

export function validateRemoteWeaveEnvelope(input = {}, headers = new Headers()) {
  if (!advertisedWeavePayload(input)) return null;
  const generationValue = Number(input.generation || 1);
  const message = {
    ...input,
    session: clean(input.session),
    generation: Math.max(1, generationValue || 1),
    issuer: clean(input.issuer || headers.get('x-remote-principal')),
    issued_at: clean(input.issued_at || headers.get('x-remote-timestamp')),
    visibility: input.visibility === 'public' ? 'public' : 'private'
  };
  return normalizePersistedWeaveMessage(message);
}

export async function validateRemoteWeaveRequest(request) {
  if (request.method !== 'POST') return null;
  const text = await request.clone().text().catch(() => '');
  if (!text) return null;
  let body;
  try { body = JSON.parse(text); }
  catch { return null; }
  return validateRemoteWeaveEnvelope(body.message || body, request.headers);
}
