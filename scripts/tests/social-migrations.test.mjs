import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MIGRATIONS, ensureSocialSchema } from '../../netlify/functions/social-postgres-migrations.mjs';

function fakePool(applied = [], failures = 0) {
  const calls = [];
  let connects = 0;
  let failuresLeft = failures;
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (failuresLeft > 0 && text.includes('pg_advisory_lock')) {
        failuresLeft -= 1;
        throw new Error('transient database failure');
      }
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

test('a transient bootstrap failure clears readiness so the same runtime can recover', async () => {
  const pool = fakePool([], 1);
  await assert.rejects(ensureSocialSchema(pool), /transient database failure/);
  await ensureSocialSchema(pool);
  assert.equal(pool.connectCount(), 2);
});

test('Netlify bundles migration SQL with the social function', async () => {
  const config = await readFile(new URL('../../netlify.toml', import.meta.url), 'utf8');
  assert.match(config, /included_files\s*=\s*\["migrations\/\*\.sql"\]/);
});
