import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before, beforeEach } from 'node:test';
import pg from 'pg';
import { createPostgresCommunityRuntime } from '../../netlify/functions/social-postgres-community-runtime.mjs';
import { createPostgresAuthority } from '../../netlify/functions/social-postgres-store.mjs';
import { createRelationalSocialService } from '../../netlify/functions/social-relational-core.mjs';

const { Pool } = pg;
const connectionString = process.env.POSTGRES_URL || process.env.SOCIAL_DATABASE_URL || '';
const sessionSecret = process.env.SOCIAL_SESSION_SECRET || 'community-contract-secret-at-least-32-bytes';
const enabled = Boolean(connectionString);
const pool = enabled ? new Pool({ connectionString, max: 8 }) : null;

function client(service) {
  let cookie = '';
  return {
    async call(op, { method = 'GET', body, idempotencyKey, query = {}, cookieOverride } = {}) {
      const url = new URL('http://sideways.test/api/social');
      url.searchParams.set('op', op);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const headers = {};
      const outgoingCookie = cookieOverride === undefined ? cookie : cookieOverride;
      if (outgoingCookie) headers.cookie = outgoingCookie;
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await service(new Request(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      }));
      const setCookie = response.headers.get('set-cookie');
      if (setCookie && cookieOverride === undefined) cookie = setCookie.split(';')[0];
      const data = await response.json();
      return { response, data };
    }
  };
}

