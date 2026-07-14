import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import pg from 'pg';
import { ensureSocialSchema, MIGRATIONS } from '../../netlify/functions/social-postgres-migrations.mjs';

const { Pool } = pg;
const connectionString = process.env.POSTGRES_URL || process.env.SOCIAL_DATABASE_URL || '';
const enabled = Boolean(connectionString);
const pool = enabled ? new Pool({ connectionString, max: 2 }) : null;

const migrationSQL = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');

after(async () => { if (pool) await pool.end(); });

async function resetSchema() {
  await pool.query(`
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
  await pool.query('DROP FUNCTION IF EXISTS social_enforce_conversation_authority() CASCADE');
  await pool.query('DROP FUNCTION IF EXISTS social_sync_legacy_deletion_visibility() CASCADE');
}

test('staged 001+002 database upgrades to the complete authority schema and quarantines legacy receipts', { skip: !enabled }, async () => {
  assert.deepEqual(MIGRATIONS, [
    '001_social_authority.sql',
    '002_community_conversation_authority.sql',
    '003_social_idempotency_identity.sql',
    '004_immutable_appeal_actions.sql',
    '005_quarantine_legacy_idempotency_receipts.sql'
  ]);

  await resetSchema();
  await pool.query(await migrationSQL(MIGRATIONS[0]));
  await pool.query(await migrationSQL(MIGRATIONS[1]));

  // Fresh-install migrations are intentionally cumulative. Remove fields backported
  // into 001/002 so this database matches a real deployment that predates 003/004.
  await pool.query(`
    ALTER TABLE social_mutation_receipts
      DROP CONSTRAINT IF EXISTS social_mutation_receipts_request_digest_shape;
    ALTER TABLE social_mutation_receipts
      DROP COLUMN IF EXISTS request_digest;
    DROP INDEX IF EXISTS social_appeals_appealed_action_unique;
    ALTER TABLE social_appeals
      DROP COLUMN IF EXISTS appealed_action_id;
    ALTER TABLE social_appeals
      DROP COLUMN IF EXISTS appeal_target;
  `);

  await pool.query(`
    CREATE TABLE social_schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `INSERT INTO social_schema_migrations (name) VALUES ($1), ($2)`,
    [MIGRATIONS[0], MIGRATIONS[1]]
  );
  await pool.query(`
    INSERT INTO social_mutation_receipts
      (scope, idempotency_key, operation, actor_id, status, body, created_at)
    VALUES
      ('community:place', 'legacy-key', 'community.role.set', NULL, 200, '{"role":"moderator"}'::jsonb, now())
  `);

  await ensureSocialSchema(pool);

  const applied = await pool.query('SELECT name FROM social_schema_migrations ORDER BY name');
  assert.deepEqual(applied.rows.map(row => row.name), [...MIGRATIONS]);

  const receiptColumns = await pool.query(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'social_mutation_receipts'
  `);
  const receiptShape = new Map(receiptColumns.rows.map(row => [row.column_name, row]));
  assert.equal(receiptShape.get('request_digest')?.is_nullable, 'NO');

  const legacy = await pool.query(`
    SELECT operation, request_digest, status, body
    FROM social_mutation_receipts
    WHERE scope = 'community:place' AND idempotency_key = 'legacy-key'
  `);
  assert.equal(legacy.rowCount, 1);
  assert.equal(legacy.rows[0].operation, 'legacy-unbound:community.role.set');
  assert.equal(legacy.rows[0].request_digest, '0'.repeat(64));
  assert.notEqual(legacy.rows[0].operation, 'community.role.set', 'pre-003 runtimes must not replay the legacy operation');

  await assert.rejects(
    pool.query(`
      INSERT INTO social_mutation_receipts
        (scope, idempotency_key, operation, actor_id, status, body, created_at)
      VALUES
        ('community:place', 'old-writer-key', 'community.role.set', NULL, 200, '{}'::jsonb, now())
    `),
    error => error?.code === '23502'
  );

  await pool.query(`
    INSERT INTO social_mutation_receipts
      (scope, idempotency_key, operation, actor_id, request_digest, status, body, created_at)
    VALUES
      ('community:place', 'bound-key', 'community.role.set', NULL, repeat('a', 64), 200, '{}'::jsonb, now())
  `);

  const appealColumns = await pool.query(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'social_appeals'
  `);
  const appeals = new Map(appealColumns.rows.map(row => [row.column_name, row]));
  assert.equal(appeals.get('appealed_action_id')?.is_nullable, 'YES');
  assert.equal(appeals.get('appeal_target')?.is_nullable, 'NO');

  const index = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'social_appeals_appealed_action_unique'
  `);
  assert.equal(index.rowCount, 1);
});
