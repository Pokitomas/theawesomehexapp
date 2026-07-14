import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail, response } from './social-schema.mjs';

const mutationContext = new AsyncLocalStorage();
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_MUTATION_BODY_BYTES = 64 * 1024;
const DIGEST_DOMAIN = 'sideways-social-idempotency-v1\0';

const clean = value => String(value ?? '').trim();

function safeEqual(left, right) {
  const a = Buffer.from(clean(left));
  const b = Buffer.from(clean(right));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function boundedBody(request) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MUTATION_BODY_BYTES) {
    throw fail(413, 'Request is too large.');
  }
  const body = request.clone().body;
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_MUTATION_BODY_BYTES) throw fail(413, 'Request is too large.');
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, total);
}

export async function mutationRequestDigest(request, secret) {
  if (!(request instanceof Request)) throw new TypeError('A Request is required for social mutation identity.');
  const key = String(secret || '');
  if (!key) throw fail(500, 'Social mutation request identity is unavailable.');
  const method = clean(request.method).toUpperCase() || 'GET';
  const url = new URL(request.url);
  const contentType = clean(request.headers.get('content-type')).toLowerCase();
  const body = SAFE_METHODS.has(method) ? Buffer.alloc(0) : await boundedBody(request);
  const digest = createHmac('sha256', key);
  digest.update(DIGEST_DOMAIN, 'utf8');
  digest.update(`${method}\n${url.pathname}${url.search}\n${contentType}\n${body.length}\n`, 'utf8');
  digest.update(body);
  return digest.digest('hex');
}

export async function withSocialMutationContext(request, secret, work) {
  if (typeof work !== 'function') throw new TypeError('A social mutation callback is required.');
  const method = clean(request?.method).toUpperCase() || 'GET';
  const idempotencyKey = clean(request?.headers?.get?.('idempotency-key'));
  if (SAFE_METHODS.has(method) || !idempotencyKey) return work();
  try {
    const requestDigest = await mutationRequestDigest(request, secret);
    return mutationContext.run(Object.freeze({ requestDigest }), work);
  } catch (error) {
    return response(Number(error?.status || 500), {
      error: error?.status ? error.message : 'Social service failed.'
    });
  }
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

export { MAX_MUTATION_BODY_BYTES };
