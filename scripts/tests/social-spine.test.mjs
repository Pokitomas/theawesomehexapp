import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySocialStore, postToRecord } from '../../netlify/functions/social-core.mjs';

test('two accounts can follow, post, reply, like, and receive normalized following records', async () => {
  const store = createMemorySocialStore();
  const alice = await store.signup({
    email: 'alice@example.test', password: 'correct horse battery staple',
    profile: { handle: 'alice', displayName: 'Alice' }, idempotencyKey: 'signup-alice'
  });
  const bob = await store.signup({
    email: 'bob@example.test', password: 'correct horse battery staple',
    profile: { handle: 'bob', displayName: 'Bob' }, idempotencyKey: 'signup-bob'
  });

  const aliceSession = await store.login({ email: 'alice@example.test', password: 'correct horse battery staple' });
  const bobSession = await store.login({ email: 'bob@example.test', password: 'correct horse battery staple' });
  assert.equal((await store.authenticate(aliceSession.token)).id, alice.id);
  assert.equal((await store.authenticate(bobSession.token)).id, bob.id);

  const publicAlice = await store.getUser('alice');
  assert.equal(publicAlice.handle, 'alice');
  assert.equal(Object.hasOwn(publicAlice, 'email'), false, 'public profile lookup must never expose account email');

  await store.follow(bob.id, alice.id, true, 'bob-follows-alice');
  const root = await store.createPost(alice.id, { body: 'The public fact lives on the server.' }, 'alice-post-1');
  const duplicate = await store.createPost(alice.id, { body: 'ignored duplicate body' }, 'alice-post-1');
  assert.equal(duplicate.id, root.id, 'idempotency must return the original mutation');

  const reply = await store.createPost(bob.id, { body: 'The private archive stays local.', replyToId: root.id }, 'bob-reply-1');
  await store.like(bob.id, root.id, true, 'bob-likes-root');

  const feed = await store.followingFeed(bob.id);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].id, root.id);
  assert.equal(feed[0].type, 'social');
  assert.equal(feed[0].author.handle, '@alice');
  assert.equal(feed[0].engagement.likes, 1);
  assert.equal(feed[0].engagement.replies, 1);
  assert.equal(feed[0].network.authoritative, true);
  assert.equal(reply.reply_to_id, root.id);

  await store.deletePost(alice.id, root.id, 'alice-delete-root');
  assert.equal((await store.followingFeed(bob.id)).length, 0, 'deleted content must leave eligible feeds');

  await store.logout(aliceSession.token);
  assert.equal(await store.authenticate(aliceSession.token), null);
});

test('network record projection preserves the existing candidate schema', () => {
  const record = postToRecord({
    id: 'post_1', author_id: 'usr_1', body: 'hello', visibility: 'public',
    created_at: '2026-01-01T00:00:00.000Z', handle: 'kai', display_name: 'Kai',
    avatar_url: '', like_count: 2, reply_count: 1, repost_count: 0,
    liked_by_viewer: true, followed_author: true
  }, { id: 'usr_2' });
  for (const key of ['id','type','source','canonicalUrl','published','author','text','media','engagement','tags','retrievalFeatures']) {
    assert.ok(Object.hasOwn(record, key), `missing ${key}`);
  }
});
