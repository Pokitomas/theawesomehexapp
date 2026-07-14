-- Social Authority Schema v1
-- Transactional relational store for users, posts, follows, reactions, and events
-- All mutations write facts and events in atomic transactions

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  accent TEXT NOT NULL DEFAULT '#335cff',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(handle) >= 2 AND length(handle) <= 30),
  CHECK (length(name) >= 1 AND length(name) <= 48),
  CHECK (length(bio) <= 180)
);

CREATE INDEX IF NOT EXISTS idx_social_accounts_handle ON social_accounts(handle);
CREATE INDEX IF NOT EXISTS idx_social_accounts_created_at ON social_accounts(created_at);

CREATE TABLE IF NOT EXISTS social_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_social_sessions_account_id ON social_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_social_sessions_expires_at ON social_sessions(expires_at);

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  reply_to TEXT REFERENCES social_posts(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(text) >= 1 AND length(text) <= 4000)
);

CREATE INDEX IF NOT EXISTS idx_social_posts_author_id ON social_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_created_at ON social_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_reply_to ON social_posts(reply_to);

CREATE TABLE IF NOT EXISTS social_follows (
  follower_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  followed_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id != followed_id)
);

CREATE INDEX IF NOT EXISTS idx_social_follows_followed_id ON social_follows(followed_id);

CREATE TABLE IF NOT EXISTS social_likes (
  account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_social_likes_post_id ON social_likes(post_id);

CREATE TABLE IF NOT EXISTS social_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (type IN ('account.registered', 'session.started', 'profile.updated', 
                   'post.created', 'post.replied', 'follow.created', 'follow.deleted',
                   'like.created', 'like.deleted'))
);

CREATE INDEX IF NOT EXISTS idx_social_events_account_id ON social_events(account_id);
CREATE INDEX IF NOT EXISTS idx_social_events_created_at ON social_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_events_type ON social_events(type);

-- Idempotency tracking: prevent duplicate mutations
CREATE TABLE IF NOT EXISTS social_idempotency (
  account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, idempotency_key),
  CHECK (length(idempotency_key) > 0)
);

CREATE INDEX IF NOT EXISTS idx_social_idempotency_created_at ON social_idempotency(created_at);