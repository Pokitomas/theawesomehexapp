import { getStore } from '@netlify/blobs';
import pg from 'pg';
import { createSocialService } from './social-core.mjs';
import { createPostgresAuthority } from './social-postgres-store.mjs';
import { createRelationalSocialService } from './social-relational-core.mjs';

const { Pool } = pg;
const STORE_NAME = 'sideways-social';

export function createBlobStore(store) {
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
  getBlobStore = getStore,
  PoolClass = Pool,
  createBlobService = createSocialService,
  createAuthority = createPostgresAuthority,
  createRelationalService = createRelationalSocialService
} = {}) {
  const databaseUrl = env.SOCIAL_DATABASE_URL || env.NETLIFY_DATABASE_URL || env.DATABASE_URL || '';
  if (databaseUrl) {
    const pool = new PoolClass({ connectionString: databaseUrl, max: 4, idleTimeoutMillis: 20_000 });
    return createRelationalService({
      authority: createAuthority({ pool }),
      sessionSecret: env.SOCIAL_SESSION_SECRET
    });
  }

  return createBlobService({ store: createBlobStore(getBlobStore(STORE_NAME)) });
}

let defaultService;
export default function social(request) {
  defaultService ||= createProductionSocialService();
  return defaultService(request);
}
