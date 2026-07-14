import {
  assertCommunityRole,
  communitySlug,
  contentState,
  inverseModerationAction,
  postStatePatch,
  publicCommunity,
  visibleText
} from './community-authority.mjs';
import { MAX_FEED, fail, publicAccount, randomId } from './social-schema.mjs';

const iso = value => value instanceof Date ? value.toISOString() : (value ? String(value) : null);

const communityPostSelect = `
  SELECT p.id, p.text, p.reply_to_id, p.community_id, p.thread_root_id,
         p.author_deleted_at, p.moderator_removed_at, p.legal_restricted_at, p.locked_at,
         p.created_at, p.updated_at,
         c.slug AS community_slug, c.name AS community_name,
         u.id AS author_id, pr.handle AS author_handle, pr.name AS author_name,
         pr.bio AS author_bio, pr.accent AS author_accent,
         u.created_at AS author_created_at,
         GREATEST(u.updated_at, pr.updated_at) AS author_updated_at,
         (SELECT count(*) FROM social_reactions r WHERE r.post_id = p.id AND r.kind = 'like') AS like_count,
         (SELECT count(*) FROM social_posts rp WHERE rp.reply_to_id = p.id) AS reply_count,
         EXISTS(SELECT 1 FROM social_reactions vr WHERE vr.actor_id = $1 AND vr.post_id = p.id AND vr.kind = 'like') AS liked,
         EXISTS(SELECT 1 FROM social_follows vf WHERE vf.follower_id = $1 AND vf.followed_id = p.author_id) AS following,
         (p.author_id = $1) AS mine
  FROM social_posts p
  JOIN social_users u ON u.id = p.author_id
  JOIN social_public_profiles pr ON pr.user_id = u.id
  LEFT JOIN social_communities c ON c.id = p.community_id
`;

