import {
  CAPABILITIES,
  MAX_BODY_BYTES,
  MAX_CLOCK_SKEW_MS,
  MAX_PAGE_SIZE,
  canonicalRequest,
  clean,
  controlCapability,
  defaultState,
  hasCapability,
  messageIdKey,
  messageKey,
  nonceKey,
  normalizeCapabilities,
  normalizeMessage,
  normalizeSession,
  principalKey,
  pruneExpiredClaims,
  publicStateProjection,
  requireCapability,
  sessionDigest,
  stateKey,
  terminalKey,
  terminalReceipt,
  timestampIsFresh,
  validateTerminalEvidence,
  verifyEd25519Signature,
  verifyHmacSignature
} from './remote-core.mjs';
import { lassoRemoteArrival } from './weave-lasso-service.mjs';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-remote-principal,x-remote-timestamp,x-remote-nonce,x-remote-signature,x-remote-path'
};

const reply = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: jsonHeaders });
const fail = (status, message, detail) => reply(status, { error: message, ...(detail ? { detail } : {}) });

async function getJSON(store, key) {
  try { return await store.get(key, { type: 'json' }); }
  catch { return null; }
}

async function listBlobKeys(store, prefix) {
  const keys = [];
  let providerCursor;
  let pages = 0;
  do {
    const result = await store.list({ prefix, ...(providerCursor ? { cursor: providerCursor } : {}) });
    for (const blob of result?.blobs || []) if (blob?.key) keys.push(blob.key);
    providerCursor = result?.cursor || result?.next_cursor || result?.nextCursor || null;
    pages += 1;
  } while (providerCursor && pages < 50);
  return [...new Set(keys)].sort();
}

function envValue(env, key) {
  return typeof env?.[key] === 'string' ? env[key] : '';
}

function lassoEnabled(env) {
  const explicit = clean(envValue(env, 'REMOTE_WEAVE_LASSO')).toLowerCase();
  if (['0', 'false', 'off', 'disabled'].includes(explicit)) return false;
  if (['1', 'true', 'on', 'enabled'].includes(explicit)) return true;
  return clean(envValue(env, 'NETLIFY')).toLowerCase() === 'true';
}

function envPrincipalKeyName(principalId) {
  return `REMOTE_KEY_${clean(principalId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function rootPrincipal(env) {
  const id = clean(envValue(env, 'REMOTE_ROOT_ID') || 'root');
  const secret = envValue(env, 'REMOTE_ROOT_KEY');
  return secret ? { id, algorithm: 'hmac-sha256', secret, capabilities: [...CAPABILITIES], root: true } : null;
}

async function loadPrincipal(store, env, principalId) {
  const root = rootPrincipal(env);
  if (root && principalId === root.id) return root;
  const envSecret = envValue(env, envPrincipalKeyName(principalId));
  if (envSecret) {
    const capabilityKey = `REMOTE_CAPS_${clean(principalId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const configured = envValue(env, capabilityKey).split(',').map(value => value.trim()).filter(Boolean);
    return { id: principalId, algorithm: 'hmac-sha256', secret: envSecret, capabilities: configured.length ? normalizeCapabilities(configured) : [...CAPABILITIES] };
  }
  const record = await getJSON(store, principalKey(principalId));
  if (!record || record.id !== principalId || record.revoked_at) return null;
  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) return null;
  return { ...record, capabilities: normalizeCapabilities(record.capabilities) };
}

