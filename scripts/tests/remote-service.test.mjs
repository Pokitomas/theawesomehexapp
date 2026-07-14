import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';
import test from 'node:test';
import { canonicalRequest } from '../../netlify/functions/remote-core.mjs';
import { createRemoteHandler } from '../../netlify/functions/remote-service.mjs';

class MemoryStore {
  constructor() { this.map = new Map(); }
  async get(key, options = {}) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    if (options.type === 'json') return structuredClone(value);
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  async setJSON(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = '', cursor } = {}) {
    const keys = [...this.map.keys()].filter(key => key.startsWith(prefix)).sort();
    const after = cursor ? keys.findIndex(key => key === cursor) + 1 : 0;
    const page = keys.slice(after, after + 3);
    return {
      blobs: page.map(key => ({ key })),
      directories: [],
      cursor: after + page.length < keys.length ? page[page.length - 1] : null
    };
  }
}

const ROOT = 'operator';
const KEY = 'test-root-key';
const SESSION = 'Pokitomas/theawesomehexapp:test';
const FIXED_NOW = Date.parse('2026-07-14T03:00:00.000Z');
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);
const MERGE = 'b'.repeat(40);

function signedRequest({ method = 'POST', path = '/api/remote', bodyObject, nonce = randomUUID(), timestamp = new Date(FIXED_NOW).toISOString(), principal = ROOT }) {
  const body = bodyObject === undefined ? '' : JSON.stringify(bodyObject);
  const canonical = canonicalRequest({ method, path, timestamp, nonce, bodyText: body });
  const signature = createHmac('sha256', KEY).update(canonical).digest('hex');
  return new Request(`https://sideways.example${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-remote-principal': principal,
      'x-remote-timestamp': timestamp,
      'x-remote-nonce': nonce,
      'x-remote-signature': signature,
      'x-remote-path': path
    },
    ...(body ? { body } : {})
  });
}

function ed25519Request({ path = '/api/remote', bodyObject, nonce, timestamp = new Date(FIXED_NOW).toISOString(), principal, privateKey }) {
  const body = JSON.stringify(bodyObject);
  const material = canonicalRequest({ method: 'POST', path, timestamp, nonce, bodyText: body });
  const signature = signBytes(null, Buffer.from(material), privateKey).toString('base64');
  return new Request(`https://sideways.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-remote-principal': principal,
      'x-remote-timestamp': timestamp,
      'x-remote-nonce': nonce,
      'x-remote-signature': signature,
      'x-remote-path': path
    },
    body
  });
}

function message(id, payload = {}, overrides = {}) {
  return {
    id,
    session: SESSION,
    generation: 1,
    issuer: ROOT,
    issued_at: new Date(FIXED_NOW).toISOString(),
    head_sha: HEAD,
    scope: [],
    payload,
    visibility: 'public',
    ...overrides
  };
}

async function json(response) {
  const data = await response.json();
  return { response, data };
}

function setup() {
  const store = new MemoryStore();
  const handler = createRemoteHandler({
    store,
    env: { REMOTE_ROOT_ID: ROOT, REMOTE_ROOT_KEY: KEY, REMOTE_PUBLIC_SESSION: SESSION },
    now: () => FIXED_NOW
  });
  return { store, handler };
}

test('append-only messages paginate with application cursors and public projection', async () => {
  const { handler } = setup();
  for (let index = 0; index < 7; index += 1) {
    const nonce = `nonce-${index}`;
    const body = { message: { ...message(`message-${index}`, { summary: `Work ${index}` }), nonce } };
    const { response } = await json(await handler(signedRequest({ bodyObject: body, nonce })));
    assert.equal(response.status, 200);
  }

  const first = await json(await handler(new Request(`https://sideways.example/api/remote?session=${encodeURIComponent(SESSION)}&public=1&limit=3`)));
  assert.equal(first.response.status, 200);
  assert.equal(first.data.messages.length, 3);
  assert.equal(first.data.has_more, true);
  const second = await json(await handler(new Request(`https://sideways.example/api/remote?session=${encodeURIComponent(SESSION)}&public=1&limit=3&after=${encodeURIComponent(first.data.next_cursor)}`)));
  assert.equal(second.data.messages.length, 3);
  assert.notEqual(second.data.messages[0].id, first.data.messages[0].id);
});

test('replayed nonces and duplicate message ids are rejected', async () => {
  const { handler } = setup();
  const nonce = 'single-use';
  const body = { message: { ...message('once', { summary: 'Once' }), nonce } };
  assert.equal((await handler(signedRequest({ bodyObject: body, nonce }))).status, 200);
  assert.equal((await handler(signedRequest({ bodyObject: body, nonce }))).status, 409);

  const nonce2 = 'different-nonce';
  const duplicate = { message: { ...message('once', { summary: 'Duplicate' }), nonce: nonce2 } };
  assert.equal((await handler(signedRequest({ bodyObject: duplicate, nonce: nonce2 }))).status, 409);
});

