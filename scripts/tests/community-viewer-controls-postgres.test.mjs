import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import pg from 'pg';
import { createPostgresCommunityRuntime } from '../../netlify/functions/social-postgres-community-runtime.mjs';
import { ensureSocialSchema } from '../../netlify/functions/social-postgres-migrations.mjs';
import { createPostgresAuthority } from '../../netlify/functions/social-postgres-store.mjs';
import { createRelationalSocialService } from '../../netlify/functions/social-relational-core.mjs';

const { Pool } = pg;
const connectionString = process.env.POSTGRES_URL || process.env.SOCIAL_DATABASE_URL || '';
const enabled = Boolean(connectionString);
const pool = enabled ? new Pool({ connectionString, max: 8 }) : null;

function client(service) {
  let cookie = '';
  return {
    async call(op, { method = 'GET', body, key, query = {} } = {}) {
      const url = new URL('http://sideways.test/api/social');
      url.searchParams.set('op', op);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      const headers = {};
      if (cookie) headers.cookie = cookie;
      if (key) headers['idempotency-key'] = key;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await service(new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { response, data: await response.json() };
    }
  };
}

before(async () => {
  if (enabled) await ensureSocialSchema(pool);
});

beforeEach(async () => {
  if (!enabled) return;
  await pool.query(`
    TRUNCATE social_local_controls, social_appeals, social_moderation_actions, social_moderation_cases,
             social_post_revisions, social_community_memberships, social_community_policy_versions,
             social_communities, social_mutation_receipts, social_events, social_reactions, social_follows,
             social_posts, social_sessions, social_public_profiles, social_users CASCADE
  `);
});

after(async () => { if (pool) await pool.end(); });

test('viewer controls change only the controlling viewer projection', { skip: !enabled }, async () => {
  let tick = Date.parse('2026-07-14T20:00:00.000Z');
  const service = createRelationalSocialService({
    authority: { ...createPostgresAuthority({ pool }), ...createPostgresCommunityRuntime({ pool }) },
    sessionSecret: 'viewer-control-contract-secret-at-least-32-bytes',
    now: () => tick++
  });
  const owner = client(service);
  const alice = client(service);
  const bob = client(service);
  const ids = {};

  for (const [person, name, handle] of [[owner, 'Owner', 'owner'], [alice, 'Alice', 'alice'], [bob, 'Bob', 'bob']]) {
    const result = await person.call('register', {
      method: 'POST', key: `register-${handle}`,
      body: { name, handle, password: `${handle} password is long enough` }
    });
    assert.equal(result.response.status, 201);
    ids[handle] = result.data.account.id;
  }

  const createdCommunity = await owner.call('community', {
    method: 'POST', key: 'create-community',
    body: { name: 'Viewer Matrix', slug: 'viewer-matrix', rules: {} }
  });
  const communityId = createdCommunity.data.community.id;
  for (const [person, handle] of [[alice, 'alice'], [bob, 'bob']]) {
    assert.equal((await person.call('community-member', {
      method: 'POST', key: `join-${handle}`, body: { slug: 'viewer-matrix', active: true }
    })).response.status, 200);
  }

  const root = await owner.call('post', {
    method: 'POST', key: 'owner-root',
    body: { community: 'viewer-matrix', text: 'owner root' }
  });
  const rootId = root.data.post.id;
  const reply = await bob.call('post', {
    method: 'POST', key: 'bob-reply',
    body: { community: 'viewer-matrix', replyTo: rootId, text: 'bob reply survives' }
  });
  const replyId = reply.data.post.id;

  const control = (person, key, targetType, targetId, kind, active = true) => person.call('local-control', {
    method: 'POST', key,
    body: { targetType, targetId, kind, active }
  });

  assert.equal((await control(alice, 'bad-pair', 'community', communityId, 'hide')).response.status, 400);
  assert.equal((await control(alice, 'missing-target', 'post', 'missing-post', 'hide')).response.status, 404);

  assert.equal((await control(alice, 'hide-root', 'post', rootId, 'hide')).response.status, 200);
  assert.equal((await alice.call('community-feed', { query: { slug: 'viewer-matrix' } })).data.posts.some(post => post.id === rootId), false);
  assert.equal((await bob.call('community-feed', { query: { slug: 'viewer-matrix' } })).data.posts.some(post => post.id === rootId), true);
  const aliceThread = await alice.call('thread', { query: { postId: rootId } });
  assert.equal(aliceThread.data.posts.find(post => post.id === rootId).text, '[hidden locally]');
  assert.equal(aliceThread.data.posts.find(post => post.id === replyId).text, 'bob reply survives');
  assert.equal((await bob.call('thread', { query: { postId: rootId } })).data.posts.find(post => post.id === rootId).text, 'owner root');
  await control(alice, 'unhide-root', 'post', rootId, 'hide', false);
  assert.equal((await alice.call('community-feed', { query: { slug: 'viewer-matrix' } })).data.posts.some(post => post.id === rootId), true);

  await control(alice, 'mute-community', 'community', communityId, 'mute');
  assert.equal((await alice.call('discover')).data.posts.some(post => post.community?.id === communityId), false);
  assert.equal((await bob.call('discover')).data.posts.some(post => post.community?.id === communityId), true);
  await control(alice, 'unmute-community', 'community', communityId, 'mute', false);
  assert.equal((await alice.call('discover')).data.posts.some(post => post.community?.id === communityId), true);

  await control(alice, 'block-owner', 'user', ids.owner, 'block');
  assert.equal((await alice.call('discover')).data.posts.some(post => post.author.id === ids.owner), false);
  assert.equal((await bob.call('discover')).data.posts.some(post => post.author.id === ids.owner), true);
  await control(alice, 'unblock-owner', 'user', ids.owner, 'block', false);
  assert.equal((await alice.call('discover')).data.posts.some(post => post.author.id === ids.owner), true);

  const { rows: [counts] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM social_posts WHERE id IN ($1, $2))::int AS canonical_posts,
      (SELECT count(*) FROM social_moderation_cases)::int AS moderation_cases,
      (SELECT count(*) FROM social_moderation_actions)::int AS moderation_actions,
      (SELECT count(*) FROM social_local_controls)::int AS local_controls
  `, [rootId, replyId]);
  assert.deepEqual(counts, { canonical_posts: 2, moderation_cases: 0, moderation_actions: 0, local_controls: 0 });
});
