import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteHandler, signRemoteRequest } from '../netlify/functions/remote-core.mjs';

class MemoryStore {
  constructor() { this.values = new Map(); }
  async get(key, options = {}) {
    if (!this.values.has(key)) return null;
    const value = this.values.get(key);
    if (options.type === 'json') return structuredClone(value);
    return JSON.stringify(value);
  }
  async setJSON(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  list({ prefix = '', paginate = false } = {}) {
    const blobs = [...this.values.keys()].filter(key => key.startsWith(prefix)).sort().map(key => ({ key }));
    if (!paginate) return Promise.resolve({ blobs, directories: [] });
    return {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < blobs.length; index += 2) yield { blobs: blobs.slice(index, index + 2), directories: [] };
      }
    };
  }
}

function fixture() {
  const store = new MemoryStore();
  let clock = Date.parse('2026-07-14T04:00:00.000Z');
  const env = {
    REMOTE_ROOT_KEY: 'root-secret',
    REMOTE_KEY_WORKER_1: 'worker-secret',
    REMOTE_CAPS_WORKER_1: 'read'
  };
  const handler = createRemoteHandler({ getStore: () => store, env, now: () => clock, uuid: () => 'generated-id' });
  const session = 'theawesomehexapp/universal-remote';

  const signed = ({ principal = 'operator-7', keyId = 'root', secret = 'root-secret', method = 'POST', path = '/api/remote', body = {}, nonce = `nonce-${Math.random()}` }) => {
    const bodyText = method === 'GET' ? '' : JSON.stringify(body);
    const timestamp = new Date(clock).toISOString();
    const signaturePath = new URL(`https://example.test${path}`).pathname;
    const signature = signRemoteRequest({ method, path: signaturePath, timestamp, nonce, bodyText, secret });
    const headers = {
      'x-remote-principal': principal,
      'x-remote-key-id': keyId,
      'x-remote-timestamp': timestamp,
      'x-remote-nonce': nonce,
      'x-remote-signature': signature
    };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    return new Request(`https://example.test${path}`, { method, headers, body: method === 'GET' ? undefined : bodyText });
  };

  const post = async (body, auth = {}) => {
    const response = await handler(signed({ body, ...auth }));
    return { response, data: await response.json() };
  };

  return { store, env, handler, session, signed, post, get clock() { return clock; }, set clock(value) { clock = value; } };
}

async function openAndGrant(fx) {
  let result = await fx.post({ op: 'open', session: fx.session, generation: 1, head_sha: 'a'.repeat(40) }, { nonce: 'open-1' });
  assert.equal(result.response.status, 201);
  result = await fx.post({ op: 'grant', session: fx.session, generation: 1, principal: 'worker-1', capabilities: ['read', 'write', 'claim', 'release', 'pause', 'resume', 'terminate'] }, { nonce: 'grant-1' });
  assert.equal(result.response.status, 200);
}

function workerAuth(nonce) {
  return { principal: 'worker-1', keyId: 'worker-1', secret: 'worker-secret', nonce };
}

