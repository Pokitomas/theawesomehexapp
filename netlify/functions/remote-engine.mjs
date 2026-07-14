import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const CAPABILITIES = Object.freeze([
  'read', 'write', 'claim', 'release', 'pause', 'resume', 'terminate', 'admin',
  'repo:read', 'repo:write', 'ci:read', 'ci:run', 'deploy:read', 'deploy:write'
]);

const CAPABILITY_SET = new Set(CAPABILITIES);
const ROOT_CAPABILITIES = new Set(CAPABILITIES);
const DEFAULT_SKEW_MS = 5 * 60 * 1000;
const MAX_PAGE_SIZE = 100;
const MAX_CLAIM_MS = 60 * 60 * 1000;
const PUBLIC_MESSAGE_LIMIT = 30;

const jsonHeaders = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
});

function reply(status, body = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: jsonHeaders });
}

function clean(value, max = 240) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function opaque(value, max = 160) {
  const text = clean(value, max);
  if (!text || !/^[A-Za-z0-9._:/@+-]+$/.test(text)) return '';
  return text;
}

function keyPart(value) {
  return encodeURIComponent(value).replace(/%/g, '~');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function constantEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function canonicalSignatureInput(method, path, timestamp, nonce, bodyText) {
  return [method.toUpperCase(), path, timestamp, nonce, sha256(bodyText)].join('\n');
}

export function signRemoteRequest({ method = 'POST', path = '/api/remote', timestamp, nonce, bodyText = '', secret }) {
  return createHmac('sha256', secret)
    .update(canonicalSignatureInput(method, path, timestamp, nonce, bodyText))
    .digest('hex');
}

function principalEnvToken(principal) {
  return principal.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function sessionPrefix(session) {
  return `remote/${keyPart(session)}`;
}

function generationPrefix(session, generation) {
  return `${sessionPrefix(session)}/generation-${generation}`;
}

function stateKey(session, generation) {
  return `${generationPrefix(session, generation)}/state.json`;
}

function principalKey(session, principal) {
  return `${sessionPrefix(session)}/principals/${keyPart(principal)}.json`;
}

function currentKey(session) {
  return `${sessionPrefix(session)}/current.json`;
}

function terminalKey(session, generation) {
  return `${generationPrefix(session, generation)}/terminal.json`;
}

function messagePrefix(session, generation) {
  return `${generationPrefix(session, generation)}/messages/`;
}

function proposalPrefix(session, generation) {
  return `${generationPrefix(session, generation)}/proposals/`;
}

function claimKey(session, generation, scope) {
  return `${generationPrefix(session, generation)}/claims/${sha256(scope)}.json`;
}

function nonceKey(principal, nonce) {
  return `remote/nonces/${keyPart(principal)}/${sha256(nonce)}.json`;
}

function messageIdKey(session, generation, id) {
  return `${generationPrefix(session, generation)}/message-ids/${sha256(id)}.json`;
}

function orderedId(issuedAt, id) {
  const stamp = new Date(issuedAt).toISOString().replace(/[-:.TZ]/g, '').padEnd(17, '0');
  return `${stamp}-${keyPart(id)}`;
}

async function readJSON(store, key) {
  try {
    return await store.get(key, { type: 'json' });
  } catch {
    return null;
  }
}

async function listBlobs(store, prefix) {
  const candidate = store.list({ prefix, paginate: true });
  const resolved = await candidate;
  const pages = resolved && typeof resolved[Symbol.asyncIterator] === 'function' ? resolved : candidate;
  if (pages && typeof pages[Symbol.asyncIterator] === 'function') {
    const blobs = [];
    for await (const page of pages) blobs.push(...(page?.blobs || []));
    return blobs;
  }
  return resolved?.blobs || [];
}

function defaultState(session, generation, nowISO) {
  return {
    session,
    generation,
    decision: 'proceed',
    head_sha: null,
    blocking: false,
    blocker_count: 0,
    claims: {},
    terminal: false,
    terminal_proposal: null,
    updated_at: nowISO
  };
}

function sanitizeCapabilities(values) {
  const source = Array.isArray(values) ? values : String(values || '').split(',');
  return [...new Set(source.map(value => clean(value, 80)).filter(value => CAPABILITY_SET.has(value)))];
}

function isExpired(value, nowMs) {
  if (!value) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= nowMs;
}

function pruneClaims(state, nowMs) {
  const claims = {};
  for (const [scope, claim] of Object.entries(state.claims || {})) {
    if (!claim || isExpired(claim.expires_at, nowMs)) continue;
    claims[scope] = claim;
  }
  return { ...state, claims };
}

function publicMessage(message) {
  return {
    id: message.id,
    session: message.session,
    generation: message.generation,
    issuer: message.issuer,
    parent: message.parent || null,
    issued_at: message.issued_at,
    expires_at: message.expires_at || null,
    head_sha: message.head_sha || null,
    scope: message.scope || [],
    payload: message.payload || {},
    visibility: 'public'
  };
}

function publicState(state, terminal = null) {
  return {
    session: state.session,
    generation: state.generation,
    decision: state.decision,
    head_sha: state.head_sha,
    blocking: Boolean(state.blocking),
    blocker_count: Number(state.blocker_count || 0),
    claims: Object.values(state.claims || {}).map(claim => ({
      scope: claim.scope,
      holder: claim.holder,
      expires_at: claim.expires_at
    })),
    terminal: Boolean(state.terminal),
    terminal_receipt: terminal ? {
      session: terminal.session,
      generation: terminal.generation,
      head_sha: terminal.head_sha,
      merge_sha: terminal.merge_sha,
      evidence: terminal.evidence,
      production: terminal.production,
      terminated_at: terminal.terminated_at,
      terminated_by: terminal.terminated_by
    } : null,
    updated_at: state.updated_at
  };
}

function requiredCapability(op, body = {}) {
  if (op === 'message') return 'write';
  if (op === 'claim') return 'claim';
  if (op === 'release') return 'release';
  if (op === 'propose_terminal') return 'terminate';
  if (op === 'grant' || op === 'revoke' || op === 'open' || op === 'new_generation' || op === 'terminalize') return 'admin';
  if (op === 'state') {
    const decision = clean(body.decision, 40);
    if (decision === 'proceed') return 'resume';
    if (decision === 'pause' || decision === 'stop') return 'pause';
    return 'admin';
  }
  return 'admin';
}

async function resolvePrincipal(store, env, session, principal, keyId, nowMs) {
  const rootSecret = String(env.REMOTE_ROOT_KEY || '');
  if (keyId === 'root' && rootSecret) {
    return { principal, keyId, secret: rootSecret, capabilities: ROOT_CAPABILITIES, root: true, expires_at: null };
  }

  if (keyId !== principal) return null;
  const token = principalEnvToken(keyId);
  const secret = String(env[`REMOTE_KEY_${token}`] || '');
  if (!secret) return null;

  const record = await readJSON(store, principalKey(session, principal));
  if (record?.revoked || isExpired(record?.expires_at, nowMs)) return null;
  const envCapabilities = sanitizeCapabilities(env[`REMOTE_CAPS_${token}`] || 'read');
  const capabilities = new Set(record ? sanitizeCapabilities(record.capabilities) : envCapabilities);
  return { principal, keyId, secret, capabilities, root: false, expires_at: record?.expires_at || null };
}

async function authenticate({ request, bodyText, store, env, session, nowMs, skewMs }) {
  const principal = opaque(request.headers.get('x-remote-principal'));
  const keyId = opaque(request.headers.get('x-remote-key-id') || principal, 160);
  const timestamp = clean(request.headers.get('x-remote-timestamp'), 80);
  const nonce = opaque(request.headers.get('x-remote-nonce'));
  const signature = clean(request.headers.get('x-remote-signature'), 256).toLowerCase();
  if (!principal || !keyId || !timestamp || !nonce || !signature) return { error: reply(401, { error: 'missing authentication headers' }) };

  const issuedMs = Date.parse(timestamp);
  if (!Number.isFinite(issuedMs) || Math.abs(nowMs - issuedMs) > skewMs) {
    return { error: reply(401, { error: 'stale request timestamp' }) };
  }

  const resolved = await resolvePrincipal(store, env, session, principal, keyId, nowMs);
  if (!resolved) return { error: reply(401, { error: 'unknown or expired principal' }) };

  const url = new URL(request.url);
  const expected = signRemoteRequest({
    method: request.method,
    path: url.pathname,
    timestamp,
    nonce,
    bodyText,
    secret: resolved.secret
  });
  if (!constantEqual(expected, signature)) return { error: reply(401, { error: 'invalid signature' }) };

  const noncePath = nonceKey(principal, nonce);
  if (await readJSON(store, noncePath)) return { error: reply(409, { error: 'nonce already used' }) };
  await store.setJSON(noncePath, { principal, used_at: new Date(nowMs).toISOString(), expires_at: new Date(nowMs + skewMs * 2).toISOString() });

  return { auth: resolved };
}

function hasCapability(auth, capability) {
  return auth.root || auth.capabilities.has(capability) || auth.capabilities.has('admin');
}

async function loadCurrent(store, session) {
  return await readJSON(store, currentKey(session));
}

async function loadState(store, session, generation, nowMs) {
  const raw = await readJSON(store, stateKey(session, generation));
  if (!raw) return null;
  const state = pruneClaims(raw, nowMs);
  if (JSON.stringify(state.claims) !== JSON.stringify(raw.claims || {})) await store.setJSON(stateKey(session, generation), state);
  return state;
}

async function requireSession(store, session, requestedGeneration, nowMs) {
  const current = await loadCurrent(store, session);
  if (!current) return { error: reply(404, { error: 'session not found' }) };
  const generation = Number(requestedGeneration || current.generation);
  if (!Number.isInteger(generation) || generation !== current.generation) {
    return { error: reply(409, { error: 'invalid session generation', current_generation: current.generation }) };
  }
  const state = await loadState(store, session, generation, nowMs);
  if (!state) return { error: reply(500, { error: 'session state missing' }) };
  return { current, state, generation };
}

async function appendMessage(store, state, principal, input, nowMs) {
  const id = opaque(input.id || randomUUID(), 180);
  if (!id) return { error: reply(400, { error: 'valid globally unique message id required' }) };
  const issuedAt = clean(input.issued_at || new Date(nowMs).toISOString(), 80);
  const issuedMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMs) || issuedMs > nowMs + DEFAULT_SKEW_MS) return { error: reply(400, { error: 'invalid message issued_at' }) };
  const expiresAt = input.expires_at ? clean(input.expires_at, 80) : null;
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) return { error: reply(400, { error: 'invalid message expires_at' }) };
  const issuer = opaque(input.issuer || principal, 160);
  if (issuer !== principal) return { error: reply(403, { error: 'issuer must match authenticated principal' }) };
  const session = opaque(input.session || state.session, 160);
  if (session !== state.session) return { error: reply(409, { error: 'message session mismatch' }) };
  const generation = Number(input.generation || state.generation);
  if (generation !== state.generation) return { error: reply(409, { error: 'message generation mismatch' }) };
  const parent = input.parent ? opaque(input.parent, 180) : null;
  const headSha = input.head_sha ? clean(input.head_sha, 80) : null;
  const scope = Array.isArray(input.scope) ? input.scope.map(value => opaque(value, 180)).filter(Boolean).slice(0, 32) : [];
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
  const visibility = input.visibility === 'public' ? 'public' : 'private';

  const idIndex = messageIdKey(session, generation, id);
  if (await readJSON(store, idIndex)) return { error: reply(409, { error: 'message id already exists' }) };

  const message = { id, session, generation, issuer, parent, issued_at: issuedAt, expires_at: expiresAt, head_sha: headSha, scope, payload, visibility };
  const ordered = orderedId(issuedAt, id);
  const key = `${messagePrefix(session, generation)}${ordered}.json`;
  await store.setJSON(key, message);
  await store.setJSON(idIndex, { id, key, issued_at: issuedAt });
  return { message, cursor: ordered };
}

