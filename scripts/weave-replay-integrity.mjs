import { createHash } from 'node:crypto';
import {
  defaultWeaveVisibility,
  foldWeaveMessages as foldLegacyWeaveMessages,
  normalizeWeaveEvent as normalizeLegacyWeaveEvent,
  summarizeWeaveEvent
} from './weave-protocol.mjs';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();

function fail(message, code = 'WEAVE_PERSISTED_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function stableWeaveDigest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function exactId(value, name = 'Weave event id') {
  const id = clean(value);
  if (!ID_PATTERN.test(id)) fail(`${name} is invalid.`);
  return id;
}

function exactTimestamp(value, name = 'Weave issued_at') {
  const text = clean(value);
  if (!text || !Number.isFinite(Date.parse(text))) fail(`${name} must be an ISO-compatible timestamp.`);
  return new Date(text).toISOString();
}

function exactVisibility(value, name = 'Weave visibility') {
  const visibility = clean(value);
  if (!['public', 'private'].includes(visibility)) fail(`${name} must be public or private.`);
  return visibility;
}

function eventVisibility(input, envelopeVisibility = null) {
  const explicit = clean(input?.visibility);
  if (explicit) return defaultWeaveVisibility(input.kind, explicit);
  if (envelopeVisibility === 'private') return 'private';
  return defaultWeaveVisibility(input?.kind);
}

export function normalizePersistedWeaveEvent(input = {}, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Persisted weave event must be an object.');
  if (input.protocol !== 'sideways-weave' || Number(input.version) !== 1) fail('Persisted weave protocol and version are invalid.');
  const id = exactId(input.id || context.id);
  const issuedAt = exactTimestamp(input.issued_at || context.issued_at);
  const issuer = clean(input.issuer || context.issuer);
  if (!issuer) fail('Persisted weave issuer is required.');
  const visibility = eventVisibility(input, context.visibility ? exactVisibility(context.visibility, 'Envelope visibility') : null);
  return {
    ...normalizeLegacyWeaveEvent({ ...input, id, issuer, issued_at: issuedAt }, context),
    visibility
  };
}

export function createWeaveEvent(input = {}, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Weave event input must be an object.');
  const issuedAt = exactTimestamp(input.issued_at || context.issued_at, 'Creation issued_at');
  const issuer = clean(input.issuer || context.issuer);
  if (!issuer) fail('Creation issuer is required.');
  const visibility = defaultWeaveVisibility(input.kind, input.visibility || context.visibility);
  const id = input.id || `weave:${stableWeaveDigest({
    ...input,
    id: null,
    issuer,
    issued_at: issuedAt,
    visibility
  }).slice(0, 32)}`;
  return normalizePersistedWeaveEvent({
    protocol: 'sideways-weave',
    version: 1,
    ...input,
    id,
    issuer,
    issued_at: issuedAt,
    visibility
  });
}

export function strictWeavePayload(input = {}, context = {}) {
  const event = input?.protocol === 'sideways-weave' && Number(input?.version) === 1 && input?.id && input?.issued_at
    ? normalizePersistedWeaveEvent(input, context)
    : createWeaveEvent(input, context);
  return {
    summary: context.summary || summarizeWeaveEvent(event),
    action: event.kind,
    weave: event
  };
}

function advertisedWeave(message) {
  return Boolean(message?.payload && typeof message.payload === 'object' && !Array.isArray(message.payload) && message.payload.weave);
}

export function normalizePersistedWeaveMessage(message = {}) {
  if (!advertisedWeave(message)) return null;
  const session = clean(message.session);
  const generation = Number(message.generation);
  const issuer = clean(message.issuer);
  const issuedAt = exactTimestamp(message.issued_at, 'Remote issued_at');
  const visibility = exactVisibility(message.visibility, 'Remote visibility');
  if (!session) fail('Remote session is required for a persisted weave event.');
  if (!Number.isSafeInteger(generation) || generation < 1) fail('Remote generation must be a positive safe integer.');
  if (!issuer) fail('Remote issuer is required for a persisted weave event.');

  const event = normalizePersistedWeaveEvent(message.payload.weave, { visibility });
  if (issuer !== event.issuer) fail(`Remote issuer mismatch for weave event ${event.id}.`, 'WEAVE_TRANSPORT_MISMATCH');
  if (issuedAt !== event.issued_at) fail(`Remote issued_at mismatch for weave event ${event.id}.`, 'WEAVE_TRANSPORT_MISMATCH');
  if (visibility !== event.visibility) fail(`Remote visibility mismatch for weave event ${event.id}.`, 'WEAVE_VISIBILITY_MISMATCH');

  return {
    ...message,
    session,
    generation,
    issuer,
    issued_at: issuedAt,
    visibility,
    payload: { ...message.payload, weave: event }
  };
}

function transportBinding(message) {
  return {
    session: message.session,
    generation: message.generation,
    issuer: message.issuer,
    issued_at: message.issued_at,
    visibility: message.visibility
  };
}

export function canonicalWeaveMessages(messages = []) {
  const byId = new Map();
  for (const raw of Array.isArray(messages) ? messages : []) {
    if (!advertisedWeave(raw)) continue;
    const message = normalizePersistedWeaveMessage(raw);
    const event = message.payload.weave;
    const eventDigest = stableWeaveDigest(event);
    const bindingDigest = stableWeaveDigest(transportBinding(message));
    const previous = byId.get(event.id);
    if (previous && previous.event_digest !== eventDigest) {
      fail(`Conflicting weave event id: ${event.id}.`, 'WEAVE_ID_CONFLICT');
    }
    if (previous && previous.binding_digest !== bindingDigest) {
      fail(`Weave event ${event.id} changed Remote session, generation, issuer, time, or visibility.`, 'WEAVE_TRANSPORT_CONFLICT');
    }
    if (!previous) byId.set(event.id, { event, event_digest: eventDigest, binding_digest: bindingDigest, message });
  }
  return [...byId.values()]
    .sort((left, right) => Date.parse(left.event.issued_at) - Date.parse(right.event.issued_at) || left.event.id.localeCompare(right.event.id))
    .map(value => value.message);
}

export function foldWeaveMessages(messages = [], now = Date.now()) {
  return foldLegacyWeaveMessages(canonicalWeaveMessages(messages), now);
}
