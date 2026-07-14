import { createPostgresCommunityAuthority } from './social-postgres-community.mjs';
import { SOCIAL_VERSION, fail, randomId } from './social-schema.mjs';

const iso = value => value instanceof Date ? value.toISOString() : String(value);
const account = (row, privateFields = false) => row ? {
  id: row.id,
  handle: row.handle,
  name: row.name,
  bio: row.bio,
  accent: row.accent,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  ...(privateFields ? { password: { salt: row.password_salt, hash: row.password_hash } } : {})
} : null;

const accountSelect = `
  SELECT u.id, p.handle, p.name, p.bio, p.accent,
         u.password_salt, u.password_hash,
         u.created_at, GREATEST(u.updated_at, p.updated_at) AS updated_at
  FROM social_users u
  JOIN social_public_profiles p ON p.user_id = u.id
`;

const dbFail = error => {
  if (error?.status) return error;
  if (error?.code === '23505') {
    if (String(error.constraint || '').includes('slug')) return fail(409, 'That community slug is taken.');
    if (String(error.constraint || '').includes('idempotency')) return fail(409, 'That idempotency key was already used.');
    return fail(409, 'That community mutation conflicts with existing state.');
  }
  if (error?.code === '23503') return fail(404, 'The referenced community object no longer exists.');
  return error;
};

export function createPostgresCommunityRuntime({ pool, afterMutation = async () => {} } = {}) {
  if (!pool) throw new Error('A PostgreSQL pool is required.');

  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dbFail(error);
    } finally {
      client.release();
    }
  }

  async function accountBy(client, field, value, privateFields = false) {
    const column = field === 'id' ? 'u.id' : 'p.handle';
    const { rows } = await client.query(`${accountSelect} WHERE ${column} = $1 LIMIT 1`, [value]);
    return account(rows[0], privateFields);
  }

  async function event(client, { type, actorId, key, payload, at }) {
    await client.query(
      `INSERT INTO social_events (id, version, type, actor_id, idempotency_key, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [`evt_${randomId(14)}`, SOCIAL_VERSION, type, actorId, key, JSON.stringify(payload), at]
    );
  }

  async function receipt(client, { scope, operation, actorId, key, at }, mutate) {
    if (!key) return mutate();
    const lockKey = JSON.stringify([scope, key]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))', [lockKey]);
    const prior = await client.query(
      'SELECT operation, status, body FROM social_mutation_receipts WHERE scope = $1 AND idempotency_key = $2',
      [scope, key]
    );
    if (prior.rows[0]) {
      if (prior.rows[0].operation !== operation) throw fail(409, 'That idempotency key belongs to another operation.');
      return { status: Number(prior.rows[0].status), body: prior.rows[0].body, replayed: true };
    }
    const result = await mutate();
    await client.query(
      `INSERT INTO social_mutation_receipts
       (scope, idempotency_key, operation, actor_id, status, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [scope, key, operation, actorId, result.status, JSON.stringify(result.body), at]
    );
    return result;
  }

  return createPostgresCommunityAuthority({
    pool,
    transaction,
    receipt,
    event,
    accountBy,
    afterMutation
  });
}
