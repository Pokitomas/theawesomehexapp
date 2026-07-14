// netlify/functions/agent-directive.mjs
import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const reply = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });

const nowISO = () => new Date().toISOString();

function safeEqual(a, b) {
  try {
    const A = Buffer.from(String(a));
    const B = Buffer.from(String(b));
    if (A.length !== B.length) return false;
    return timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

async function listAllJSON(store) {
  const list = await (store.list ? store.list() : []);
  const out = [];
  for (const item of list) {
    try {
      const data = await store.get(item.name, { type: 'json' });
      out.push({ meta: item, name: item.name, data });
    } catch {
      // ignore read errors
    }
  }
  return out;
}

export default async request => {
  if (request.method === 'OPTIONS') return reply(204, {});
  const secret = process.env.NETLIFY_AGENT_KEY || '';
  if (!secret) return reply(500, { error: 'Agent secret not configured (NETLIFY_AGENT_KEY).' });

  const url = new URL(request.url);
  const store = getStore('agent-directives');
  const principalsStore = getStore('agent-principals');
  const noncesStore = getStore('agent-nonces');

  // GET latest directive
  if (request.method === 'GET') {
    try {
      const directives = await listAllJSON(store);
      directives.sort((a, b) => (a.meta.updatedAt || '') < (b.meta.updatedAt || '') ? -1 : 1);
      const latest = directives.reverse().find(it => {
        const d = it.data;
        if (!d) return false;
        if (!d.expires_at) return true;
        return new Date(d.expires_at) > new Date();
      });
      return reply(200, { directive: latest ? latest.data : null });
    } catch (err) {
      return reply(500, { error: 'failed listing directives', detail: String(err) });
    }
  }

  // POST principals: admin path to register principals (must be signed by root HMAC)
  // POST /?op=principal
  if (request.method === 'POST' && url.searchParams.get('op') === 'principal') {
    const sig = request.headers.get('x-agent-signature') || '';
    const bodyText = await request.text().catch(() => '');
    const h = createHmac('sha256', secret).update(bodyText).digest('hex');
    if (!safeEqual(h, sig)) return reply(401, { error: 'principal registration requires valid root HMAC signature' });

    let payload;
    try { payload = JSON.parse(bodyText); } catch { return reply(400, { error: 'invalid json' }); }

    // payload: { id, publicKey, alg: 'ed25519', capabilities: ['post','admin'], expires_at }
    if (!payload || !payload.id || !payload.publicKey) return reply(400, { error: 'id and publicKey required' });

    try {
      const key = `principal-${payload.id}`;
      await principalsStore.setJSON(key, payload);
      return reply(200, { stored: key, principal: payload });
    } catch (err) {
      return reply(500, { error: 'failed to store principal', detail: String(err) });
    }
  }

  // GET principals: list registered principals (read-only)
  if (request.method === 'GET' && url.searchParams.get('op') === 'principals') {
    try {
      const items = await listAllJSON(principalsStore);
      return reply(200, { principals: items.map(i => ({ name: i.name, data: i.data })) });
    } catch (err) {
      return reply(500, { error: 'failed listing principals', detail: String(err) });
    }
  }

  // POST directive (normal path)
  if (request.method === 'POST') {
    const bodyText = await request.text().catch(() => '');
    if (!bodyText) return reply(400, { error: 'empty body' });

    // First try HMAC root signature header 'x-agent-signature'
    const sigHmac = request.headers.get('x-agent-signature') || '';
    if (sigHmac) {
      const h = createHmac('sha256', secret).update(bodyText).digest('hex');
      if (!safeEqual(h, sigHmac)) return reply(401, { error: 'invalid HMAC signature' });
      // HMAC root auth OK: proceed to store
      try {
        const payload = JSON.parse(bodyText);
        // validate basic shape
        if (!payload.directive) return reply(400, { error: 'directive field required' });
        const nonce = payload.nonce || `${Date.now()}-${Math.floor(Math.random()*1e6)}`;
        // check nonce unused
        const exists = await noncesStore.get(nonce).catch(() => null);
        if (exists) return reply(409, { error: 'nonce already used' });
        await noncesStore.setJSON(nonce, { used_at: nowISO(), by: 'hmac-root' });
        const key = `directive-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
        payload.issued_at = nowISO();
        payload._auth = { method: 'hmac-root' };
        await store.setJSON(key, payload);
        return reply(200, { stored: key, directive: payload });
      } catch (err) {
        return reply(500, { error: 'failed storing directive', detail: String(err) });
      }
    }

    // Otherwise try Ed25519 principal signature: headers 'x-agent-signature-ed25519' and 'x-agent-key-id'
    const sigEd = request.headers.get('x-agent-signature-ed25519') || '';
    const keyId = request.headers.get('x-agent-key-id') || '';
    if (sigEd && keyId) {
      // fetch principal record
      const pName = `principal-${keyId}`;
      const principal = await principalsStore.get(pName, { type: 'json' }).catch(() => null);
      if (!principal) return reply(401, { error: 'unknown principal key id' });
      if (principal.alg !== 'ed25519') return reply(401, { error: 'principal does not use ed25519' });

      try {
        const pubKeyPem = principal.publicKey; // expect PEM format
        const signatureBuf = Buffer.from(sigEd, 'base64');
        const crypto = await import('node:crypto');
        const valid = crypto.verify(null, Buffer.from(bodyText), pubKeyPem, signatureBuf);
        if (!valid) return reply(401, { error: 'invalid ed25519 signature' });

        const payload = JSON.parse(bodyText);
        if (!payload.directive) return reply(400, { error: 'directive field required' });

        // Check nonce
        const nonce = payload.nonce || `${Date.now()}-${Math.floor(Math.random()*1e6)}`;
        const exists = await noncesStore.get(nonce).catch(() => null);
        if (exists) return reply(409, { error: 'nonce already used' });
        await noncesStore.setJSON(nonce, { used_at: nowISO(), by: keyId });

        const key = `directive-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
        payload.issued_at = nowISO();
        payload._auth = { method: 'ed25519', principal: keyId };
        await store.setJSON(key, payload);
        return reply(200, { stored: key, directive: payload });
      } catch (err) {
        return reply(500, { error: 'signature verification failed', detail: String(err) });
      }
    }

    return reply(401, { error: 'no valid signature supplied' });
  }

  return reply(405, { error: 'method not allowed' });
};
