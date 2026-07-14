import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HANDLE = /^[a-z0-9][a-z0-9_.-]{1,29}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (value, max = 1000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const handleOf = value => clean(value, 31).replace(/^@/, '').toLowerCase();
const emailOf = value => clean(value, 254).toLowerCase();
const tokenHash = value => createHash('sha256').update(String(value)).digest('hex');
const opaqueToken = prefix => `${prefix}_${randomBytes(32).toString('base64url')}`;
const isoAfter = milliseconds => new Date(Date.now() + milliseconds).toISOString();
const expired = value => !value || Date.parse(value) <= Date.now();
const response = (status, body = null, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
function assertSameOriginMutation(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) throw Object.assign(new Error('Cross-origin mutation rejected.'), { status: 403 });
  const site = request.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) throw Object.assign(new Error('Cross-site mutation rejected.'), { status: 403 });
}

const json = request => {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 64 * 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  return request.json().catch(() => ({}));
};
const asLimit = value => Math.max(1, Math.min(50, Number(value) || 30));

function routeFrom(request, explicitRoute = '') {
  if (explicitRoute) return explicitRoute.startsWith('/') ? explicitRoute : `/${explicitRoute}`;
  const url = new URL(request.url);
  const queryRoute = url.searchParams.get('route');
  if (queryRoute) return queryRoute.startsWith('/') ? queryRoute : `/${queryRoute}`;
  return url.pathname.replace(/^\/\.netlify\/functions\/social/, '') || '/';
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, saltValue, hashValue] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, 'base64url');
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicIdentity(bundle, viewerId = '') {
  if (!bundle?.profile) return null;
  return {
    id: bundle.id,
    handle: bundle.profile.handle,
    displayName: bundle.profile.displayName,
    bio: bundle.profile.bio || '',
    avatar: bundle.profile.avatar || '',
    cover: bundle.profile.cover || '',
    pronouns: bundle.profile.pronouns || '',
    website: bundle.profile.website || '',
    createdAt: bundle.createdAt,
    isSelf: bundle.id === viewerId
  };
}

