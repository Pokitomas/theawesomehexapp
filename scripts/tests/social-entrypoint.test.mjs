import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlobStore, createProductionSocialService } from '../../netlify/functions/social-entrypoint-core.mjs';

function fakeBlobStore(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, structuredClone(value)]));
  const calls = { get: [], setJSON: [], delete: [], list: [] };
  return {
    calls,
    values,
    store: {
      async get(key, options) {
        calls.get.push([key, options]);
        return values.has(key) ? structuredClone(values.get(key)) : null;
      },
      async setJSON(key, value) {
        calls.setJSON.push([key, structuredClone(value)]);
        values.set(key, structuredClone(value));
      },
      async delete(key) {
        calls.delete.push(key);
        values.delete(key);
      },
      async list(options = {}) {
        calls.list.push(structuredClone(options));
        const prefix = options.prefix || '';
        const blobs = [...values.keys()]
          .filter(key => key.startsWith(prefix))
          .sort()
          .map(key => ({ key }));
        return { blobs };
      }
    }
  };
}

test('Netlify Blob adapter maps JSON reads, writes, deletion, and prefix listing', async () => {
  const fake = fakeBlobStore({
    'social/a': { value: 1 },
    'social/b': { value: 2 },
    'other/c': { value: 3 }
  });
  const names = [];
  const adapter = createBlobStore({
    getStore(name) {
      names.push(name);
      return fake.store;
    }
  });

  assert.deepEqual(await adapter.get('social/a'), { value: 1 });
  assert.deepEqual(fake.calls.get[0], ['social/a', { type: 'json' }]);

  await adapter.set('social/d', { value: 4 });
  assert.deepEqual(fake.calls.setJSON[0], ['social/d', { value: 4 }]);
  assert.deepEqual(fake.values.get('social/d'), { value: 4 });

  await adapter.delete('social/b');
  assert.deepEqual(fake.calls.delete, ['social/b']);
  assert.equal(fake.values.has('social/b'), false);

  assert.deepEqual(await adapter.list('social/'), ['social/a', 'social/d']);
  assert.deepEqual(fake.calls.list[0], { prefix: 'social/' });
  assert.deepEqual(names, ['sideways-social']);
});

test('production factory executes a complete request through the Blob fallback', async () => {
  const fake = fakeBlobStore();
  const service = createProductionSocialService({
    env: {},
    getStore: () => fake.store
  });

  const response = await service(new Request('http://sideways.test/api/social?op=register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://sideways.test' },
    body: JSON.stringify({
      name: 'Adapter Alice',
      handle: 'adapter-alice',
      password: 'correct horse battery staple'
    })
  }));

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.account.handle, 'adapter-alice');
  assert.match(response.headers.get('set-cookie') || '', /^sideways_session=/);
  assert.ok(fake.calls.setJSON.length >= 4);
  assert.ok([...fake.values.keys()].some(key => key.startsWith('social/account/')));
  assert.ok([...fake.values.keys()].some(key => key.startsWith('social/session/')));
  assert.ok([...fake.values.keys()].some(key => key.startsWith('social/event/')));
});

test('production factory bootstraps and composes PostgreSQL authority before serving', async () => {
  const fake = fakeBlobStore();
  const pool = { kind: 'pool' };
  const baseAuthority = { accountForLogin: 'base' };
  const communityAuthority = { createCommunity: 'community' };
  let poolOptions;
  let authorityPool;
  let communityPool;
  let migrationPool;
  let relationalOptions;
  let blobRequested = false;
  let served = 0;

  const relationalService = createProductionSocialService({
    env: {
      SOCIAL_DATABASE_URL: 'postgres://sideways.test/social',
      SOCIAL_SESSION_SECRET: 'test-session-secret'
    },
    getStore() {
      blobRequested = true;
      return fake.store;
    },
    createPool(options) {
      poolOptions = options;
      return pool;
    },
    createRelationalAuthority(options) {
      authorityPool = options.pool;
      return baseAuthority;
    },
    createCommunityAuthority(options) {
      communityPool = options.pool;
      return communityAuthority;
    },
    async ensureRelationalSchema(value) {
      migrationPool = value;
    },
    createRelationalService(options) {
      relationalOptions = options;
      return async () => {
        served += 1;
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      };
    }
  });

  assert.equal(blobRequested, false);
  assert.deepEqual(poolOptions, {
    connectionString: 'postgres://sideways.test/social',
    max: 4,
    idleTimeoutMillis: 20_000
  });
  assert.equal(authorityPool, pool);
  assert.equal(communityPool, pool);
  assert.deepEqual(relationalOptions, {
    authority: { ...baseAuthority, ...communityAuthority },
    sessionSecret: 'test-session-secret'
  });

  const first = await relationalService(new Request('http://sideways.test/api/social?op=session'));
  const second = await relationalService(new Request('http://sideways.test/api/social?op=session'));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(migrationPool, pool);
  assert.equal(served, 2);
});

test('schema bootstrap failure fails closed before relational handlers run', async () => {
  let served = false;
  const service = createProductionSocialService({
    env: { SOCIAL_DATABASE_URL: 'postgres://sideways.test/social', SOCIAL_SESSION_SECRET: 'test-session-secret' },
    createPool: () => ({ kind: 'pool' }),
    createRelationalAuthority: () => ({}),
    createCommunityAuthority: () => ({}),
    ensureRelationalSchema: async () => { throw new Error('migration failed'); },
    createRelationalService: () => async () => {
      served = true;
      return new Response('{}');
    }
  });
  const response = await service(new Request('http://sideways.test/api/social?op=session'));
  assert.equal(response.status, 503);
  assert.equal(served, false);
  assert.deepEqual(await response.json(), { error: 'Social database schema is unavailable.' });
});
