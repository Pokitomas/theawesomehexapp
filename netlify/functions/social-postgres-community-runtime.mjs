import {
  assertCommunityRole,
  assertMemberModerationHierarchy,
  assertModerationTargetAction,
  communitySlug,
  contentState,
  inverseModerationAction,
  postStatePatch,
  visibleText
} from './community-authority.mjs';
import { createPostgresCommunityAuthority } from './social-postgres-community.mjs';
import { assertSocialReceiptReplay, currentSocialMutationIdentity } from './social-idempotency.mjs';
import { MAX_FEED, SOCIAL_VERSION, fail, publicAccount, randomId, sha256 } from './social-schema.mjs';
import {
  assertLocalControlPair,
  localControlSets,
  viewerThreadProjection
} from './social-viewer-controls.mjs';

const iso = value => value instanceof Date ? value.toISOString() : String(value);
const account = (row, privateFields = false) => row ? {
  id: row.id,
  handle: row.handle,
  name: row.name,
  bio: row.bio,
  accent: row.accent,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  ...(privateFields ? { password: { salt: row.password_salt, hash: row.password_hash } } : {})
} : null;

const accountSelect = `
  SELECT u.id, p.handle, p.name, p.bio, p.accent,
         u.password_salt, u.password_hash,
         u.created_at, GREATEST(u.updated_at, p.updated_at) AS updated_at
  FROM social_users u
  JOIN social_public_profiles p ON p.user_id = u.id
`;

const viewerEligibility = `
  NOT EXISTS (
    SELECT 1 FROM social_local_controls lc
    WHERE lc.actor_id = $1 AND (
      (lc.target_type = 'post' AND lc.target_id = p.id AND lc.kind = 'hide') OR
      (lc.target_type = 'community' AND lc.target_id = p.community_id AND lc.kind = 'mute') OR
      (lc.target_type = 'user' AND lc.target_id = p.author_id AND lc.kind IN ('mute', 'block'))
    )
  )
`;

const projectionSelect = `
  SELECT p.id, p.text, p.reply_to_id, p.community_id, p.thread_root_id,
         p.author_deleted_at, p.moderator_removed_at, p.legal_restricted_at, p.locked_at,
         p.created_at, p.updated_at,
         c.slug AS community_slug, c.name AS community_name,
         u.id AS author_id, pr.handle AS author_handle, pr.name AS author_name,
         pr.bio AS author_bio, pr.accent AS author_accent,
         u.created_at AS author_created_at,
         GREATEST(u.updated_at, pr.updated_at) AS author_updated_at,
         (SELECT count(*) FROM social_reactions r WHERE r.post_id = p.id AND r.kind = 'like') AS like_count,
         (SELECT count(*) FROM social_posts rp WHERE rp.reply_to_id = p.id AND rp.deleted_at IS NULL) AS reply_count,
         EXISTS(SELECT 1 FROM social_reactions vr WHERE vr.actor_id = $1 AND vr.post_id = p.id AND vr.kind = 'like') AS liked,
         EXISTS(SELECT 1 FROM social_follows vf WHERE vf.follower_id = $1 AND vf.followed_id = p.author_id) AS following,
         (p.author_id = $1) AS mine
  FROM social_posts p
  JOIN social_users u ON u.id = p.author_id
  JOIN social_public_profiles pr ON pr.user_id = u.id
  LEFT JOIN social_communities c ON c.id = p.community_id
`;

function projectedPost(row) {
  const state = contentState(row);
  return {
    id: row.id,
    text: visibleText(row),
    rawTextAvailable: state.visibility === 'visible',
    replyTo: row.reply_to_id || null,
    threadRootId: row.thread_root_id || row.id,
    community: row.community_id ? { id: row.community_id, slug: row.community_slug, name: row.community_name } : null,
    state,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    author: publicAccount({
      id: row.author_id,
      handle: row.author_handle,
      name: row.author_name,
      bio: row.author_bio,
      accent: row.author_accent,
      createdAt: iso(row.author_created_at),
      updatedAt: iso(row.author_updated_at)
    }),
    likeCount: Number(row.like_count || 0),
    replyCount: Number(row.reply_count || 0),
    liked: Boolean(row.liked),
    following: Boolean(row.following),
    mine: Boolean(row.mine)
  };
}

