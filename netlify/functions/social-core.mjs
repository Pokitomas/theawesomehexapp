import {
  COLORS,
  MAX_FEED,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SOCIAL_VERSION,
  assertSameOriginMutation,
  clean,
  cookieToken,
  fail,
  handleOf,
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

const accountKey = id => `social/account/${id}`;
const handleKey = handle => `social/handle/${handle}`;
const sessionKey = token => `social/session/${sha256(token)}`;
const postKey = id => `social/post/${id}`;
const postStateKey = id => `social/post-state/${id}`;
const followKey = (viewerId, targetId) => `social/follow/${viewerId}/${targetId}`;
const likeKey = (viewerId, postId) => `social/like/${viewerId}/${postId}`;
const likePostKey = (postId, viewerId) => `social/like-post/${postId}/${viewerId}`;
const eventKey = (at, id = randomId(10)) => `social/event/${at.replace(/[-:.TZ]/g, '')}-${id}`;

async function writeEvent(store, type, actorId, payload, at) {
  const event = { version: SOCIAL_VERSION, id: randomId(12), type, actorId, at, payload };
  await store.set(eventKey(at, event.id), event);
  return event;
}

async function resolveSession(store, request, now) {
  const token = cookieToken(request);
  if (!token) return null;
  const session = await store.get(sessionKey(token));
  if (!session || Date.parse(session.expiresAt) <= now()) {
    if (session) await store.delete(sessionKey(token));
    return null;
  }
  const account = await store.get(accountKey(session.accountId));
  return account ? { token, session, account } : null;
}

async function requireSession(store, request, now) {
  const value = await resolveSession(store, request, now);
  if (!value) throw fail(401, 'Sign in required.');
  return value;
}

async function issueSession(store, accountId, request, now) {
  const token = randomId(32);
  const createdAt = nowISO(now);
  const expiresAt = new Date(now() + SESSION_TTL_MS).toISOString();
  await store.set(sessionKey(token), { accountId, createdAt, expiresAt });
  return { token, cookie: sessionCookie(token, request), expiresAt };
}

async function accountByHandle(store, value) {
  const handle = handleOf(value);
  if (!handle) return null;
  const pointer = await store.get(handleKey(handle));
  return pointer?.accountId ? store.get(accountKey(pointer.accountId)) : null;
}

async function listObjects(store, prefix) {
  const keys = await store.list(prefix);
  const rows = await Promise.all(keys.map(key => store.get(key)));
  return rows.filter(Boolean);
}

async function relationSets(store, viewerId) {
  if (!viewerId) return { follows: new Set(), likes: new Set() };
  const [follows, likes] = await Promise.all([
    listObjects(store, `social/follow/${viewerId}/`),
    listObjects(store, `social/like/${viewerId}/`)
  ]);
  return {
    follows: new Set(follows.map(item => item.targetId)),
    likes: new Set(likes.map(item => item.postId))
  };
}

async function projectPosts(store, posts, viewerId = '') {
  const accounts = new Map();
  for (const post of posts) {
    if (!accounts.has(post.authorId)) accounts.set(post.authorId, await store.get(accountKey(post.authorId)));
  }
  const relations = await relationSets(store, viewerId);
  const allPosts = await listObjects(store, 'social/post/');
  const replyCounts = new Map();
  for (const item of allPosts) if (item.replyTo) replyCounts.set(item.replyTo, (replyCounts.get(item.replyTo) || 0) + 1);
  return Promise.all(posts.map(async post => ({
    id: post.id,
    text: post.text,
    replyTo: post.replyTo || null,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    author: publicAccount(accounts.get(post.authorId)),
    likeCount: (await store.list(`social/like-post/${post.id}/`)).length,
    replyCount: replyCounts.get(post.id) || 0,
    liked: relations.likes.has(post.id),
    following: relations.follows.has(post.authorId),
    mine: viewerId === post.authorId
  })));
}

function newest(posts) {
  return posts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, MAX_FEED);
}