function projectedPost(row) {
  if (!row) return null;
  const state = contentState(row);
  return {
    id: row.id,
    text: visibleText(row),
    rawTextAvailable: state.visibility === 'visible',
    replyTo: row.reply_to_id || null,
    threadRootId: row.thread_root_id || row.id,
    community: row.community_id ? {
      id: row.community_id,
      slug: row.community_slug,
      name: row.community_name
    } : null,
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

export function createPostgresCommunityAuthority({
  pool,
  transaction,
  receipt,
  event,
  accountBy,
  afterMutation = async () => {}
} = {}) {
  if (!pool || !transaction || !receipt || !event || !accountBy) throw new Error('Community authority dependencies are required.');

  async function communityRow(client, slug, viewerId = '', lock = false) {
    const normalized = communitySlug(slug);
    const { rows } = await client.query(
      `SELECT c.*,
              m.role AS membership_role, m.status AS membership_status, m.reason AS membership_reason,
              pv.version AS policy_version, pv.rules AS policy_rules, pv.created_at AS policy_created_at
       FROM social_communities c
       LEFT JOIN social_community_memberships m ON m.community_id = c.id AND m.user_id = $2
       LEFT JOIN social_community_policy_versions pv
         ON pv.community_id = c.id AND pv.version = c.current_policy_version
       WHERE c.slug = $1
       ${lock ? 'FOR UPDATE OF c' : ''}
       LIMIT 1`,
      [normalized, viewerId || null]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      row,
      membership: row.membership_role ? {
        role: row.membership_role,
        status: row.membership_status,
        reason: row.membership_reason || ''
      } : null,
      policy: row.policy_version ? {
        version: row.policy_version,
        rules: row.policy_rules || {},
        created_at: row.policy_created_at
      } : null
    };
  }

  async function membership(client, communityId, userId, lock = false) {
    const { rows } = await client.query(
      `SELECT * FROM social_community_memberships
       WHERE community_id = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [communityId, userId]
    );
    return rows[0] || null;
  }

  async function projected(client, postId, viewerId = '') {
    const { rows } = await client.query(`${communityPostSelect} WHERE p.id = $2 LIMIT 1`, [viewerId, postId]);
    return projectedPost(rows[0]);
  }

  async function applyPostAction(client, postId, action, at) {
    const patch = postStatePatch(action, at);
    const [column, value] = Object.entries(patch)[0];
    const allowed = new Set(['author_deleted_at', 'moderator_removed_at', 'legal_restricted_at', 'locked_at']);
    if (!allowed.has(column)) throw fail(400, 'Unsupported post state mutation.');
    await client.query(`UPDATE social_posts SET ${column} = $2, updated_at = $3 WHERE id = $1`, [postId, value, at]);
  }

  async function moderatorMembership(client, communityId, actorId) {
    return assertCommunityRole(await membership(client, communityId, actorId), ['moderator', 'owner']);
  }

  async function insertModerationCase(client, {
    id,
    communityId,
    postId = null,
    subjectUserId = null,
    actorId,
    kind,
    status,
    evidence,
    policyVersion,
    at
  }) {
    await client.query(
      `INSERT INTO social_moderation_cases
       (id, community_id, post_id, subject_user_id, opened_by, kind, status, evidence, policy_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $10)`,
      [id, communityId, postId, subjectUserId, actorId, kind, status, JSON.stringify(evidence || {}), policyVersion, at]
    );
  }

  async function insertModerationAction(client, { caseId, actorId, action, reason, at }) {
    const id = `mod_${randomId(14)}`;
    await client.query(
      `INSERT INTO social_moderation_actions (id, case_id, actor_id, action, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, caseId, actorId, action, reason || '', at]
    );
    return { id, caseId, actorId, action, reason: reason || '', createdAt: at };
  }

  return {
    async community({ slug, viewerId = '' }) {
      const client = await pool.connect();
      try {
        const found = await communityRow(client, slug, viewerId);
        return found ? { community: publicCommunity(found.row, found.membership, found.policy) } : null;
      } finally { client.release(); }
    },

    async createCommunity({ id, actorId, slug, name, description, rules, at, idempotencyKey: key }) {
      const normalized = communitySlug(slug);
      if (normalized.length < 2 || !name) throw fail(400, 'Community name and slug are required.');
      return transaction(client => receipt(client, {
        scope: `community:${normalized}`, operation: 'community.create', actorId, key, at
      }, async () => {
        await client.query(
          `INSERT INTO social_communities
           (id, slug, name, description, created_by, state, current_policy_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $6)`,
          [id, normalized, name, description || '', actorId, at]
        );
        await client.query(
          `INSERT INTO social_community_policy_versions
           (id, community_id, version, rules, created_by, created_at)
           VALUES ($1, $2, 1, $3::jsonb, $4, $5)`,
          [`policy_${randomId(14)}`, id, JSON.stringify(rules || {}), actorId, at]
        );
        await client.query(
          `INSERT INTO social_community_memberships
           (community_id, user_id, role, status, reason, created_at, updated_at)
           VALUES ($1, $2, 'owner', 'active', '', $3, $3)`,
          [id, actorId, at]
        );
        await afterMutation({ operation: 'community.create', client, actorId, objectId: id });
        await event(client, { type: 'community.created', actorId, key, payload: { communityId: id, slug: normalized }, at });
        const found = await communityRow(client, normalized, actorId);
        return { status: 201, body: { community: publicCommunity(found.row, found.membership, found.policy) } };
      }));
    },

    async setCommunityMembership({ actorId, slug, active, at, idempotencyKey: key }) {
      const normalized = communitySlug(slug);
      return transaction(client => receipt(client, {
        scope: `actor:${actorId}`, operation: 'community.membership.set', actorId, key, at
      }, async () => {
        const found = await communityRow(client, normalized, actorId, true);
        if (!found || found.row.state === 'archived') throw fail(404, 'Community not found.');
        const current = await membership(client, found.row.id, actorId, true);
        if (active) {
          if (current?.status === 'banned') throw fail(403, 'You are banned from this community.');
          await client.query(
            `INSERT INTO social_community_memberships
             (community_id, user_id, role, status, reason, created_at, updated_at)
             VALUES ($1, $2, 'member', 'active', '', $3, $3)
             ON CONFLICT (community_id, user_id) DO UPDATE
             SET status = 'active', reason = '', updated_at = EXCLUDED.updated_at`,
            [found.row.id, actorId, at]
          );
        } else {
          if (current?.role === 'owner' && current?.status === 'active') throw fail(409, 'Transfer ownership before leaving.');
          if (current) await client.query(
            `UPDATE social_community_memberships SET status = 'left', updated_at = $3
             WHERE community_id = $1 AND user_id = $2`,
            [found.row.id, actorId, at]
          );
        }
        await afterMutation({ operation: 'community.membership.set', client, actorId, objectId: found.row.id });
        await event(client, { type: active ? 'community.joined' : 'community.left', actorId, key, payload: { communityId: found.row.id }, at });
        const updated = await communityRow(client, normalized, actorId);
        return { status: 200, body: { active, community: publicCommunity(updated.row, updated.membership, updated.policy) } };
      }));
    },

    async setCommunityRole({ actorId, slug, handle, role, at, idempotencyKey: key }) {
      if (!['member', 'moderator', 'owner'].includes(role)) throw fail(400, 'Unsupported community role.');
      const normalized = communitySlug(slug);
      return transaction(client => receipt(client, {
        scope: `community:${normalized}`, operation: 'community.role.set', actorId, key, at
      }, async () => {
        const found = await communityRow(client, normalized, actorId, true);
        if (!found) throw fail(404, 'Community not found.');
        assertCommunityRole(await membership(client, found.row.id, actorId), 'owner', 'Only a community owner can change roles.');
        const target = await accountBy(client, 'handle', handle);
        if (!target) throw fail(404, 'Profile not found.');
        const targetMembership = await membership(client, found.row.id, target.id, true);
        if (!targetMembership || targetMembership.status !== 'active') throw fail(409, 'That person must join the community first.');
        if (targetMembership.role === 'owner' && role !== 'owner') {
          const owners = await client.query(
            `SELECT count(*)::int AS count FROM social_community_memberships
             WHERE community_id = $1 AND role = 'owner' AND status = 'active'`,
            [found.row.id]
          );
          if (Number(owners.rows[0].count) <= 1) throw fail(409, 'A community must retain an owner.');
        }
        await client.query(
          `UPDATE social_community_memberships SET role = $3, updated_at = $4
           WHERE community_id = $1 AND user_id = $2`,
          [found.row.id, target.id, role, at]
        );
        await event(client, { type: 'community.role.changed', actorId, key, payload: { communityId: found.row.id, userId: target.id, role }, at });
        return { status: 200, body: { account: publicAccount(target), role } };
      }));
    },

    async forkCommunity({ id, actorId, slug, newSlug, name, description, at, idempotencyKey: key }) {
      const sourceSlug = communitySlug(slug);
      const targetSlug = communitySlug(newSlug);
      if (targetSlug.length < 2) throw fail(400, 'A fork slug is required.');
      return transaction(client => receipt(client, {
        scope: `community:${targetSlug}`, operation: 'community.fork', actorId, key, at
      }, async () => {
        const source = await communityRow(client, sourceSlug, actorId, true);
        if (!source) throw fail(404, 'Community not found.');
        const actorMembership = await membership(client, source.row.id, actorId);
        if (!actorMembership || actorMembership.status !== 'active') throw fail(403, 'Join the community before forking it.');
        await client.query(
          `INSERT INTO social_communities
           (id, slug, name, description, created_by, parent_community_id, state, current_policy_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', 1, $7, $7)`,
          [id, targetSlug, name || `${source.row.name} fork`, description ?? source.row.description, actorId, source.row.id, at]
        );
        await client.query(
          `INSERT INTO social_community_policy_versions
           (id, community_id, version, rules, created_by, created_at)
           VALUES ($1, $2, 1, $3::jsonb, $4, $5)`,
          [`policy_${randomId(14)}`, id, JSON.stringify(source.policy?.rules || {}), actorId, at]
        );
        await client.query(
          `INSERT INTO social_community_memberships
           (community_id, user_id, role, status, reason, created_at, updated_at)
           VALUES ($1, $2, 'owner', 'active', '', $3, $3)`,
          [id, actorId, at]
        );
        await event(client, { type: 'community.forked', actorId, key, payload: { communityId: id, parentCommunityId: source.row.id }, at });
        const created = await communityRow(client, targetSlug, actorId);
        return { status: 201, body: { community: publicCommunity(created.row, created.membership, created.policy) } };
      }));
    },

    async createCommunityPost({ id, actorId, slug, text, replyTo, at, idempotencyKey: key }) {
      const normalized = communitySlug(slug);
      return transaction(client => receipt(client, {
        scope: `actor:${actorId}`, operation: 'community.post.create', actorId, key, at
      }, async () => {
        const found = await communityRow(client, normalized, actorId, true);
        if (!found || found.row.state === 'archived') throw fail(404, 'Community not found.');
        const actorMembership = await membership(client, found.row.id, actorId);
        if (!actorMembership || actorMembership.status !== 'active') throw fail(403, 'Join the community before posting.');
        let rootId = id;
        if (replyTo) {
          const parent = await client.query(
            `SELECT id, community_id, thread_root_id, author_deleted_at, moderator_removed_at,
                    legal_restricted_at, locked_at
             FROM social_posts WHERE id = $1 FOR UPDATE`,
            [replyTo]
          );
          const value = parent.rows[0];
          if (!value || value.community_id !== found.row.id) throw fail(404, 'The conversation is not in this community.');
          if (contentState(value).tombstone) throw fail(409, 'That conversation cannot receive new replies.');
          if (value.locked_at) throw fail(409, 'That conversation is locked.');
          rootId = value.thread_root_id || value.id;
        }
        await client.query(
          `INSERT INTO social_posts
           (id, author_id, text, reply_to_id, community_id, thread_root_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [id, actorId, text, replyTo || null, found.row.id, rootId, at]
        );
        await client.query(
          `INSERT INTO social_post_revisions (id, post_id, revision, text, editor_id, reason, created_at)
           VALUES ($1, $2, 1, $3, $4, 'created', $5)`,
          [`rev_${randomId(14)}`, id, text, actorId, at]
        );
        await afterMutation({ operation: 'community.post.create', client, actorId, objectId: id });
        await event(client, {
          type: replyTo ? 'conversation.replied' : 'publication.created', actorId, key,
          payload: { postId: id, communityId: found.row.id, replyTo: replyTo || null, threadRootId: rootId }, at
        });
        return { status: 201, body: { post: await projected(client, id, actorId) } };
      }));
    },

    async editCommunityPost({ actorId, postId, text, reason, at, idempotencyKey: key }) {
      return transaction(client => receipt(client, {
        scope: `post:${postId}`, operation: 'community.post.edit', actorId, key, at
      }, async () => {
        const current = await client.query('SELECT * FROM social_posts WHERE id = $1 FOR UPDATE', [postId]);
        const post = current.rows[0];
        if (!post || !post.community_id) throw fail(404, 'Community post not found.');
        if (post.author_id !== actorId) throw fail(403, 'Only the author can edit this post.');
        const revision = await client.query('SELECT COALESCE(max(revision), 0)::int + 1 AS next FROM social_post_revisions WHERE post_id = $1', [postId]);
        await client.query('UPDATE social_posts SET text = $2, updated_at = $3 WHERE id = $1', [postId, text, at]);
        await client.query(
          `INSERT INTO social_post_revisions (id, post_id, revision, text, editor_id, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [`rev_${randomId(14)}`, postId, Number(revision.rows[0].next), text, actorId, reason || '', at]
        );
        await event(client, { type: 'publication.revised', actorId, key, payload: { postId, revision: Number(revision.rows[0].next) }, at });
        return { status: 200, body: { post: await projected(client, postId, actorId) } };
      }));
    },

    async setAuthorPostState({ actorId, postId, active, at, idempotencyKey: key }) {
      const action = active ? 'author-restore' : 'author-delete';
      return transaction(client => receipt(client, {
        scope: `post:${postId}`, operation: 'community.post.author-state', actorId, key, at
      }, async () => {
        const current = await client.query('SELECT * FROM social_posts WHERE id = $1 FOR UPDATE', [postId]);
        const post = current.rows[0];
        if (!post || !post.community_id) throw fail(404, 'Community post not found.');
        if (post.author_id !== actorId) throw fail(403, 'Only the author can change author deletion state.');
        await applyPostAction(client, postId, action, at);
        await event(client, { type: active ? 'publication.author-restored' : 'publication.author-deleted', actorId, key, payload: { postId }, at });
        return { status: 200, body: { post: await projected(client, postId, actorId) } };
      }));
    },

    async moderate({ actorId, slug, targetType, targetId, action, reason, at, idempotencyKey: key }) {
      const normalized = communitySlug(slug);
      const postActions = new Set(['remove', 'restore', 'lock', 'unlock']);
      const memberActions = new Set(['ban', 'unban']);
      if (!(targetType === 'post' ? postActions : memberActions).has(action)) throw fail(400, 'Unsupported moderation action.');
      return transaction(client => receipt(client, {
        scope: `community:${normalized}`, operation: 'moderation.action', actorId, key, at
      }, async () => {
        const found = await communityRow(client, normalized, actorId, true);
        if (!found) throw fail(404, 'Community not found.');
        await moderatorMembership(client, found.row.id, actorId);
        const caseId = `case_${randomId(14)}`;
        if (targetType === 'post') {
          const current = await client.query('SELECT * FROM social_posts WHERE id = $1 FOR UPDATE', [targetId]);
          const post = current.rows[0];
          if (!post || post.community_id !== found.row.id) throw fail(404, 'Community post not found.');
          await insertModerationCase(client, {
            id: caseId, communityId: found.row.id, postId: post.id, actorId,
            kind: action, status: 'actioned', evidence: { reason: reason || '' },
            policyVersion: found.row.current_policy_version, at
          });
          await applyPostAction(client, post.id, action, at);
        } else {
          const target = await accountBy(client, 'id', targetId);
          if (!target) throw fail(404, 'Community member not found.');
          const targetMembership = await membership(client, found.row.id, target.id, true);
          if (!targetMembership) throw fail(404, 'Community member not found.');
          if (targetMembership.role === 'owner') throw fail(409, 'Community owners cannot be banned through moderation.');
          await insertModerationCase(client, {
            id: caseId, communityId: found.row.id, subjectUserId: target.id, actorId,
            kind: action, status: 'actioned', evidence: { reason: reason || '' },
            policyVersion: found.row.current_policy_version, at
          });
          await client.query(
            `UPDATE social_community_memberships
             SET status = $3, reason = $4, updated_at = $5
             WHERE community_id = $1 AND user_id = $2`,
            [found.row.id, target.id, action === 'ban' ? 'banned' : 'active', action === 'ban' ? (reason || '') : '', at]
          );
        }
        const moderationAction = await insertModerationAction(client, { caseId, actorId, action, reason, at });
        await event(client, { type: `moderation.${action}`, actorId, key, payload: { caseId, targetType, targetId, communityId: found.row.id }, at });
        return {
          status: 200,
          body: {
            case: { id: caseId, status: 'actioned', targetType, targetId, policyVersion: found.row.current_policy_version },
            action: moderationAction,
            ...(targetType === 'post' ? { post: await projected(client, targetId, actorId) } : {})
          }
        };
      }));
    },

    async report({ actorId, postId, kind, evidence, at, idempotencyKey: key }) {
      return transaction(client => receipt(client, {
        scope: `post:${postId}`, operation: 'moderation.report', actorId, key, at
      }, async () => {
        const current = await client.query(
          `SELECT p.*, c.current_policy_version FROM social_posts p
           JOIN social_communities c ON c.id = p.community_id
           WHERE p.id = $1`,
          [postId]
        );
        const post = current.rows[0];
        if (!post) throw fail(404, 'Community post not found.');
        const caseId = `case_${randomId(14)}`;
        await insertModerationCase(client, {
          id: caseId, communityId: post.community_id, postId, actorId,
          kind: kind || 'report', status: 'open', evidence: evidence || {},
          policyVersion: post.current_policy_version, at
        });
        await event(client, { type: 'moderation.reported', actorId, key, payload: { caseId, postId, communityId: post.community_id }, at });
        return { status: 201, body: { case: { id: caseId, status: 'open', postId, kind: kind || 'report' } } };
      }));
    },

    async appeal({ actorId, caseId, text, at, idempotencyKey: key }) {
      return transaction(client => receipt(client, {
        scope: `case:${caseId}`, operation: 'moderation.appeal', actorId, key, at
      }, async () => {
        const current = await client.query(
          `SELECT mc.*, p.author_id FROM social_moderation_cases mc
           LEFT JOIN social_posts p ON p.id = mc.post_id
           WHERE mc.id = $1 FOR UPDATE OF mc`,
          [caseId]
        );
        const moderationCase = current.rows[0];
        if (!moderationCase) throw fail(404, 'Moderation case not found.');
        if (![moderationCase.author_id, moderationCase.subject_user_id].includes(actorId)) throw fail(403, 'Only the affected person can appeal.');
        if (!['actioned', 'resolved'].includes(moderationCase.status)) throw fail(409, 'This case is not appealable.');
        const id = `appeal_${randomId(14)}`;
        await client.query(
          `INSERT INTO social_appeals (id, case_id, appellant_id, text, status, created_at)
           VALUES ($1, $2, $3, $4, 'pending', $5)`,
          [id, caseId, actorId, text, at]
        );
        await client.query(`UPDATE social_moderation_cases SET status = 'appealed', updated_at = $2 WHERE id = $1`, [caseId, at]);
        await event(client, { type: 'moderation.appealed', actorId, key, payload: { caseId, appealId: id }, at });
        return { status: 201, body: { appeal: { id, caseId, status: 'pending', text, createdAt: at } } };
      }));
    },

    async decideAppeal({ actorId, appealId, decision, reason, at, idempotencyKey: key }) {
      if (!['upheld', 'reversed'].includes(decision)) throw fail(400, 'Appeal decision must be upheld or reversed.');
      return transaction(client => receipt(client, {
        scope: `appeal:${appealId}`, operation: 'moderation.appeal.decide', actorId, key, at
      }, async () => {
        const current = await client.query(
          `SELECT a.*, mc.community_id, mc.post_id, mc.subject_user_id
           FROM social_appeals a
           JOIN social_moderation_cases mc ON mc.id = a.case_id
           WHERE a.id = $1 FOR UPDATE OF a`,
          [appealId]
        );
        const appeal = current.rows[0];
        if (!appeal) throw fail(404, 'Appeal not found.');
        if (appeal.status !== 'pending') throw fail(409, 'Appeal is already decided.');
        await moderatorMembership(client, appeal.community_id, actorId);
        const latest = await client.query(
          `SELECT * FROM social_moderation_actions WHERE case_id = $1
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [appeal.case_id]
        );
        const priorAction = latest.rows[0];
        if (!priorAction) throw fail(409, 'The case has no action to review.');
        if (priorAction.actor_id === actorId) throw fail(409, 'A different moderator must decide the appeal.');
        if (decision === 'reversed') {
          const inverse = inverseModerationAction(priorAction.action);
          if (!inverse) throw fail(409, 'The original action cannot be reversed automatically.');
          if (appeal.post_id) await applyPostAction(client, appeal.post_id, inverse, at);
          if (appeal.subject_user_id) {
            await client.query(
              `UPDATE social_community_memberships SET status = $3, reason = '', updated_at = $4
               WHERE community_id = $1 AND user_id = $2`,
              [appeal.community_id, appeal.subject_user_id, inverse === 'unban' ? 'active' : 'banned', at]
            );
          }
          await insertModerationAction(client, { caseId: appeal.case_id, actorId, action: inverse, reason: `appeal reversed: ${reason || ''}`, at });
        }
        await client.query(
          `UPDATE social_appeals
           SET status = $2, decided_by = $3, decision_reason = $4, decided_at = $5
           WHERE id = $1`,
          [appealId, decision, actorId, reason || '', at]
        );
        await client.query(`UPDATE social_moderation_cases SET status = 'resolved', updated_at = $2 WHERE id = $1`, [appeal.case_id, at]);
        await event(client, { type: `moderation.appeal.${decision}`, actorId, key, payload: { caseId: appeal.case_id, appealId }, at });
        return {
          status: 200,
          body: {
            appeal: { id: appealId, caseId: appeal.case_id, status: decision, decisionReason: reason || '', decidedAt: at },
            ...(appeal.post_id ? { post: await projected(client, appeal.post_id, actorId) } : {})
          }
        };
      }));
    },

    async setLocalControl({ actorId, targetType, targetId, kind, active, at, idempotencyKey: key }) {
      if (!['user', 'community', 'post'].includes(targetType) || !['hide', 'mute', 'block'].includes(kind)) throw fail(400, 'Unsupported local control.');
      return transaction(client => receipt(client, {
        scope: `actor:${actorId}`, operation: 'local-control.set', actorId, key, at
      }, async () => {
        if (active) {
          await client.query(
            `INSERT INTO social_local_controls (actor_id, target_type, target_id, kind, created_at)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
            [actorId, targetType, targetId, kind, at]
          );
        } else {
          await client.query(
            `DELETE FROM social_local_controls WHERE actor_id = $1 AND target_type = $2 AND target_id = $3 AND kind = $4`,
            [actorId, targetType, targetId, kind]
          );
        }
        await event(client, { type: active ? 'local-control.created' : 'local-control.deleted', actorId, key, payload: { targetType, targetId, kind }, at });
        return { status: 200, body: { active, targetType, targetId, kind } };
      }));
    },

    async communityPosts({ slug, viewerId = '' }) {
      const normalized = communitySlug(slug);
      const { rows } = await pool.query(
        `${communityPostSelect}
         WHERE c.slug = $2
           AND p.reply_to_id IS NULL
           AND p.author_deleted_at IS NULL
           AND p.moderator_removed_at IS NULL
           AND p.legal_restricted_at IS NULL
         ORDER BY p.created_at DESC, p.id DESC LIMIT ${MAX_FEED}`,
        [viewerId, normalized]
      );
      return rows.map(projectedPost);
    },

    async thread({ postId, viewerId = '' }) {
      const root = await pool.query('SELECT COALESCE(thread_root_id, id) AS root_id FROM social_posts WHERE id = $1', [postId]);
      if (!root.rows[0]) return null;
      const rootId = root.rows[0].root_id;
      const { rows } = await pool.query(
        `${communityPostSelect}
         WHERE p.id = $2 OR p.thread_root_id = $2
         ORDER BY p.created_at ASC, p.id ASC`,
        [viewerId, rootId]
      );
      return { rootId, posts: rows.map(projectedPost) };
    }
  };
}
