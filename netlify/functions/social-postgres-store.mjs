import { randomUUID } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { SOCIAL_SCHEMA } from './social-schema.mjs';

const clone = value => value == null ? value : structuredClone(value);
const asISO = value => value ? new Date(value).toISOString() : null;
const uniqueError = error => {
  if (error?.code !== '23505') return error;
  const text = `${error.constraint || ''} ${error.detail || ''}`;
  if (/email/i.test(text)) return Object.assign(new Error('Email already exists.'), { code: 'unique_email' });
  if (/handle/i.test(text)) return Object.assign(new Error('Handle already exists.'), { code: 'unique_handle' });
  return error;
};

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    status: row.status,
    createdAt: asISO(row.created_at),
    profile: row.handle ? {
      userId: row.id,
      handle: row.handle,
      displayName: row.display_name,
      bio: row.bio || '',
      avatar: row.avatar || '',
      cover: row.cover || '',
      pronouns: row.pronouns || '',
      website: row.website || '',
      createdAt: asISO(row.profile_created_at),
      updatedAt: asISO(row.updated_at)
    } : null
  };
}

function safeEventUser(bundle) {
  return bundle ? { id: bundle.id, status: bundle.status, createdAt: bundle.createdAt, profile: clone(bundle.profile) } : null;
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    accessHash: row.access_hash,
    refreshHash: row.refresh_hash,
    accessExpiresAt: asISO(row.access_expires_at),
    refreshExpiresAt: asISO(row.refresh_expires_at),
    createdAt: asISO(row.created_at),
    revokedAt: asISO(row.revoked_at)
  };
}

function mapPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    authorId: row.author_id,
    body: row.body || '',
    visibility: row.visibility,
    replyToId: row.reply_to_id || null,
    repostOfId: row.repost_of_id || null,
    contentWarning: row.content_warning || '',
    language: row.language || 'und',
    createdAt: asISO(row.created_at),
    editedAt: asISO(row.edited_at),
    deletedAt: asISO(row.deleted_at),
    author: row.handle ? {
      id: row.author_id,
      handle: row.handle,
      displayName: row.display_name,
      bio: row.bio || '',
      avatar: row.avatar || '',
      cover: row.cover || '',
      pronouns: row.pronouns || '',
      website: row.website || ''
    } : null,
    engagement: {
      likes: Number(row.like_count || 0),
      replies: Number(row.reply_count || 0),
      viewerLiked: Boolean(row.viewer_liked)
    }
  };
}

const USER_SELECT = `
  SELECT u.*, p.handle, p.display_name, p.bio, p.avatar, p.cover, p.pronouns, p.website,
         p.created_at AS profile_created_at, p.updated_at
  FROM users u JOIN profiles p ON p.user_id = u.id`;

const POST_SELECT = viewerParam => `
  SELECT p.*, pr.handle, pr.display_name, pr.bio, pr.avatar, pr.cover, pr.pronouns, pr.website,
    (SELECT count(*) FROM reactions r WHERE r.post_id = p.id AND r.kind = 'like') AS like_count,
    (SELECT count(*) FROM posts child WHERE child.reply_to_id = p.id AND child.deleted_at IS NULL) AS reply_count,
    EXISTS(SELECT 1 FROM reactions mine WHERE mine.post_id = p.id AND mine.kind = 'like' AND mine.actor_id = ${viewerParam}) AS viewer_liked
  FROM posts p JOIN profiles pr ON pr.user_id = p.author_id`;

