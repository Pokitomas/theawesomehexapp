import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { MIGRATIONS, ensureSocialSchema } from '../../netlify/functions/social-postgres-migrations.mjs';

const { Pool } = pg;
const connectionString = process.env.POSTGRES_URL || process.env.SOCIAL_DATABASE_URL || '';
const enabled = Boolean(connectionString);

test('fresh production PostgreSQL bootstraps the complete social authority exactly once across runtimes', { skip: !enabled }, async () => {
  const admin = new Pool({ connectionString, max: 2 });
  await admin.query(`
    DROP TABLE IF EXISTS
      social_local_controls,
      social_appeals,
      social_moderation_actions,
      social_moderation_cases,
      social_post_revisions,
      social_community_memberships,
      social_community_policy_versions,
      social_communities,
      social_mutation_receipts,
      social_events,
      social_reactions,
      social_follows,
      social_posts,
      social_sessions,
      social_public_profiles,
      social_users,
      social_schema_migrations
    CASCADE
  `);
  await admin.query('DROP FUNCTION IF EXISTS social_enforce_conversation_authority() CASCADE');
  await admin.query('DROP FUNCTION IF EXISTS social_sync_legacy_deletion_visibility() CASCADE');
  await admin.end();

  const poolA = new Pool({ connectionString, max: 2 });
  const poolB = new Pool({ connectionString, max: 2 });
  await Promise.all([ensureSocialSchema(poolA), ensureSocialSchema(poolB)]);

  const { rows: migrations } = await poolA.query('SELECT name FROM social_schema_migrations ORDER BY name');
  assert.deepEqual(migrations.map(row => row.name), [...MIGRATIONS]);

  const { rows: [shape] } = await poolA.query(`
    SELECT
      to_regclass('public.social_users') IS NOT NULL AS users,
      to_regclass('public.social_communities') IS NOT NULL AS communities,
      to_regclass('public.social_moderation_cases') IS NOT NULL AS moderation_cases,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'social_posts' AND column_name = 'community_id'
      ) AS community_post_authority,
      EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'social_posts_conversation_authority' AND NOT tgisinternal
      ) AS conversation_trigger
  `);
  assert.deepEqual(shape, {
    users: true,
    communities: true,
    moderation_cases: true,
    community_post_authority: true,
    conversation_trigger: true
  });

  await ensureSocialSchema(poolA);
  const { rows: [count] } = await poolA.query('SELECT count(*)::int AS count FROM social_schema_migrations');
  assert.equal(count.count, MIGRATIONS.length);

  await Promise.all([poolA.end(), poolB.end()]);
});