test('claims are optional, exclusive while live, releasable, and terminalization is exact', async () => {
  const { handler } = setup();
  const setHeadNonce = 'set-head';
  const setHead = {
    message: { ...message('set-head-message', { summary: 'Exact work head' }), nonce: setHeadNonce },
    control: { op: 'set-head', head_sha: HEAD }
  };
  assert.equal((await handler(signedRequest({ bodyObject: setHead, nonce: setHeadNonce }))).status, 200);

  const claimNonce = 'claim';
  const claim = {
    message: { ...message('claim-message', { summary: 'Editing branch' }, { scope: ['repo:branch:test'] }), nonce: claimNonce },
    control: { op: 'claim', scope: 'repo:branch:test', ttl_seconds: 300 }
  };
  assert.equal((await handler(signedRequest({ bodyObject: claim, nonce: claimNonce }))).status, 200);

  const badEvidence = {
    head_sha: HEAD,
    checks: [{ name: 'remote', conclusion: 'success', head_sha: HEAD }],
    artifacts: [{ digest: 'sha256:abc' }],
    remaining_test_records: 1,
    active_blockers: 0,
    merge: { state: 'merged', sha: MERGE },
    production: { state: 'unverified', receipt: null }
  };
  const badNonce = 'bad-proposal';
  const badProposal = {
    message: { ...message('bad-proposal-message', { summary: 'Premature completion' }), nonce: badNonce },
    control: { op: 'propose-terminal', evidence: badEvidence }
  };
  const bad = await json(await handler(signedRequest({ bodyObject: badProposal, nonce: badNonce })));
  assert.equal(bad.response.status, 409);
  assert.ok(bad.data.detail.some(value => value.includes('Temporary test records')));

  const releaseNonce = 'release';
  const release = {
    message: { ...message('release-message', { summary: 'Editing complete' }), nonce: releaseNonce },
    control: { op: 'release', scope: 'repo:branch:test' }
  };
  assert.equal((await handler(signedRequest({ bodyObject: release, nonce: releaseNonce }))).status, 200);

  const evidence = { ...badEvidence, remaining_test_records: 0 };
  const proposalNonce = 'proposal';
  const proposal = {
    message: { ...message('proposal-message', { summary: 'Exact head complete', evidence }), nonce: proposalNonce },
    control: { op: 'propose-terminal', evidence }
  };
  assert.equal((await handler(signedRequest({ bodyObject: proposal, nonce: proposalNonce }))).status, 200);

  const terminalNonce = 'terminal';
  const terminal = {
    message: { ...message('terminal-message', { summary: 'Terminal receipt written' }), nonce: terminalNonce },
    control: { op: 'terminalize' }
  };
  const terminalResult = await json(await handler(signedRequest({ bodyObject: terminal, nonce: terminalNonce })));
  assert.equal(terminalResult.response.status, 200);
  assert.equal(terminalResult.data.state.terminal, true);
  assert.equal(terminalResult.data.state.terminal_receipt.merge_sha, MERGE);

  const afterNonce = 'after-terminal';
  const after = { message: { ...message('after-message', { summary: 'Should not append' }), nonce: afterNonce } };
  assert.equal((await handler(signedRequest({ bodyObject: after, nonce: afterNonce }))).status, 409);
});