const dbFail = error => {
  if (error?.status) return error;
  if (error?.code === '23505') {
    if (String(error.constraint || '').includes('slug')) return fail(409, 'That community slug is taken.');
    if (String(error.constraint || '').includes('idempotency')) return fail(409, 'That idempotency key was already used.');
    if (String(error.constraint || '').includes('appealed_action')) return fail(409, 'That moderation action already has an appeal.');
    return fail(409, 'That community mutation conflicts with existing state.');
  }
  if (error?.code === '23503') return fail(404, 'The referenced community object no longer exists.');
  if (error?.code === '23514') return fail(409, error.message || 'That conversation mutation violates community authority.');
  return error;
};

export function createPostgresCommunityRuntime({ pool, afterMutation = async () => {} } = {}) {
  if (!pool) throw new Error('A PostgreSQL pool is required.');

  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dbFail(error);
    } finally {
      client.release();
    }
  }

  async function accountBy(client, field, value, privateFields = false) {
    const column = field === 'id' ? 'u.id' : 'p.handle';
    const { rows } = await client.query(`${accountSelect} WHERE ${column} = $1 LIMIT 1`, [value]);
    return account(rows[0], privateFields);
  }

  async function event(client, { type, actorId, key, payload, at }) {
    await client.query(
      `INSERT INTO social_events (id, version, type, actor_id, idempotency_key, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [`evt_${randomId(14)}`, SOCIAL_VERSION, type, actorId, key, JSON.stringify(payload), at]
    );
  }

  async function receipt(client, { scope, operation, actorId, key, at }, mutate) {
    if (!key) return mutate();
    const identity = currentSocialMutationIdentity(actorId, operation);
    const lockKey = JSON.stringify([scope, key]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))', [lockKey]);
    const prior = await client.query(
      `SELECT operation, actor_id, request_digest, status, body
       FROM social_mutation_receipts WHERE scope = $1 AND idempotency_key = $2`,
      [scope, key]
    );
    if (prior.rows[0]) {
      assertSocialReceiptReplay(prior.rows[0], identity);
      return { status: Number(prior.rows[0].status), body: prior.rows[0].body, replayed: true };
    }
    const result = await mutate();
    await client.query(
      `INSERT INTO social_mutation_receipts
       (scope, idempotency_key, operation, actor_id, request_digest, status, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [scope, key, operation, actorId, identity.requestDigest, result.status, JSON.stringify(result.body), at]
    );
    return result;
  }

  const authority = createPostgresCommunityAuthority({
    pool,
    transaction,
    receipt,
    event,
    accountBy,
    afterMutation
  });

  async function membership(client, communityId, userId, lock = false) {
    const { rows } = await client.query(
      `SELECT * FROM social_community_memberships
       WHERE community_id = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [communityId, userId]
    );
    return rows[0] || null;
  }

  async function moderatorMembership(client, communityId, actorId) {
    return assertCommunityRole(await membership(client, communityId, actorId, true), ['moderator', 'owner']);
  }

  async function applyPostAction(client, postId, action, at) {
    const patch = postStatePatch(action, at);
    const [column, value] = Object.entries(patch)[0];
    const allowed = new Set(['author_deleted_at', 'moderator_removed_at', 'legal_restricted_at', 'locked_at']);
    if (!allowed.has(column)) throw fail(400, 'Unsupported post state mutation.');
    await client.query(`UPDATE social_posts SET ${column} = $2, updated_at = $3 WHERE id = $1`, [postId, value, at]);
  }

  async function postTarget(client, postId, lock = false) {
    const { rows } = await client.query(
      `SELECT p.*,
              COALESCE(r.revision, 1) AS target_revision,
              COALESCE(r.text, p.text) AS target_revision_text
       FROM social_posts p
       LEFT JOIN LATERAL (
         SELECT revision, text FROM social_post_revisions
         WHERE post_id = p.id ORDER BY revision DESC LIMIT 1
       ) r ON true
       WHERE p.id = $1 ${lock ? 'FOR UPDATE OF p' : ''}`,
      [postId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      row,
      evidence: {
        type: 'post',
        postId: row.id,
        revision: Number(row.target_revision),
        contentDigest: sha256(String(row.target_revision_text || '')),
        state: contentState(row)
      }
    };
  }

  async function postProjection(client, postId) {
    const target = await postTarget(client, postId);
    if (!target) return null;
    const state = contentState(target.row);
    return {
      id: target.row.id,
      text: visibleText(target.row),
      rawTextAvailable: state.visibility === 'visible',
      state,
      updatedAt: iso(target.row.updated_at),
      revision: target.evidence.revision,
      contentDigest: target.evidence.contentDigest
    };
  }

  async function memberTarget(client, communityId, userId, lock = false) {
    const row = await membership(client, communityId, userId, lock);
    return row ? {
      row,
      evidence: {
        type: 'member',
        userId,
        role: row.role,
        status: row.status,
        reason: row.reason || ''
      }
    } : null;
  }

  async function insertAction(client, { id = `mod_${randomId(14)}`, caseId, actorId, action, reason, at }) {
    await client.query(
      `INSERT INTO social_moderation_actions (id, case_id, actor_id, action, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, caseId, actorId, action, reason || '', at]
    );
    return { id, caseId, actorId, action, reason: reason || '', createdAt: at };
  }

  async function currentTarget(client, moderationCase) {
    if (moderationCase.post_id) return (await postTarget(client, moderationCase.post_id))?.evidence || null;
    if (moderationCase.subject_user_id) return (await memberTarget(client, moderationCase.community_id, moderationCase.subject_user_id))?.evidence || null;
    return null;
  }

  async function moderate({ actorId, slug, targetType, targetId, action, reason, at, idempotencyKey: key }) {
    assertModerationTargetAction(targetType, action);
    const normalized = communitySlug(slug);
    return transaction(client => receipt(client, {
      scope: `community:${normalized}`, operation: 'moderation.action', actorId, key, at
    }, async () => {
      const communityResult = await client.query('SELECT * FROM social_communities WHERE slug = $1 FOR UPDATE', [normalized]);
      const community = communityResult.rows[0];
      if (!community) throw fail(404, 'Community not found.');
      const actorMembership = await moderatorMembership(client, community.id, actorId);

      const caseId = `case_${randomId(14)}`;
      const actionId = `mod_${randomId(14)}`;
      let targetEvidence;
      let postId = null;
      let subjectUserId = null;
      if (targetType === 'post') {
        const target = await postTarget(client, targetId, true);
        if (!target || target.row.community_id !== community.id) throw fail(404, 'Community post not found.');
        targetEvidence = target.evidence;
        postId = target.row.id;
      } else {
        const target = await memberTarget(client, community.id, targetId, true);
        if (!target) throw fail(404, 'Community member not found.');
        assertMemberModerationHierarchy({
          actorId,
          actorMembership,
          targetId,
          targetMembership: target.row
        });
        targetEvidence = target.evidence;
        subjectUserId = targetId;
      }
      const caseEvidence = { reason: reason || '', actionId, target: targetEvidence };
      await client.query(
        `INSERT INTO social_moderation_cases
         (id, community_id, post_id, subject_user_id, opened_by, kind, status, evidence, policy_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'actioned', $7::jsonb, $8, $9, $9)`,
        [caseId, community.id, postId, subjectUserId, actorId, action, JSON.stringify(caseEvidence), community.current_policy_version, at]
      );
      const moderationAction = await insertAction(client, { id: actionId, caseId, actorId, action, reason, at });
      if (postId) await applyPostAction(client, postId, action, at);
      if (subjectUserId) {
        await client.query(
          `UPDATE social_community_memberships SET status = $3, reason = $4, updated_at = $5
           WHERE community_id = $1 AND user_id = $2`,
          [community.id, subjectUserId, action === 'ban' ? 'banned' : 'active', action === 'ban' ? (reason || '') : '', at]
        );
      }
      await event(client, {
        type: `moderation.${action}`, actorId, key,
        payload: { caseId, actionId, targetType, targetId, communityId: community.id }, at
      });
      return {
        status: 200,
        body: {
          case: { id: caseId, status: 'actioned', targetType, targetId, policyVersion: Number(community.current_policy_version), evidence: caseEvidence },
          action: moderationAction,
          ...(postId ? { post: await postProjection(client, postId) } : {})
        }
      };
    }));
  }

  async function appeal({ actorId, caseId, text, at, idempotencyKey: key }) {
    return transaction(client => receipt(client, {
      scope: `case:${caseId}`, operation: 'moderation.appeal', actorId, key, at
    }, async () => {
      const current = await client.query(
        `SELECT mc.*, p.author_id
         FROM social_moderation_cases mc
         LEFT JOIN social_posts p ON p.id = mc.post_id
         WHERE mc.id = $1 FOR UPDATE OF mc`,
        [caseId]
      );
      const moderationCase = current.rows[0];
      if (!moderationCase) throw fail(404, 'Moderation case not found.');
      if (![moderationCase.author_id, moderationCase.subject_user_id].includes(actorId)) throw fail(403, 'Only the affected person can appeal.');
      if (moderationCase.status !== 'actioned') throw fail(409, 'This action is not appealable.');
      const actionId = String(moderationCase.evidence?.actionId || '');
      if (!actionId) throw fail(409, 'This case has no immutable action identity.');
      const actionResult = await client.query(
        `SELECT * FROM social_moderation_actions WHERE id = $1 AND case_id = $2`,
        [actionId, caseId]
      );
      const action = actionResult.rows[0];
      if (!action) throw fail(409, 'The appealed moderation action no longer exists.');
      const appealTarget = {
        action: {
          id: action.id,
          actorId: action.actor_id,
          action: action.action,
          reason: action.reason || '',
          createdAt: iso(action.created_at)
        },
        actionEvidence: moderationCase.evidence?.target || null,
        currentTarget: await currentTarget(client, moderationCase)
      };
      const id = `appeal_${randomId(14)}`;
      await client.query(
        `INSERT INTO social_appeals
         (id, case_id, appellant_id, appealed_action_id, appeal_target, text, status, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending', $7)`,
        [id, caseId, actorId, action.id, JSON.stringify(appealTarget), text, at]
      );
      await client.query(`UPDATE social_moderation_cases SET status = 'appealed', updated_at = $2 WHERE id = $1`, [caseId, at]);
      await event(client, { type: 'moderation.appealed', actorId, key, payload: { caseId, appealId: id, actionId: action.id }, at });
      return {
        status: 201,
        body: {
          appeal: { id, caseId, status: 'pending', text, createdAt: at, appealedActionId: action.id, target: appealTarget }
        }
      };
    }));
  }

  async function decideAppeal({ actorId, appealId, decision, reason, at, idempotencyKey: key }) {
    if (!['upheld', 'reversed'].includes(decision)) throw fail(400, 'Appeal decision must be upheld or reversed.');
    return transaction(client => receipt(client, {
      scope: `appeal:${appealId}`, operation: 'moderation.appeal.decide', actorId, key, at
    }, async () => {
      const current = await client.query(
        `SELECT a.*, mc.community_id, mc.post_id, mc.subject_user_id,
                ma.actor_id AS appealed_actor_id, ma.action AS appealed_action, ma.reason AS appealed_reason,
                ma.created_at AS appealed_created_at
         FROM social_appeals a
         JOIN social_moderation_cases mc ON mc.id = a.case_id
         JOIN social_moderation_actions ma ON ma.id = a.appealed_action_id
         WHERE a.id = $1 FOR UPDATE OF a`,
        [appealId]
      );
      const appealRow = current.rows[0];
      if (!appealRow) throw fail(404, 'Appeal not found.');
      if (appealRow.status !== 'pending') throw fail(409, 'Appeal is already decided.');
      await moderatorMembership(client, appealRow.community_id, actorId);
      if (appealRow.appealed_actor_id === actorId) throw fail(409, 'A different moderator must decide the appeal.');

      let reversalAction = null;
      if (decision === 'reversed') {
        const inverse = inverseModerationAction(appealRow.appealed_action);
        if (!inverse) throw fail(409, 'The appealed action cannot be reversed automatically.');
        if (appealRow.post_id) await applyPostAction(client, appealRow.post_id, inverse, at);
        if (appealRow.subject_user_id) {
          await client.query(
            `UPDATE social_community_memberships SET status = $3, reason = '', updated_at = $4
             WHERE community_id = $1 AND user_id = $2`,
            [appealRow.community_id, appealRow.subject_user_id, inverse === 'unban' ? 'active' : 'banned', at]
          );
        }
        reversalAction = await insertAction(client, {
          caseId: appealRow.case_id,
          actorId,
          action: inverse,
          reason: `appeal reversed: ${reason || ''}`,
          at
        });
      }
      await client.query(
        `UPDATE social_appeals
         SET status = $2, decided_by = $3, decision_reason = $4, decided_at = $5
         WHERE id = $1`,
        [appealId, decision, actorId, reason || '', at]
      );
      await client.query(`UPDATE social_moderation_cases SET status = 'resolved', updated_at = $2 WHERE id = $1`, [appealRow.case_id, at]);
      await event(client, {
        type: `moderation.appeal.${decision}`, actorId, key,
        payload: { caseId: appealRow.case_id, appealId, appealedActionId: appealRow.appealed_action_id }, at
      });
      return {
        status: 200,
        body: {
          appeal: {
            id: appealId,
            caseId: appealRow.case_id,
            status: decision,
            decisionReason: reason || '',
            decidedAt: at,
            appealedActionId: appealRow.appealed_action_id,
            target: appealRow.appeal_target
          },
          appealedAction: {
            id: appealRow.appealed_action_id,
            actorId: appealRow.appealed_actor_id,
            action: appealRow.appealed_action,
            reason: appealRow.appealed_reason || '',
            createdAt: iso(appealRow.appealed_created_at)
          },
          reversalAction,
          currentTarget: await currentTarget(client, appealRow),
          ...(appealRow.post_id ? { post: await postProjection(client, appealRow.post_id) } : {})
        }
      };
    }));
  }

  async function controlsFor(actorId) {
    if (!actorId) return localControlSets([]);
    const { rows } = await pool.query(
      `SELECT target_type, target_id, kind FROM social_local_controls WHERE actor_id = $1`,
      [actorId]
    );
    return localControlSets(rows);
  }

  async function setLocalControl({ actorId, targetType, targetId, kind, active, at, idempotencyKey: key }) {
    assertLocalControlPair(targetType, kind);
    return transaction(client => receipt(client, {
      scope: `actor:${actorId}`, operation: 'local-control.set', actorId, key, at
    }, async () => {
      const targetQueries = {
        post: 'SELECT id FROM social_posts WHERE id = $1',
        community: 'SELECT id FROM social_communities WHERE id = $1',
        user: 'SELECT id FROM social_users WHERE id = $1'
      };
      const target = await client.query(targetQueries[targetType], [targetId]);
      if (!target.rows[0]) throw fail(404, 'Local control target not found.');
      if (active) {
        await client.query(
          `INSERT INTO social_local_controls (actor_id, target_type, target_id, kind, created_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [actorId, targetType, targetId, kind, at]
        );
      } else {
        await client.query(
          `DELETE FROM social_local_controls
           WHERE actor_id = $1 AND target_type = $2 AND target_id = $3 AND kind = $4`,
          [actorId, targetType, targetId, kind]
        );
      }
      await event(client, {
        type: active ? 'local-control.created' : 'local-control.deleted', actorId, key,
        payload: { targetType, targetId, kind }, at
      });
      return { status: 200, body: { active, targetType, targetId, kind } };
    }));
  }

  async function listPosts({ viewerId = '', mode = 'discover' } = {}) {
    const following = mode === 'feed'
      ? `AND (p.author_id = $1 OR EXISTS (
           SELECT 1 FROM social_follows f WHERE f.follower_id = $1 AND f.followed_id = p.author_id
         ))`
      : '';
    const { rows } = await pool.query(
      `${projectionSelect}
       WHERE p.deleted_at IS NULL
         AND p.author_deleted_at IS NULL
         AND p.moderator_removed_at IS NULL
         AND p.legal_restricted_at IS NULL
         AND ${viewerEligibility}
         ${following}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ${MAX_FEED}`,
      [viewerId]
    );
    return rows.map(projectedPost);
  }

  async function communityPosts({ slug, viewerId = '' }) {
    const { rows } = await pool.query(
      `${projectionSelect}
       WHERE c.slug = $2
         AND p.reply_to_id IS NULL
         AND p.deleted_at IS NULL
         AND p.author_deleted_at IS NULL
         AND p.moderator_removed_at IS NULL
         AND p.legal_restricted_at IS NULL
         AND ${viewerEligibility}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ${MAX_FEED}`,
      [viewerId, String(slug)]
    );
    return rows.map(projectedPost);
  }

  async function thread({ postId, viewerId = '' }) {
    const value = await authority.thread({ postId, viewerId });
    if (!value || !viewerId) return value;
    const controls = await controlsFor(viewerId);
    return { ...value, posts: value.posts.map(post => viewerThreadProjection(post, controls)) };
  }

  return {
    ...authority,
    moderate,
    appeal,
    decideAppeal,
    setLocalControl,
    listPosts,
    communityPosts,
    thread,
    async communityPostContext(postId) {
      const { rows } = await pool.query(
        `SELECT c.slug FROM social_posts p
         JOIN social_communities c ON c.id = p.community_id
         WHERE p.id = $1 LIMIT 1`,
        [postId]
      );
      return rows[0] ? { slug: rows[0].slug } : null;
    }
  };
}
