import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'sideways_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const randomId = (bytes = 18) => randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function passwordMatches(password, record = {}) {
  try {
    return safeEqual(scryptSync(password, record.salt, 64).toString('hex'), record.hash);
  } catch {
    return false;
  }
}

/**
 * PostgreSQL store adapter for social service
 * Manages transactional integrity for accounts, posts, follows, likes, and events
 */
export function createPostgresStore(pool) {
  if (!pool) throw new Error('Database pool is required.');

  return {
    /**
     * Execute a query and return the result
     */
    async query(text, values = []) {
      const client = await pool.connect();
      try {
        return await client.query(text, values);
      } finally {
        client.release();
      }
    },

    /**
     * Get a single row by key (for compatibility layer)
     * Maps to internal lookups by type
     */
    async get(key) {
      if (!key.startsWith('social/')) return null;

      const [type, ...parts] = key.slice(7).split('/');

      if (type === 'account') {
        const [id] = parts;
        const result = await this.query('SELECT * FROM social_accounts WHERE id = $1', [id]);
        if (!result.rows[0]) return null;
        const row = result.rows[0];
        return {
          id: row.id,
          handle: row.handle,
          name: row.name,
          bio: row.bio,
          accent: row.accent,
          password: { salt: row.password_salt, hash: row.password_hash },
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString()
        };
      }

      if (type === 'handle') {
        const [handle] = parts;
        const result = await this.query('SELECT id FROM social_accounts WHERE handle = $1', [handle]);
        return result.rows[0] ? { accountId: result.rows[0].id, at: new Date().toISOString() } : null;
      }

      if (type === 'session') {
        const tokenHash = sha256(Buffer.from(parts.join('/'), 'base64url'));
        const result = await this.query('SELECT * FROM social_sessions WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
        if (!result.rows[0]) return null;
        const row = result.rows[0];
        return {
          accountId: row.account_id,
          createdAt: row.created_at.toISOString(),
          expiresAt: row.expires_at.toISOString()
        };
      }

      if (type === 'post') {
        const [id] = parts;
        const result = await this.query('SELECT * FROM social_posts WHERE id = $1', [id]);
        if (!result.rows[0]) return null;
        const row = result.rows[0];
        return {
          id: row.id,
          authorId: row.author_id,
          text: row.text,
          replyTo: row.reply_to || null,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString()
        };
      }

      if (type === 'follow') {
        const [viewerId, targetId] = parts;
        const result = await this.query('SELECT * FROM social_follows WHERE follower_id = $1 AND followed_id = $2', [viewerId, targetId]);
        return result.rows[0] ? { viewerId, targetId, at: result.rows[0].created_at.toISOString() } : null;
      }

      if (type === 'like') {
        const [viewerId, postId] = parts;
        const result = await this.query('SELECT * FROM social_likes WHERE account_id = $1 AND post_id = $2', [viewerId, postId]);
        return result.rows[0] ? { viewerId, postId, at: result.rows[0].created_at.toISOString() } : null;
      }

      if (type === 'like-post') {
        const [postId, viewerId] = parts;
        const result = await this.query('SELECT * FROM social_likes WHERE post_id = $1 AND account_id = $2', [postId, viewerId]);
        return result.rows[0] ? { viewerId, postId, at: result.rows[0].created_at.toISOString() } : null;
      }

      return null;
    },

    /**
     * Set a key-value pair
     */
    async set(key, value) {
      if (!key.startsWith('social/')) return;

      const [type, ...parts] = key.slice(7).split('/');
      const now = new Date();

      if (type === 'account') {
        const account = value;
        await this.query(
          `INSERT INTO social_accounts (id, handle, name, bio, accent, password_hash, password_salt, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET
           name = $3, bio = $4, accent = $5, updated_at = $9`,
          [
            account.id,
            account.handle,
            account.name,
            account.bio || '',
            account.accent || '#335cff',
            account.password.hash,
            account.password.salt,
            new Date(account.createdAt),
            new Date(account.updatedAt)
          ]
        );
      }

      if (type === 'handle') {
        const handle = parts[0];
        const { accountId } = value;
        await this.query(
          `INSERT INTO social_accounts (id, handle, name, bio, accent, password_hash, password_salt, created_at, updated_at)
           VALUES ($1, $2, '', '', '#335cff', '', '', $3, $3)
           ON CONFLICT (handle) DO NOTHING`,
          [accountId, handle, now]
        );
      }

      if (type === 'session') {
        const session = value;
        const tokenHash = sha256(Buffer.from(parts.join('/'), 'base64url'));
        await this.query(
          `INSERT INTO social_sessions (token_hash, account_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [tokenHash, session.accountId, new Date(session.createdAt), new Date(session.expiresAt)]
        );
      }

      if (type === 'post') {
        const post = value;
        await this.query(
          `INSERT INTO social_posts (id, author_id, text, reply_to, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET text = $3, updated_at = $6`,
          [post.id, post.authorId, post.text, post.replyTo || null, new Date(post.createdAt), new Date(post.updatedAt)]
        );
      }

      if (type === 'follow') {
        const [viewerId, targetId] = parts;
        const follow = value;
        await this.query(
          `INSERT INTO social_follows (follower_id, followed_id, created_at)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [viewerId, targetId, new Date(follow.at)]
        );
      }

      if (type === 'like') {
        const [viewerId, postId] = parts;
        const like = value;
        await this.query(
          `INSERT INTO social_likes (account_id, post_id, created_at)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [viewerId, postId, new Date(like.at)]
        );
      }

      if (type === 'event') {
        const event = value;
        await this.query(
          `INSERT INTO social_events (id, type, account_id, created_at, payload)
           VALUES ($1, $2, $3, $4, $5)`,
          [event.id, event.type, event.actorId, new Date(event.at), JSON.stringify(event.payload || {})]
        );
      }
    },

    /**
     * Delete a key
     */
    async delete(key) {
      if (!key.startsWith('social/')) return;

      const [type, ...parts] = key.slice(7).split('/');

      if (type === 'session') {
        const tokenHash = sha256(Buffer.from(parts.join('/'), 'base64url'));
        await this.query('UPDATE social_sessions SET revoked_at = NOW() WHERE token_hash = $1', [tokenHash]);
      }

      if (type === 'follow') {
        const [viewerId, targetId] = parts;
        await this.query('DELETE FROM social_follows WHERE follower_id = $1 AND followed_id = $2', [viewerId, targetId]);
      }

      if (type === 'like') {
        const [viewerId, postId] = parts;
        await this.query('DELETE FROM social_likes WHERE account_id = $1 AND post_id = $2', [viewerId, postId]);
      }
    },

    /**
     * List keys by prefix
     */
    async list(prefix = '') {
      if (!prefix.startsWith('social/')) return [];

      const [type] = prefix.slice(7).split('/');

      if (type === 'follow') {
        const viewerId = prefix.split('/')[2];
        const result = await this.query('SELECT follower_id, followed_id FROM social_follows WHERE follower_id = $1', [viewerId]);
        return result.rows.map(row => `social/follow/${row.follower_id}/${row.followed_id}`);
      }

      if (type === 'like') {
        const viewerId = prefix.split('/')[2];
        const result = await this.query('SELECT account_id, post_id FROM social_likes WHERE account_id = $1', [viewerId]);
        return result.rows.map(row => `social/like/${row.account_id}/${row.post_id}`);
      }

      if (type === 'like-post') {
        const postId = prefix.split('/')[2];
        const result = await this.query('SELECT account_id, post_id FROM social_likes WHERE post_id = $1', [postId]);
        return result.rows.map(row => `social/like-post/${row.post_id}/${row.account_id}`);
      }

      if (type === 'post') {
        const result = await this.query('SELECT id FROM social_posts ORDER BY created_at DESC');
        return result.rows.map(row => `social/post/${row.id}`);
      }

      return [];
    }
  };
}

export { SESSION_COOKIE, SESSION_TTL_MS, sha256, randomId, safeEqual, passwordRecord, passwordMatches };
