import assert from 'node:assert/strict';
import test from 'node:test';
import defaultSocialHandler, {
  createBlobStore,
  createProductionSocialService,
  databaseUrlFrom
} from '../../netlify/functions/social.mjs';

function fakeNetlifyStore() {
  const values = new Map();
  const calls = [];
  return {
    values,
    calls,
    store: {
      async get(key, options) {
        calls.push(['get', key, options]);
        return values.has(key) ? structuredClone(values.get(key)) : null;
      },
      async setJSON(key, value) {
        calls.push(['setJSON', key, value]);
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

test('Blob adapter maps JSON reads, setJSON, delete, prefix listing, and keys', async () => {
  const fake = fakeNetlifyStore();
  let selectedName = '';
  const adapter = createBlobStore({
    getStore(name) {
      selectedName = name;
      return fake.store;
    }
  });

  await adapter.set('social/post/b', { id: 'b' });
  await adapter.set('social/post/a', { id: 'a' });
  await adapter.set('other/value', { id: 'other' });

  assert.equal(selectedName, 'sideways-social');
  assert.deepEqual(await adapter.get('social/post/a'), { id: 'a' });
  assert.deepEqual(await adapter.list('social/post/'), ['social/post/a', 'social/post/b']);
  await adapter.delete('social/post/a');
  assert.equal(await adapter.get('social/post/a'), null);

  assert.deepEqual(fake.calls.map(call => call[0]), [
    'setJSON', 'setJSON', 'setJSON', 'get', 'list', 'delete', 'get'
  ]);
  assert.deepEqual(fake.calls[3], ['get', 'social/post/a', { type: 'json' }]);
  assert.deepEqual(fake.calls[4], ['list', 'social/post/']);
});

test('production factory executes a complete registration through the Blob fallback', async () => {
  const fake = fakeNetlifyStore();
  const service = createProductionSocialService({
    env: {},
    getStore: () => fake.store
  });

  const response = await service(new Request('http://sideways.test/api/social?op=register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Blob Alice',
      handle: '@blob-alice',
      password: 'correct horse battery staple',
      bio: 'production fallback proof'
    })
  }));
  const data = await response.json();

  assert.equal(response.status, 201);
  assert.equal(data.account.handle, 'blob-alice');
  assert.match(response.headers.get('set-cookie') || '', /^sideways_session=/);
  assert.equal([...fake.values.keys()].filter(key => key.startsWith('social/account/')).length, 1);
  assert.equal([...fake.values.keys()].filter(key => key.startsWith('social/session/')).length, 1);
  assert.equal([...fake.values.keys()].filter(key => key.startsWith('social/event/')).length, 1);
});

test('production factory deterministically selects Blob without a database URL', () => {
  const fake = fakeNetlifyStore();
  const blobHandler = async () => new Response('blob');
  let receivedStore;

  const service = createProductionSocialService({
    env: {},
    getStore: () => fake.store,
    Pool: class UnexpectedPool {
      constructor() { throw new Error('PostgreSQL must not be constructed on Blob fallback.'); }
    },
    createSocialServiceImpl({ store }) {
      receivedStore = store;
      return blobHandler;
    },
    createPostgresAuthorityImpl() {
      throw new Error('Relational authority must not be selected on Blob fallback.');
    },
    createRelationalSocialServiceImpl() {
      throw new Error('Relational service must not be selected on Blob fallback.');
    }
  });

  assert.equal(service, blobHandler);
  assert.equal(typeof receivedStore.get, 'function');
  assert.equal(databaseUrlFrom({}), '');
});

test('production factory deterministically selects the existing relational authority with a database URL', () => {
  const relationalHandler = async () => new Response('postgres');
  let poolOptions;
  let authorityPool;
  let relationalArguments;

  class FakePool {
    constructor(options) {
      poolOptions = options;
    }
  }

  const service = createProductionSocialService({
    env: {
      SOCIAL_DATABASE_URL: 'postgres://sideways.test/social',
      SOCIAL_SESSION_SECRET: 'production-secret'
    },
    getStore() {
      throw new Error('Blob store must not be selected when a database URL exists.');
    },
    Pool: FakePool,
    createSocialServiceImpl() {
      throw new Error('Blob social service must not be selected when a database URL exists.');
    },
    createPostgresAuthorityImpl({ pool }) {
      authorityPool = pool;
      return { kind: 'existing-relational-authority' };
    },
    createRelationalSocialServiceImpl(args) {
      relationalArguments = args;
      return relationalHandler;
    }
  });

  assert.equal(service, relationalHandler);
  assert.deepEqual(poolOptions, {
    connectionString: 'postgres://sideways.test/social',
    max: 4,
    idleTimeoutMillis: 20_000
  });
  assert.ok(authorityPool instanceof FakePool);
  assert.deepEqual(relationalArguments, {
    authority: { kind: 'existing-relational-authority' },
    sessionSecret: 'production-secret'
  });
  assert.equal(databaseUrlFrom({ NETLIFY_DATABASE_URL: 'postgres://netlify' }), 'postgres://netlify');
  assert.equal(databaseUrlFrom({ DATABASE_URL: 'postgres://generic' }), 'postgres://generic');
});

test('default Netlify export remains a request handler without eager runtime initialization', () => {
  assert.equal(typeof defaultSocialHandler, 'function');
});
