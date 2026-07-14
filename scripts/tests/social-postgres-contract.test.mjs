import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before, beforeEach } from 'node:test';
import pg from 'pg';
const { Pool } = pg;
import { createPostgresAuthority } from '../../netlify/functions/social-postgres-store.mjs';
import { createRelationalSocialService } from '../../netlify/functions/social-relational-core.mjs';

const connectionString = process.env.POSTGRES_URL || process.env.SOCIAL_DATABASE_URL || '';
const sessionSecret = process.env.SOCIAL_SESSION_SECRET || 'postgres-contract-secret-at-least-32-bytes';
const enabled = Boolean(connectionString);
const pool = enabled ? new Pool({ connectionString, max: 8 }) : null;

function client(service) {
  let cookie = '';
  return {
    async call(op, { method = 'GET', body, idempotencyKey, cookieOverride } = {}) {
      const headers = {};
      const outgoingCookie = cookieOverride === undefined ? cookie : cookieOverride;
      if (outgoingCookie) headers.cookie = outgoingCookie;
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await service(new Request(`http://sideways.test/api/social?op=${op}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      }));
      const setCookie = response.headers.get('set-cookie');
      if (setCookie && cookieOverride === undefined) cookie = setCookie.split(';')[0];
      const data = await response.json();
      return { response, data, setCookie };
    },
    cookie: () => cookie
  };
}

async function counts() {
  const { rows: [row] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM social_users)::int AS users,
      (SELECT count(*) FROM social_public_profiles)::int AS profiles,
      (SELECT count(*) FROM social_sessions)::int AS sessions,
      (SELECT count(*) FROM social_posts)::int AS posts,
      (SELECT count(*) FROM social_follows)::int AS follows,
      (SELECT count(*) FROM social_reactions)::int AS reactions,
      (SELECT count(*) FROM social_events)::int AS events,
      (SELECT count(*) FROM social_mutation_receipts)::int AS receipts
  `);
  return row;
}

before(async () => {
  if (!enabled) return;
  const migration = await readFile(new URL('../../migrations/001_social_authority.sql', import.meta.url), 'utf8');
  await pool.query(migration);
});

beforeEach(async () => {
  if (!enabled) return;
  await pool.query(`
    TRUNCATE social_mutation_receipts, social_events, social_reactions, social_follows,
             social_posts, social_sessions, social_public_profiles, social_users CASCADE
  `);
});

after(async () => {
  if (pool) await pool.end();
});

test('real PostgreSQL preserves the existing Alice/Bob HTTP journey and relational counts', { skip: !enabled }, async () => {
  let tick = Date.parse('2026-07-14T06:00:00.000Z');
  const service = createRelationalSocialService({
    authority: createPostgresAuthority({ pool }),
    sessionSecret,
    now: () => tick++
  });
  const alice = client(service);
  const bob = client(service);

  let result = await alice.call('register', {
    method: 'POST', idempotencyKey: 'alice-register',
    body: { name: 'Alice', handle: '@alice', password: 'correct horse battery staple', bio: 'first account' }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.account.handle, 'alice');
  assert.match(alice.cookie(), /^sideways_session=/);

  result = await bob.call('register', {
    method: 'POST', idempotencyKey: 'bob-register',
    body: { name: 'Bob', handle: 'bob', password: 'another excellent password' }
  });
  assert.equal(result.response.status, 201);
  assert.notEqual(alice.cookie(), bob.cookie());

  result = await alice.call('post', {
    method: 'POST', idempotencyKey: 'alice-post-1', body: { text: 'hello from alice' }
  });
  assert.equal(result.response.status, 201);
  const alicePost = result.data.post;

  result = await bob.call('follow', {
    method: 'POST', idempotencyKey: 'bob-follow-alice', body: { handle: 'alice', active: true }
  });
  assert.equal(result.response.status, 200);

  result = await bob.call('feed');
  assert.deepEqual(result.data.posts.map(item => item.id), [alicePost.id]);

  result = await bob.call('post', {
    method: 'POST', idempotencyKey: 'bob-reply-1',
    body: { text: 'a first-class reply', replyTo: alicePost.id }
  });
  const bobReply = result.data.post;
  assert.equal(bobReply.replyTo, alicePost.id);

  result = await alice.call('like', {
    method: 'POST', idempotencyKey: 'alice-like-bob-reply',
    body: { postId: bobReply.id, active: true }
  });
  assert.equal(result.data.post.likeCount, 1);

  result = await bob.call('discover');
  const reply = result.data.posts.find(item => item.id === bobReply.id);
  const parent = result.data.posts.find(item => item.id === alicePost.id);
  assert.equal(reply.likeCount, 1);
  assert.equal(parent.replyCount, 1);

  assert.deepEqual(await counts(), {
    users: 2, profiles: 2, sessions: 2, posts: 2,
    follows: 1, reactions: 1, events: 6, receipts: 6
  });

  const privateLeak = await pool.query(`
    SELECT 1 FROM social_events
    WHERE payload::text ~* '(password|password_hash|password_salt|token|cookie)'
    LIMIT 1
  `);
  assert.equal(privateLeak.rows.length, 0);
});

test('concurrent same-handle registration has exactly one winner and no orphan rows', { skip: !enabled }, async () => {
  const service = createRelationalSocialService({ authority: createPostgresAuthority({ pool }), sessionSecret });
  const one = client(service);
  const two = client(service);
  const attempts = await Promise.all([
    one.call('register', {
      method: 'POST', idempotencyKey: 'race-one',
      body: { name: 'One', handle: 'same', password: 'password one is long' }
    }),
    two.call('register', {
      method: 'POST', idempotencyKey: 'race-two',
      body: { name: 'Two', handle: 'same', password: 'password two is long' }
    })
  ]);
  assert.deepEqual(attempts.map(item => item.response.status).sort(), [201, 409]);
  const state = await counts();
  assert.deepEqual(
    { users: state.users, profiles: state.profiles, sessions: state.sessions, events: state.events },
    { users: 1, profiles: 1, sessions: 1, events: 1 }
  );
});

test('same idempotency key replays the first committed registration without duplicate state', { skip: !enabled }, async () => {
  const service = createRelationalSocialService({ authority: createPostgresAuthority({ pool }), sessionSecret });
  const first = client(service);
  const second = client(service);
  const request = {
    method: 'POST', idempotencyKey: 'same-register-key',
    body: { name: 'Ida', handle: 'ida', password: 'a sufficiently long password' }
  };
  const results = await Promise.all([first.call('register', request), second.call('register', request)]);
  assert.equal(results[0].response.status, 201);
  assert.equal(results[1].response.status, 201);
  assert.equal(results[0].data.account.id, results[1].data.account.id);
  assert.equal(first.cookie(), second.cookie());
  const state = await counts();
  assert.deepEqual(
    { users: state.users, sessions: state.sessions, events: state.events, receipts: state.receipts },
    { users: 1, sessions: 1, events: 1, receipts: 1 }
  );
});

test('failure between object write and event append rolls the full transaction back', { skip: !enabled }, async () => {
  const authority = createPostgresAuthority({
    pool,
    afterMutation: async ({ operation }) => {
      if (operation === 'post.create') throw new Error('injected failure');
    }
  });
  const service = createRelationalSocialService({ authority, sessionSecret });
  const alice = client(service);
  await alice.call('register', {
    method: 'POST', idempotencyKey: 'rollback-register',
    body: { name: 'Alice', handle: 'alice', password: 'correct horse battery staple' }
  });
  const result = await alice.call('post', {
    method: 'POST', idempotencyKey: 'rollback-post', body: { text: 'must roll back' }
  });
  assert.equal(result.response.status, 500);
  const state = await counts();
  assert.equal(state.posts, 0);
  assert.equal(state.events, 1);
  assert.equal(state.receipts, 1);
});

test('logout invalidates the old hashed session token', { skip: !enabled }, async () => {
  const service = createRelationalSocialService({ authority: createPostgresAuthority({ pool }), sessionSecret });
  const alice = client(service);
  await alice.call('register', {
    method: 'POST', idempotencyKey: 'logout-register',
    body: { name: 'Alice', handle: 'alice', password: 'correct horse battery staple' }
  });
  const oldCookie = alice.cookie();
  const rawToken = decodeURIComponent(oldCookie.replace(/^sideways_session=/, ''));
  const { rows: [stored] } = await pool.query('SELECT token_hash FROM social_sessions LIMIT 1');
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.token_hash, rawToken);

  const logout = await alice.call('logout', { method: 'POST', idempotencyKey: 'logout-once' });
  assert.equal(logout.response.status, 200);
  const stale = await alice.call('session', { cookieOverride: oldCookie });
  assert.equal(stale.data.authenticated, false);
  const { rows: [remaining] } = await pool.query('SELECT count(*)::int AS count FROM social_sessions');
  assert.equal(remaining.count, 0);
});
