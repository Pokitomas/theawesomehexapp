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
    headers: { 'content-type': 'application/json' },
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

test('production factory deterministically selects Blob or PostgreSQL authority', () => {
  const fake = fakeBlobStore();
  const blobMarker = async () => new Response('{}');
  let blobStore;
  const blobService = createProductionSocialService({
    env: {},
    getStore: () => fake.store,
    createBlobService(options) {
      blobStore = options.store;
      return blobMarker;
    }
  });

  assert.equal(blobService, blobMarker);
  assert.ok(blobStore);

  const relationalMarker = async () => new Response('{}');
  const pool = { kind: 'pool' };
  const authority = { kind: 'authority' };
  let poolOptions;
  let authorityPool;
  let relationalOptions;
  let blobRequested = false;

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
      return authority;
    },
    createRelationalService(options) {
      relationalOptions = options;
      return relationalMarker;
    }
  });

  assert.equal(relationalService, relationalMarker);
  assert.equal(blobRequested, false);
  assert.deepEqual(poolOptions, {
    connectionString: 'postgres://sideways.test/social',
    max: 4,
    idleTimeoutMillis: 20_000
  });
  assert.equal(authorityPool, pool);
  assert.deepEqual(relationalOptions, {
    authority,
    sessionSecret: 'test-session-secret'
  });
});
