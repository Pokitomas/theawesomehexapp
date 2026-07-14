import { createSocialService } from './social-core.mjs';
import { createPostgresSocialStore } from './social-postgres-store.mjs';

let service;

export default async function social(request, context) {
  try {
    service ||= createSocialService({ store: createPostgresSocialStore() });
    return service(request, context);
  } catch (error) {
    const status = Number(error?.status || 500);
    if (status >= 500) console.error('[social bootstrap]', error);
    return new Response(JSON.stringify({ error: status === 503 ? error.message : 'Social service unavailable.' }), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });
  }
}