export function createPostgresSocialStore({ connectionString = process.env.DATABASE_URL } = {}) {
  if (!connectionString) throw Object.assign(new Error('DATABASE_URL is required for the public social service.'), { status: 503 });
  const pool = new Pool({ connectionString });
  let schemaReady;

  const ensureSchema = () => schemaReady ||= (async () => {
    const client = await pool.connect();
    try {
      for (const statement of SOCIAL_SCHEMA) await client.query(statement);
    } finally { client.release(); }
  })();

  const transaction = async work => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw uniqueError(error);
    } finally { client.release(); }
  };

  const queryUser = async (where, params) => mapUser((await pool.query(`${USER_SELECT} WHERE ${where} LIMIT 1`, params)).rows[0]);
  const replay = async (client, actorId, key) => {
    if (!key) return null;
    const row = (await client.query('SELECT response FROM events WHERE actor_id=$1 AND idempotency_key=$2 LIMIT 1', [actorId, key])).rows[0];
    return row?.response ?? null;
  };
  const appendEvent = (client, { actorId, type, objectType, objectId, payload = {}, response = null, idempotencyKey = '' }) => client.query(
    `INSERT INTO events(id,actor_id,type,object_type,object_id,payload,response,idempotency_key)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [`evt_${randomUUID()}`, actorId, type, objectType, objectId, JSON.stringify(payload), JSON.stringify(response), idempotencyKey || null]
  );
  const postById = async (postId, viewerId = '') => mapPost((await pool.query(`${POST_SELECT('$2')} WHERE p.id=$1 LIMIT 1`, [postId, viewerId || '__anonymous__'])).rows[0]);

  return Object.freeze({
    kind: 'postgres',
    ensureSchema,
    async createUser({ email, passwordHash, profile, idempotencyKey = '' }) {
      return transaction(async client => {
        const id = `usr_${randomUUID()}`;
        await client.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [id, email, passwordHash]);
        await client.query(`INSERT INTO profiles(user_id,handle,display_name,bio,avatar,cover,pronouns,website)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, profile.handle, profile.displayName, profile.bio || '', profile.avatar || '', profile.cover || '', profile.pronouns || '', profile.website || '']);
        const bundle = mapUser((await client.query(`${USER_SELECT} WHERE u.id=$1`, [id])).rows[0]);
        await appendEvent(client, { actorId: id, type: 'account.created', objectType: 'user', objectId: id, payload: { handle: profile.handle }, response: safeEventUser(bundle), idempotencyKey });
        return bundle;
      });
    },
    async findUserByEmail(email) {
      const row = (await pool.query('SELECT * FROM users WHERE email=$1 LIMIT 1', [email])).rows[0];
      return row ? { id: row.id, email: row.email, passwordHash: row.password_hash, status: row.status, createdAt: asISO(row.created_at) } : null;
    },
    getUserById: id => queryUser('u.id=$1', [id]),
    getUserByHandle: handle => queryUser('p.handle=$1', [handle]),
    async updateProfile(userId, patch, idempotencyKey = '') {
      return transaction(async client => {
        const old = await replay(client, userId, idempotencyKey);
        if (old) return clone(old);
        const fields = [];
        const values = [];
        const columns = { handle: 'handle', displayName: 'display_name', bio: 'bio', avatar: 'avatar', cover: 'cover', pronouns: 'pronouns', website: 'website' };
        for (const [key, column] of Object.entries(columns)) {
          if (patch[key] === undefined) continue;
          values.push(patch[key]);
          fields.push(`${column}=$${values.length}`);
        }
        values.push(userId);
        await client.query(`UPDATE profiles SET ${fields.join(', ')}, updated_at=now() WHERE user_id=$${values.length}`, values);
        const bundle = mapUser((await client.query(`${USER_SELECT} WHERE u.id=$1`, [userId])).rows[0]);
        await appendEvent(client, { actorId: userId, type: 'profile.updated', objectType: 'profile', objectId: userId, payload: patch, response: safeEventUser(bundle), idempotencyKey });
        return bundle;
      });
    },
    async createSession({ userId, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt }) {
      const id = `ses_${randomUUID()}`;
      const row = (await pool.query(`INSERT INTO sessions(id,user_id,access_hash,refresh_hash,access_expires_at,refresh_expires_at)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [id, userId, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt])).rows[0];
      return mapSession(row);
    },
    async sessionByAccessHash(hash) { return mapSession((await pool.query('SELECT * FROM sessions WHERE access_hash=$1 LIMIT 1', [hash])).rows[0]); },
    async sessionByRefreshHash(hash) { return mapSession((await pool.query('SELECT * FROM sessions WHERE refresh_hash=$1 LIMIT 1', [hash])).rows[0]); },
    async rotateSession(id, next) {
      return mapSession((await pool.query(`UPDATE sessions SET access_hash=$2,access_expires_at=$3,refresh_hash=$4,refresh_expires_at=$5
        WHERE id=$1 AND revoked_at IS NULL RETURNING *`, [id, next.accessHash, next.accessExpiresAt, next.refreshHash, next.refreshExpiresAt])).rows[0]);
    },
    async revokeSession(id) { return Boolean((await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id', [id])).rowCount); },
    async createPost(actorId, input, idempotencyKey = '') {
      const postId = await transaction(async client => {
        const old = await replay(client, actorId, idempotencyKey);
        if (old) return { replay: old };
        const id = `post_${randomUUID()}`;
        await client.query(`INSERT INTO posts(id,author_id,body,visibility,reply_to_id,repost_of_id,content_warning,language)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, actorId, input.body, input.visibility, input.replyToId, input.repostOfId, input.contentWarning, input.language]);
        const basic = { id, authorId: actorId, body: input.body, visibility: input.visibility, replyToId: input.replyToId, repostOfId: input.repostOfId };
        await appendEvent(client, { actorId, type: 'post.created', objectType: 'post', objectId: id, payload: { replyToId: input.replyToId, repostOfId: input.repostOfId }, response: basic, idempotencyKey });
        return { id };
      });
      if (postId.replay?.id) return postById(postId.replay.id, actorId);
      return postById(postId.id, actorId);
    },
    getPost: postById,
    async deletePost(actorId, postId, idempotencyKey = '') {
      const result = await transaction(async client => {
        const old = await replay(client, actorId, idempotencyKey);
        if (old) return old;
        const changed = (await client.query(`UPDATE posts SET body='',deleted_at=now() WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL RETURNING id`, [postId, actorId])).rows[0];
        if (!changed) return null;
        const payload = { id: postId, deletedAt: new Date().toISOString() };
        await appendEvent(client, { actorId, type: 'post.deleted', objectType: 'post', objectId: postId, response: payload, idempotencyKey });
        return payload;
      });
      return result ? postById(postId, actorId) : null;
    },
    async setFollow(actorId, followedId, active, idempotencyKey = '') {
      return transaction(async client => {
        const old = await replay(client, actorId, idempotencyKey);
        if (old) return clone(old);
        if (active) await client.query('INSERT INTO follows(follower_id,followed_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [actorId, followedId]);
        else await client.query('DELETE FROM follows WHERE follower_id=$1 AND followed_id=$2', [actorId, followedId]);
        const result = { followerId: actorId, followedId, following: active };
        await appendEvent(client, { actorId, type: active ? 'follow.created' : 'follow.deleted', objectType: 'user', objectId: followedId, response: result, idempotencyKey });
        return result;
      });
    },
    async setReaction(actorId, postId, active, kind = 'like', idempotencyKey = '') {
      const result = await transaction(async client => {
        const old = await replay(client, actorId, idempotencyKey);
        if (old) return old;
        const exists = (await client.query('SELECT id FROM posts WHERE id=$1', [postId])).rows[0];
        if (!exists) return null;
        if (active) await client.query('INSERT INTO reactions(actor_id,post_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [actorId, postId, kind]);
        else await client.query('DELETE FROM reactions WHERE actor_id=$1 AND post_id=$2 AND kind=$3', [actorId, postId, kind]);
        const payload = { actorId, postId, kind, active };
        await appendEvent(client, { actorId, type: active ? 'reaction.created' : 'reaction.deleted', objectType: 'post', objectId: postId, payload: { kind }, response: payload, idempotencyKey });
        return payload;
      });
      if (!result) return null;
      return { ...result, post: await postById(postId, actorId) };
    },
    async followingFeed(viewerId, { cursor = null, limit = 30 } = {}) {
      const params = [viewerId, viewerId, limit + 1];
      let cursorClause = '';
      if (cursor) {
        params.push(cursor);
        cursorClause = `AND (p.created_at,p.id) < (SELECT created_at,id FROM posts WHERE id=$4)`;
      }
      const rows = (await pool.query(`${POST_SELECT('$2')}
        WHERE p.deleted_at IS NULL AND p.visibility='public'
          AND (p.author_id=$1 OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.followed_id=p.author_id))
          ${cursorClause}
        ORDER BY p.created_at DESC,p.id DESC LIMIT $3`, params)).rows.map(mapPost);
      return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
    },
    async userPosts(userId, viewerId, { cursor = null, limit = 30 } = {}) {
      const params = [userId, viewerId || '__anonymous__', limit + 1];
      let cursorClause = '';
      if (cursor) {
        params.push(cursor);
        cursorClause = `AND (p.created_at,p.id) < (SELECT created_at,id FROM posts WHERE id=$4)`;
      }
      const rows = (await pool.query(`${POST_SELECT('$2')} WHERE p.author_id=$1 AND p.deleted_at IS NULL AND p.visibility='public' ${cursorClause}
        ORDER BY p.created_at DESC,p.id DESC LIMIT $3`, params)).rows.map(mapPost);
      return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
    },
    async thread(postId, viewerId, { cursor = null, limit = 30 } = {}) {
      const root = await postById(postId, viewerId);
      if (!root) return null;
      const ancestors = [];
      let parentId = root.replyToId;
      const seen = new Set();
      while (parentId && !seen.has(parentId) && ancestors.length < 50) {
        seen.add(parentId);
        const parent = await postById(parentId, viewerId);
        if (!parent) break;
        ancestors.unshift(parent);
        parentId = parent.replyToId;
      }
      const params = [postId, viewerId || '__anonymous__', limit + 1];
      let cursorClause = '';
      if (cursor) { params.push(cursor); cursorClause = `AND (p.created_at,p.id) > (SELECT created_at,id FROM posts WHERE id=$4)`; }
      const rows = (await pool.query(`${POST_SELECT('$2')} WHERE p.reply_to_id=$1 AND p.deleted_at IS NULL ${cursorClause}
        ORDER BY p.created_at ASC,p.id ASC LIMIT $3`, params)).rows.map(mapPost);
      return { root, ancestors, replies: rows.slice(0, limit), continuation: rows.length > limit ? rows[limit - 1].id : null };
    },
    async listEvents() { return (await pool.query('SELECT * FROM events ORDER BY created_at ASC,id ASC')).rows.map(row => ({ ...row, createdAt: asISO(row.created_at) })); },
    async close() { await pool.end(); }
  });
}
