import { assertSocialReceiptReplay, currentSocialMutationIdentity } from './social-idempotency.mjs';
import { MAX_FEED, SOCIAL_VERSION, fail, publicAccount, randomId } from './social-schema.mjs';

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

const post = row => ({
  id: row.id,
  text: row.text,
  replyTo: row.reply_to_id || null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  author: {
    id: row.author_id,
    handle: row.author_handle,
    name: row.author_name,
    bio: row.author_bio,
    accent: row.author_accent,
    createdAt: iso(row.author_created_at),
    updatedAt: iso(row.author_updated_at)
  },
  likeCount: Number(row.like_count || 0),
  replyCount: Number(row.reply_count || 0),
  liked: Boolean(row.liked),
  following: Boolean(row.following),
  mine: Boolean(row.mine)
});

const dbFail = error => {
  if (error?.status) return error;
  if (error?.code === '23505') {
    if (String(error.constraint || '').includes('handle')) return fail(409, 'That handle is taken.');
    if (String(error.constraint || '').includes('idempotency')) return fail(409, 'That idempotency key was already used.');
    return fail(409, 'That social mutation conflicts with existing state.');
  }
  if (error?.code === '23503') return fail(404, 'The referenced social object no longer exists.');
  return error;
};

const accountSelect = `
  SELECT u.id, p.handle, p.name, p.bio, p.accent,
         u.password_salt, u.password_hash,
         u.created_at, GREATEST(u.updated_at, p.updated_at) AS updated_at
  FROM social_users u
  JOIN social_public_profiles p ON p.user_id = u.id
`;

const projectionSelect = `
  SELECT p.id, p.text, p.reply_to_id, p.created_at, p.updated_at,
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
`;

