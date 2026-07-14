import { createSocialService } from './social-core.mjs';
import { createPostgresCommunityRuntime } from './social-postgres-community-runtime.mjs';
import { createPostgresAuthority } from './social-postgres-store.mjs';
import { ensureSocialSchema } from './social-postgres-migrations.mjs';
import { cookieMutationProvenanceResponse } from './social-provenance.mjs';
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

function guardCookieMutations(service) {
  return async request => {
    const denied = cookieMutationProvenanceResponse(request);
    if (denied) return denied;
    return service(request);
  };
}

export function createProductionSocialService({
  env = process.env,
  getStore,
  createPool,
  createBlobService = createSocialService,
  createRelationalAuthority = createPostgresAuthority,
  createCommunityAuthority = createPostgresCommunityRuntime,
  createRelationalService = createRelationalSocialService,
  ensureRelationalSchema = ensureSocialSchema
} = {}) {
  const databaseUrl = env.SOCIAL_DATABASE_URL || env.NETLIFY_DATABASE_URL || env.DATABASE_URL || '';
  if (!databaseUrl) {
    return guardCookieMutations(createBlobService({ store: createBlobStore({ getStore }) }));
  }
  if (typeof createPool !== 'function') throw new Error('A PostgreSQL pool factory is required.');

  const pool = createPool({ connectionString: databaseUrl, max: 4, idleTimeoutMillis: 20_000 });
  const service = createRelationalService({
    authority: {
      ...createRelationalAuthority({ pool }),
      ...createCommunityAuthority({ pool })
    },
    sessionSecret: env.SOCIAL_SESSION_SECRET
  });
  let schemaReady;
  return async request => {
    const denied = cookieMutationProvenanceResponse(request);
    if (denied) return denied;
    try {
      schemaReady ||= ensureRelationalSchema(pool);
      await schemaReady;
      return service(request);
    } catch {
      return new Response(JSON.stringify({ error: 'Social database schema is unavailable.' }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
  };
}
