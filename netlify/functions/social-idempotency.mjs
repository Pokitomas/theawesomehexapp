import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fail } from './social-schema.mjs';

const mutationContext = new AsyncLocalStorage();
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const clean = value => String(value ?? '').trim();

function safeEqual(left, right) {
  const a = Buffer.from(clean(left));
  const b = Buffer.from(clean(right));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function mutationRequestDigest(request) {
  if (!(request instanceof Request)) throw new TypeError('A Request is required for social mutation identity.');
  const method = clean(request.method).toUpperCase() || 'GET';
  const url = new URL(request.url);
  const contentType = clean(request.headers.get('content-type')).toLowerCase();
  const body = SAFE_METHODS.has(method)
    ? Buffer.alloc(0)
    : Buffer.from(await request.clone().arrayBuffer());
  const envelope = Buffer.concat([
    Buffer.from(`${method}\n${url.pathname}${url.search}\n${contentType}\n${body.length}\n`, 'utf8'),
    body
  ]);
  return createHash('sha256').update(envelope).digest('hex');
}

export async function withSocialMutationContext(request, work) {
  if (typeof work !== 'function') throw new TypeError('A social mutation callback is required.');
  const method = clean(request?.method).toUpperCase() || 'GET';
  if (SAFE_METHODS.has(method)) return work();
  const requestDigest = await mutationRequestDigest(request);
  return mutationContext.run(Object.freeze({ requestDigest }), work);
}

export function currentSocialMutationIdentity(actorId, operation) {
  const requestDigest = clean(mutationContext.getStore()?.requestDigest);
  if (!requestDigest) throw fail(500, 'Social mutation request identity is unavailable.');
  return {
    actorId: clean(actorId),
    operation: clean(operation),
    requestDigest
  };
}

export function assertSocialReceiptReplay(prior, current) {
  if (!prior) return;
  const mismatch = () => fail(409, 'That idempotency key belongs to another mutation.');
  if (clean(prior.operation) !== clean(current.operation)) throw mismatch();
  if (!safeEqual(prior.request_digest, current.requestDigest)) throw mismatch();
  if (clean(current.operation) !== 'register' && clean(prior.actor_id) !== clean(current.actorId)) throw mismatch();
}