export function createPostgresAuthority({ pool, afterMutation = async () => {} } = {}) {
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

  async function projected(client, postId, viewerId = '') {
    const { rows } = await client.query(`${projectionSelect} WHERE p.id = $2 AND p.deleted_at IS NULL LIMIT 1`, [viewerId, postId]);
    return rows[0] ? post(rows[0]) : null;
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

  return {
    async resolveSession(tokenHash, at) {
      const { rows } = await pool.query(
        `${accountSelect}
         JOIN social_sessions s ON s.user_id = u.id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
         LIMIT 1`,
        [tokenHash, at]
      );
      return rows[0] ? { tokenHash, account: account(rows[0]) } : null;
    },

    async accountForLogin(handle) {
      const client = await pool.connect();
      try { return await accountBy(client, 'handle', handle, true); }
      finally { client.release(); }
    },

    async profile(handle, viewerId = '') {
      const client = await pool.connect();
      try {
        const found = await accountBy(client, 'handle', handle);
        if (!found) return null;
        const relation = viewerId
          ? await client.query('SELECT 1 FROM social_follows WHERE follower_id = $1 AND followed_id = $2', [viewerId, found.id])
          : { rows: [] };
        return { account: publicAccount(found), following: Boolean(relation.rows[0]), mine: viewerId === found.id };
      } finally { client.release(); }
    },

    async register({ id, name, handle, bio, accent, password, tokenHash, at, expiresAt, idempotencyKey: key }) {
      return transaction(client => receipt(client, {
        scope: `register:${handle}`, operation: 'register', actorId: id, key, at
      }, async () => {
        await client.query(
          `INSERT INTO social_users (id, password_salt, password_hash, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)`,
          [id, password.salt, password.hash, at]
        );
        await client.query(
          `INSERT INTO social_public_profiles (user_id, handle, name, bio, accent, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [id, handle, name, bio, accent, at]
        );
        await client.query(
          'INSERT INTO social_sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
          [tokenHash, id, at, expiresAt]
        );
        await afterMutation({ operation: 'register', client, actorId: id });
        await event(client, { type: 'account.registered', actorId: id, key, payload: { handle }, at });
        return { status: 201, body: { account: publicAccount({ id, name, handle, bio, accent, createdAt: at, updatedAt: at }) } };
      }));
    },

    async startSession({ account: found, tokenHash, at, expiresAt, idempotencyKey: key }) {
      return transaction(client => receipt(client, {
        scope: `actor:${found.id}`, operation: 'login', actorId: found.id, key, at
      }, async () => {
        await client.query(
          `INSERT INTO social_sessions (token_hash, user_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id,
             created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, revoked_at = NULL`,
          [tokenHash, found.id, at, expiresAt]
        );
        await afterMutation({ operation: 'login', client, actorId: found.id });
        await event(client, { type: 'session.started', actorId: found.id, key, payload: {}, at });
        return { status: 200, body: { account: publicAccount(found) } };
      }));
    },

    async logout({ tokenHash, actorId, at, idempotencyKey: key }) {
      if (!actorId) return { status: 200, body: { signedOut: true } };
      return transaction(client => receipt(client, {
        scope: `actor:${actorId}`, operation: 'logout', actorId, key, at
      }, async () => {
        await client.query('DELETE FROM social_sessions WHERE token_hash = $1 AND user_id = $2', [tokenHash, actorId]);
        await afterMutation({ operation: 'logout', client, actorId });
        await event(client, { type: 'session.ended', actorId, key, payload: {}, at });
        return { status: 200, body: { signedOut: true } };
      }));
    },

    async updateProfile({ actorId, name, handle, bio, accent, at, idempotencyKey: key }) {
      return transaction(client => receipt(client, {
        scope: `actor:${actorId}`, operation: 'profile.update', actorId, key, at
      }, async () => {
        const current = await client.query('SELECT * FROM social_public_profiles WHERE user_id = $1 FOR UPDATE', [actorId]);
        if (!current.rows[0]) throw fail(404, 'Profile not found.');
        const value = current.rows[0];
        const next = {
          name: name ?? value.name,
          handle: handle ?? value.handle,
          bio: bio ?? value.bio,
          accent: accent ?? value.accent
        };
        await client.query(
          `UPDATE social_public_profiles SET handle = $2, name = $3, bio = $4, accent = $5, updated_at = $6
           WHERE user_id = $1`,
          [actorId, next.handle, next.name, next.bio, next.accent, at]
        );
        await client.query('UPDATE social_users SET updated_at = $2 WHERE id = $1', [actorId, at]);
        await afterMutation({ operation: 'profile.update', client, actorId });
        await event(client, { type: 'profile.updated', actorId, key, payload: { handle: next.handle }, at });
        return { status: 200, body: { account: publicAccount(await accountBy(client, 'id', actorId)) } };
      }));
    },

    async createPost({ id, actorId, text, replyTo, at, idempotencyKey: key }) {
      return transaction(client => receipt(client, {
        scope: `actor:${actorId}`, operation: 'post.create', actorId, key, at
      }, async () => {
        if (replyTo) {
          const parent = await client.query('SELECT id FROM social_posts WHERE id = $1 AND deleted_at IS NULL', [replyTo]);
          if (!parent.rows[0]) throw fail(404, 'The post you are replying to is gone.');
        }
        await client.query(
          `INSERT INTO social_posts (id, author_id, text, reply_to_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [id, actorId, text, replyTo, at]
        );
        await afterMutation({ operation: 'post.create', client, actorId, objectId: id });
        await event(client, {
          type: replyTo ? 'post.replied' : 'post.created', actorId, key,
          payload: { postId: id, replyTo }, at
        });
        return { status: 201, body: { post: await projected(client, id, actorId) } };
      }));
    },

    async setFollow({ actorId, handle, active, at, idempotencyKey: key }) {
      return transaction(client => receipt(client, {
        scope: `actor:${actorId}`, operation: 'follow.set', actorId, key, at
      }, async () => {
        const target = await accountBy(client, 'handle', handle);
        if (!target) throw fail(404, 'Profile not found.');
        if (target.id === actorId) throw fail(400, 'You already follow yourself.');
        if (active) {
          await client.query(
            `INSERT INTO social_follows (follower_id, followed_id, created_at)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [actorId, target.id, at]
          );
        } else {
          await client.query('DELETE FROM social_follows WHERE follower_id = $1 AND followed_id = $2', [actorId, target.id]);
        }
        await afterMutation({ operation: 'follow.set', client, actorId, objectId: target.id });
        await event(client, {
          type: active ? 'follow.created' : 'follow.deleted', actorId, key,
          payload: { targetId: target.id }, at
        });
        return { status: 200, body: { active, account: publicAccount(target) } };
      }));
    },

    async setLike({ actorId, postId, active, at, idempotencyKey: key }) {
      return transaction(client => receipt(client, {
        scope: `actor:${actorId}`, operation: 'like.set', actorId, key, at
      }, async () => {
        const found = await client.query('SELECT id FROM social_posts WHERE id = $1 AND deleted_at IS NULL', [postId]);
        if (!found.rows[0]) throw fail(404, 'Post not found.');
        if (active) {
          await client.query(
            `INSERT INTO social_reactions (actor_id, post_id, kind, created_at)
             VALUES ($1, $2, 'like', $3) ON CONFLICT DO NOTHING`,
            [actorId, postId, at]
          );
        } else {
          await client.query("DELETE FROM social_reactions WHERE actor_id = $1 AND post_id = $2 AND kind = 'like'", [actorId, postId]);
        }
        await afterMutation({ operation: 'like.set', client, actorId, objectId: postId });
        await event(client, {
          type: active ? 'like.created' : 'like.deleted', actorId, key,
          payload: { postId }, at
        });
        return { status: 200, body: { active, post: await projected(client, postId, actorId) } };
      }));
    },

    async listPosts({ viewerId = '', mode = 'discover' } = {}) {
      const where = mode === 'feed'
        ? `WHERE p.deleted_at IS NULL AND (p.author_id = $1 OR EXISTS (
             SELECT 1 FROM social_follows f WHERE f.follower_id = $1 AND f.followed_id = p.author_id
           ))`
        : 'WHERE p.deleted_at IS NULL';
      const { rows } = await pool.query(
        `${projectionSelect} ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${MAX_FEED}`,
        [viewerId]
      );
      return rows.map(post);
    }
  };
}
