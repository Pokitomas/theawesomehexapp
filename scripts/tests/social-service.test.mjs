import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStore, createSocialService } from '../../netlify/functions/social-core.mjs';

function client(service) {
  let cookie = '';
  return {
    async call(op, { method = 'GET', body } = {}) {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await service(new Request(`http://sideways.test/api/social?op=${op}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      }));
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const data = await response.json();
      return { response, data };
    },
    cookie: () => cookie
  };
}

test('two accounts can post, follow, reply, and like through isolated sessions', async () => {
  let tick = Date.parse('2026-07-14T06:00:00.000Z');
  const store = createMemoryStore();
  const service = createSocialService({ store, now: () => tick++ });
  const alice = client(service);
  const bob = client(service);

  let result = await alice.call('register', { method: 'POST', body: { name: 'Alice', handle: '@alice', password: 'correct horse battery staple', bio: 'first account' } });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.account.handle, 'alice');
  assert.match(alice.cookie(), /^sideways_session=/);

  result = await bob.call('register', { method: 'POST', body: { name: 'Bob', handle: 'bob', password: 'another excellent password' } });
  assert.equal(result.response.status, 201);
  assert.notEqual(alice.cookie(), bob.cookie());

  const stranger = client(service);
  result = await stranger.call('login', { method: 'POST', body: { handle: 'alice', password: 'wrong password' } });
  assert.equal(result.response.status, 401);
  assert.equal(stranger.cookie(), '');

  result = await alice.call('post', { method: 'POST', body: { text: 'hello from alice' } });
  assert.equal(result.response.status, 201);
  const alicePost = result.data.post;
  assert.equal(alicePost.author.handle, 'alice');

  result = await bob.call('discover');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.posts[0].id, alicePost.id);
  assert.equal(result.data.posts[0].following, false);

  result = await bob.call('follow', { method: 'POST', body: { handle: 'alice', active: true } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.active, true);

  result = await bob.call('feed');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.posts.map(post => post.id), [alicePost.id]);

  result = await bob.call('post', { method: 'POST', body: { text: 'a first-class reply', replyTo: alicePost.id } });
  assert.equal(result.response.status, 201);
  const bobReply = result.data.post;
  assert.equal(bobReply.replyTo, alicePost.id);

  result = await alice.call('like', { method: 'POST', body: { postId: bobReply.id, active: true } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.post.liked, true);
  assert.equal(result.data.post.likeCount, 1);

  result = await bob.call('discover');
  const reply = result.data.posts.find(post => post.id === bobReply.id);
  const parent = result.data.posts.find(post => post.id === alicePost.id);
  assert.equal(reply.likeCount, 1);
  assert.equal(reply.liked, false);
  assert.equal(parent.replyCount, 1);

  result = await alice.call('session');
  assert.equal(result.data.account.handle, 'alice');
  result = await bob.call('session');
  assert.equal(result.data.account.handle, 'bob');

  const snapshot = store.snapshot();
  const eventTypes = [...snapshot.entries()].filter(([key]) => key.startsWith('social/event/')).map(([, value]) => value.type);
  for (const type of ['account.registered', 'post.created', 'follow.created', 'post.replied', 'like.created']) {
    assert.ok(eventTypes.includes(type), `missing append-only event ${type}`);
  }
  assert.equal([...snapshot.keys()].filter(key => key.startsWith('social/session/')).length, 2);
});

test('mutations reject a cross-origin request', async () => {
  const service = createSocialService({ store: createMemoryStore() });
  const response = await service(new Request('https://sideways.test/api/social?op=register', {
    method: 'POST',
    headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'X', handle: 'xx', password: '12345678' })
  }));
  assert.equal(response.status, 403);
});