export function createMemoryStore() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async list(prefix = '') { return [...values.keys()].filter(key => key.startsWith(prefix)).sort(); },
    snapshot() { return new Map([...values].map(([key, value]) => [key, structuredClone(value)])); }
  };
}

export function createSocialService({ store, now = Date.now } = {}) {
  if (!store) throw new Error('A social store is required.');
  return async function socialService(request) {
    try {
      assertSameOriginMutation(request);
      if (request.method === 'OPTIONS') return response(204, {});
      const url = new URL(request.url);
      const op = clean(url.searchParams.get('op')).toLowerCase();
      const current = await resolveSession(store, request, now);

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
        if (await store.get(handleKey(handle))) throw fail(409, 'That handle is taken.');
        const id = `acct_${randomId(14)}`;
        const at = nowISO(now);
        const account = { id, name, handle, bio, accent, password: passwordRecord(password), createdAt: at, updatedAt: at };
        await store.set(accountKey(id), account);
        await store.set(handleKey(handle), { accountId: id, at });
        const claimed = await store.get(handleKey(handle));
        if (claimed?.accountId !== id) {
          await store.delete(accountKey(id));
          throw fail(409, 'That handle was claimed simultaneously. Try another.');
        }
        await writeEvent(store, 'account.registered', id, { handle }, at);
        const issued = await issueSession(store, id, request, now);
        return response(201, { account: publicAccount(account) }, { 'set-cookie': issued.cookie });
      }

      if (request.method === 'POST' && op === 'login') {
        const body = await jsonBody(request);
        const account = await accountByHandle(store, body.handle);
        const password = String(body.password || '');
        if (!account || !passwordMatches(password, account.password)) throw fail(401, 'Handle or password is incorrect.');
        const issued = await issueSession(store, account.id, request, now);
        await writeEvent(store, 'session.started', account.id, {}, nowISO(now));
        return response(200, { account: publicAccount(account) }, { 'set-cookie': issued.cookie });
      }

      if (request.method === 'POST' && op === 'logout') {
        if (current) await store.delete(sessionKey(current.token));
        return response(200, { signedOut: true }, { 'set-cookie': sessionCookie('', request, 0) });
      }

      if (request.method === 'GET' && op === 'profile') {
        const account = await accountByHandle(store, url.searchParams.get('handle'));
        if (!account) throw fail(404, 'Profile not found.');
        const following = current ? Boolean(await store.get(followKey(current.account.id, account.id))) : false;
        return response(200, { account: publicAccount(account), following, mine: current?.account.id === account.id });
      }

      if (request.method === 'PATCH' && op === 'profile') {
        const { account } = await requireSession(store, request, now);
        const body = await jsonBody(request);
        const previousHandle = account.handle;
        const nextHandle = body.handle === undefined ? previousHandle : handleOf(body.handle);
        const nextName = body.name === undefined ? account.name : clean(body.name).slice(0, 48);
        const bio = body.bio === undefined ? account.bio : clean(body.bio).slice(0, 180);
        const accent = body.accent === undefined ? account.accent : (COLORS.has(body.accent) ? body.accent : account.accent);
        if (!nextName || nextHandle.length < 2) throw fail(400, 'Name and a two-character handle are required.');
        if (nextHandle !== previousHandle) {
          const owner = await store.get(handleKey(nextHandle));
          if (owner && owner.accountId !== account.id) throw fail(409, 'That handle is taken.');
          await store.set(handleKey(nextHandle), { accountId: account.id, at: nowISO(now) });
          await store.delete(handleKey(previousHandle));
        }
        const updated = { ...account, name: nextName, handle: nextHandle, bio, accent, updatedAt: nowISO(now) };
        await store.set(accountKey(account.id), updated);
        await writeEvent(store, 'profile.updated', account.id, { handle: nextHandle }, updated.updatedAt);
        return response(200, { account: publicAccount(updated) });
      }

      if (request.method === 'POST' && op === 'post') {
        const { account } = await requireSession(store, request, now);
        const body = await jsonBody(request);
        const text = clean(body.text).slice(0, 4000);
        const replyTo = clean(body.replyTo).slice(0, 80) || null;
        if (!text) throw fail(400, 'Write something first.');
        if (replyTo && !await store.get(postKey(replyTo))) throw fail(404, 'The post you are replying to is gone.');
        const at = nowISO(now);
        const post = { id: `post_${randomId(14)}`, authorId: account.id, text, replyTo, createdAt: at, updatedAt: at };
        await store.set(postKey(post.id), post);
        await store.set(postStateKey(post.id), { postId: post.id, authorId: account.id, state: 'active', updatedAt: at });
        await writeEvent(store, replyTo ? 'post.replied' : 'post.created', account.id, { postId: post.id, replyTo }, at);
        const [projected] = await projectPosts(store, [post], account.id);
        return response(201, { post: projected });
      }

      if (request.method === 'DELETE' && op === 'post') {
        const { account } = await requireSession(store, request, now);
        const body = await jsonBody(request);
        const postId = clean(body.postId).slice(0, 80);
        const post = await store.get(postKey(postId));
        if (!post) throw fail(404, 'Post not found.');
        if (post.authorId !== account.id) throw fail(403, 'Only the author can delete this post.');
        const at = nowISO(now);
        await store.set(postStateKey(postId), {
          postId,
          authorId: post.authorId,
          state: 'author_deleted',
          deletedAt: at,
          updatedAt: at
        });
        await store.delete(postKey(postId));
        for (const relation of await listObjects(store, `social/like-post/${postId}/`)) {
          await store.delete(likePostKey(postId, relation.viewerId));
          await store.delete(likeKey(relation.viewerId, postId));
        }
        await writeEvent(store, 'post.author_deleted', account.id, { postId }, at);
        return response(200, { deleted: true, postId });
      }

      if (request.method === 'POST' && op === 'follow') {
        const { account } = await requireSession(store, request, now);
        const body = await jsonBody(request);
        const target = await accountByHandle(store, body.handle);
        if (!target) throw fail(404, 'Profile not found.');
        if (target.id === account.id) throw fail(400, 'You already follow yourself.');
        const active = body.active !== false;
        const key = followKey(account.id, target.id);
        if (active) await store.set(key, { viewerId: account.id, targetId: target.id, at: nowISO(now) }); else await store.delete(key);
        await writeEvent(store, active ? 'follow.created' : 'follow.deleted', account.id, { targetId: target.id }, nowISO(now));
        return response(200, { active, account: publicAccount(target) });
      }

      if (request.method === 'POST' && op === 'like') {
        const { account } = await requireSession(store, request, now);
        const body = await jsonBody(request);
        const postId = clean(body.postId).slice(0, 80);
        const post = await store.get(postKey(postId));
        if (!post) throw fail(404, 'Post not found.');
        const active = body.active !== false;
        if (active) {
          const value = { viewerId: account.id, postId, at: nowISO(now) };
          await store.set(likeKey(account.id, postId), value);
          await store.set(likePostKey(postId, account.id), value);
        } else {
          await store.delete(likeKey(account.id, postId));
          await store.delete(likePostKey(postId, account.id));
        }
        await writeEvent(store, active ? 'like.created' : 'like.deleted', account.id, { postId }, nowISO(now));
        const [projected] = await projectPosts(store, [post], account.id);
        return response(200, { active, post: projected });
      }

      if (request.method === 'GET' && (op === 'discover' || op === 'feed')) {
        const viewer = op === 'feed' ? (await requireSession(store, request, now)).account : current?.account;
        const posts = await listObjects(store, 'social/post/');
        let selected = posts;
        if (op === 'feed') {
          const relations = await relationSets(store, viewer.id);
          selected = posts.filter(post => post.authorId === viewer.id || relations.follows.has(post.authorId));
        }
        return response(200, { mode: op, posts: await projectPosts(store, newest(selected), viewer?.id || '') });
      }

      throw fail(404, 'Social operation not found.');
    } catch (error) {
      return response(Number(error?.status || 500), { error: error?.status ? error.message : 'Social service failed.' });
    }
  };
}
