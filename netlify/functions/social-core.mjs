import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const text = value => String(value ?? '').trim();
const json = value => JSON.stringify(value ?? {});
const nowIso = () => new Date().toISOString();
const normalizeHandle = value => text(value).toLowerCase();
const hashToken = token => createHash('sha256').update(token).digest('hex');

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const normalized = String(password || '');
  if (normalized.length < 10) throw new Error('Password must be at least 10 characters.');
  return `${salt}:${scryptSync(normalized, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, encoded) {
  const [salt, expected] = String(encoded || '').split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(String(password || ''), salt, 64);
  const target = Buffer.from(expected, 'hex');
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export function makeSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function parseSession(request) {
  const authorization = request.headers.get('authorization') || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
  const match = (request.headers.get('cookie') || '').match(/(?:^|;\s*)sideways_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export function sessionCookie(token, maxAge = 60 * 60 * 24 * 30) {
  return `sideways_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function normalizePublicProfile(input = {}) {
  return {
    handle: normalizeHandle(input.handle),
    displayName: text(input.displayName || input.display_name).slice(0, 80),
    bio: text(input.bio).slice(0, 500),
    avatar: text(input.avatar || input.avatar_url).slice(0, 2048),
    cover: text(input.cover || input.cover_url).slice(0, 2048),
    pronouns: text(input.pronouns).slice(0, 80),
    website: text(input.website).slice(0, 2048),
  };
}

export function postToRecord(row, viewer = {}) {
  return {
    id: row.id,
    type: 'social',
    source: 'Sideways network',
    canonicalUrl: `/manual/#/post/${row.id}`,
    published: new Date(row.created_at).toISOString(),
    author: {
      id: row.author_id,
      name: row.display_name || row.handle,
      handle: `@${row.handle}`,
      url: `/manual/#/author/${row.handle}`,
      avatar: row.avatar_url || '',
    },
    title: '',
    text: row.body,
    summary: row.body,
    media: [],
    engagement: {
      likes: Number(row.like_count || 0),
      replies: Number(row.reply_count || 0),
      reposts: Number(row.repost_count || 0),
      likedByViewer: Boolean(row.liked_by_viewer),
      followedAuthor: Boolean(row.followed_author),
    },
    replyTo: row.reply_to_id || null,
    repostOf: row.repost_of_id || null,
    tags: [],
    retrievalFeatures: row.retrieval_features || {},
    network: { authoritative: true, visibility: row.visibility, viewerId: viewer.id || null },
  };
}

