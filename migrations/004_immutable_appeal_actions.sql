BEGIN;

ALTER TABLE social_appeals
  ADD COLUMN IF NOT EXISTS appealed_action_id text REFERENCES social_moderation_actions(id) ON DELETE RESTRICT;

ALTER TABLE social_appeals
  ADD COLUMN IF NOT EXISTS appeal_target jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS social_appeals_appealed_action_unique
  ON social_appeals(appealed_action_id)
  WHERE appealed_action_id IS NOT NULL;

COMMIT;
