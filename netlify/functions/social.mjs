import { createSocialService } from './social-core.mjs';
import { createPostgresAuthority } from './social-postgres-store.mjs';
import { createRelationalSocialService } from './social-relational-core.mjs';

const STORE_NAME = 'sideways-social';

export function createBlobStore({ getStore, storeName = STORE_NAME } = {}) {
  if (typeof getStore !== 'function') throw new Error('A Netlify getStore function is required.');
  const store = getStore(storeName);
  return {
    async get(key) { return store.get(key, { type: 'json' }); },
    async set(key, value) { await store.setJSON(key, value); },
    async delete(key) { await store.delete(key); },
    async list(prefix = '') {
      const result = await store.list({ prefix });
      return (result.blobs || []).map(item => item.key);
    }
  };
}

export function databaseUrlFrom(env = {}) {
  return env.SOCIAL_DATABASE_URL || env.NETLIFY_DATABASE_URL || env.DATABASE_URL || '';
}

export function createProductionSocialService({
  env = {},
  getStore,
  Pool,
  createSocialServiceImpl = createSocialService,
  createPostgresAuthorityImpl = createPostgresAuthority,
  createRelationalSocialServiceImpl = createRelationalSocialService
} = {}) {
  const databaseUrl = databaseUrlFrom(env);
  if (!databaseUrl) {
    return createSocialServiceImpl({ store: createBlobStore({ getStore }) });
  }

  if (typeof Pool !== 'function') throw new Error('A PostgreSQL Pool constructor is required.');
  const pool = new Pool({ connectionString: databaseUrl, max: 4, idleTimeoutMillis: 20_000 });
  const authority = createPostgresAuthorityImpl({ pool });
  return createRelationalSocialServiceImpl({
    authority,
    sessionSecret: env.SOCIAL_SESSION_SECRET
  });
}

let defaultServicePromise;

async function defaultService() {
  if (!defaultServicePromise) {
    defaultServicePromise = Promise.all([
      import('@netlify/blobs'),
      import('pg')
    ]).then(([blobs, pgModule]) => {
      const pg = pgModule.default || pgModule;
      return createProductionSocialService({
        env: process.env,
        getStore: blobs.getStore,
        Pool: pg.Pool || pgModule.Pool
      });
    });
  }
  return defaultServicePromise;
}

export default async function social(request) {
  const service = await defaultService();
  return service(request);
}
