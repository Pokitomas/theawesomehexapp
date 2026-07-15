import { createHash } from 'node:crypto';
import {
  foldWeaveMessages as foldLegacyWeaveMessages,
  isWeaveMessage,
  normalizeWeaveEvent as normalizeLegacyWeaveEvent
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

export function normalizePersistedWeaveEvent(input = {}, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Persisted weave event must be an object.');
  const id = exactId(input.id || context.id);
  const issuedAt = exactTimestamp(input.issued_at || context.issued_at);
  const issuer = clean(input.issuer || context.issuer);
  if (!issuer) fail('Persisted weave issuer is required.');
  return normalizeLegacyWeaveEvent({ ...input, id, issuer, issued_at: issuedAt }, context);
}

export function createWeaveEvent(input = {}, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Weave event input must be an object.');
  const issuedAt = exactTimestamp(input.issued_at || context.issued_at, 'Creation issued_at');
  const issuer = clean(input.issuer || context.issuer);
  if (!issuer) fail('Creation issuer is required.');
  const id = input.id || `weave:${stableWeaveDigest({
    ...input,
    id: null,
    issuer,
    issued_at: issuedAt
  }).slice(0, 32)}`;
  return normalizePersistedWeaveEvent({ ...input, id, issuer, issued_at: issuedAt }, context);
}

function transportBinding(message, event) {
  const issuer = clean(message.issuer);
  if (issuer && issuer !== event.issuer) fail(`Remote issuer mismatch for weave event ${event.id}.`, 'WEAVE_TRANSPORT_MISMATCH');
  const issuedAt = message.issued_at ? exactTimestamp(message.issued_at, 'Remote issued_at') : event.issued_at;
  if (issuedAt !== event.issued_at) fail(`Remote issued_at mismatch for weave event ${event.id}.`, 'WEAVE_TRANSPORT_MISMATCH');
  return {
    session: clean(message.session) || null,
    generation: Number.isSafeInteger(Number(message.generation)) ? Number(message.generation) : null,
    issuer: issuer || event.issuer,
    issued_at: issuedAt,
    visibility: clean(message.visibility) || null
  };
}

export function canonicalWeaveMessages(messages = []) {
  const byId = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isWeaveMessage(message)) continue;
    const event = normalizePersistedWeaveEvent(message.payload.weave);
    const eventDigest = stableWeaveDigest(event);
    const binding = transportBinding(message, event);
    const bindingDigest = stableWeaveDigest(binding);
    const previous = byId.get(event.id);
    if (previous && previous.event_digest !== eventDigest) {
      fail(`Conflicting weave event id: ${event.id}.`, 'WEAVE_ID_CONFLICT');
    }
    if (previous && previous.binding_digest !== bindingDigest) {
      fail(`Weave event ${event.id} changed Remote session, generation, issuer, time, or visibility.`, 'WEAVE_TRANSPORT_CONFLICT');
    }
    if (!previous) {
      byId.set(event.id, {
        event,
        event_digest: eventDigest,
        binding_digest: bindingDigest,
        message: {
          ...message,
          issuer: binding.issuer,
          issued_at: binding.issued_at,
          payload: { ...message.payload, weave: event }
        }
      });
    }
  }
  return [...byId.values()]
    .sort((left, right) => Date.parse(left.event.issued_at) - Date.parse(right.event.issued_at) || left.event.id.localeCompare(right.event.id))
    .map(value => value.message);
}

export function foldWeaveMessages(messages = [], now = Date.now()) {
  return foldLegacyWeaveMessages(canonicalWeaveMessages(messages), now);
}