test('terminal evidence binds successful checks to the exact head and deployed receipts to the merge SHA', async () => {
  const { handler } = setup();
  const baseEvidence = {
    head_sha: HEAD,
    checks: [{ name: 'remote', conclusion: 'success', head_sha: HEAD }],
    artifacts: [{ digest: 'sha256:exact-head-proof' }],
    remaining_test_records: 0,
    active_blockers: 0,
    merge: { state: 'merged', sha: MERGE },
    production: { state: 'unverified', receipt: null }
  };

  const missingHeadNonce = 'missing-check-head';
  const missingHead = {
    message: { ...message('missing-check-head-message', { summary: 'Check is not bound to a head' }), nonce: missingHeadNonce },
    control: { op: 'propose-terminal', evidence: { ...baseEvidence, checks: [{ name: 'remote', conclusion: 'success' }] } }
  };
  const missingResult = await json(await handler(signedRequest({ bodyObject: missingHead, nonce: missingHeadNonce })));
  assert.equal(missingResult.response.status, 409);
  assert.ok(missingResult.data.detail.some(value => value.includes('exact tested head')));

  const wrongHeadNonce = 'wrong-check-head';
  const wrongHead = {
    message: { ...message('wrong-check-head-message', { summary: 'Check belongs to another head' }), nonce: wrongHeadNonce },
    control: { op: 'propose-terminal', evidence: { ...baseEvidence, checks: [{ name: 'remote', conclusion: 'success', head_sha: OTHER_HEAD }] } }
  };
  const wrongResult = await json(await handler(signedRequest({ bodyObject: wrongHead, nonce: wrongHeadNonce })));
  assert.equal(wrongResult.response.status, 409);
  assert.ok(wrongResult.data.detail.some(value => value.includes('exact tested head')));

  const badReceiptNonce = 'bad-deployment-receipt';
  const badReceipt = {
    message: { ...message('bad-deployment-receipt-message', { summary: 'Deployment receipt is unrelated' }), nonce: badReceiptNonce },
    control: {
      op: 'propose-terminal',
      evidence: { ...baseEvidence, production: { state: 'deployed', receipt: 'receipt-for-another-merge' } }
    }
  };
  const badReceiptResult = await json(await handler(signedRequest({ bodyObject: badReceipt, nonce: badReceiptNonce })));
  assert.equal(badReceiptResult.response.status, 409);
  assert.ok(badReceiptResult.data.detail.some(value => value.includes('merge SHA')));

  const goodReceiptNonce = 'good-deployment-receipt';
  const goodReceipt = {
    message: { ...message('good-deployment-receipt-message', { summary: 'Deployment receipt names the merge' }), nonce: goodReceiptNonce },
    control: {
      op: 'propose-terminal',
      evidence: { ...baseEvidence, production: { state: 'deployed', receipt: { commit: MERGE, url: 'https://example.test/receipt' } } }
    }
  };
  const goodReceiptResult = await json(await handler(signedRequest({ bodyObject: goodReceipt, nonce: goodReceiptNonce })));
  assert.equal(goodReceiptResult.response.status, 200);
  assert.equal(goodReceiptResult.data.state.terminal, false);
});

test('public state exposes digestible work and never leaks private payloads', async () => {
  const { handler } = setup();
  const privateNonce = 'private';
  const privateBody = { message: { ...message('private-message', { summary: 'Secret mechanics', secret: 'do-not-show' }, { visibility: 'private' }), nonce: privateNonce } };
  assert.equal((await handler(signedRequest({ bodyObject: privateBody, nonce: privateNonce }))).status, 200);
  const publicNonce = 'public';
  const publicBody = { message: { ...message('public-message', { summary: 'Profile flow is being repaired', evidence: { checks: [{ name: 'phone', conclusion: 'success' }], artifacts: [{ id: 'phone-proof' }], remaining_test_records: 0 } }), nonce: publicNonce } };
  assert.equal((await handler(signedRequest({ bodyObject: publicBody, nonce: publicNonce }))).status, 200);

  const state = await json(await handler(new Request(`https://sideways.example/api/remote/state?session=${encodeURIComponent(SESSION)}&public=1`)));
  assert.equal(state.response.status, 200);
  assert.equal(state.data.state.summary, 'Profile flow is being repaired');
  assert.equal(state.data.state.messages.length, 1);
  assert.equal(state.data.state.messages[0].summary, 'Profile flow is being repaired');
  assert.equal('payload' in state.data.state.messages[0], false);
  assert.equal(JSON.stringify(state.data).includes('do-not-show'), false);
});

test('root can grant a vendorless Ed25519 principal with limited capabilities', async () => {
  const { handler } = setup();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const grantNonce = 'grant-ed25519';
  const grant = {
    message: { ...message('grant-message', { summary: 'Temporary principal granted' }), nonce: grantNonce },
    control: {
      op: 'grant',
      principal: { id: 'replacement-principal', public_key_pem: publicKeyPem, capabilities: ['read', 'write'] }
    }
  };
  assert.equal((await handler(signedRequest({ bodyObject: grant, nonce: grantNonce }))).status, 200);

  const nonce = 'ed25519-message';
  const body = {
    message: {
      id: 'replacement-message',
      session: SESSION,
      generation: 1,
      issuer: 'replacement-principal',
      issued_at: new Date(FIXED_NOW).toISOString(),
      head_sha: HEAD,
      scope: [],
      payload: { summary: 'Replacement participant continued from the same session.' },
      visibility: 'public',
      nonce
    }
  };
  const result = await json(await handler(ed25519Request({ bodyObject: body, nonce, principal: 'replacement-principal', privateKey })));
  assert.equal(result.response.status, 200);
  assert.equal(result.data.message.issuer, 'replacement-principal');

  const claimNonce = 'ed25519-claim';
  const claimBody = {
    message: { ...body.message, id: 'replacement-claim', nonce: claimNonce },
    control: { op: 'claim', scope: 'repo:branch:limited' }
  };
  assert.equal((await handler(ed25519Request({ bodyObject: claimBody, nonce: claimNonce, principal: 'replacement-principal', privateKey }))).status, 403);
});
