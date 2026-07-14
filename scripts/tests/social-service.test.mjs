import assert from 'node:assert/strict';
import test from 'node:test';
import { createSocialService } from '../../netlify/functions/social-core.mjs';
import { createMemorySocialStore } from '../../netlify/functions/social-memory-store.mjs';

function harness() {
  const store = createMemorySocialStore();
  const service = createSocialService({ store });
  const call = async (method, route, { token = '', body, key = '', query = '' } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    const request = new Request(`http://sideways.test${route}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await service(request, { route });
    const payload = result.status === 204 ? null : await result.json();
    return { status: result.status, body: payload };
  };
  return { store, call };
}

const signup = (call, identity) => call('POST', '/auth/signup', { body: identity, key: `signup-${identity.handle}` });

test('two accounts can follow, post, reply, like, synchronize and return on a fresh session', async () => {
  const { store, call } = harness();
  const first = await signup(call, { email: 'first@example.com', password: 'correct horse 1', handle: 'first', displayName: 'First Person', bio: 'one' });
  const second = await signup(call, { email: 'second@example.com', password: 'correct horse 2', handle: 'second', displayName: 'Second Person', bio: 'two' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.user.id, second.body.user.id);

  const firstToken = first.body.session.accessToken;
  const secondToken = second.body.session.accessToken;

  const lookup = await call('GET', '/users/first', { token: secondToken });
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.user.handle, 'first');

  const follow = await call('POST', `/users/${first.body.user.id}/follow`, { token: secondToken, key: 'follow-first' });
  assert.equal(follow.status, 200);
  assert.equal(follow.body.following, true);

  const post = await call('POST', '/posts', { token: firstToken, key: 'first-post', body: { body: 'hello from the shared social graph' } });
  assert.equal(post.status, 201);
  const duplicate = await call('POST', '/posts', { token: firstToken, key: 'first-post', body: { body: 'this must not create another post' } });
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.body.post.id, post.body.post.id);

  const feed = await call('GET', '/feed/following', { token: secondToken });
  assert.equal(feed.status, 200);
  assert.equal(feed.body.items.length, 1);
  assert.equal(feed.body.items[0].body, 'hello from the shared social graph');

  const reply = await call('POST', '/posts', { token: secondToken, key: 'reply-first', body: { body: 'a real reply', replyToId: post.body.post.id } });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.post.replyToId, post.body.post.id);

  const like = await call('POST', `/posts/${post.body.post.id}/like`, { token: secondToken, key: 'like-first' });
  assert.equal(like.status, 200);
  assert.equal(like.body.active, true);
  assert.equal(like.body.post.engagement.likes, 1);
  assert.equal(like.body.post.engagement.viewerLiked, true);

  const thread = await call('GET', `/posts/${post.body.post.id}/thread`, { token: firstToken });
  assert.equal(thread.status, 200);
  assert.equal(thread.body.root.id, post.body.post.id);
  assert.equal(thread.body.replies.length, 1);
  assert.equal(thread.body.replies[0].body, 'a real reply');

  const logout = await call('POST', '/auth/logout', { token: firstToken });
  assert.equal(logout.status, 204);
  const expiredMe = await call('GET', '/me', { token: firstToken });
  assert.equal(expiredMe.status, 401);

  const login = await call('POST', '/auth/login', { body: { email: 'first@example.com', password: 'correct horse 1' } });
  assert.equal(login.status, 200);
  const restored = await call('GET', '/me', { token: login.body.session.accessToken });
  assert.equal(restored.body.user.handle, 'first');
  const ownPosts = await call('GET', `/users/${first.body.user.id}/posts`, { token: login.body.session.accessToken });
  assert.equal(ownPosts.body.items.length, 1);

  const events = await store.listEvents();
  assert.deepEqual(events.map(event => event.type), ['account.created', 'account.created', 'follow.created', 'post.created', 'post.created', 'reaction.created']);
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes('passwordHash'), false);
  assert.equal(serializedEvents.includes('scrypt$'), false);
  assert.equal(serializedEvents.includes('first@example.com'), false);
});

test('public identity stays separate from local preferences and profile updates are idempotent', async () => {
  const { call } = harness();
  const created = await signup(call, { email: 'profile@example.com', password: 'correct horse 3', handle: 'profile', displayName: 'Profile Person' });
  const token = created.body.session.accessToken;
  const patch = await call('PATCH', '/me/profile', { token, key: 'profile-v2', body: { displayName: 'Public Name', bio: 'public bio', website: 'https://example.com' } });
  const replay = await call('PATCH', '/me/profile', { token, key: 'profile-v2', body: { displayName: 'Wrong Replay' } });
  assert.equal(patch.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.user.displayName, 'Public Name');
  assert.equal('theme' in replay.body.user, false);
  assert.equal('feedDensity' in replay.body.user, false);
});

test('unique account constraints, ownership and request boundaries are enforced', async () => {
  const { call } = harness();
  const first = await signup(call, { email: 'same@example.com', password: 'correct horse 4', handle: 'same', displayName: 'Same' });
  assert.equal(first.status, 201);
  assert.equal((await signup(call, { email: 'same@example.com', password: 'correct horse 5', handle: 'other', displayName: 'Other' })).status, 409);
  assert.equal((await signup(call, { email: 'other@example.com', password: 'correct horse 5', handle: 'same', displayName: 'Other' })).status, 409);

  const second = await signup(call, { email: 'other@example.com', password: 'correct horse 5', handle: 'other', displayName: 'Other' });
  const post = await call('POST', '/posts', { token: first.body.session.accessToken, body: { body: 'owned by first' }, key: 'owned' });
  const forbiddenDelete = await call('DELETE', `/posts/${post.body.post.id}`, { token: second.body.session.accessToken, key: 'wrong-owner' });
  assert.equal(forbiddenDelete.status, 404);

  const store = createMemorySocialStore();
  const service = createSocialService({ store });
  const crossOrigin = await service(new Request('https://sideways.test/auth/signup', {
    method: 'POST',
    headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@example.com', password: 'correct horse 6', handle: 'xx', displayName: 'X' })
  }), { route: '/auth/signup' });
  assert.equal(crossOrigin.status, 403);
});
