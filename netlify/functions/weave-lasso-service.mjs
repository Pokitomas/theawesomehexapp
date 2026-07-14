import {
  buildLassoEvents
} from '../../scripts/weave-lasso.mjs';
import {
  normalizeWeaveEvent,
  weavePayload
} from '../../scripts/weave-protocol.mjs';
import {
  clean,
  messageIdKey,
  messageKey,
  sha256Hex
} from './remote-core.mjs';

export const LASSO_SYSTEM_PRINCIPAL = 'system:weave-lasso';
const INTERNAL_PRINCIPALS = new Set([LASSO_SYSTEM_PRINCIPAL, 'weave-lasso']);

async function getJSON(store, key) {
  try { return await store.get(key, { type: 'json' }); }
  catch { return null; }
}

function sessionParts(session) {
  const value = clean(session);
  const split = value.lastIndexOf(':');
  if (split <= 0) return { repository: value || 'unknown', branch: 'main' };
  return {
    repository: value.slice(0, split),
    branch: value.slice(split + 1) || 'main'
  };
}

export function remoteArrival(message) {
  const { repository, branch } = sessionParts(message?.session);
  const payload = message?.payload && typeof message.payload === 'object' ? message.payload : {};
  return {
    actor: clean(message?.issuer),
    repository,
    event_name: 'remote_message',
    action: 'stored',
    source_id: clean(message?.issuer),
    title: clean(payload.summary || payload.action || payload.status || 'Remote participant arrived').slice(0, 1000),
    body: JSON.stringify(payload).slice(0, 12000),
    ref: '',
    default_branch: branch,
    observed_at: clean(message?.issued_at) || new Date().toISOString()
  };
}

function internalMessage({ event, sourceMessage, state, issuedAt }) {
  const normalized = normalizeWeaveEvent({
    ...event,
    issuer: LASSO_SYSTEM_PRINCIPAL,
    issued_at: issuedAt
  });
  const id = `internal-${sha256Hex(normalized.id).slice(0, 48)}`;
  return {
    id,
    session: sourceMessage.session,
    generation: sourceMessage.generation,
    issuer: LASSO_SYSTEM_PRINCIPAL,
    parent: sourceMessage.id,
    issued_at: issuedAt,
    expires_at: null,
    head_sha: sourceMessage.head_sha || state?.head_sha || null,
    scope: ['weave', 'lasso', normalized.body?.thread_id || normalized.body?.beacon_id].filter(Boolean),
    payload: weavePayload(normalized),
    visibility: 'private',
    nonce: `internal:${normalized.id}`,
    signature: '',
    signature_algorithm: 'internal-system',
    protocol_version: Number(state?.protocol_version || 1)
  };
}

export async function lassoRemoteArrival({
  store,
  message,
  state,
  existingMessages = [],
  now = Date.now()
}) {
  if (!store) throw new Error('A store is required for the Remote lasso.');
  if (!message || INTERNAL_PRINCIPALS.has(clean(message.issuer))) {
    return { skipped: true, stored: 0, duplicates: 0 };
  }

  const arrival = remoteArrival(message);
  const events = buildLassoEvents(arrival, existingMessages, {
    principal: LASSO_SYSTEM_PRINCIPAL
  });
  let stored = 0;
  let duplicates = 0;
  const keys = [];

  for (let index = 0; index < events.length; index += 1) {
    const issuedAt = new Date(now + index).toISOString();
    const internal = internalMessage({
      event: events[index],
      sourceMessage: message,
      state,
      issuedAt
    });
    const idKey = messageIdKey(internal.session, internal.generation, internal.id);
    if (await getJSON(store, idKey)) {
      duplicates += 1;
      continue;
    }
    const key = messageKey(internal.session, internal.generation, internal.issued_at, internal.id);
    await store.setJSON(key, internal);
    await store.setJSON(idKey, { key, id: internal.id, issued_at: internal.issued_at });
    keys.push(key);
    stored += 1;
  }

  return {
    skipped: false,
    arrival,
    planned: events.length,
    stored,
    duplicates,
    keys
  };
}
