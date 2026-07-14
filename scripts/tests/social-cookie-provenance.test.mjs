import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductionSocialService } from '../../netlify/functions/social-entrypoint-core.mjs';
import {
  cookieMutationProvenanceError
} from '../../netlify/functions/social-provenance.mjs';
import { sessionCookie } from '../../netlify/functions/social-schema.mjs';

const TARGET = 'https://sideways.test/api/social?op=register';

function mutation(headers = {}, url = TARGET) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}'
  });
}

function fakeStore() {
  return {
    async get() { return null; },
    async setJSON() {},
    async delete() {},
    async list() { return { blobs: [] }; }
  };
}

test('cookie mutation provenance accepts only an exact Origin or same-origin Fetch Metadata', () => {
  const allowed = [
    mutation({ origin: 'https://sideways.test' }),
    mutation({ 'sec-fetch-site': 'same-origin' }),
    mutation({ origin: 'https://sideways.test', 'sec-fetch-site': 'same-origin' })
  ];
  for (const request of allowed) assert.equal(cookieMutationProvenanceError(request), '');

  const denied = [
    mutation(),
    mutation({ origin: 'https://sideways.test:444' }),
    mutation({ origin: 'https://app.sideways.test' }),
    mutation({ origin: 'https://foreign.test' }),
    mutation({ origin: 'null' }),
    mutation({ 'sec-fetch-site': 'same-site' }),
    mutation({ 'sec-fetch-site': 'cross-site' }),
    mutation({ 'sec-fetch-site': 'none' }),
    mutation({ origin: 'https://foreign.test', 'sec-fetch-site': 'same-origin' }),
    mutation({ origin: 'https://sideways.test', 'sec-fetch-site': 'cross-site' })
  ];
  for (const request of denied) assert.notEqual(cookieMutationProvenanceError(request), '');
});

test('safe reads and preflight do not require mutation provenance', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const request = new Request(TARGET, { method });
    assert.equal(cookieMutationProvenanceError(request), '');
  }
});

test('the production boundary denies unproven cookie mutations before either authority runs', async () => {
  let served = 0;
  const service = createProductionSocialService({
    env: {},
    getStore: () => fakeStore(),
    createBlobService: () => async () => {
      served += 1;
      return new Response('{"ok":true}', { status: 200 });
    }
  });

  const absent = await service(mutation());
  const conflicting = await service(mutation({
    origin: 'https://foreign.test',
    'sec-fetch-site': 'same-origin'
  }));
  assert.equal(absent.status, 403);
  assert.equal(conflicting.status, 403);
  assert.equal(served, 0);

  const accepted = await service(mutation({ origin: 'https://sideways.test' }));
  assert.equal(accepted.status, 200);
  assert.equal(served, 1);
});

test('cookie transport adds Secure only for HTTPS without weakening SameSite', () => {
  const http = sessionCookie('token', new Request('http://sideways.test/api/social'));
  const https = sessionCookie('token', new Request('https://sideways.test/api/social'));
  assert.match(http, /HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(http, /; Secure/);
  assert.match(https, /HttpOnly; SameSite=Lax/);
  assert.match(https, /; Secure$/);
});