test('append-only messages paginate with cursors and public projection redacts private work', async () => {
  const fx = fixture();
  await openAndGrant(fx);
  for (let index = 1; index <= 3; index += 1) {
    fx.clock += 1000;
    const result = await fx.post({
      op: 'message', session: fx.session, generation: 1,
      message: {
        id: `m-${index}`, session: fx.session, generation: 1, issuer: 'worker-1',
        issued_at: new Date(fx.clock).toISOString(), visibility: index === 2 ? 'private' : 'public',
        payload: { action: `work-${index}` }
      }
    }, workerAuth(`message-${index}`));
    assert.equal(result.response.status, 201);
  }

  const firstPath = `/api/remote?session=${encodeURIComponent(fx.session)}&limit=2`;
  let response = await fx.handler(fx.signed({ method: 'GET', path: firstPath, principal: 'worker-1', keyId: 'worker-1', secret: 'worker-secret', nonce: 'get-1' }));
  let page = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(page.messages.map(item => item.id), ['m-1', 'm-2']);
  assert.equal(page.more, true);

  const secondPath = `/api/remote?session=${encodeURIComponent(fx.session)}&limit=2&after=${encodeURIComponent(page.next_cursor)}`;
  response = await fx.handler(fx.signed({ method: 'GET', path: secondPath, principal: 'worker-1', keyId: 'worker-1', secret: 'worker-secret', nonce: 'get-2' }));
  page = await response.json();
  assert.deepEqual(page.messages.map(item => item.id), ['m-3']);

  response = await fx.handler(new Request(`https://example.test/api/remote/state?session=${encodeURIComponent(fx.session)}&public=1`));
  const projection = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(projection.messages.map(item => item.id), ['m-1', 'm-3']);
  assert.equal(JSON.stringify(projection).includes('worker-secret'), false);
});

test('authentication rejects stale timestamps, replayed nonces, impersonation, and missing capabilities', async () => {
  const fx = fixture();
  await openAndGrant(fx);
  const body = { op: 'message', session: fx.session, generation: 1, message: { id: 'replay', issuer: 'worker-1', payload: {} } };
  let response = await fx.handler(fx.signed({ body, ...workerAuth('same-nonce') }));
  assert.equal(response.status, 201);
  response = await fx.handler(fx.signed({ body: { ...body, message: { ...body.message, id: 'replay-2' } }, ...workerAuth('same-nonce') }));
  assert.equal(response.status, 409);

  const staleBody = JSON.stringify(body);
  const staleTimestamp = new Date(fx.clock - 10 * 60 * 1000).toISOString();
  const staleSignature = signRemoteRequest({ method: 'POST', path: '/api/remote', timestamp: staleTimestamp, nonce: 'stale', bodyText: staleBody, secret: 'worker-secret' });
  response = await fx.handler(new Request('https://example.test/api/remote', {
    method: 'POST', body: staleBody, headers: {
      'content-type': 'application/json', 'x-remote-principal': 'worker-1', 'x-remote-key-id': 'worker-1',
      'x-remote-timestamp': staleTimestamp, 'x-remote-nonce': 'stale', 'x-remote-signature': staleSignature
    }
  }));
  assert.equal(response.status, 401);

  response = await fx.handler(fx.signed({ body, principal: 'other-principal', keyId: 'worker-1', secret: 'worker-secret', nonce: 'impersonate' }));
  assert.equal(response.status, 401);
  response = await fx.handler(fx.signed({ body: { op: 'grant', session: fx.session, principal: 'x', capabilities: ['write'] }, ...workerAuth('no-admin') }));
  assert.equal(response.status, 403);
});

test('claims are optional, exclusive while live, releasable, and expire', async () => {
  const fx = fixture();
  await openAndGrant(fx);
  let result = await fx.post({ op: 'claim', session: fx.session, generation: 1, scope: 'repo:branch:agent/frontier', expires_at: new Date(fx.clock + 60_000).toISOString() }, workerAuth('claim-1'));
  assert.equal(result.response.status, 200);

  await fx.post({ op: 'grant', session: fx.session, generation: 1, principal: 'worker-2', capabilities: ['read', 'claim', 'release'] }, { nonce: 'grant-2' });
  fx.env.REMOTE_KEY_WORKER_2 = 'worker-2-secret';
  result = await fx.post({ op: 'claim', session: fx.session, generation: 1, scope: 'repo:branch:agent/frontier' }, { principal: 'worker-2', keyId: 'worker-2', secret: 'worker-2-secret', nonce: 'claim-2' });
  assert.equal(result.response.status, 409);

  result = await fx.post({ op: 'release', session: fx.session, generation: 1, scope: 'repo:branch:agent/frontier' }, workerAuth('release-1'));
  assert.equal(result.response.status, 200);
  await fx.post({ op: 'claim', session: fx.session, generation: 1, scope: 'repo:branch:agent/frontier', expires_at: new Date(fx.clock + 1000).toISOString() }, workerAuth('claim-3'));
  fx.clock += 2000;
  result = await fx.post({ op: 'claim', session: fx.session, generation: 1, scope: 'repo:branch:agent/frontier' }, { principal: 'worker-2', keyId: 'worker-2', secret: 'worker-2-secret', nonce: 'claim-after-expiry' });
  assert.equal(result.response.status, 200);
});

