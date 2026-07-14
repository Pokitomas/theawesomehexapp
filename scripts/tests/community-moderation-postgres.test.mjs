import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before, beforeEach } from 'node:test';
import pg from 'pg';
import { createPostgresCommunityRuntime } from '../../netlify/functions/social-postgres-community-runtime.mjs';
import { createPostgresAuthority } from '../../netlify/functions/social-postgres-store.mjs';
import { createRelationalSocialService } from '../../netlify/functions/social-relational-core.mjs';

const { Pool } = pg;
const connectionString = process.env.POSTGRES_URL || process.env.SOCIAL_DATABASE_URL || '';
const enabled = Boolean(connectionString);
const pool = enabled ? new Pool({ connectionString, max: 8 }) : null;

function client(service) {
  let cookie = '';
  return {
    async call(op, { method = 'GET', body, key } = {}) {
      const url = new URL('http://sideways.test/api/social');
      url.searchParams.set('op', op);
      const headers = {};
      if (cookie) headers.cookie = cookie;
      if (key) headers['idempotency-key'] = key;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await service(new Request(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      }));
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { response, data: await response.json() };
    }
  };
}

before(async () => {
  if (!enabled) return;
  for (const file of ['001_social_authority.sql', '002_community_conversation_authority.sql']) {
    await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
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

after(async () => { if (pool) await pool.end(); });

test('PostgreSQL moderation target and role matrix fails closed on current membership', { skip: !enabled }, async () => {
  let tick = Date.parse('2026-07-14T19:00:00.000Z');
  const service = createRelationalSocialService({
    authority: {
      ...createPostgresAuthority({ pool }),
      ...createPostgresCommunityRuntime({ pool })
    },
    sessionSecret: 'moderation-role-matrix-secret-at-least-32-bytes',
    now: () => tick++
  });
  const owner = client(service);
  const moderatorA = client(service);
  const moderatorB = client(service);
  const member = client(service);
  const identities = {};

  for (const [person, name, handle] of [
    [owner, 'Owner', 'owner'],
    [moderatorA, 'Moderator A', 'moderator-a'],
    [moderatorB, 'Moderator B', 'moderator-b'],
    [member, 'Member', 'member']
  ]) {
    const result = await person.call('register', {
      method: 'POST', key: `register-${handle}`,
      body: { name, handle, password: `${handle} password is long enough` }
    });
    assert.equal(result.response.status, 201);
    identities[handle] = result.data.account.id;
  }

  assert.equal((await owner.call('community', {
    method: 'POST', key: 'create-community',
    body: { name: 'Role Matrix', slug: 'role-matrix', rules: {} }
  })).response.status, 201);

  for (const [person, handle] of [[moderatorA, 'moderator-a'], [moderatorB, 'moderator-b'], [member, 'member']]) {
    assert.equal((await person.call('community-member', {
      method: 'POST', key: `join-${handle}`, body: { slug: 'role-matrix', active: true }
    })).response.status, 200);
  }
  for (const handle of ['moderator-a', 'moderator-b']) {
    assert.equal((await owner.call('community-role', {
      method: 'POST', key: `promote-${handle}`,
      body: { slug: 'role-matrix', handle, role: 'moderator' }
    })).response.status, 200);
  }

  const moderate = (person, key, targetType, targetId, action) => person.call('moderate', {
    method: 'POST', key,
    body: { slug: 'role-matrix', targetType, targetId, action, reason: key }
  });

  assert.equal((await moderate(moderatorA, 'unknown-target', 'banana', identities.member, 'ban')).response.status, 400);
  assert.equal((await moderate(moderatorA, 'self-ban', 'member', identities['moderator-a'], 'ban')).response.status, 409);
  assert.equal((await moderate(moderatorA, 'peer-ban', 'member', identities['moderator-b'], 'ban')).response.status, 403);
  assert.equal((await moderate(moderatorA, 'owner-ban', 'member', identities.owner, 'ban')).response.status, 409);
  assert.equal((await moderatorA.call('community-role', {
    method: 'POST', key: 'moderator-role-change',
    body: { slug: 'role-matrix', handle: 'member', role: 'moderator' }
  })).response.status, 403);

  assert.equal((await moderate(moderatorA, 'moderator-bans-member', 'member', identities.member, 'ban')).response.status, 200);
  assert.equal((await moderate(owner, 'owner-unbans-member', 'member', identities.member, 'unban')).response.status, 200);
  assert.equal((await moderate(owner, 'owner-bans-moderator', 'member', identities['moderator-b'], 'ban')).response.status, 200);

  assert.equal((await owner.call('community-role', {
    method: 'POST', key: 'preserve-final-owner',
    body: { slug: 'role-matrix', handle: 'owner', role: 'member' }
  })).response.status, 409);

  assert.equal((await owner.call('community-role', {
    method: 'POST', key: 'demote-moderator-a',
    body: { slug: 'role-matrix', handle: 'moderator-a', role: 'member' }
  })).response.status, 200);
  assert.equal((await moderate(moderatorA, 'stale-role-after-demotion', 'member', identities.member, 'ban')).response.status, 403);

  const { rows } = await pool.query(
    `SELECT role, status FROM social_community_memberships
     WHERE community_id = (SELECT id FROM social_communities WHERE slug = 'role-matrix')
       AND user_id = $1`,
    [identities['moderator-a']]
  );
  assert.deepEqual(rows[0], { role: 'member', status: 'active' });
});
