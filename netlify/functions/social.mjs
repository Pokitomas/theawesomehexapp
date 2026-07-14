import { getStore } from '@netlify/blobs';
import pg from 'pg';
import { createSocialService } from './social-core.mjs';
import { createPostgresAuthority } from './social-postgres-store.mjs';
import { createRelationalSocialService } from './social-relational-core.mjs';

const { Pool } = pg;

function blobStore() {
  const store = getStore('sideways-social');
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

const databaseUrl = process.env.SOCIAL_DATABASE_URL || process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || '';

const service = databaseUrl
  ? createRelationalSocialService({
      authority: createPostgresAuthority({
        pool: new Pool({ connectionString: databaseUrl, max: 4, idleTimeoutMillis: 20_000 })
      }),
      sessionSecret: process.env.SOCIAL_SESSION_SECRET
    })
  : createSocialService({ store: blobStore() });

export default service;