async function listMessages(store, state, { after = '', limit = 50, publicOnly = false, nowMs }) {
  const prefix = messagePrefix(state.session, state.generation);
  const blobs = (await listBlobs(store, prefix)).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const safeLimit = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(limit) || 50));
  const messages = [];
  let nextCursor = after || '';
  let scanned = 0;
  let more = false;

  for (const blob of blobs) {
    const cursor = String(blob.key).slice(prefix.length).replace(/\.json$/, '');
    if (after && cursor <= after) continue;
    const message = await readJSON(store, blob.key);
    nextCursor = cursor;
    scanned += 1;
    if (!message || isExpired(message.expires_at, nowMs) || (publicOnly && message.visibility !== 'public')) continue;
    messages.push(publicOnly ? publicMessage(message) : message);
    if (messages.length >= safeLimit) {
      more = blobs.some(candidate => String(candidate.key).slice(prefix.length).replace(/\.json$/, '') > cursor);
      break;
    }
  }

  return { messages, next_cursor: nextCursor, more, scanned };
}

function validateTerminalEvidence(proposal, state) {
  const errors = [];
  const headSha = clean(proposal.head_sha, 80);
  if (!/^[a-f0-9]{40}$/i.test(headSha)) errors.push('exact head_sha required');
  if (state.head_sha && headSha !== state.head_sha) errors.push('proposed head is stale');

  const checks = Array.isArray(proposal.checks) ? proposal.checks : [];
  if (!checks.length || checks.some(check => check?.conclusion !== 'success' || (check.head_sha && check.head_sha !== headSha))) {
    errors.push('all required checks must be successful on the exact head');
  }

  const artifacts = Array.isArray(proposal.artifacts) ? proposal.artifacts : [];
  if (!artifacts.length || artifacts.some(item => !clean(item?.id || item?.digest, 240))) errors.push('artifact identifiers or digests required');
  if (Number(proposal.remaining_test_records) !== 0) errors.push('temporary test records remain');
  if (Number(proposal.active_blockers) !== 0 || state.blocking || Number(state.blocker_count || 0) !== 0) errors.push('live blockers remain');
  if (Object.keys(state.claims || {}).length) errors.push('active mutation claim remains');

  const merge = proposal.merge || {};
  if (merge.state !== 'merged' || !/^[a-f0-9]{40}$/i.test(clean(merge.merge_sha, 80))) errors.push('consistent merged state required');

  const production = proposal.production || {};
  if (!['deployed', 'unverified'].includes(production.state)) errors.push('production state must be deployed or unverified');
  if (production.state === 'deployed' && !String(production.receipt || '').includes(merge.merge_sha || '')) {
    errors.push('deployment receipt must name the merge commit');
  }

  return { errors, headSha, checks, artifacts, merge, production };
}

