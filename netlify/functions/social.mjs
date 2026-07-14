import { getStore } from '@netlify/blobs';
import { createSocialService } from './social-core.mjs';

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

export default createSocialService({ store: blobStore() });
