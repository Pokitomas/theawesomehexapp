import { contentState, visibleText } from './community-authority.mjs';
import { createPostgresCommunityAuthority } from './social-postgres-community.mjs';
import { MAX_FEED, SOCIAL_VERSION, fail, publicAccount, randomId } from './social-schema.mjs';
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
    const lockKey = JSON.stringify([scope, key]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))', [lockKey]);
    const prior = await client.query(
      'SELECT operation, status, body FROM social_mutation_receipts WHERE scope = $1 AND idempotency_key = $2',
      [scope, key]
    );
    if (prior.rows[0]) {
      if (prior.rows[0].operation !== operation) throw fail(409, 'That idempotency key belongs to another operation.');
      return { status: Number(prior.rows[0].status), body: prior.rows[0].body, replayed: true };
    }
    const result = await mutate();
    await client.query(
      `INSERT INTO social_mutation_receipts
       (scope, idempotency_key, operation, actor_id, status, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [scope, key, operation, actorId, result.status, JSON.stringify(result.body), at]
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
    const thread = await authority.thread({ postId, viewerId });
    if (!thread || !viewerId) return thread;
    const controls = await controlsFor(viewerId);
    return { ...thread, posts: thread.posts.map(post => viewerThreadProjection(post, controls)) };
  }

  return {
    ...authority,
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
