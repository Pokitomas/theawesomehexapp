import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlobStore, createProductionSocialService } from '../../netlify/functions/social.mjs';

function fakeBlobStore() {
  const values = new Map();
  const calls = [];
  return {
    values,
    calls,
    raw: {
      async get(key, options) {
        calls.push(['get', key, options]);
        return values.has(key) ? structuredClone(values.get(key)) : null;
      },
      async setJSON(key, value) {
        calls.push(['setJSON', key, structuredClone(value)]);
        values.set(key, structuredClone(value));
      },
      async delete(key) {
        calls.push(['delete', key]);
        values.delete(key);
      },
      async list({ prefix = '' } = {}) {
        calls.push(['list', prefix]);
        return {
          blobs: [...values.keys()]
            .filter(key => key.startsWith(prefix))
            .sort()
            .map(key => ({ key }))
        };
      }
    }
  };
}

test('Netlify Blob adapter maps JSON operations and prefix listing', async () => {
  const fake = fakeBlobStore();
  const store = createBlobStore(fake.raw);
  const post = { id: 'post_1', text: 'hello' };

  await store.set('social/post/post_1', post);
  await store.set('social/account/acct_1', { id: 'acct_1' });

  assert.deepEqual(await store.get('social/post/post_1'), post);
  assert.deepEqual(await store.list('social/post/'), ['social/post/post_1']);

  await store.delete('social/post/post_1');
  assert.equal(await store.get('social/post/post_1'), null);

  assert.deepEqual(fake.calls, [
    ['setJSON', 'social/post/post_1', post],
    ['setJSON', 'social/account/acct_1', { id: 'acct_1' }],
    ['get', 'social/post/post_1', { type: 'json' }],
    ['list', 'social/post/'],
    ['delete', 'social/post/post_1'],
    ['get', 'social/post/post_1', { type: 'json' }]
  ]);
});

test('production factory serves a complete registration request through Blob fallback', async () => {
  const fake = fakeBlobStore();
  let requestedStore = '';
  const service = createProductionSocialService({
    env: {},
    getBlobStore(name) {
      requestedStore = name;
      return fake.raw;
    },
    PoolClass: class UnexpectedPool {
      constructor() { throw new Error('PostgreSQL must not be selected without a database URL.'); }
    }
  });

  const response = await service(new Request('https://sideways.test/api/social?op=register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://sideways.test'
    },
    body: JSON.stringify({
      name: 'Alice',
      handle: 'alice',
      password: 'correct horse battery staple',
      bio: 'Blob-backed account'
    })
  }));

  assert.equal(requestedStore, 'sideways-social');
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie') || '', /^sideways_session=/);
  assert.equal((await response.json()).account.handle, 'alice');
  assert.ok([...fake.values.keys()].some(key => key.startsWith('social/account/')));
  assert.ok([...fake.values.keys()].some(key => key.startsWith('social/session/')));
  assert.ok([...fake.values.keys()].some(key => key.startsWith('social/event/')));
});

test('production factory selects the existing relational authority when configured', () => {
  let poolOptions;
  let authorityInput;
  let relationalInput;
  const authority = { kind: 'postgres-authority' };
  const service = () => new Response(null, { status: 204 });

  class FakePool {
    constructor(options) { poolOptions = options; }
  }

  const selected = createProductionSocialService({
    env: {
      DATABASE_URL: 'postgres://example.test/sideways',
      SOCIAL_SESSION_SECRET: 'test-session-secret'
    },
    getBlobStore() {
      throw new Error('Blob fallback must not be selected when a database URL exists.');
    },
    PoolClass: FakePool,
    createAuthority(input) {
      authorityInput = input;
      return authority;
    },
    createRelationalService(input) {
      relationalInput = input;
      return service;
    }
  });

  assert.equal(selected, service);
  assert.deepEqual(poolOptions, {
    connectionString: 'postgres://example.test/sideways',
    max: 4,
    idleTimeoutMillis: 20_000
  });
  assert.ok(authorityInput.pool instanceof FakePool);
  assert.deepEqual(relationalInput, {
    authority,
    sessionSecret: 'test-session-secret'
  });
});