async function publicProjection(store, session, generation, nowMs) {
  const state = await loadState(store, session, generation, nowMs);
  if (!state) return null;
  const terminal = state.terminal ? await readJSON(store, terminalKey(session, generation)) : null;
  const prefix = messagePrefix(session, generation);
  const blobs = (await listBlobs(store, prefix)).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const messages = [];
  for (const blob of blobs.slice(-Math.max(PUBLIC_MESSAGE_LIMIT * 4, PUBLIC_MESSAGE_LIMIT))) {
    const message = await readJSON(store, blob.key);
    if (!message || message.visibility !== 'public' || isExpired(message.expires_at, nowMs)) continue;
    messages.push(publicMessage(message));
  }
  return {
    state: publicState(state, terminal),
    messages: messages.slice(-PUBLIC_MESSAGE_LIMIT),
    next_cursor: blobs.length ? String(blobs.at(-1).key).slice(prefix.length).replace(/\.json$/, '') : ''
  };
}

export {
  DEFAULT_SKEW_MS, MAX_CLAIM_MS, appendMessage, authenticate, claimKey, clean, currentKey, defaultState,
  hasCapability, keyPart, listMessages, loadCurrent, loadState, opaque, principalKey,
  proposalPrefix, pruneClaims, publicProjection, readJSON, reply, requireSession,
  requiredCapability, sanitizeCapabilities, stateKey, terminalKey, validateTerminalEvidence
};
