import { createHash, createHmac, timingSafeEqual, verify as verifySignatureBytes } from 'node:crypto';

export const REMOTE_VERSION = 1;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_PAGE_SIZE = 100;
export const CAPABILITIES = Object.freeze([
  'read', 'write', 'claim', 'release', 'pause', 'resume', 'terminate', 'admin',
  'repo:read', 'repo:write', 'ci:read', 'ci:run', 'deploy:read', 'deploy:write'
]);
export const DECISIONS = Object.freeze(['proceed', 'pause', 'stop', 'superseded', 'terminal']);

export const isoNow = () => new Date().toISOString();
export const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
export const sha256Hex = value => createHash('sha256').update(value).digest('hex');
export const sha256Base64 = value => createHash('sha256').update(value).digest('base64');
export const sessionDigest = session => sha256Hex(clean(session)).slice(0, 32);
export const principalDigest = principal => sha256Hex(clean(principal)).slice(0, 32);
export const nonceDigest = nonce => sha256Hex(clean(nonce));

export function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

export function canonicalRequest({ method, path, timestamp, nonce, bodyText = '' }) {
  return [
    String(method || 'GET').toUpperCase(),
    String(path || '/'),
    String(timestamp || ''),
    String(nonce || ''),
    sha256Hex(bodyText)
  ].join('\n');
}

export function verifyHmacSignature({ secret, canonical, signature }) {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(canonical).digest('hex');
  return safeEqual(expected, String(signature).toLowerCase());
}

