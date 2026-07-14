import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSocialReceiptReplay,
  currentSocialMutationIdentity,
  mutationRequestDigest,
  withSocialMutationContext
} from '../../netlify/functions/social-idempotency.mjs';

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

test('request identity is deterministic, body-bound, operation-bound, and non-consuming', async () => {
  const first = request('register', { handle: 'ida', password: 'secret one' });
  const second = request('register', { handle: 'ida', password: 'secret one' });
  const changedBody = request('register', { handle: 'ida', password: 'secret two' });
  const changedOperation = request('login', { handle: 'ida', password: 'secret one' });

  assert.equal(await mutationRequestDigest(first), await mutationRequestDigest(second));
  assert.notEqual(await mutationRequestDigest(second), await mutationRequestDigest(changedBody));
  assert.notEqual(await mutationRequestDigest(second), await mutationRequestDigest(changedOperation));
  assert.deepEqual(await first.json(), { handle: 'ida', password: 'secret one' });
});

test('mutation identity remains isolated across concurrent async request chains', async () => {
  const one = request('post', { text: 'one' });
  const two = request('post', { text: 'two' });
  const identities = await Promise.all([
    withSocialMutationContext(one, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return currentSocialMutationIdentity('acct-one', 'post.create');
    }),
    withSocialMutationContext(two, async () => {
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
  const registrationIdentity = await withSocialMutationContext(registration, () =>
    currentSocialMutationIdentity('new-attempt-id', 'register'));
  const storedRegistration = {
    operation: 'register',
    actor_id: 'original-account-id',
    request_digest: registrationIdentity.requestDigest
  };
  assert.doesNotThrow(() => assertSocialReceiptReplay(storedRegistration, registrationIdentity));

  const post = request('post', { text: 'hello' });
  const postIdentity = await withSocialMutationContext(post, () =>
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