async function authenticate(request, bodyText, store, env, now) {
  const principalId = clean(request.headers.get('x-remote-principal')).slice(0, 160);
  const timestamp = clean(request.headers.get('x-remote-timestamp')).slice(0, 80);
  const nonce = clean(request.headers.get('x-remote-nonce')).slice(0, 220);
  const signature = clean(request.headers.get('x-remote-signature')).slice(0, 2048);
  if (!principalId || !timestamp || !nonce || !signature) {
    const error = new Error('Missing remote authentication headers.');
    error.status = 401;
    throw error;
  }
  if (!timestampIsFresh(timestamp, now, Number(envValue(env, 'REMOTE_CLOCK_SKEW_MS')) || MAX_CLOCK_SKEW_MS)) {
    const error = new Error('Request timestamp is stale.');
    error.status = 401;
    throw error;
  }
  const principal = await loadPrincipal(store, env, principalId);
  if (!principal) {
    const error = new Error('Unknown or expired principal.');
    error.status = 401;
    throw error;
  }
  const url = new URL(request.url);
  const signedPath = clean(request.headers.get('x-remote-path')) || `${url.pathname}${url.search}`;
  const canonical = canonicalRequest({ method: request.method, path: signedPath, timestamp, nonce, bodyText });
  let valid = false;
  if (principal.algorithm === 'hmac-sha256') valid = verifyHmacSignature({ secret: principal.secret, canonical, signature });
  if (principal.algorithm === 'ed25519') valid = verifyEd25519Signature({ publicKey: principal.public_key_pem, canonical, signature });
  if (!valid) {
    const error = new Error('Invalid request signature.');
    error.status = 401;
    throw error;
  }
  const replayKey = nonceKey(principalId, nonce);
  if (await getJSON(store, replayKey)) {
    const error = new Error('Nonce already used.');
    error.status = 409;
    throw error;
  }
  await store.setJSON(replayKey, { principal: principalId, timestamp, used_at: new Date(now).toISOString() });
  return { principal, principalId, timestamp, nonce, signature, algorithm: principal.algorithm, now };
}

async function resolveSession(store, env, requested) {
  if (requested) return normalizeSession(requested);
  const configured = clean(envValue(env, 'REMOTE_PUBLIC_SESSION'));
  if (configured) return configured;
  const current = await getJSON(store, 'remote/current.json');
  if (current?.session) return normalizeSession(current.session);
  return clean(envValue(env, 'REMOTE_DEFAULT_SESSION') || 'Pokitomas/theawesomehexapp:main');
}

async function readState(store, session) {
  return pruneExpiredClaims((await getJSON(store, stateKey(session))) || defaultState(session));
}

async function writeState(store, state, principalId, now) {
  const next = {
    ...pruneExpiredClaims(state, now),
    updated_at: new Date(now).toISOString(),
    updated_by: principalId
  };
  await store.setJSON(stateKey(next.session), next);
  await store.setJSON('remote/current.json', { session: next.session, generation: next.generation, updated_at: next.updated_at });
  return next;
}

async function readMessages(store, session, generation, { after = '', limit = 30, publicOnly = false } = {}) {
  const prefix = `remote/${sessionDigest(session)}/messages/g${generation}/`;
  const keys = await listBlobKeys(store, prefix);
  const filtered = keys.filter(key => !after || key > after);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(limit) || 30));
  const selected = filtered.slice(0, pageSize);
  const messages = [];
  for (const key of selected) {
    const message = await getJSON(store, key);
    if (!message) continue;
    if (message.expires_at && Date.parse(message.expires_at) <= Date.now()) continue;
    if (publicOnly && message.visibility !== 'public') continue;
    messages.push(message);
  }
  return {
    messages,
    next_cursor: selected.length ? selected[selected.length - 1] : after || null,
    has_more: filtered.length > selected.length
  };
}

function claimScope(control) {
  const scope = clean(control.scope).slice(0, 220);
  if (!scope) {
    const error = new Error('Claim scope required.');
    error.status = 400;
    throw error;
  }
  return scope;
}