function profileInput(body, { partial = false } = {}) {
  const source = body?.profile && typeof body.profile === 'object' ? body.profile : body || {};
  const handle = source.handle === undefined && partial ? undefined : handleOf(source.handle);
  const displayName = source.displayName === undefined && partial ? undefined : clean(source.displayName || source.name, 64);
  const profile = {
    ...(handle !== undefined ? { handle } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(source.bio !== undefined ? { bio: clean(source.bio, 280) } : {}),
    ...(source.avatar !== undefined ? { avatar: clean(source.avatar, 500) } : {}),
    ...(source.cover !== undefined ? { cover: clean(source.cover, 500) } : {}),
    ...(source.pronouns !== undefined ? { pronouns: clean(source.pronouns, 48) } : {}),
    ...(source.website !== undefined ? { website: clean(source.website, 500) } : {})
  };
  if (!partial && (!HANDLE.test(profile.handle || '') || !profile.displayName)) throw Object.assign(new Error('A valid handle and display name are required.'), { status: 400 });
  if (profile.handle !== undefined && !HANDLE.test(profile.handle)) throw Object.assign(new Error('Handle must be 2–30 lowercase letters, numbers, dots, dashes, or underscores.'), { status: 400 });
  return profile;
}

async function issueSession(store, userId) {
  const accessToken = opaqueToken('sat');
  const refreshToken = opaqueToken('srt');
  const accessExpiresAt = isoAfter(ACCESS_TTL_MS);
  const refreshExpiresAt = isoAfter(REFRESH_TTL_MS);
  const session = await store.createSession({ userId, accessHash: tokenHash(accessToken), refreshHash: tokenHash(refreshToken), accessExpiresAt, refreshExpiresAt });
  return { sessionId: session.id, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

async function authenticate(store, request, { optional = false } = {}) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  if (!token) {
    if (optional) return null;
    throw Object.assign(new Error('Authentication required.'), { status: 401 });
  }
  const session = await store.sessionByAccessHash(tokenHash(token));
  if (!session || session.revokedAt || expired(session.accessExpiresAt)) throw Object.assign(new Error('Session expired.'), { status: 401 });
  const user = await store.getUserById(session.userId);
  if (!user || user.status !== 'active') throw Object.assign(new Error('Account is unavailable.'), { status: 403 });
  return { session, user };
}

function mapStoreError(error) {
  if (error?.status) return error;
  if (error?.code === 'unique_email') return Object.assign(new Error('Email already exists.'), { status: 409 });
  if (error?.code === 'unique_handle') return Object.assign(new Error('Handle already exists.'), { status: 409 });
  if (error?.code === 'foreign_key') return Object.assign(new Error(error.message || 'Related object not found.'), { status: 404 });
  return error;
}

export function createSocialService({ store }) {
  if (!store) throw new TypeError('social store required');
  let ready;
  const ensureReady = () => ready ||= Promise.resolve(store.ensureSchema?.());

  return async function socialService(request, context = {}) {
    try {
      await ensureReady();
      assertSameOriginMutation(request);
      if (request.method === 'OPTIONS') return response(204);
      const url = new URL(request.url);
      const route = routeFrom(request, context.route || '');
      const segments = route.split('/').filter(Boolean).map(decodeURIComponent);
      const idempotencyKey = clean(request.headers.get('idempotency-key'), 180);

      if (request.method === 'POST' && route === '/auth/signup') {
        const body = await json(request);
        const email = emailOf(body.email);
        const password = String(body.password || '');
        if (!EMAIL.test(email)) return response(400, { error: 'A valid email is required.' });
        if (password.length < 10 || password.length > 200) return response(400, { error: 'Password must be at least 10 characters.' });
        const profile = profileInput(body);
        const user = await store.createUser({ email, passwordHash: await hashPassword(password), profile, idempotencyKey });
        const session = await issueSession(store, user.id);
        return response(201, { session, user: publicIdentity(user, user.id), email: user.email });
      }

      if (request.method === 'POST' && route === '/auth/login') {
        const body = await json(request);
        const user = await store.findUserByEmail(emailOf(body.email));
        if (!user || !await verifyPassword(String(body.password || ''), user.passwordHash)) return response(401, { error: 'Email or password is incorrect.' });
        const bundle = await store.getUserById(user.id);
        const session = await issueSession(store, user.id);
        return response(200, { session, user: publicIdentity(bundle, user.id), email: user.email });
      }

      if (request.method === 'POST' && route === '/auth/refresh') {
        const body = await json(request);
        const refreshToken = clean(body.refreshToken, 300);
        const current = refreshToken ? await store.sessionByRefreshHash(tokenHash(refreshToken)) : null;
        if (!current || current.revokedAt || expired(current.refreshExpiresAt)) return response(401, { error: 'Refresh session expired.' });
        const accessToken = opaqueToken('sat');
        const nextRefreshToken = opaqueToken('srt');
        const accessExpiresAt = isoAfter(ACCESS_TTL_MS);
        const refreshExpiresAt = isoAfter(REFRESH_TTL_MS);
        await store.rotateSession(current.id, { accessHash: tokenHash(accessToken), accessExpiresAt, refreshHash: tokenHash(nextRefreshToken), refreshExpiresAt });
        return response(200, { session: { sessionId: current.id, accessToken, refreshToken: nextRefreshToken, accessExpiresAt, refreshExpiresAt } });
      }

      if (request.method === 'POST' && route === '/auth/logout') {
        const auth = await authenticate(store, request);
        await store.revokeSession(auth.session.id);
        return response(204);
      }

      if (request.method === 'GET' && route === '/me') {
        const auth = await authenticate(store, request);
        return response(200, { user: publicIdentity(auth.user, auth.user.id), email: auth.user.email });
      }

      if (request.method === 'PATCH' && route === '/me/profile') {
        const auth = await authenticate(store, request);
        const patch = profileInput(await json(request), { partial: true });
        if (!Object.keys(patch).length) return response(400, { error: 'No profile changes supplied.' });
        const updated = await store.updateProfile(auth.user.id, patch, idempotencyKey);
        return response(200, { user: publicIdentity(updated, auth.user.id) });
      }

      if (segments[0] === 'users' && segments.length === 2 && request.method === 'GET') {
        const viewer = await authenticate(store, request, { optional: true });
        const bundle = await store.getUserByHandle(handleOf(segments[1]));
        if (!bundle) return response(404, { error: 'User not found.' });
        return response(200, { user: publicIdentity(bundle, viewer?.user.id || '') });
      }

      if (segments[0] === 'users' && segments[2] === 'follow' && segments.length === 3 && ['POST', 'DELETE'].includes(request.method)) {
        const auth = await authenticate(store, request);
        const followedId = segments[1];
        if (followedId === auth.user.id) return response(400, { error: 'You cannot follow yourself.' });
        if (!await store.getUserById(followedId)) return response(404, { error: 'User not found.' });
        const result = await store.setFollow(auth.user.id, followedId, request.method === 'POST', idempotencyKey);
        return response(200, result);
      }

      if (segments[0] === 'users' && segments[2] === 'posts' && segments.length === 3 && request.method === 'GET') {
        const viewer = await authenticate(store, request, { optional: true });
        if (!await store.getUserById(segments[1])) return response(404, { error: 'User not found.' });
        return response(200, await store.userPosts(segments[1], viewer?.user.id || '', { cursor: url.searchParams.get('cursor'), limit: asLimit(url.searchParams.get('limit')) }));
      }

      if (request.method === 'POST' && route === '/posts') {
        const auth = await authenticate(store, request);
        const body = await json(request);
        const text = clean(body.body, 4000);
        if (!text) return response(400, { error: 'Post text is required.' });
        const visibility = clean(body.visibility || 'public', 20);
        if (!['public', 'unlisted'].includes(visibility)) return response(400, { error: 'Unsupported visibility.' });
        const post = await store.createPost(auth.user.id, {
          body: text,
          visibility,
          replyToId: clean(body.replyToId || body.reply_to_id, 100) || null,
          repostOfId: clean(body.repostOfId || body.repost_of_id, 100) || null,
          contentWarning: clean(body.contentWarning || body.content_warning, 280),
          language: clean(body.language || 'und', 12) || 'und'
        }, idempotencyKey);
        return response(201, { post });
      }

      if (segments[0] === 'posts' && segments.length === 2 && request.method === 'GET') {
        const viewer = await authenticate(store, request, { optional: true });
        const post = await store.getPost(segments[1], viewer?.user.id || '');
        if (!post) return response(404, { error: 'Post not found.' });
        return response(200, { post });
      }

      if (segments[0] === 'posts' && segments.length === 2 && request.method === 'DELETE') {
        const auth = await authenticate(store, request);
        const post = await store.deletePost(auth.user.id, segments[1], idempotencyKey);
        if (!post) return response(404, { error: 'Post not found or not owned by you.' });
        return response(200, { post });
      }

      if (segments[0] === 'posts' && segments[2] === 'like' && segments.length === 3 && ['POST', 'DELETE'].includes(request.method)) {
        const auth = await authenticate(store, request);
        const result = await store.setReaction(auth.user.id, segments[1], request.method === 'POST', 'like', idempotencyKey);
        if (!result) return response(404, { error: 'Post not found.' });
        return response(200, result);
      }

      if (segments[0] === 'posts' && segments[2] === 'thread' && segments.length === 3 && request.method === 'GET') {
        const viewer = await authenticate(store, request, { optional: true });
        const thread = await store.thread(segments[1], viewer?.user.id || '', { cursor: url.searchParams.get('cursor'), limit: asLimit(url.searchParams.get('limit')) });
        if (!thread) return response(404, { error: 'Post not found.' });
        return response(200, thread);
      }

      if (request.method === 'GET' && route === '/feed/following') {
        const auth = await authenticate(store, request);
        return response(200, await store.followingFeed(auth.user.id, { cursor: url.searchParams.get('cursor'), limit: asLimit(url.searchParams.get('limit')) }));
      }

      return response(404, { error: 'Route not found.' });
    } catch (rawError) {
      const error = mapStoreError(rawError);
      if (!error.status || error.status >= 500) console.error('[social]', error);
      return response(error.status || 500, { error: error.status ? error.message : 'Social service failed.' });
    }
  };
}

export const SocialSecurity = Object.freeze({ hashPassword, verifyPassword, tokenHash });
