import { readFile } from 'node:fs/promises';

const MIGRATIONS = Object.freeze([
  '001_social_authority.sql',
  '002_community_conversation_authority.sql',
  '003_social_idempotency_identity.sql'
]);
const readyByPool = new WeakMap();

async function migrationSQL(name) {
  return readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

async function migrate(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('A PostgreSQL pool is required for social schema migration.');
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('sideways-social-schema'::text, 0::bigint))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS social_schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await client.query('SELECT name FROM social_schema_migrations');
    const done = new Set(applied.rows.map(row => row.name));
    for (const name of MIGRATIONS) {
      if (done.has(name)) continue;
      await client.query(await migrationSQL(name));
      await client.query(
        'INSERT INTO social_schema_migrations (name, applied_at) VALUES ($1, now()) ON CONFLICT DO NOTHING',
        [name]
      );
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('sideways-social-schema'::text, 0::bigint))").catch(() => {});
    client.release();
  }
}

export function ensureSocialSchema(pool) {
  if (!readyByPool.has(pool)) {
    const pending = migrate(pool).catch(error => {
      readyByPool.delete(pool);
      throw error;
    });
    readyByPool.set(pool, pending);
  }
  return readyByPool.get(pool);
}

export { MIGRATIONS };
