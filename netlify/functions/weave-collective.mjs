import { getStore } from '@netlify/blobs';
import { clean, defaultState, sessionDigest, stateKey } from './remote-core.mjs';
import { publicCognitionStateProjection } from './weave-cognition-public.mjs';

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS'
};

const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });

async function getJSON(store, key) {
  try { return await store.get(key, { type: 'json' }); }
  catch { return null; }
}

async function listKeys(store, prefix) {
  const values = [];
  let cursor;
  let pages = 0;
  do {
    const page = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const blob of page?.blobs || []) if (blob?.key) values.push(blob.key);
    cursor = page?.cursor || page?.next_cursor || page?.nextCursor || null;
    pages += 1;
  } while (cursor && pages < 50);
  return [...new Set(values)].sort();
}

async function resolveSession(store, env, requested) {
  const explicit = clean(requested).slice(0, 220);
  if (explicit) return explicit;
  const configured = clean(env?.REMOTE_PUBLIC_SESSION).slice(0, 220);
  if (configured) return configured;
  const current = await getJSON(store, 'remote/current.json');
  return clean(current?.session || env?.REMOTE_DEFAULT_SESSION || 'Pokitomas/theawesomehexapp:main').slice(0, 220);
}

async function publicMessages(store, session, generation) {
  const prefix = `remote/${sessionDigest(session)}/messages/g${generation}/`;
  const messages = [];
  for (const key of await listKeys(store, prefix)) {
    const message = await getJSON(store, key);
    if (!message || message.visibility !== 'public') continue;
    if (message.expires_at && Date.parse(message.expires_at) <= Date.now()) continue;
    messages.push(message);
  }
  return messages;
}

export function createWeaveCollectiveHandler({ store, env = process.env } = {}) {
  if (!store) throw new Error('A Netlify Blob store is required.');
  return async request => {
    if (request.method === 'OPTIONS') return reply(204);
    if (request.method !== 'GET') return reply(405, { error: 'Method not allowed.' });
    try {
      const url = new URL(request.url);
      const session = await resolveSession(store, env, url.searchParams.get('session'));
      const state = (await getJSON(store, stateKey(session))) || defaultState(session);
      const messages = await publicMessages(store, session, state.generation);
      return reply(200, {
        session,
        generation: state.generation,
        updated_at: state.updated_at || null,
        collective: publicCognitionStateProjection(messages, {
          max_items: Number(url.searchParams.get('limit')) || 24
        })
      });
    } catch {
      return reply(500, { error: 'Collective state unavailable.' });
    }
  };
}

const handler = createWeaveCollectiveHandler({ store: getStore('sideways-remote') });
export default handler;
