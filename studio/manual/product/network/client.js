const JSON_HEADERS = { 'content-type': 'application/json' };

export class NetworkError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'NetworkError';
    this.status = status;
    this.payload = payload;
  }
}

export function createClient({ base = '/api', fetchImpl = fetch } = {}) {
  async function request(path, { method = 'GET', body, idempotencyKey, signal } = {}) {
    const headers = body === undefined ? {} : { ...JSON_HEADERS };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await fetchImpl(`${base}${path}`, {
      method,
      credentials: 'include',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new NetworkError(payload?.error || `Request failed (${response.status})`, response.status, payload);
    return payload;
  }

  return Object.freeze({ request });
}

export function idempotencyKey(prefix = 'cmd') {
  return `${prefix}:${crypto.randomUUID()}`;
}
