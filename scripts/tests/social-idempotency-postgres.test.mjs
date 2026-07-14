import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import pg from 'pg';
import { createPostgresCommunityRuntime } from '../../netlify/functions/social-postgres-community-runtime.mjs';
import { ensureSocialSchema } from '../../netlify/functions/social-postgres-migrations.mjs';
import { createPostgresAuthority } from '../../netlify/functions/social-postgres-store.mjs';
import { createRelationalSocialService } from '../../netlify/functions/social-relational-core.mjs';

const { Pool } = pg;
const connectionString = process.env.POSTGRES_URL || process.env.SOCIAL_DATABASE_URL || '';
const sessionSecret = process.env.SOCIAL_SESSION_SECRET || 'postgres-idempotency-secret-at-least-32-bytes';
const enabled = Boolean(connectionString);
const pool = enabled ? new Pool({ connectionString, max: 8 }) : null;

function service() {
  return createRelationalSocialService({
    authority: {
      ...createPostgresAuthority({ pool }),
      ...createPostgresCommunityRuntime({ pool })
    },
    sessionSecret
  });
}

function client(socialService) {
  let cookie = '';
  return {
    async call(op, { method = 'GET', body, idempotencyKey, cookieOverride } = {}) {
      const headers = {};
      const outgoingCookie = cookieOverride === undefined ? cookie : cookieOverride;
      if (outgoingCookie) headers.cookie = outgoingCookie;
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await socialService(new Request(`http://sideways.test/api/social?op=${op}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      }));
      const setCookie = response.headers.get('set-cookie');
      if (setCookie && cookieOverride === undefined) cookie = setCookie.split(';')[0];
      return { response, data: await response.json(), setCookie };
    },
    cookie: () => cookie
  };
}

before(async () => {
  if (pool) await ensureSocialSchema(pool);
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query(`
    TRUNCATE social_local_controls, social_appeals, social_moderation_actions,
             social_moderation_cases, social_post_revisions, social_community_memberships,
             social_community_policy_versions, social_communities, social_mutation_receipts,
             social_events, social_reactions, social_follows, social_posts, social_sessions,
             social_public_profiles, social_users CASCADE
  `);
});

after(async () => {
  if (pool) await pool.end();
});

test('exact registration retry replays, but changed credentials under the same key fail closed', { skip: !enabled }, async () => {
  const socialService = service();
  const first = client(socialService);
  const exactRetry = client(socialService);
  const changedRequest = client(socialService);
  const original = {
    method: 'POST',
    idempotencyKey: 'registration-request-identity',
    body: { name: 'Ida', handle: 'ida', password: 'original sufficiently long password' }
  };

  const created = await first.call('register', original);
  const replayed = await exactRetry.call('register', original);
  const rejected = await changedRequest.call('register', {
    ...original,
    body: { ...original.body, password: 'attacker supplied different password' }
  });

  assert.equal(created.response.status, 201);
  assert.equal(replayed.response.status, 201);
  assert.equal(created.data.account.id, replayed.data.account.id);
  assert.equal(first.cookie(), exactRetry.cookie());
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.setCookie, null);
  assert.equal(changedRequest.cookie(), '');

  const { rows: [state] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM social_users)::int AS users,
      (SELECT count(*) FROM social_sessions)::int AS sessions,
      (SELECT count(*) FROM social_mutation_receipts)::int AS receipts,
      (SELECT request_digest FROM social_mutation_receipts LIMIT 1) AS request_digest
  `);
  assert.deepEqual(
    { users: state.users, sessions: state.sessions, receipts: state.receipts },
    { users: 1, sessions: 1, receipts: 1 }
  );
  assert.match(state.request_digest, /^[a-f0-9]{64}$/);
});

test('same actor cannot reuse one key for a different mutation body', { skip: !enabled }, async () => {
  const socialService = service();
  const alice = client(socialService);
  await alice.call('register', {
    method: 'POST', idempotencyKey: 'alice-register',
    body: { name: 'Alice', handle: 'alice', password: 'correct horse battery staple' }
  });

  const first = await alice.call('post', {
    method: 'POST', idempotencyKey: 'one-post-key', body: { text: 'first body' }
  });
  const changed = await alice.call('post', {
    method: 'POST', idempotencyKey: 'one-post-key', body: { text: 'different body' }
  });

  assert.equal(first.response.status, 201);
  assert.equal(changed.response.status, 409);
  const { rows: [state] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM social_posts)::int AS posts,
      (SELECT count(*) FROM social_mutation_receipts WHERE operation = 'post.create')::int AS receipts
  `);
  assert.deepEqual(state, { posts: 1, receipts: 1 });
});

test('a different social actor cannot replay a community-scoped owner mutation', { skip: !enabled }, async () => {
  const socialService = service();
  const owner = client(socialService);
  const member = client(socialService);

  await owner.call('register', {
    method: 'POST', idempotencyKey: 'owner-register',
    body: { name: 'Owner', handle: 'owner', password: 'owner password is sufficiently long' }
  });
  await member.call('register', {
    method: 'POST', idempotencyKey: 'member-register',
    body: { name: 'Member', handle: 'member', password: 'member password is sufficiently long' }
  });
  await owner.call('community', {
    method: 'POST', idempotencyKey: 'create-place',
    body: { name: 'Place', slug: 'place' }
  });
  await member.call('community-member', {
    method: 'POST', idempotencyKey: 'join-place',
    body: { slug: 'place', active: true }
  });

  const request = {
    method: 'POST',
    idempotencyKey: 'owner-role-change',
    body: { slug: 'place', handle: 'member', role: 'moderator' }
  };
  const authorized = await owner.call('community-role', request);
  const replayByDifferentActor = await member.call('community-role', request);

  assert.equal(authorized.response.status, 200);
  assert.equal(replayByDifferentActor.response.status, 409);
  assert.match(replayByDifferentActor.data.error, /another mutation/i);

  const { rows: [receipt] } = await pool.query(`
    SELECT actor_id, request_digest FROM social_mutation_receipts
    WHERE scope = 'community:place' AND idempotency_key = 'owner-role-change'
  `);
  assert.ok(receipt.actor_id);
  assert.match(receipt.request_digest, /^[a-f0-9]{64}$/);
});
