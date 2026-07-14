BEGIN;

CREATE TABLE IF NOT EXISTS social_users (
  id text PRIMARY KEY,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS social_public_profiles (
  user_id text PRIMARY KEY REFERENCES social_users(id) ON DELETE CASCADE,
  handle text NOT NULL,
  name text NOT NULL,
  bio text NOT NULL DEFAULT '',
  accent text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT social_public_profiles_handle_lower CHECK (handle = lower(handle)),
  CONSTRAINT social_public_profiles_handle_unique UNIQUE (handle)
);

CREATE TABLE IF NOT EXISTS social_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES social_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS social_posts (
  id text PRIMARY KEY,
  author_id text NOT NULL REFERENCES social_users(id) ON DELETE RESTRICT,
  text text NOT NULL,
  reply_to_id text REFERENCES social_posts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT social_posts_text_nonempty CHECK (length(text) > 0)
);

CREATE TABLE IF NOT EXISTS social_follows (
  follower_id text NOT NULL REFERENCES social_users(id) ON DELETE CASCADE,
  followed_id text NOT NULL REFERENCES social_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (follower_id, followed_id),
  CONSTRAINT social_follows_not_self CHECK (follower_id <> followed_id)
);

CREATE TABLE IF NOT EXISTS social_reactions (
  actor_id text NOT NULL REFERENCES social_users(id) ON DELETE CASCADE,
  post_id text NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, post_id, kind),
  CONSTRAINT social_reactions_kind CHECK (kind IN ('like'))
);

CREATE TABLE IF NOT EXISTS social_events (
  id text PRIMARY KEY,
  version integer NOT NULL,
  type text NOT NULL,
  actor_id text NOT NULL REFERENCES social_users(id) ON DELETE RESTRICT,
  idempotency_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS social_events_actor_idempotency_unique
  ON social_events(actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS social_mutation_receipts (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  actor_id text REFERENCES social_users(id) ON DELETE RESTRICT,
  status integer NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS social_sessions_user_active_idx
  ON social_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS social_posts_created_idx
  ON social_posts(created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS social_posts_reply_idx
  ON social_posts(reply_to_id)
  WHERE reply_to_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS social_follows_followed_idx
  ON social_follows(followed_id, follower_id);
CREATE INDEX IF NOT EXISTS social_reactions_post_idx
  ON social_reactions(post_id, kind);
CREATE INDEX IF NOT EXISTS social_events_actor_created_idx
  ON social_events(actor_id, created_at DESC);

COMMIT;
