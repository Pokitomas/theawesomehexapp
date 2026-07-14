import { createSocialService } from './social-core.mjs';
import { createPostgresAuthority } from './social-postgres-store.mjs';
import { createRelationalSocialService } from './social-relational-core.mjs';

export function createBlobStore({ getStore, storeName = 'sideways-social' } = {}) {
  if (typeof getStore !== 'function') throw new Error('A Netlify Blob store factory is required.');
  const store = getStore(storeName);
  if (!store) throw new Error('A Netlify Blob store is required.');
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

export function createProductionSocialService({
  env = process.env,
  getStore,
  createPool,
  createBlobService = createSocialService,
  createRelationalAuthority = createPostgresAuthority,
  createRelationalService = createRelationalSocialService
} = {}) {
  const databaseUrl = env.SOCIAL_DATABASE_URL || env.NETLIFY_DATABASE_URL || env.DATABASE_URL || '';
  if (!databaseUrl) {
    return createBlobService({ store: createBlobStore({ getStore }) });
  }
  if (typeof createPool !== 'function') throw new Error('A PostgreSQL pool factory is required.');

  const pool = createPool({ connectionString: databaseUrl, max: 4, idleTimeoutMillis: 20_000 });
  return createRelationalService({
    authority: createRelationalAuthority({ pool }),
    sessionSecret: env.SOCIAL_SESSION_SECRET
  });
}
