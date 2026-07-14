BEGIN;

CREATE TABLE IF NOT EXISTS social_communities (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by text NOT NULL REFERENCES social_users(id) ON DELETE RESTRICT,
  parent_community_id text REFERENCES social_communities(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'active',
  current_policy_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT social_communities_slug_lower CHECK (slug = lower(slug)),
  CONSTRAINT social_communities_state CHECK (state IN ('active', 'forked', 'archived'))
);

CREATE TABLE IF NOT EXISTS social_community_policy_versions (
  id text PRIMARY KEY,
  community_id text NOT NULL REFERENCES social_communities(id) ON DELETE CASCADE,
  version integer NOT NULL,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL REFERENCES social_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  UNIQUE (community_id, version)
);

CREATE TABLE IF NOT EXISTS social_community_memberships (
  community_id text NOT NULL REFERENCES social_communities(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES social_users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (community_id, user_id),
  CONSTRAINT social_community_memberships_role CHECK (role IN ('member', 'moderator', 'owner')),
  CONSTRAINT social_community_memberships_status CHECK (status IN ('active', 'left', 'banned'))
);

ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS community_id text REFERENCES social_communities(id) ON DELETE RESTRICT;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS thread_root_id text REFERENCES social_posts(id) ON DELETE RESTRICT;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS author_deleted_at timestamptz;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS moderator_removed_at timestamptz;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS legal_restricted_at timestamptz;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS locked_at timestamptz;

CREATE OR REPLACE FUNCTION social_enforce_conversation_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_row social_posts%ROWTYPE;
BEGIN
  IF NEW.reply_to_id IS NULL THEN
    IF NEW.community_id IS NOT NULL THEN NEW.thread_root_id := NEW.id; END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO parent_row FROM social_posts WHERE id = NEW.reply_to_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF parent_row.community_id IS NOT NULL THEN
    IF NEW.community_id IS NULL OR NEW.community_id <> parent_row.community_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Replies inherit the parent community authority.';
    END IF;
    IF parent_row.author_deleted_at IS NOT NULL
       OR parent_row.moderator_removed_at IS NOT NULL
       OR parent_row.legal_restricted_at IS NOT NULL
       OR parent_row.locked_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'This conversation cannot receive new replies.';
    END IF;
    NEW.thread_root_id := COALESCE(parent_row.thread_root_id, parent_row.id);
  ELSIF NEW.community_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Community replies require a community parent.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS social_posts_conversation_authority ON social_posts;
CREATE TRIGGER social_posts_conversation_authority
BEFORE INSERT OR UPDATE OF reply_to_id, community_id ON social_posts
FOR EACH ROW EXECUTE FUNCTION social_enforce_conversation_authority();

CREATE OR REPLACE FUNCTION social_sync_legacy_deletion_visibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.author_deleted_at IS NOT NULL
     OR NEW.moderator_removed_at IS NOT NULL
     OR NEW.legal_restricted_at IS NOT NULL THEN
    NEW.deleted_at := COALESCE(NEW.deleted_at, NEW.author_deleted_at, NEW.moderator_removed_at, NEW.legal_restricted_at, now());
  ELSE
    NEW.deleted_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS social_posts_visibility_projection ON social_posts;
CREATE TRIGGER social_posts_visibility_projection
BEFORE INSERT OR UPDATE OF author_deleted_at, moderator_removed_at, legal_restricted_at ON social_posts
FOR EACH ROW EXECUTE FUNCTION social_sync_legacy_deletion_visibility();

UPDATE social_posts
SET thread_root_id = id
WHERE thread_root_id IS NULL AND reply_to_id IS NULL;

WITH RECURSIVE roots AS (
  SELECT id, id AS root_id
  FROM social_posts
  WHERE reply_to_id IS NULL
  UNION ALL
  SELECT child.id, roots.root_id
  FROM social_posts child
  JOIN roots ON child.reply_to_id = roots.id
)
UPDATE social_posts post
SET thread_root_id = roots.root_id
FROM roots
WHERE post.id = roots.id AND post.thread_root_id IS NULL;

CREATE TABLE IF NOT EXISTS social_post_revisions (
  id text PRIMARY KEY,
  post_id text NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  text text NOT NULL,
  editor_id text NOT NULL REFERENCES social_users(id) ON DELETE RESTRICT,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  UNIQUE (post_id, revision)
);

INSERT INTO social_post_revisions (id, post_id, revision, text, editor_id, reason, created_at)
SELECT 'rev_' || id, id, 1, text, author_id, 'migration', created_at
FROM social_posts
ON CONFLICT (post_id, revision) DO NOTHING;

CREATE TABLE IF NOT EXISTS social_moderation_cases (
  id text PRIMARY KEY,
  community_id text NOT NULL REFERENCES social_communities(id) ON DELETE CASCADE,
  post_id text REFERENCES social_posts(id) ON DELETE RESTRICT,
  subject_user_id text REFERENCES social_users(id) ON DELETE RESTRICT,
  opened_by text NOT NULL REFERENCES social_users(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT social_moderation_cases_subject CHECK (post_id IS NOT NULL OR subject_user_id IS NOT NULL),
  CONSTRAINT social_moderation_cases_status CHECK (status IN ('open', 'actioned', 'appealed', 'resolved'))
);

CREATE TABLE IF NOT EXISTS social_moderation_actions (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES social_moderation_cases(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES social_users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  CONSTRAINT social_moderation_actions_action CHECK (action IN ('remove', 'restore', 'lock', 'unlock', 'ban', 'unban', 'restrict', 'unrestrict'))
);

CREATE TABLE IF NOT EXISTS social_appeals (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES social_moderation_cases(id) ON DELETE CASCADE,
  appellant_id text NOT NULL REFERENCES social_users(id) ON DELETE RESTRICT,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_by text REFERENCES social_users(id) ON DELETE RESTRICT,
  decision_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  CONSTRAINT social_appeals_status CHECK (status IN ('pending', 'upheld', 'reversed'))
);

CREATE TABLE IF NOT EXISTS social_local_controls (
  actor_id text NOT NULL REFERENCES social_users(id) ON DELETE CASCADE,
  target_type text NOT NULL,
  target_id text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, target_type, target_id, kind),
  CONSTRAINT social_local_controls_target CHECK (target_type IN ('user', 'community', 'post')),
  CONSTRAINT social_local_controls_kind CHECK (kind IN ('hide', 'mute', 'block'))
);

CREATE INDEX IF NOT EXISTS social_communities_parent_idx ON social_communities(parent_community_id);
CREATE INDEX IF NOT EXISTS social_community_memberships_user_idx ON social_community_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS social_posts_community_created_idx ON social_posts(community_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS social_posts_thread_idx ON social_posts(thread_root_id, created_at, id);
CREATE INDEX IF NOT EXISTS social_post_revisions_post_idx ON social_post_revisions(post_id, revision DESC);
CREATE INDEX IF NOT EXISTS social_moderation_cases_community_idx ON social_moderation_cases(community_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS social_appeals_case_idx ON social_appeals(case_id, status);

COMMIT;
