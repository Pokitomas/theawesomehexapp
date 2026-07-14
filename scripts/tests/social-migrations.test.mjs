import assert from 'node:assert/strict';
import test from 'node:test';
import { MIGRATIONS, ensureSocialSchema } from '../../netlify/functions/social-postgres-migrations.mjs';

function fakePool(applied = []) {
  const calls = [];
  let connects = 0;
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (text === 'SELECT name FROM social_schema_migrations') {
        return { rows: applied.map(name => ({ name })) };
      }
      return { rows: [] };
    },
    release() {
      calls.push({ text: 'release', params: [] });
    }
  };
  return {
    calls,
    connectCount: () => connects,
    async connect() {
      connects += 1;
      return client;
    }
  };
}

test('schema bootstrap serializes, applies ordered migrations, records them, and caches readiness per pool', async () => {
  const pool = fakePool();
  const first = ensureSocialSchema(pool);
  const second = ensureSocialSchema(pool);
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(pool.connectCount(), 1);
  const text = pool.calls.map(call => call.text).join('\n');
  assert.match(text, /pg_advisory_lock/);
  assert.match(text, /CREATE TABLE IF NOT EXISTS social_schema_migrations/);
  assert.match(text, /CREATE TABLE IF NOT EXISTS social_users/);
  assert.match(text, /CREATE TABLE IF NOT EXISTS social_communities/);
  assert.match(text, /pg_advisory_unlock/);
  const recorded = pool.calls
    .filter(call => call.text.startsWith('INSERT INTO social_schema_migrations'))
    .map(call => call.params[0]);
  assert.deepEqual(recorded, MIGRATIONS);
});

test('schema bootstrap skips migrations already recorded by the database', async () => {
  const pool = fakePool(MIGRATIONS);
  await ensureSocialSchema(pool);
  const text = pool.calls.map(call => call.text).join('\n');
  assert.doesNotMatch(text, /CREATE TABLE IF NOT EXISTS social_users/);
  assert.doesNotMatch(text, /CREATE TABLE IF NOT EXISTS social_communities/);
  assert.equal(pool.calls.filter(call => call.text.startsWith('INSERT INTO social_schema_migrations')).length, 0);
});
