import {
  COLORS,
  SESSION_TTL_MS,
  assertSameOriginMutation,
  clean,
  cookieToken,
  deterministicSessionToken,
  fail,
  handleOf,
  idempotencyKey,
  jsonBody,
  nowISO,
  passwordMatches,
  passwordRecord,
  publicAccount,
  randomId,
  response,
  sessionCookie,
  sha256
} from './social-schema.mjs';

export function createRelationalSocialService({ authority, sessionSecret, now = Date.now } = {}) {
  if (!authority) throw new Error('A relational social authority is required.');
  if (!sessionSecret) throw new Error('SOCIAL_SESSION_SECRET is required for relational social authority.');

  async function currentSession(request) {
    const token = cookieToken(request);
    if (!token) return null;
    const at = nowISO(now);
    const session = await authority.resolveSession(sha256(token), at);
    return session ? { ...session, token } : null;
  }

  async function requireSession(request) {
    const current = await currentSession(request);
    if (!current) throw fail(401, 'Sign in required.');
    return current;
  }

  function issueToken(scope, key) {
    const token = deterministicSessionToken(sessionSecret, scope, key);
    const at = nowISO(now);
    const expiresAt = new Date(Date.parse(at) + SESSION_TTL_MS).toISOString();
    return { token, tokenHash: sha256(token), at, expiresAt };
  }

  return async function relationalSocialService(request) {
    try {
      assertSameOriginMutation(request);
      if (request.method === 'OPTIONS') return response(204, {});
      const url = new URL(request.url);
      const op = clean(url.searchParams.get('op')).toLowerCase();
      const key = idempotencyKey(request);
      const current = await currentSession(request);

      if (request.method === 'GET' && op === 'session') {
        return response(200, { authenticated: Boolean(current), account: publicAccount(current?.account) });
      }

      if (request.method === 'POST' && op === 'register') {
        const body = await jsonBody(request);
        const name = clean(body.name).slice(0, 48);
        const handle = handleOf(body.handle);
        const password = String(body.password || '');
        const bio = clean(body.bio).slice(0, 180);
        const accent = COLORS.has(body.accent) ? body.accent : '#335cff';
        if (!name || handle.length < 2) throw fail(400, 'Name and a two-character handle are required.');
        if (password.length < 8 || password.length > 200) throw fail(400, 'Password must be 8–200 characters.');
        const issued = issueToken(`register:${handle}`, key);
        const result = await authority.register({
          id: `acct_${randomId(14)}`,
          name,
          handle,
          password: passwordRecord(password),
          bio,
          accent,
          tokenHash: issued.tokenHash,
          at: issued.at,
          expiresAt: issued.expiresAt,
          idempotencyKey: key
        });
        return response(result.status, result.body, { 'set-cookie': sessionCookie(issued.token, request) });
      }

      if (request.method === 'POST' && op === 'login') {
        const body = await jsonBody(request);
        const handle = handleOf(body.handle);
        const found = await authority.accountForLogin(handle);
        const password = String(body.password || '');
        if (!found || !passwordMatches(password, found.password)) throw fail(401, 'Handle or password is incorrect.');
        const issued = issueToken(`login:${found.id}`, key);
        const result = await authority.startSession({
          account: found,
          tokenHash: issued.tokenHash,
          at: issued.at,
          expiresAt: issued.expiresAt,
          idempotencyKey: key
        });
        return response(result.status, result.body, { 'set-cookie': sessionCookie(issued.token, request) });
      }

      if (request.method === 'POST' && op === 'logout') {
        const at = nowISO(now);
        const result = await authority.logout({
          tokenHash: current?.token ? sha256(current.token) : '',
          actorId: current?.account?.id || null,
          at,
          idempotencyKey: key
        });
        return response(result.status, result.body, { 'set-cookie': sessionCookie('', request, 0) });
      }

      if (request.method === 'GET' && op === 'profile') {
        const profile = await authority.profile(handleOf(url.searchParams.get('handle')), current?.account?.id || '');
        if (!profile) throw fail(404, 'Profile not found.');
        return response(200, profile);
      }

      if (request.method === 'PATCH' && op === 'profile') {
        const session = await requireSession(request);
        const body = await jsonBody(request);
        const nextName = body.name === undefined ? null : clean(body.name).slice(0, 48);
        const nextHandle = body.handle === undefined ? null : handleOf(body.handle);
        const bio = body.bio === undefined ? null : clean(body.bio).slice(0, 180);
        const accent = body.accent === undefined ? null : (COLORS.has(body.accent) ? body.accent : session.account.accent);
        if (nextName === '' || (nextHandle !== null && nextHandle.length < 2)) throw fail(400, 'Name and a two-character handle are required.');
        const result = await authority.updateProfile({
          actorId: session.account.id,
          name: nextName,
          handle: nextHandle,
          bio,
          accent,
          at: nowISO(now),
          idempotencyKey: key
        });
        return response(result.status, result.body);
      }

      if (request.method === 'POST' && op === 'post') {
        const session = await requireSession(request);
        const body = await jsonBody(request);
        const text = clean(body.text).slice(0, 4000);
        const replyTo = clean(body.replyTo).slice(0, 80) || null;
        if (!text) throw fail(400, 'Write something first.');
        const result = await authority.createPost({
          id: `post_${randomId(14)}`,
          actorId: session.account.id,
          text,
          replyTo,
          at: nowISO(now),
          idempotencyKey: key
        });
        return response(result.status, result.body);
      }

      if (request.method === 'POST' && op === 'follow') {
        const session = await requireSession(request);
        const body = await jsonBody(request);
        const handle = handleOf(body.handle);
        if (!handle) throw fail(404, 'Profile not found.');
        const result = await authority.setFollow({
          actorId: session.account.id,
          handle,
          active: body.active !== false,
          at: nowISO(now),
          idempotencyKey: key
        });
        return response(result.status, result.body);
      }

      if (request.method === 'POST' && op === 'like') {
        const session = await requireSession(request);
        const body = await jsonBody(request);
        const postId = clean(body.postId).slice(0, 80);
        const result = await authority.setLike({
          actorId: session.account.id,
          postId,
          active: body.active !== false,
          at: nowISO(now),
          idempotencyKey: key
        });
        return response(result.status, result.body);
      }

      if (request.method === 'GET' && (op === 'discover' || op === 'feed')) {
        const viewer = op === 'feed' ? (await requireSession(request)).account : current?.account;
        const posts = await authority.listPosts({ viewerId: viewer?.id || '', mode: op });
        return response(200, { mode: op, posts });
      }

      throw fail(404, 'Social operation not found.');
    } catch (error) {
      return response(Number(error?.status || 500), { error: error?.status ? error.message : 'Social service failed.' });
    }
  };
}