test('terminalization is exact-head, evidence-bound, claim-free, immutable, and generation-safe', async () => {
  const fx = fixture();
  await openAndGrant(fx);
  const head = 'a'.repeat(40);
  const merge = 'b'.repeat(40);
  let result = await fx.post({ op: 'claim', session: fx.session, generation: 1, scope: 'repo:branch:agent/frontier' }, workerAuth('term-claim'));
  assert.equal(result.response.status, 200);

  const proposal = {
    id: 'ready-1', head_sha: head,
    checks: [{ name: 'phone', conclusion: 'success', head_sha: head }],
    artifacts: [{ id: 'artifact-1', digest: 'sha256:abc' }],
    remaining_test_records: 0, active_blockers: 0,
    merge: { state: 'merged', merge_sha: merge },
    production: { state: 'unverified', receipt: null }, evidence: { inspected: true }
  };

  result = await fx.post({ op: 'propose_terminal', session: fx.session, generation: 1, proposal }, workerAuth('proposal-with-claim'));
  assert.equal(result.response.status, 409);
  assert.equal(result.data.reasons.includes('active mutation claim remains'), true);
  await fx.post({ op: 'release', session: fx.session, generation: 1, scope: 'repo:branch:agent/frontier' }, workerAuth('term-release'));

  result = await fx.post({ op: 'propose_terminal', session: fx.session, generation: 1, proposal: { ...proposal, head_sha: 'c'.repeat(40) } }, workerAuth('proposal-stale'));
  assert.equal(result.response.status, 409);
  assert.equal(result.data.reasons.includes('proposed head is stale'), true);
  result = await fx.post({ op: 'propose_terminal', session: fx.session, generation: 1, proposal }, workerAuth('proposal-good'));
  assert.equal(result.response.status, 201);

  result = await fx.post({ op: 'terminalize', session: fx.session, generation: 1, proposal_id: 'ready-1' }, { nonce: 'terminalize' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.terminal.merge_sha, merge);
  result = await fx.post({ op: 'message', session: fx.session, generation: 1, message: { id: 'zombie', issuer: 'worker-1', payload: {} } }, workerAuth('zombie'));
  assert.equal(result.response.status, 409);

  result = await fx.post({ op: 'new_generation', session: fx.session, generation: 1, next_generation: 2, head_sha: merge }, { nonce: 'new-generation' });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.state.generation, 2);
});

test('deployment cannot be marked deployed without a receipt naming the merge commit', async () => {
  const fx = fixture();
  await openAndGrant(fx);
  const head = 'a'.repeat(40);
  const merge = 'b'.repeat(40);
  const result = await fx.post({
    op: 'propose_terminal', session: fx.session, generation: 1,
    proposal: {
      id: 'bad-deploy', head_sha: head,
      checks: [{ name: 'all', conclusion: 'success', head_sha: head }],
      artifacts: [{ digest: 'sha256:abc' }], remaining_test_records: 0, active_blockers: 0,
      merge: { state: 'merged', merge_sha: merge },
      production: { state: 'deployed', receipt: 'receipt for another commit' }
    }
  }, workerAuth('bad-deploy'));
  assert.equal(result.response.status, 409);
  assert.equal(result.data.reasons.includes('deployment receipt must name the merge commit'), true);
});