async function applyControl({ store, state, message, control, auth, now }) {
  const publicSummary = message.visibility === 'public'
    ? clean(message.payload?.summary || message.payload?.action || message.payload?.status).slice(0, 320)
    : '';
  if (!control || typeof control !== 'object') return publicSummary ? { ...state, summary: publicSummary } : state;
  const op = clean(control.op);
  if (!op) return publicSummary ? { ...state, summary: publicSummary } : state;
  requireCapability(auth.principal, controlCapability(control));
  let next = pruneExpiredClaims(state, now);
  if (next.terminal && op !== 'new-generation') {
    const error = new Error('Session generation is terminal. Start a new generation.');
    error.status = 409;
    throw error;
  }

  if (op === 'claim') {
    const scope = claimScope(control);
    const current = next.claims?.[scope];
    if (current && current.holder !== auth.principalId) {
      const error = new Error(`Scope already claimed by ${current.holder}.`);
      error.status = 409;
      throw error;
    }
    const ttl = Math.max(30, Math.min(3600, Number(control.ttl_seconds) || 1200));
    next = { ...next, claims: { ...next.claims, [scope]: { holder: auth.principalId, issued_at: new Date(now).toISOString(), expires_at: new Date(now + ttl * 1000).toISOString() } } };
  } else if (op === 'release') {
    const scope = claimScope(control);
    const claim = next.claims?.[scope];
    if (claim && claim.holder !== auth.principalId && !hasCapability(auth.principal, 'admin')) {
      const error = new Error('Only the claim holder or an admin can release this scope.');
      error.status = 403;
      throw error;
    }
    const claims = { ...next.claims };
    delete claims[scope];
    next = { ...next, claims };
  } else if (op === 'invalidate-claim') {
    const scope = claimScope(control);
    const claims = { ...next.claims };
    delete claims[scope];
    next = { ...next, claims };
  } else if (op === 'pause' || op === 'stop') {
    next = { ...next, decision: op };
  } else if (op === 'resume') {
    next = { ...next, decision: 'proceed' };
  } else if (op === 'supersede') {
    next = { ...next, decision: 'superseded' };
  } else if (op === 'set-head') {
    const head = clean(control.head_sha || message.head_sha).slice(0, 80);
    if (!head) {
      const error = new Error('Exact head SHA required.');
      error.status = 400;
      throw error;
    }
    next = { ...next, head_sha: head };
  } else if (op === 'block') {
    const id = clean(control.id || message.id).slice(0, 160);
    next = { ...next, blockers: { ...next.blockers, [id]: { issuer: auth.principalId, summary: clean(control.summary || message.payload?.summary || message.payload?.action).slice(0, 320), issued_at: message.issued_at } } };
  } else if (op === 'unblock') {
    const id = clean(control.id).slice(0, 160);
    const blockers = { ...next.blockers };
    delete blockers[id];
    next = { ...next, blockers };
  } else if (op === 'grant') {
    const record = control.principal || {};
    const id = clean(record.id).slice(0, 160);
    if (!id || !clean(record.public_key_pem)) {
      const error = new Error('Principal id and public key are required.');
      error.status = 400;
      throw error;
    }
    await store.setJSON(principalKey(id), {
      id,
      algorithm: 'ed25519',
      public_key_pem: clean(record.public_key_pem),
      capabilities: normalizeCapabilities(record.capabilities),
      expires_at: clean(record.expires_at) || null,
      issued_at: new Date(now).toISOString(),
      issued_by: auth.principalId,
      revoked_at: null
    });
  } else if (op === 'revoke') {
    const id = clean(control.principal_id).slice(0, 160);
    const record = await getJSON(store, principalKey(id));
    if (!record) {
      const error = new Error('Principal not found.');
      error.status = 404;
      throw error;
    }
    await store.setJSON(principalKey(id), { ...record, revoked_at: new Date(now).toISOString(), revoked_by: auth.principalId });
  } else if (op === 'propose-terminal') {
    const checked = validateTerminalEvidence({ evidence: control.evidence, state: next, proposedHead: message.head_sha });
    if (!checked.ok) {
      const error = new Error('Terminal evidence rejected.');
      error.status = 409;
      error.detail = checked.errors;
      throw error;
    }
    next = { ...next, proposal: { evidence: checked.normalized, proposed_by: auth.principalId, proposed_at: new Date(now).toISOString(), message_id: message.id } };
  } else if (op === 'terminalize') {
    if (!next.proposal) {
      const error = new Error('No valid terminal proposal exists.');
      error.status = 409;
      throw error;
    }
    const checked = validateTerminalEvidence({ evidence: next.proposal.evidence, state: next, proposedHead: next.proposal.evidence.head_sha });
    if (!checked.ok) {
      const error = new Error('Terminal predicates no longer pass.');
      error.status = 409;
      error.detail = checked.errors;
      throw error;
    }
    const key = terminalKey(next.session, next.generation);
    if (await getJSON(store, key)) {
      const error = new Error('Terminal receipt already exists.');
      error.status = 409;
      throw error;
    }
    const receipt = terminalReceipt({ session: next.session, generation: next.generation, evidence: checked.normalized, principalId: auth.principalId, terminatedAt: new Date(now).toISOString() });
    await store.setJSON(key, receipt);
    next = { ...next, terminal: true, terminal_receipt: receipt, decision: 'terminal' };
  } else if (op === 'new-generation') {
    if (!next.terminal) {
      const error = new Error('A new generation is only valid after terminalization.');
      error.status = 409;
      throw error;
    }
    next = defaultState(next.session, next.generation + 1);
  }

  if (message.visibility === 'public') {
    next = { ...next, summary: clean(message.payload?.summary || message.payload?.action || message.payload?.status || next.summary).slice(0, 320) || next.summary };
  }
  return next;
}

