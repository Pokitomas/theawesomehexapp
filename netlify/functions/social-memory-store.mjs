import { randomUUID } from 'node:crypto';

const clone = value => value === undefined ? undefined : structuredClone(value);
const nowISO = () => new Date().toISOString();
const page = (rows, cursor, limit) => {
  const start = cursor ? Math.max(0, rows.findIndex(row => row.id === cursor) + 1) : 0;
  const items = rows.slice(start, start + limit);
  return { items: clone(items), nextCursor: rows[start + limit]?.id || null };
};

export function createMemorySocialStore() {
  const state = {
    users: new Map(), emails: new Map(), handles: new Map(), profiles: new Map(), sessions: new Map(), access: new Map(), refresh: new Map(), posts: new Map(), follows: new Map(), reactions: new Map(), events: [], idempotency: new Map()
  };
  const followKey = (followerId, followedId) => `${followerId}:${followedId}`;
  const reactionKey = (actorId, postId, kind = 'like') => `${actorId}:${postId}:${kind}`;
  const idemKey = (actorId, key) => key ? `${actorId}:${key}` : '';
  const userBundle = userId => {
    const user = state.users.get(userId);
    const profile = state.profiles.get(userId);
    return user && profile ? { ...clone(user), profile: clone(profile) } : null;
  };
  const eventResponse = (actorId, key) => {
    const id = state.idempotency.get(idemKey(actorId, key));
    const event = id ? state.events.find(item => item.id === id) : null;
    return event ? clone(event.response) : null;
  };
  const appendEvent = ({ actorId, type, objectType, objectId, payload = {}, idempotencyKey = '', response = null }) => {
    const event = { id: `evt_${randomUUID()}`, actorId, type, objectType, objectId, payload: clone(payload), idempotencyKey, createdAt: nowISO(), response: clone(response) };
    state.events.push(event);
    if (idempotencyKey) state.idempotency.set(idemKey(actorId, idempotencyKey), event.id);
    return event;
  };
  const postView = (post, viewerId = '') => {
    if (!post) return null;
    const author = userBundle(post.authorId);
    const likeCount = [...state.reactions.values()].filter(item => item.postId === post.id && item.kind === 'like').length;
    const replyCount = [...state.posts.values()].filter(item => item.replyToId === post.id && !item.deletedAt).length;
    return {
      ...clone(post),
      author: author ? { id: author.id, handle: author.profile.handle, displayName: author.profile.displayName, bio: author.profile.bio, avatar: author.profile.avatar, cover: author.profile.cover, pronouns: author.profile.pronouns, website: author.profile.website } : null,
      engagement: { likes: likeCount, replies: replyCount, viewerLiked: Boolean(viewerId && state.reactions.has(reactionKey(viewerId, post.id))) }
    };
  };

  return Object.freeze({
    kind: 'memory',
    async ensureSchema() {},
    async reset() {
      for (const value of Object.values(state)) {
        if (value instanceof Map) value.clear();
        else if (Array.isArray(value)) value.length = 0;
      }
    },
    async createUser({ email, passwordHash, profile, idempotencyKey = '' }) {
      const normalizedEmail = String(email).toLowerCase();
      if (state.emails.has(normalizedEmail)) throw Object.assign(new Error('Email already exists.'), { code: 'unique_email' });
      if (state.handles.has(profile.handle)) throw Object.assign(new Error('Handle already exists.'), { code: 'unique_handle' });
      const id = `usr_${randomUUID()}`;
      const createdAt = nowISO();
      const user = { id, email: normalizedEmail, passwordHash, status: 'active', createdAt };
      const publicProfile = { userId: id, ...clone(profile), createdAt, updatedAt: createdAt };
      state.users.set(id, user); state.emails.set(normalizedEmail, id); state.handles.set(profile.handle, id); state.profiles.set(id, publicProfile);
      const result = userBundle(id);
      appendEvent({ actorId: id, type: 'account.created', objectType: 'user', objectId: id, payload: { handle: profile.handle }, idempotencyKey, response: result });
      return clone(result);
    },
    async findUserByEmail(email) { const id = state.emails.get(String(email).toLowerCase()); return id ? clone(state.users.get(id)) : null; },
    async getUserById(id) { return clone(userBundle(id)); },
    async getUserByHandle(handle) { const id = state.handles.get(String(handle).toLowerCase()); return id ? clone(userBundle(id)) : null; },
    async updateProfile(userId, patch, idempotencyKey = '') {
      const replay = eventResponse(userId, idempotencyKey); if (replay) return replay;
      const current = state.profiles.get(userId); if (!current) return null;
      if (patch.handle && patch.handle !== current.handle) {
        const owner = state.handles.get(patch.handle);
        if (owner && owner !== userId) throw Object.assign(new Error('Handle already exists.'), { code: 'unique_handle' });
        state.handles.delete(current.handle); state.handles.set(patch.handle, userId);
      }
      const next = { ...current, ...clone(patch), updatedAt: nowISO() };
      state.profiles.set(userId, next);
      const result = userBundle(userId);
      appendEvent({ actorId: userId, type: 'profile.updated', objectType: 'profile', objectId: userId, payload: patch, idempotencyKey, response: result });
      return clone(result);
    },
    async createSession({ userId, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt }) {
      const id = `ses_${randomUUID()}`;
      const session = { id, userId, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt, createdAt: nowISO(), revokedAt: null };
      state.sessions.set(id, session); state.access.set(accessHash, id); state.refresh.set(refreshHash, id); return clone(session);
    },
    async sessionByAccessHash(hash) { const id = state.access.get(hash); return id ? clone(state.sessions.get(id)) : null; },
    async sessionByRefreshHash(hash) { const id = state.refresh.get(hash); return id ? clone(state.sessions.get(id)) : null; },
    async rotateSession(sessionId, { accessHash, accessExpiresAt, refreshHash, refreshExpiresAt }) {
      const session = state.sessions.get(sessionId); if (!session) return null;
      state.access.delete(session.accessHash); state.refresh.delete(session.refreshHash);
      Object.assign(session, { accessHash, accessExpiresAt, refreshHash, refreshExpiresAt });
      state.access.set(accessHash, sessionId); state.refresh.set(refreshHash, sessionId); return clone(session);
    },
    async revokeSession(sessionId) {
      const session = state.sessions.get(sessionId); if (!session) return false;
      session.revokedAt = nowISO(); state.access.delete(session.accessHash); state.refresh.delete(session.refreshHash); return true;
    },
    async createPost(actorId, input, idempotencyKey = '') {
      const replay = eventResponse(actorId, idempotencyKey); if (replay) return replay;
      if (input.replyToId && !state.posts.has(input.replyToId)) throw Object.assign(new Error('Reply target not found.'), { code: 'foreign_key' });
      if (input.repostOfId && !state.posts.has(input.repostOfId)) throw Object.assign(new Error('Repost target not found.'), { code: 'foreign_key' });
      const id = `post_${randomUUID()}`; const createdAt = nowISO();
      const post = { id, authorId: actorId, body: input.body, visibility: input.visibility || 'public', replyToId: input.replyToId || null, repostOfId: input.repostOfId || null, contentWarning: input.contentWarning || '', language: input.language || 'und', createdAt, editedAt: null, deletedAt: null };
      state.posts.set(id, post);
      const result = postView(post, actorId);
      appendEvent({ actorId, type: 'post.created', objectType: 'post', objectId: id, payload: { replyToId: post.replyToId, repostOfId: post.repostOfId }, idempotencyKey, response: result });
      return clone(result);
    },
    async getPost(postId, viewerId = '') { return clone(postView(state.posts.get(postId), viewerId)); },
    async deletePost(actorId, postId, idempotencyKey = '') {
      const replay = eventResponse(actorId, idempotencyKey); if (replay) return replay;
      const post = state.posts.get(postId); if (!post || post.authorId !== actorId) return null;
      post.deletedAt = nowISO(); post.body = '';
      const result = postView(post, actorId);
      appendEvent({ actorId, type: 'post.deleted', objectType: 'post', objectId: postId, idempotencyKey, response: result });
      return clone(result);
    },
    async setFollow(actorId, followedId, active, idempotencyKey = '') {
      const replay = eventResponse(actorId, idempotencyKey); if (replay) return replay;
      const key = followKey(actorId, followedId);
      if (active) state.follows.set(key, { followerId: actorId, followedId, createdAt: nowISO() }); else state.follows.delete(key);
      const result = { followerId: actorId, followedId, following: active };
      appendEvent({ actorId, type: active ? 'follow.created' : 'follow.deleted', objectType: 'user', objectId: followedId, idempotencyKey, response: result });
      return clone(result);
    },
    async setReaction(actorId, postId, active, kind = 'like', idempotencyKey = '') {
      const replay = eventResponse(actorId, idempotencyKey); if (replay) return replay;
      if (!state.posts.has(postId)) return null;
      const key = reactionKey(actorId, postId, kind);
      if (active) state.reactions.set(key, { actorId, postId, kind, createdAt: nowISO() }); else state.reactions.delete(key);
      const result = { actorId, postId, kind, active, post: postView(state.posts.get(postId), actorId) };
      appendEvent({ actorId, type: active ? 'reaction.created' : 'reaction.deleted', objectType: 'post', objectId: postId, payload: { kind }, idempotencyKey, response: result });
      return clone(result);
    },
    async followingFeed(viewerId, { cursor = null, limit = 30 } = {}) {
      const followed = new Set([viewerId]); for (const item of state.follows.values()) if (item.followerId === viewerId) followed.add(item.followedId);
      const rows = [...state.posts.values()].filter(item => followed.has(item.authorId) && item.visibility === 'public' && !item.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(item => postView(item, viewerId));
      return page(rows, cursor, limit);
    },
    async userPosts(userId, viewerId, { cursor = null, limit = 30 } = {}) {
      const rows = [...state.posts.values()].filter(item => item.authorId === userId && item.visibility === 'public' && !item.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(item => postView(item, viewerId));
      return page(rows, cursor, limit);
    },
    async thread(postId, viewerId, { cursor = null, limit = 30 } = {}) {
      const root = state.posts.get(postId); if (!root) return null;
      const ancestors = []; let current = root; const seen = new Set();
      while (current?.replyToId && !seen.has(current.replyToId)) { seen.add(current.replyToId); current = state.posts.get(current.replyToId); if (current) ancestors.unshift(postView(current, viewerId)); }
      const replies = [...state.posts.values()].filter(item => item.replyToId === postId && !item.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(item => postView(item, viewerId));
      const replyPage = page(replies, cursor, limit);
      return { root: postView(root, viewerId), ancestors, replies: replyPage.items, continuation: replyPage.nextCursor };
    },
    async listEvents() { return clone(state.events); },
    _state: state
  });
}
