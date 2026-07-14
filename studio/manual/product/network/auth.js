import { idempotencyKey, request, session, setSession } from './client.js';

let identity = session()?.user || null;

function update(result) {
  const next = result?.session ? { ...result.session, user: result.user || identity, email: result.email || '' } : null;
  identity = result?.user || next?.user || null;
  if (next) setSession(next);
  window.dispatchEvent(new CustomEvent('sideways:networkidentity', { detail: identity ? structuredClone(identity) : null }));
  return result;
}

export async function signup(input) { return update(await request('/api/auth/signup', { method: 'POST', body: input, idempotencyKey: idempotencyKey('signup') }, false)); }
export async function login(input) { return update(await request('/api/auth/login', { method: 'POST', body: input }, false)); }
export async function logout() {
  try { await request('/api/auth/logout', { method: 'POST' }, false); } catch {}
  identity = null;
  setSession(null);
  window.dispatchEvent(new CustomEvent('sideways:networkidentity', { detail: null }));
}
export async function me() {
  const result = await request('/api/me');
  identity = result.user;
  const existing = session();
  if (existing) setSession({ ...existing, user: identity, email: result.email || existing.email || '' });
  return result;
}
export async function updateProfile(patch) {
  const result = await request('/api/me/profile', { method: 'PATCH', body: patch, idempotencyKey: idempotencyKey('profile') });
  identity = result.user;
  const existing = session();
  if (existing) setSession({ ...existing, user: identity });
  window.dispatchEvent(new CustomEvent('sideways:networkidentity', { detail: structuredClone(identity) }));
  return result;
}
export async function user(handle) { return request(`/api/users/${encodeURIComponent(String(handle).replace(/^@/, ''))}`); }
export function currentIdentity() { return identity ? structuredClone(identity) : session()?.user || null; }
export function signedIn() { return Boolean(session()?.accessToken); }

export const Auth = Object.freeze({ signup, login, logout, me, updateProfile, user, currentIdentity, signedIn });
