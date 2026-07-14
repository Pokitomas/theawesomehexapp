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
    async call(op, { method = 'GET', body, key } = {}) {
      const url = new URL('http://sideways.test/api/social');
      url.searchParams.set('op', op);
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

test('appeals reverse one immutable action and cannot ping-pong after resolution', { skip: !enabled }, async () => {
  let tick = Date.parse('2026-07-14T21:00:00.000Z');
  const service = createRelationalSocialService({
    authority: { ...createPostgresAuthority({ pool }), ...createPostgresCommunityRuntime({ pool }) },
    sessionSecret: 'immutable-appeal-contract-secret-at-least-32-bytes',
    now: () => tick++
  });
  const owner = client(service);
  const moderatorA = client(service);
  const moderatorB = client(service);
  const author = client(service);
  const ids = {};

  for (const [person, name, handle] of [
    [owner, 'Owner', 'owner'],
    [moderatorA, 'Moderator A', 'moderator-a'],
    [moderatorB, 'Moderator B', 'moderator-b'],
    [author, 'Author', 'author']
  ]) {
    const result = await person.call('register', {
      method: 'POST', key: `register-${handle}`,
      body: { name, handle, password: `${handle} password is long enough` }
    });
    assert.equal(result.response.status, 201);
    ids[handle] = result.data.account.id;
  }

  assert.equal((await owner.call('community', {
    method: 'POST', key: 'create-community',
    body: { name: 'Appeal Matrix', slug: 'appeal-matrix', rules: {} }
  })).response.status, 201);
  for (const [person, handle] of [[moderatorA, 'moderator-a'], [moderatorB, 'moderator-b'], [author, 'author']]) {
    assert.equal((await person.call('community-member', {
      method: 'POST', key: `join-${handle}`, body: { slug: 'appeal-matrix', active: true }
    })).response.status, 200);
  }
  for (const handle of ['moderator-a', 'moderator-b']) {
    assert.equal((await owner.call('community-role', {
      method: 'POST', key: `promote-${handle}`,
      body: { slug: 'appeal-matrix', handle, role: 'moderator' }
    })).response.status, 200);
  }

  const created = await author.call('post', {
    method: 'POST', key: 'create-post',
    body: { community: 'appeal-matrix', text: 'original revision' }
  });
  const postId = created.data.post.id;
  const removed = await moderatorA.call('moderate', {
    method: 'POST', key: 'remove-post',
    body: { slug: 'appeal-matrix', targetType: 'post', targetId: postId, action: 'remove', reason: 'original action' }
  });
  assert.equal(removed.response.status, 200);
  const caseId = removed.data.case.id;
  const actionId = removed.data.action.id;
  assert.equal(removed.data.case.evidence.actionId, actionId);
  assert.equal(removed.data.case.evidence.target.revision, 1);

  const revised = await author.call('post', {
    method: 'PATCH', key: 'revise-removed-post',
    body: { postId, text: 'revision written while removed', reason: 'appeal context' }
  });
  assert.equal(revised.response.status, 200);

  const appealed = await author.call('appeal', {
    method: 'POST', key: 'appeal-original-remove',
    body: { caseId, text: 'please review the original action' }
  });
  assert.equal(appealed.response.status, 201);
  const appealId = appealed.data.appeal.id;
  assert.equal(appealed.data.appeal.appealedActionId, actionId);
  assert.equal(appealed.data.appeal.target.actionEvidence.revision, 1);
  assert.equal(appealed.data.appeal.target.currentTarget.revision, 2);
  assert.notEqual(
    appealed.data.appeal.target.actionEvidence.contentDigest,
    appealed.data.appeal.target.currentTarget.contentDigest
  );

  await pool.query(
    `INSERT INTO social_moderation_actions (id, case_id, actor_id, action, reason, created_at)
     VALUES ('mod_unrelated', $1, $2, 'lock', 'unrelated ordering noise', now())`,
    [caseId, ids['moderator-b']]
  );

  const originalActorDenied = await moderatorA.call('appeal-decide', {
    method: 'POST', key: 'original-actor-denied',
    body: { appealId, decision: 'reversed', reason: 'must not reacquire authority' }
  });
  assert.equal(originalActorDenied.response.status, 409);

  const reversed = await moderatorB.call('appeal-decide', {
    method: 'POST', key: 'reviewer-reverses-original',
    body: { appealId, decision: 'reversed', reason: 'action did not satisfy policy' }
  });
  assert.equal(reversed.response.status, 200);
  assert.equal(reversed.data.appealedAction.id, actionId);
  assert.equal(reversed.data.appealedAction.actorId, ids['moderator-a']);
  assert.equal(reversed.data.reversalAction.action, 'restore');
  assert.equal(reversed.data.post.state.visibility, 'visible');
  assert.equal(reversed.data.post.text, 'revision written while removed');

  const reappeal = await author.call('appeal', {
    method: 'POST', key: 'resolved-reappeal',
    body: { caseId, text: 'try to reopen the same action' }
  });
  assert.equal(reappeal.response.status, 409);

  const banned = await moderatorA.call('moderate', {
    method: 'POST', key: 'ban-author',
    body: { slug: 'appeal-matrix', targetType: 'member', targetId: ids.author, action: 'ban', reason: 'member action' }
  });
  assert.equal(banned.response.status, 200);
  const banCaseId = banned.data.case.id;
  const banActionId = banned.data.action.id;
  const banAppeal = await author.call('appeal', {
    method: 'POST', key: 'appeal-ban',
    body: { caseId: banCaseId, text: 'appeal member action' }
  });
  assert.equal(banAppeal.response.status, 201);
  assert.equal(banAppeal.data.appeal.target.actionEvidence.status, 'active');
  const unbanned = await moderatorB.call('appeal-decide', {
    method: 'POST', key: 'reverse-ban',
    body: { appealId: banAppeal.data.appeal.id, decision: 'reversed', reason: 'reverse exact ban' }
  });
  assert.equal(unbanned.response.status, 200);
  assert.equal(unbanned.data.appealedAction.id, banActionId);
  assert.equal(unbanned.data.reversalAction.action, 'unban');
  assert.equal(unbanned.data.currentTarget.status, 'active');
  assert.equal((await author.call('appeal', {
    method: 'POST', key: 'repeat-ban-appeal', body: { caseId: banCaseId, text: 'repeat' }
  })).response.status, 409);

  const { rows } = await pool.query(
    `SELECT appealed_action_id, appeal_target FROM social_appeals ORDER BY created_at`,
  );
  assert.deepEqual(rows.map(row => row.appealed_action_id), [actionId, banActionId]);
  assert.equal(rows[0].appeal_target.action.id, actionId);
});