export function createRemoteHandler({ store, env = process.env, now = () => Date.now() }) {
  if (!store) throw new Error('A Netlify Blob store is required.');
  return async request => {
    if (request.method === 'OPTIONS') return reply(204);
    try {
      const url = new URL(request.url);
      const publicRead = url.searchParams.get('public') === '1';
      const mode = url.searchParams.get('mode') || (url.pathname.endsWith('/state') ? 'state' : 'messages');
      const session = await resolveSession(store, env, url.searchParams.get('session'));

      if (request.method === 'GET') {
        if (!publicRead) {
          const auth = await authenticate(request, '', store, env, now());
          requireCapability(auth.principal, 'read');
        }
        const state = await readState(store, session);
        const page = await readMessages(store, session, state.generation, {
          after: clean(url.searchParams.get('after')),
          limit: Number(url.searchParams.get('limit')) || (mode === 'state' ? 20 : 50),
          publicOnly: publicRead
        });
        if (mode === 'state') {
          return reply(200, {
            state: publicRead ? publicStateProjection(state, page.messages) : state,
            next_cursor: page.next_cursor,
            has_more: page.has_more
          });
        }
        return reply(200, {
          session,
          generation: state.generation,
          messages: publicRead ? page.messages.map(message => ({ ...message, signature: undefined, nonce: undefined })) : page.messages,
          next_cursor: page.next_cursor,
          has_more: page.has_more
        });
      }

      if (request.method !== 'POST') return fail(405, 'Method not allowed.');
      const bodyText = await request.text().catch(() => '');
      if (Buffer.byteLength(bodyText) > MAX_BODY_BYTES) return fail(413, 'Remote request is too large.');
      const auth = await authenticate(request, bodyText, store, env, now());
      let body;
      try { body = JSON.parse(bodyText); }
      catch { return fail(400, 'Invalid JSON.'); }
      const input = body.message || body;
      const message = normalizeMessage(input, auth);
      if (message.session !== session && url.searchParams.get('session')) return fail(409, 'Message session does not match request session.');
      let state = await readState(store, message.session);
      if (message.generation !== state.generation) return fail(409, 'Message targets an invalid session generation.', { expected: state.generation, received: message.generation });
      if (state.terminal && clean(body.control?.op) !== 'new-generation') return fail(409, 'Session generation is terminal.');
      requireCapability(auth.principal, 'write');
      const idKey = messageIdKey(message.session, message.generation, message.id);
      if (await getJSON(store, idKey)) return fail(409, 'Message id already exists.');
      const control = body.control && typeof body.control === 'object' ? body.control : null;
      const nextState = await applyControl({ store, state, message, control, auth, now: auth.now });
      const key = messageKey(message.session, message.generation, message.issued_at, message.id);
      await store.setJSON(key, message);
      await store.setJSON(idKey, { key, id: message.id, issued_at: message.issued_at });
      if (lassoEnabled(env)) {
        try {
          const page = await readMessages(store, message.session, message.generation, {
            limit: MAX_PAGE_SIZE,
            publicOnly: false
          });
          await lassoRemoteArrival({
            store,
            message,
            state: nextState,
            existingMessages: [...page.messages, message],
            now: auth.now
          });
        } catch {
          // Collaboration grouping must never block the authenticated write it accompanies.
        }
      }
      state = await writeState(store, nextState, auth.principalId, auth.now);
      return reply(200, { stored: key, message, state: publicStateProjection(state, message.visibility === 'public' ? [message] : []) });
    } catch (error) {
      return fail(error.status || 500, error.message || 'Remote request failed.', error.detail);
    }
  };
}