export function verifyEd25519Signature({ publicKey, canonical, signature }) {
  if (!publicKey || !signature) return false;
  try {
    return verifySignatureBytes(null, Buffer.from(canonical), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function timestampIsFresh(value, now = Date.now(), skew = MAX_CLOCK_SKEW_MS) {
  const time = Date.parse(value);
  return Number.isFinite(time) && Math.abs(now - time) <= skew;
}

export function normalizeCapabilities(values = []) {
  const allowed = new Set(CAPABILITIES);
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(value => allowed.has(value)))];
}

export function hasCapability(principal, capability) {
  const capabilities = new Set(principal?.capabilities || []);
  return capabilities.has('admin') || capabilities.has(capability);
}

export function requireCapability(principal, capability) {
  if (!hasCapability(principal, capability)) {
    const error = new Error(`Missing capability: ${capability}`);
    error.status = 403;
    throw error;
  }
}

export function normalizeSession(value) {
  const session = clean(value).slice(0, 220);
  if (!session) {
    const error = new Error('Session required.');
    error.status = 400;
    throw error;
  }
  return session;
}

export function normalizeMessage(input = {}, auth = {}) {
  const issuedAt = clean(input.issued_at || auth.timestamp);
  const message = {
    id: clean(input.id).slice(0, 160),
    session: normalizeSession(input.session),
    generation: Math.max(1, Number(input.generation || 1) || 1),
    issuer: clean(input.issuer || auth.principalId).slice(0, 160),
    parent: clean(input.parent).slice(0, 160) || null,
    issued_at: issuedAt,
    expires_at: clean(input.expires_at).slice(0, 64) || null,
    head_sha: clean(input.head_sha).slice(0, 80) || null,
    scope: (Array.isArray(input.scope) ? input.scope : []).map(clean).filter(Boolean).slice(0, 32),
    payload: input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {},
    visibility: input.visibility === 'public' ? 'public' : 'private',
    nonce: clean(input.nonce || auth.nonce).slice(0, 220),
    signature: clean(auth.signature).slice(0, 1024),
    signature_algorithm: clean(auth.algorithm).slice(0, 40),
    protocol_version: REMOTE_VERSION
  };
  if (!message.id) {
    const error = new Error('Message id required.');
    error.status = 400;
    throw error;
  }
  if (!message.issuer || message.issuer !== auth.principalId) {
    const error = new Error('Issuer must match the authenticated principal.');
    error.status = 403;
    throw error;
  }
  if (!message.nonce || message.nonce !== auth.nonce) {
    const error = new Error('Message nonce must match the signed request nonce.');
    error.status = 400;
    throw error;
  }
  if (!timestampIsFresh(message.issued_at, auth.now)) {
    const error = new Error('Message timestamp is stale.');
    error.status = 401;
    throw error;
  }
  if (message.expires_at && !Number.isFinite(Date.parse(message.expires_at))) {
    const error = new Error('Invalid expiration timestamp.');
    error.status = 400;
    throw error;
  }
  return message;
}

export function messageKey(session, generation, issuedAt, id) {
  const stamp = new Date(issuedAt).toISOString().replace(/[-:.TZ]/g, '');
  return `remote/${sessionDigest(session)}/messages/g${generation}/${stamp}-${sha256Hex(id).slice(0, 20)}.json`;
}

export function messageIdKey(session, generation, id) {
  return `remote/${sessionDigest(session)}/ids/g${generation}/${sha256Hex(id)}.json`;
}

export function stateKey(session) {
  return `remote/${sessionDigest(session)}/state.json`;
}

export function terminalKey(session, generation) {
  return `remote/${sessionDigest(session)}/terminal/g${generation}.json`;
}

export function principalKey(principalId) {
  return `remote/principals/${principalDigest(principalId)}.json`;
}

export function nonceKey(principalId, nonce) {
  return `remote/nonces/${principalDigest(principalId)}/${nonceDigest(nonce)}.json`;
}

export function defaultState(session, generation = 1) {
  return {
    protocol_version: REMOTE_VERSION,
    session,
    generation,
    decision: 'proceed',
    head_sha: null,
    claims: {},
    blockers: {},
    proposal: null,
    terminal: false,
    terminal_receipt: null,
    summary: 'No public work has been reported yet.',
    updated_at: null,
    updated_by: null
  };
}

export function pruneExpiredClaims(state, now = Date.now()) {
  const claims = {};
  for (const [scope, claim] of Object.entries(state?.claims || {})) {
    const expiry = Date.parse(claim?.expires_at || '');
    if (Number.isFinite(expiry) && expiry > now) claims[scope] = claim;
  }
  return { ...state, claims };
}

export function activeBlockerCount(state) {
  return Object.keys(state?.blockers || {}).length;
}

export function publicMessageProjection(message) {
  const payload = message?.payload || {};
  const summary = clean(payload.summary || payload.action || payload.status || payload.note || 'Private work event').slice(0, 320);
  const projection = {
    id: message.id,
    session: message.session,
    generation: message.generation,
    issuer: message.issuer,
    parent: message.parent,
    issued_at: message.issued_at,
    expires_at: message.expires_at,
    head_sha: message.head_sha,
    scope: message.scope,
    visibility: message.visibility,
    summary,
    evidence: payload.evidence && typeof payload.evidence === 'object' ? {
      checks: Array.isArray(payload.evidence.checks) ? payload.evidence.checks.length : 0,
      artifacts: Array.isArray(payload.evidence.artifacts) ? payload.evidence.artifacts.length : 0,
      remaining_test_records: Number(payload.evidence.remaining_test_records ?? payload.evidence.temporary_test_records ?? 0),
      active_blockers: Number(payload.evidence.active_blockers ?? 0)
    } : null
  };
  if (message.visibility === 'public') projection.payload = payload;
  return projection;
}

export function publicStateProjection(state, messages = []) {
  const cleanState = pruneExpiredClaims(state);
  return {
    protocol_version: REMOTE_VERSION,
    session: cleanState.session,
    generation: cleanState.generation,
    decision: cleanState.terminal ? 'terminal' : cleanState.decision,
    head_sha: cleanState.head_sha,
    claims: Object.entries(cleanState.claims || {}).map(([scope, claim]) => ({
      scope,
      holder: claim.holder,
      expires_at: claim.expires_at
    })),
    blocker_count: activeBlockerCount(cleanState),
    terminal: Boolean(cleanState.terminal),
    terminal_receipt: cleanState.terminal_receipt ? {
      head_sha: cleanState.terminal_receipt.head_sha,
      merge_sha: cleanState.terminal_receipt.merge_sha,
      production: cleanState.terminal_receipt.production,
      terminated_at: cleanState.terminal_receipt.terminated_at,
      terminated_by: cleanState.terminal_receipt.terminated_by
    } : null,
    summary: cleanState.summary,
    updated_at: cleanState.updated_at,
    updated_by: cleanState.updated_by,
    messages: messages.map(publicMessageProjection)
  };
}

function checkResultSuccess(check) {
  return clean(check?.conclusion || check?.status).toLowerCase() === 'success';
}

export function validateTerminalEvidence({ evidence = {}, state, proposedHead }) {
  const errors = [];
  const headSha = clean(evidence.head_sha || proposedHead);
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  const artifacts = Array.isArray(evidence.artifacts) ? evidence.artifacts : [];
  const remaining = Number(evidence.remaining_test_records ?? evidence.temporary_test_records ?? NaN);
  const blockerCount = Number(evidence.active_blockers ?? activeBlockerCount(state));
  const merge = evidence.merge && typeof evidence.merge === 'object' ? evidence.merge : {};
  const production = evidence.production && typeof evidence.production === 'object' ? evidence.production : {};
  const current = pruneExpiredClaims(state);

  if (!headSha) errors.push('Exact tested head is required.');
  if (current.head_sha && headSha && current.head_sha !== headSha) errors.push('Proposed head is stale.');
  if (!checks.length || checks.some(check => !checkResultSuccess(check))) errors.push('All required checks must be successful.');
  if (!artifacts.length || artifacts.some(item => !clean(item?.id || item?.digest || item?.name))) errors.push('Artifact identifiers or digests are required.');
  if (!Number.isFinite(remaining) || remaining !== 0) errors.push('Temporary test records must be zero.');
  if (!Number.isFinite(blockerCount) || blockerCount !== 0 || activeBlockerCount(current) !== 0) errors.push('Active blockers remain.');
  if (Object.keys(current.claims || {}).length) errors.push('Active mutation claims remain.');
  if (clean(merge.state).toLowerCase() !== 'merged' || !clean(merge.sha)) errors.push('Merge state must be merged with a merge SHA.');
  const productionState = clean(production.state).toLowerCase();
  if (!['deployed', 'unverified'].includes(productionState)) errors.push('Production state must be deployed or unverified.');
  if (productionState === 'deployed' && !clean(production.receipt)) errors.push('A deployed production state requires a receipt.');

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      head_sha: headSha,
      checks,
      artifacts,
      remaining_test_records: remaining,
      active_blockers: blockerCount,
      merge: { state: clean(merge.state).toLowerCase(), sha: clean(merge.sha) },
      production: { state: productionState, receipt: production.receipt ?? null }
    }
  };
}

export function terminalReceipt({ session, generation, evidence, principalId, terminatedAt = isoNow() }) {
  return {
    protocol_version: REMOTE_VERSION,
    session,
    generation,
    head_sha: evidence.head_sha,
    merge_sha: evidence.merge.sha,
    evidence,
    production: evidence.production,
    terminated_at: terminatedAt,
    terminated_by: principalId
  };
}

export function controlCapability(control = {}) {
  switch (clean(control.op)) {
    case 'claim': return 'claim';
    case 'release': return 'release';
    case 'pause': case 'stop': return 'pause';
    case 'resume': return 'resume';
    case 'propose-terminal': return 'terminate';
    case 'terminalize': case 'new-generation': case 'grant': case 'revoke': case 'invalidate-claim': return 'admin';
    case 'set-head': return 'repo:write';
    case 'block': case 'unblock': return 'write';
    default: return 'write';
  }
}
