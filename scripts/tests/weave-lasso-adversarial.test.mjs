import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  canonicalRequest,
  messageKey
} from '../../netlify/functions/remote-core.mjs';
import { createRemoteHandler } from '../../netlify/functions/remote-service.mjs';
import {
  LASSO_SYSTEM_PRINCIPAL,
  lassoRemoteArrival
} from '../../netlify/functions/weave-lasso-service.mjs';

class MemoryStore {
  constructor() {
    this.values = new Map();
    this.failMessageLists = false;
  }

  async get(key, options = {}) {
    if (!this.values.has(key)) return null;
    const value = this.values.get(key);
    return options.type === 'json' ? structuredClone(value) : JSON.stringify(value);
  }

  async setJSON(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix = '', cursor } = {}) {
    if (this.failMessageLists && prefix.includes('/messages/')) {
      throw new Error('synthetic lasso grouping failure');
    }
    const keys = [...this.values.keys()].filter(key => key.startsWith(prefix)).sort();
    const after = cursor ? keys.findIndex(key => key === cursor) + 1 : 0;
    const page = keys.slice(after, after + 100);
    return {
      blobs: page.map(key => ({ key })),
      directories: [],
      cursor: after + page.length < keys.length ? page.at(-1) : null
    };
  }

  messages() {
    return [...this.values.entries()]
      .filter(([key, value]) => key.includes('/messages/') && value?.payload)
      .map(([, value]) => structuredClone(value));
  }
}

const ROOT = 'operator';
const KEY = 'test-root-key';
const SESSION = 'Pokitomas/theawesomehexapp:test';
const NOW = Date.parse('2026-07-14T03:00:00.000Z');
const HEAD = 'a'.repeat(40);

const state = {
  protocol_version: 1,
  session: SESSION,
  generation: 1,
  head_sha: HEAD
};

function sourceMessage(issuer = 'agent-one') {
  return {
    id: 'same-delivery',
    session: SESSION,
    generation: 1,
    issuer,
    parent: null,
    issued_at: new Date(NOW).toISOString(),
    expires_at: null,
    head_sha: HEAD,
    scope: [],
    payload: { summary: 'Inspect the social substrate.' },
    visibility: 'private',
    nonce: `nonce-${issuer}`,
    signature: 'signed',
    signature_algorithm: 'hmac-sha256',
    protocol_version: 1
  };
}

function signedRequest(bodyObject, nonce = 'write-with-lasso-failure') {
  const body = JSON.stringify(bodyObject);
  const timestamp = new Date(NOW).toISOString();
  const path = '/api/remote';
  const canonical = canonicalRequest({ method: 'POST', path, timestamp, nonce, bodyText: body });
  const signature = createHmac('sha256', KEY).update(canonical).digest('hex');
  return new Request(`https://sideways.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-remote-principal': ROOT,
      'x-remote-timestamp': timestamp,
      'x-remote-nonce': nonce,
      'x-remote-signature': signature,
      'x-remote-path': path
    },
    body
  });
}

test('repeated delivery without refreshed history reports deterministic duplicates', async () => {
  const store = new MemoryStore();
  const message = sourceMessage();

  const first = await lassoRemoteArrival({
    store,
    message,
    state,
    existingMessages: [],
    now: NOW
  });
  const storedAfterFirst = store.messages();

  const second = await lassoRemoteArrival({
    store,
    message,
    state,
    existingMessages: [],
    now: NOW
  });

  assert.equal(first.stored, first.planned);
  assert.ok(first.stored > 0);
  assert.equal(second.planned, first.planned);
  assert.equal(second.stored, 0);
  assert.equal(second.duplicates, first.planned);
  assert.deepEqual(store.messages(), storedAfterFirst);
});

test('internal lasso messages cannot recursively create another lasso batch', async () => {
  const result = await lassoRemoteArrival({
    store: new MemoryStore(),
    message: sourceMessage(LASSO_SYSTEM_PRINCIPAL),
    state,
    existingMessages: [],
    now: NOW
  });

  assert.deepEqual(result, { skipped: true, stored: 0, duplicates: 0 });
});

test('lasso grouping failure cannot roll back an authenticated Remote write', async () => {
  const store = new MemoryStore();
  store.failMessageLists = true;
  const handler = createRemoteHandler({
    store,
    env: {
      REMOTE_ROOT_ID: ROOT,
      REMOTE_ROOT_KEY: KEY,
      REMOTE_PUBLIC_SESSION: SESSION,
      REMOTE_WEAVE_LASSO: 'true'
    },
    now: () => NOW
  });
  const issuedAt = new Date(NOW).toISOString();
  const message = {
    id: 'survives-grouping-failure',
    session: SESSION,
    generation: 1,
    issuer: ROOT,
    issued_at: issuedAt,
    head_sha: HEAD,
    scope: [],
    payload: { summary: 'The authenticated write remains authoritative.' },
    visibility: 'public',
    nonce: 'write-with-lasso-failure'
  };

  const response = await handler(signedRequest({ message }));
  assert.equal(response.status, 200);

  const stored = await store.get(messageKey(SESSION, 1, issuedAt, message.id), { type: 'json' });
  assert.equal(stored?.id, message.id);
  assert.equal(stored?.payload?.summary, message.payload.summary);
} );
