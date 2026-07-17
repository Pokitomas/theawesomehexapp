import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_MUTATION_BODY_BYTES,
  assertSocialReceiptReplay,
  currentSocialMutationIdentity,
  mutationRequestDigest,
  withSocialMutationContext
} from '../../netlify/functions/social-idempotency.mjs';
import { createRelationalSocialService } from '../../netlify/functions/social-relational-core.mjs';

const SECRET = 'social-idempotency-test-secret-at-least-32-bytes';
const OTHER_SECRET = 'different-social-idempotency-secret-32-bytes';

function request(op, body, key = 'same-key') {
  return new Request(`https://sideways.test/api/social?op=${op}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key
    },
    body: JSON.stringify(body)
  });
}

function oversizedRequest({ idempotent = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (idempotent) headers['idempotency-key'] = 'oversized-request';
  return new Request('https://sideways.test/api/social?op=post', {
    method: 'POST',
    headers,
    body: 'x'.repeat(MAX_MUTATION_BODY_BYTES + 1)
  });
}

function chunkedOversizedRequest() {
  const bytes = new TextEncoder().encode('x'.repeat(MAX_MUTATION_BODY_BYTES + 1));
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const end = Math.min(bytes.length, offset + 16 * 1024);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  });
  return new Request('https://sideways.test/api/social?op=post', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'chunked-oversized-request'
    },
    body,
    duplex: 'half'
  });
}

test('request identity is keyed, deterministic, body-bound, operation-bound, and non-consuming', async () => {
  const first = request('register', { handle: 'ida', password: 'secret one' });
  const second = request('register', { handle: 'ida', password: 'secret one' });
  const changedBody = request('register', { handle: 'ida', password: 'secret two' });
  const changedOperation = request('login', { handle: 'ida', password: 'secret one' });

  assert.equal(await mutationRequestDigest(first, SECRET), await mutationRequestDigest(second, SECRET));
  assert.notEqual(await mutationRequestDigest(second, SECRET), await mutationRequestDigest(changedBody, SECRET));
  assert.notEqual(await mutationRequestDigest(second, SECRET), await mutationRequestDigest(changedOperation, SECRET));
  assert.notEqual(await mutationRequestDigest(second, SECRET), await mutationRequestDigest(second, OTHER_SECRET));
  assert.deepEqual(await first.json(), { handle: 'ida', password: 'secret one' });
});

test('request identity rejects an oversized body even without a content-length header', async () => {
  await assert.rejects(
    mutationRequestDigest(oversizedRequest(), SECRET),
    error => error.status === 413
  );
});

test('request identity rejects a chunked stream when it crosses the byte limit', async () => {
  await assert.rejects(
    mutationRequestDigest(chunkedOversizedRequest(), SECRET),
    error => error.status === 413
  );
});

test('the relational HTTP service converts receipt-bearing pre-handler denial into a 413 response', async () => {
  const service = createRelationalSocialService({ authority: {}, sessionSecret: SECRET });
  const result = await service(oversizedRequest());
  assert.equal(result.status, 413);
  assert.deepEqual(await result.json(), { error: 'Request is too large.' });
});

test('non-idempotent mutations are rejected before the handler when the body is oversized', async () => {
  let reached = false;
  const result = await withSocialMutationContext(oversizedRequest({ idempotent: false }), SECRET, () => {
    reached = true;
    return 'unchanged';
  });
  assert.equal(reached, false);
  assert.equal(result.status, 413);
  assert.deepEqual(await result.json(), { error: 'Request is too large.' });
});

test('mutation identity remains isolated across concurrent async request chains', async () => {
  const one = request('post', { text: 'one' });
  const two = request('post', { text: 'two' });
  const identities = await Promise.all([
    withSocialMutationContext(one, SECRET, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return currentSocialMutationIdentity('acct-one', 'post.create');
    }),
    withSocialMutationContext(two, SECRET, async () => {
      await Promise.resolve();
      return currentSocialMutationIdentity('acct-two', 'post.create');
    })
  ]);

  assert.equal(identities[0].actorId, 'acct-one');
  assert.equal(identities[1].actorId, 'acct-two');
  assert.notEqual(identities[0].requestDigest, identities[1].requestDigest);
});

test('receipt replay requires operation and digest, plus actor outside registration', async () => {
  const registration = request('register', { handle: 'ida', password: 'secret one' });
  const registrationIdentity = await withSocialMutationContext(registration, SECRET, () =>
    currentSocialMutationIdentity('new-attempt-id', 'register'));
  const storedRegistration = {
    operation: 'register',
    actor_id: 'original-account-id',
    request_digest: registrationIdentity.requestDigest
  };
  assert.doesNotThrow(() => assertSocialReceiptReplay(storedRegistration, registrationIdentity));

  const post = request('post', { text: 'hello' });
  const postIdentity = await withSocialMutationContext(post, SECRET, () =>
    currentSocialMutationIdentity('acct-a', 'post.create'));
  const storedPost = {
    operation: 'post.create',
    actor_id: 'acct-a',
    request_digest: postIdentity.requestDigest
  };
  assert.doesNotThrow(() => assertSocialReceiptReplay(storedPost, postIdentity));

  assert.throws(
    () => assertSocialReceiptReplay({ ...storedPost, actor_id: 'acct-b' }, postIdentity),
    error => error.status === 409
  );
  assert.throws(
    () => assertSocialReceiptReplay({ ...storedPost, operation: 'like.set' }, postIdentity),
    error => error.status === 409
  );
  assert.throws(
    () => assertSocialReceiptReplay({ ...storedPost, request_digest: '0'.repeat(64) }, postIdentity),
    error => error.status === 409
  );
  assert.throws(
    () => assertSocialReceiptReplay({ ...storedPost, request_digest: null }, postIdentity),
    error => error.status === 409
  );
});
