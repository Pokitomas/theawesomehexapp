import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import pg from 'pg';
import { ensureSocialSchema, MIGRATIONS } from '../../netlify/functions/social-postgres-migrations.mjs';

const { Pool } = pg;
const connectionString = process.env.POSTGRES_URL || process.env.SOCIAL_DATABASE_URL || '';
const enabled = Boolean(connectionString);
const pool = enabled ? new Pool({ connectionString, max: 2 }) : null;

after(async () => { if (pool) await pool.end(); });

test('production bootstrap installs the complete converged authority schema', { skip: !enabled }, async () => {
  assert.deepEqual(MIGRATIONS, [
    '001_social_authority.sql',
    '002_community_conversation_authority.sql',
    '003_social_idempotency_identity.sql',
    '004_immutable_appeal_actions.sql'
  ]);

  await ensureSocialSchema(pool);

  const applied = await pool.query('SELECT name FROM social_schema_migrations ORDER BY name');
  assert.deepEqual(applied.rows.map(row => row.name), [...MIGRATIONS]);

  const receiptColumns = await pool.query(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'social_mutation_receipts'
  `);
  const receipt = new Map(receiptColumns.rows.map(row => [row.column_name, row]));
  assert.equal(receipt.get('request_digest')?.is_nullable, 'NO');

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
