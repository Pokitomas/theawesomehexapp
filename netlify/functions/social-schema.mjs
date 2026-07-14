export const SOCIAL_SCHEMA_VERSION = 1;

export const SOCIAL_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS profiles (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    handle text NOT NULL UNIQUE,
    display_name text NOT NULL,
    bio text NOT NULL DEFAULT '',
    avatar text NOT NULL DEFAULT '',
    cover text NOT NULL DEFAULT '',
    pronouns text NOT NULL DEFAULT '',
    website text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_hash text NOT NULL UNIQUE,
    refresh_hash text NOT NULL UNIQUE,
    access_expires_at timestamptz NOT NULL,
    refresh_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id text PRIMARY KEY,
    author_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body text NOT NULL,
    visibility text NOT NULL DEFAULT 'public',
    reply_to_id text REFERENCES posts(id),
    repost_of_id text REFERENCES posts(id),
    content_warning text NOT NULL DEFAULT '',
    language text NOT NULL DEFAULT 'und',
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS follows (
    follower_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followed_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followed_id),
    CHECK (follower_id <> followed_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reactions (
    actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    kind text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (actor_id, post_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id text PRIMARY KEY,
    actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type text NOT NULL,
    object_type text NOT NULL,
    object_id text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    response jsonb,
    idempotency_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS posts_author_created_idx ON posts(author_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS posts_reply_created_idx ON posts(reply_to_id, created_at ASC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS events_actor_created_idx ON events(actor_id, created_at DESC, id DESC)`
]);
