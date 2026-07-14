const SESSION_KEY = 'sideways-network-session-v1';
const BACKEND_TIMEOUT = 12000;
let current = null;
let refreshing = null;

function readStored() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { localStorage.removeItem(SESSION_KEY); return null; }
}

function publish() {
  window.dispatchEvent(new CustomEvent('sideways:networksession', { detail: structuredClone(current) }));
}

export function session() {
  if (current === null) current = readStored();
  return current ? structuredClone(current) : null;
}

export function setSession(value) {
  current = value ? structuredClone(value) : null;
  if (current) localStorage.setItem(SESSION_KEY, JSON.stringify(current));
  else localStorage.removeItem(SESSION_KEY);
  publish();
  return session();
}

export function idempotencyKey(prefix = 'cmd') {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

async function refreshSession() {
  const existing = session();
  if (!existing?.refreshToken) return null;
  refreshing ||= (async () => {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: existing.refreshToken })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSession(null);
      throw new Error(body.error || 'Session expired.');
    }
    return setSession({ ...existing, ...body.session });
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function request(path, options = {}, retry = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || BACKEND_TIMEOUT);
  const existing = session();
  const headers = { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) };
  if (existing?.accessToken) headers.authorization = `Bearer ${existing.accessToken}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  try {
    const response = await fetch(path, {
      ...options,
      body: options.body === undefined || typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
      headers,
      signal: controller.signal
    });
    if (response.status === 401 && retry && existing?.refreshToken && path !== '/api/auth/refresh') {
      await refreshSession();
      return request(path, options, false);
    }
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  } finally { clearTimeout(timer); }
}

export const Client = Object.freeze({ request, session, setSession, idempotencyKey });
