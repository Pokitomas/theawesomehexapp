import { getStore } from '@netlify/blobs';
import pg from 'pg';
import { createProductionSocialService } from './social-entrypoint-core.mjs';

export { createBlobStore, createProductionSocialService } from './social-entrypoint-core.mjs';

const { Pool } = pg;

let defaultService;
export default function social(request) {
  defaultService ||= createProductionSocialService({
    env: process.env,
    getStore,
    createPool: options => new Pool(options)
  });
  return defaultService(request);
}