before(async () => {
  if (!enabled) return;
  for (const file of ['001_social_authority.sql', '002_community_conversation_authority.sql']) {
    const migration = await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
    await pool.query(migration);
  }
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

after(async () => {
  if (pool) await pool.end();
});

test('community authority survives removal, revision, appeal, tombstone, local hide, and fork', { skip: !enabled }, async () => {
  let tick = Date.parse('2026-07-14T16:00:00.000Z');
  const service = createRelationalSocialService({
    authority: {
      ...createPostgresAuthority({ pool }),
      ...createPostgresCommunityRuntime({ pool })
    },
    sessionSecret,
    now: () => tick++
  });
  const alice = client(service);
  const bob = client(service);
  const carol = client(service);

  for (const [person, name, handle, key] of [
    [alice, 'Alice', 'alice', 'register-alice'],
    [bob, 'Bob', 'bob', 'register-bob'],
    [carol, 'Carol', 'carol', 'register-carol']
  ]) {
    const result = await person.call('register', {
      method: 'POST', idempotencyKey: key,
      body: { name, handle, password: `${name.toLowerCase()} password is long enough` }
    });
    assert.equal(result.response.status, 201);
  }

  let result = await alice.call('community', {
    method: 'POST', idempotencyKey: 'create-commons',
    body: {
      name: 'The Commons', slug: 'the-commons', description: 'A governed public place',
      rules: { harassment: 'remove', appeals: true }
    }
  });
  assert.equal(result.response.status, 201);
  const communityId = result.data.community.id;
  assert.equal(result.data.community.membership.role, 'owner');

  for (const [person, key] of [[bob, 'join-bob'], [carol, 'join-carol']]) {
    result = await person.call('community-member', {
      method: 'POST', idempotencyKey: key, body: { slug: 'the-commons', active: true }
    });
    assert.equal(result.response.status, 200);
  }

  result = await alice.call('community-role', {
    method: 'POST', idempotencyKey: 'promote-carol',
    body: { slug: 'the-commons', handle: 'carol', role: 'moderator' }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.role, 'moderator');

  result = await bob.call('post', {
    method: 'POST', idempotencyKey: 'bob-root',
    body: { community: 'the-commons', text: 'The original claim' }
  });
  assert.equal(result.response.status, 201);
  const rootId = result.data.post.id;
  assert.equal(result.data.post.community.id, communityId);
  assert.equal(result.data.post.threadRootId, rootId);

  result = await alice.call('moderate', {
    method: 'POST', idempotencyKey: 'alice-remove-root',
    body: { slug: 'the-commons', targetType: 'post', targetId: rootId, action: 'remove', reason: 'rule one' }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.post.state.visibility, 'moderator_removed');
  const caseId = result.data.case.id;

  result = await bob.call('post', {
    method: 'PATCH', idempotencyKey: 'bob-edit-removed',
    body: { postId: rootId, text: 'The corrected claim', reason: 'clarified evidence' }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.post.text, '[removed by moderators]');
  assert.equal(result.data.post.rawTextAvailable, false);

  result = await bob.call('appeal', {
    method: 'POST', idempotencyKey: 'bob-appeal',
    body: { caseId, text: 'The revision fixes the violation.' }
  });
  assert.equal(result.response.status, 201);
  const appealId = result.data.appeal.id;

  result = await alice.call('appeal-decide', {
    method: 'POST', idempotencyKey: 'alice-self-review',
    body: { appealId, decision: 'reversed', reason: 'self review attempt' }
  });
  assert.equal(result.response.status, 409);

  result = await carol.call('appeal-decide', {
    method: 'POST', idempotencyKey: 'carol-reverses',
    body: { appealId, decision: 'reversed', reason: 'revision satisfies policy' }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.post.state.visibility, 'visible');
  assert.equal(result.data.post.text, 'The corrected claim');

  result = await bob.call('post', {
    method: 'POST', idempotencyKey: 'bob-reply',
    body: { community: 'the-commons', replyTo: rootId, text: 'A surviving reply' }
  });
  assert.equal(result.response.status, 201);
  const replyId = result.data.post.id;
  assert.equal(result.data.post.threadRootId, rootId);

  result = await bob.call('post-state', {
    method: 'POST', idempotencyKey: 'bob-delete-root', body: { postId: rootId, active: false }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.post.state.visibility, 'author_deleted');

  result = await alice.call('thread', { query: { postId: rootId } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.posts.length, 2);
  assert.equal(result.data.posts.find(post => post.id === rootId).text, '[deleted by author]');
  assert.equal(result.data.posts.find(post => post.id === replyId).text, 'A surviving reply');

  result = await alice.call('local-control', {
    method: 'POST', idempotencyKey: 'alice-hide-root',
    body: { targetType: 'post', targetId: rootId, kind: 'hide', active: true }
  });
  assert.equal(result.response.status, 200);

  result = await bob.call('community-fork', {
    method: 'POST', idempotencyKey: 'bob-forks',
    body: { slug: 'the-commons', newSlug: 'the-commons-fork', name: 'The Commons Fork' }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.community.parentCommunityId, communityId);
  assert.equal(result.data.community.membership.role, 'owner');

  await pool.query('UPDATE social_posts SET legal_restricted_at = $2 WHERE id = $1', [replyId, new Date(tick++).toISOString()]);
  result = await alice.call('thread', { query: { postId: rootId } });
  assert.equal(result.data.posts.find(post => post.id === replyId).state.visibility, 'legal_restricted');
  assert.equal(result.data.posts.find(post => post.id === replyId).text, '[restricted]');
  await pool.query('UPDATE social_posts SET legal_restricted_at = NULL WHERE id = $1', [replyId]);

  await assert.rejects(
    pool.query(
      `INSERT INTO social_posts (id, author_id, text, reply_to_id, created_at, updated_at)
       SELECT 'illegal_cross_authority_reply', id, 'bypass', $1, now(), now()
       FROM social_users WHERE id = (SELECT user_id FROM social_public_profiles WHERE handle = 'alice')`,
      [replyId]
    ),
    error => error?.code === '23514'
  );

  const { rows: [counts] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM social_communities)::int AS communities,
      (SELECT count(*) FROM social_community_memberships)::int AS memberships,
      (SELECT count(*) FROM social_post_revisions WHERE post_id = $1)::int AS revisions,
      (SELECT count(*) FROM social_moderation_cases)::int AS cases,
      (SELECT count(*) FROM social_moderation_actions)::int AS actions,
      (SELECT count(*) FROM social_appeals WHERE status = 'reversed')::int AS reversed_appeals,
      (SELECT count(*) FROM social_local_controls)::int AS local_controls
  `, [rootId]);
  assert.deepEqual(counts, {
    communities: 2,
    memberships: 4,
    revisions: 2,
    cases: 1,
    actions: 2,
    reversed_appeals: 1,
    local_controls: 1
  });
});
