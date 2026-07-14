import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { canonicalRequest } from '../../netlify/functions/remote-core.mjs';
import { createRemoteHandler } from '../../netlify/functions/remote-service.mjs';

class MemoryStore {
  constructor() { this.map = new Map(); }
  async get(key, options = {}) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    return options.type === 'json' ? structuredClone(value) : JSON.stringify(value);
  }
  async setJSON(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = '', cursor } = {}) {
    const keys = [...this.map.keys()].filter(key => key.startsWith(prefix)).sort();
    const after = cursor ? keys.indexOf(cursor) + 1 : 0;
    const page = keys.slice(after, after + 100);
    return { blobs: page.map(key => ({ key })), cursor: null };
  }
}

const SESSION = 'Pokitomas/theawesomehexapp:test';
const NOW = Date.parse('2026-07-14T03:00:00.000Z');
const ROOT_KEY = 'root-key';
const VENDOR_KEY = 'vendor-key';

function body(id, nonce, issuer = 'vendor') {
  return {
    message: {
      id,
      session: SESSION,
      generation: 1,
      issuer,
      issued_at: new Date(NOW).toISOString(),
      head_sha: 'a'.repeat(40),
      scope: [],
      payload: { summary: id },
      visibility: 'public',
      nonce
    }
  };
}

function signed({
  bodyObject,
  nonce,
  principal = 'vendor',
  key = VENDOR_KEY,
  signedPath = '/api/remote',
  requestPath = signedPath
}) {
  const bodyText = JSON.stringify(bodyObject);
  const timestamp = new Date(NOW).toISOString();
  const canonical = canonicalRequest({ method: 'POST', path: signedPath, timestamp, nonce, bodyText });
  const signature = createHmac('sha256', key).update(canonical).digest('hex');
  return new Request(`https://sideways.test${requestPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-remote-principal': principal,
      'x-remote-timestamp': timestamp,
      'x-remote-nonce': nonce,
      'x-remote-signature': signature,
      'x-remote-path': signedPath
    },
    body: bodyText
  });
}

function handler(extraEnv = {}) {
  return createRemoteHandler({
    store: new MemoryStore(),
    env: {
      REMOTE_ROOT_ID: 'root',
      REMOTE_ROOT_KEY: ROOT_KEY,
      REMOTE_KEY_VENDOR: VENDOR_KEY,
      REMOTE_PUBLIC_SESSION: SESSION,
      ...extraEnv
    },
    now: () => NOW
  });
}

test('non-root environment principals receive no implicit capabilities', async () => {
  const denied = handler();
  assert.equal((await denied(signed({ bodyObject: body('implicit-all', 'implicit'), nonce: 'implicit' }))).status, 403);

  const allowed = handler({ REMOTE_CAPS_VENDOR: 'read,write' });
  assert.equal((await allowed(signed({ bodyObject: body('explicit-write', 'explicit'), nonce: 'explicit' }))).status, 200);

  const readOnly = handler({ REMOTE_CAPS_VENDOR: 'read' });
  assert.equal((await readOnly(signed({ bodyObject: body('read-only', 'read-only'), nonce: 'read-only' }))).status, 403);
});

test('signed target must equal the actual request or the documented Netlify rewrite', async () => {
  const service = handler({ REMOTE_CAPS_VENDOR: 'read,write' });
  const mismatch = signed({
    bodyObject: body('mismatch', 'mismatch'),
    nonce: 'mismatch',
    signedPath: '/api/remote',
    requestPath: '/api/remote?mode=state'
  });
  assert.equal((await service(mismatch)).status, 401);

  const rewritten = signed({
    bodyObject: body('rewrite', 'rewrite'),
    nonce: 'rewrite',
    signedPath: '/api/remote',
    requestPath: '/.netlify/functions/remote'
  });
  assert.equal((await service(rewritten)).status, 200);
});

test('process-local serialization closes concurrent nonce and message-id races', async () => {
  const sameNonceService = handler({ REMOTE_CAPS_VENDOR: 'read,write' });
  const nonce = 'concurrent-nonce';
  const sameNonceResults = await Promise.all([
    sameNonceService(signed({ bodyObject: body('nonce-a', nonce), nonce })),
    sameNonceService(signed({ bodyObject: body('nonce-a', nonce), nonce }))
  ]);
  assert.deepEqual(sameNonceResults.map(result => result.status).sort(), [200, 409]);

  const sameIdService = handler({ REMOTE_CAPS_VENDOR: 'read,write' });
  const sameIdResults = await Promise.all([
    sameIdService(signed({ bodyObject: body('shared-id', 'nonce-a'), nonce: 'nonce-a' })),
    sameIdService(signed({ bodyObject: body('shared-id', 'nonce-b'), nonce: 'nonce-b' }))
  ]);
  assert.deepEqual(sameIdResults.map(result => result.status).sort(), [200, 409]);
});
