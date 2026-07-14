import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SOCIAL_VERSION = 1;
export const SESSION_COOKIE = 'sideways_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_FEED = 80;
export const COLORS = new Set(['#335cff', '#2f7d64', '#b24d6b', '#8a5b24', '#6554c0', '#24262b']);
export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
export const handleOf = value => clean(value).replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 30);
export const nowISO = now => new Date(now()).toISOString();
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const randomId = (bytes = 18) => randomBytes(bytes).toString('base64url');
export const fail = (status, message, code = '') => Object.assign(new Error(message), { status, code });

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

export function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

export function passwordMatches(password, record = {}) {
  try {
    return safeEqual(scryptSync(password, record.salt, 64).toString('hex'), record.hash);
  } catch {
    return false;
  }
}

export function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    handle: account.handle,
    name: account.name,
    bio: account.bio,
    accent: account.accent,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

export function cookieToken(request) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function sessionCookie(token, request, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function deterministicSessionToken(secret, scope, idempotencyKey) {
  if (!secret) throw new Error('SOCIAL_SESSION_SECRET is required for relational social authority.');
  if (!idempotencyKey) return randomId(32);
  return createHmac('sha256', secret).update(`${scope}\u0000${idempotencyKey}`).digest('base64url');
}

export function idempotencyKey(request) {
  return clean(request.headers.get('idempotency-key')).slice(0, 160) || null;
}

export function assertSameOriginMutation(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) throw fail(403, 'Cross-origin mutation rejected.');
  const site = request.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) throw fail(403, 'Cross-site mutation rejected.');
}

export async function jsonBody(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 64 * 1024) throw fail(413, 'Request is too large.');
  return request.json().catch(() => { throw fail(400, 'Valid JSON required.'); });
}

export function response(status, body = {}, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}