export function createMemorySocialStore() {
  const state = { users: new Map(), sessions: new Map(), posts: new Map(), follows: new Set(), likes: new Set(), events: new Map() };
  const id = prefix => `${prefix}_${randomBytes(10).toString('hex')}`;
  const event = (actorId, type, objectType, objectId, payload, key) => {
    const dedupe = `${actorId || 'system'}:${key}`;
    if (state.events.has(dedupe)) return state.events.get(dedupe);
    const row = { id: id('evt'), actor_id: actorId, type, object_type: objectType, object_id: objectId, payload, idempotency_key: key, created_at: nowIso() };
    state.events.set(dedupe, row);
    return row;
  };
  const userView = user => ({ id: user.id, email: user.email, handle: user.handle, status: user.status, profile: { ...user.profile } });

  return {
    state,
    async signup({ email, password, profile, idempotencyKey }) {
      const handle = normalizeHandle(profile.handle);
      if (!/^[a-z0-9_]{3,24}$/.test(handle)) throw new Error('Handle must be 3–24 lowercase letters, numbers, or underscores.');
      if ([...state.users.values()].some(user => user.email === text(email).toLowerCase() || user.handle === handle)) throw new Error('Account already exists.');
      const user = { id: id('usr'), email: text(email).toLowerCase(), handle, password_hash: hashPassword(password), status: 'active', created_at: nowIso(), profile: { ...normalizePublicProfile(profile), handle } };
      state.users.set(user.id, user);
      event(user.id, 'user.created', 'user', user.id, { handle }, idempotencyKey);
      return userView(user);
    },
    async login({ email, password }) {
      const user = [...state.users.values()].find(item => item.email === text(email).toLowerCase());
      if (!user || !verifyPassword(password, user.password_hash) || user.status !== 'active') throw new Error('Invalid credentials.');
      const token = makeSessionToken();
      state.sessions.set(hashToken(token), { user_id: user.id, expires_at: Date.now() + 30 * 86400000 });
      return { token, user: userView(user) };
    },
    async authenticate(token) {
      const session = state.sessions.get(hashToken(token));
      if (!session || session.expires_at <= Date.now()) return null;
      const user = state.users.get(session.user_id);
      return user ? userView(user) : null;
    },
    async logout(token) { state.sessions.delete(hashToken(token)); },
    async updateProfile(actorId, profile, idempotencyKey) {
      const user = state.users.get(actorId);
      if (!user) throw new Error('User not found.');
      const next = normalizePublicProfile({ ...user.profile, ...profile, handle: user.handle });
      user.profile = next;
      event(actorId, 'profile.updated', 'user', actorId, next, idempotencyKey);
      return userView(user);
    },
    async getUser(handle) {
      const user = [...state.users.values()].find(item => item.handle === normalizeHandle(handle));
      if (!user) return null;
      return userView(user);
    },
    async createPost(actorId, input, idempotencyKey) {
      const body = text(input.body);
      if (!body || body.length > 10000) throw new Error('Post body must be 1–10000 characters.');
      if (input.replyToId && !state.posts.has(input.replyToId)) throw new Error('Reply target not found.');
      const existing = state.events.get(`${actorId}:${idempotencyKey}`);
      if (existing?.type === 'post.created') return state.posts.get(existing.object_id);
      const post = { id: id('post'), author_id: actorId, body, visibility: input.visibility === 'followers' ? 'followers' : 'public', reply_to_id: input.replyToId || null, repost_of_id: input.repostOfId || null, created_at: nowIso(), deleted_at: null };
      state.posts.set(post.id, post);
      event(actorId, 'post.created', 'post', post.id, { replyToId: post.reply_to_id, repostOfId: post.repost_of_id }, idempotencyKey);
      return post;
    },
    async deletePost(actorId, postId, idempotencyKey) {
      const post = state.posts.get(postId);
      if (!post || post.author_id !== actorId) throw new Error('Post not found.');
      post.deleted_at = nowIso();
      event(actorId, 'post.deleted', 'post', postId, {}, idempotencyKey);
      return { id: postId, deleted: true };
    },
    async follow(actorId, targetId, enabled, idempotencyKey) {
      if (actorId === targetId || !state.users.has(targetId)) throw new Error('Invalid follow target.');
      const key = `${actorId}:${targetId}`;
      enabled ? state.follows.add(key) : state.follows.delete(key);
      event(actorId, enabled ? 'user.followed' : 'user.unfollowed', 'user', targetId, {}, idempotencyKey);
      return { following: enabled };
    },
    async like(actorId, postId, enabled, idempotencyKey) {
      if (!state.posts.has(postId)) throw new Error('Post not found.');
      const key = `${actorId}:${postId}`;
      enabled ? state.likes.add(key) : state.likes.delete(key);
      event(actorId, enabled ? 'post.liked' : 'post.unliked', 'post', postId, {}, idempotencyKey);
      return { liked: enabled };
    },
    async followingFeed(actorId, cursor = '') {
      const followed = new Set([...state.follows].filter(key => key.startsWith(`${actorId}:`)).map(key => key.split(':')[1]));
      const rows = [...state.posts.values()].filter(post => !post.deleted_at && followed.has(post.author_id) && (!cursor || post.created_at < cursor)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
      return rows.map(post => {
        const user = state.users.get(post.author_id);
        return postToRecord({ ...post, handle: user.handle, display_name: user.profile.displayName, avatar_url: user.profile.avatar, like_count: [...state.likes].filter(key => key.endsWith(`:${post.id}`)).length, reply_count: [...state.posts.values()].filter(item => item.reply_to_id === post.id && !item.deleted_at).length, repost_count: 0, liked_by_viewer: state.likes.has(`${actorId}:${post.id}`), followed_author: true });
      });
    },
  };
}

export const internals = { hashToken, normalizeHandle, json };
