import { createClient, idempotencyKey } from './client.js';

const client = createClient();
const command = (method, path, body, prefix) => client.request(path, {
  method,
  body,
  idempotencyKey: idempotencyKey(prefix),
});

const session = Object.freeze({
  signup: input => command('POST', '/auth/signup', input, 'auth.signup'),
  login: input => command('POST', '/auth/login', input, 'auth.login'),
  logout: () => command('POST', '/auth/logout', {}, 'auth.logout'),
  refresh: () => command('POST', '/auth/refresh', {}, 'auth.refresh'),
  me: () => client.request('/me'),
});

const profile = Object.freeze({
  update: input => command('PATCH', '/me/profile', input, 'profile.update'),
  byHandle: handle => client.request(`/users/${encodeURIComponent(handle)}`),
});

const posts = Object.freeze({
  create: input => command('POST', '/posts', input, 'post.create'),
  get: id => client.request(`/posts/${encodeURIComponent(id)}`),
  remove: id => command('DELETE', `/posts/${encodeURIComponent(id)}`, undefined, 'post.delete'),
  reply: (id, body) => command('POST', '/posts', { body, replyToId: id }, 'post.reply'),
  like: id => command('POST', `/posts/${encodeURIComponent(id)}/like`, {}, 'post.like'),
  unlike: id => command('DELETE', `/posts/${encodeURIComponent(id)}/like`, undefined, 'post.unlike'),
});

const graph = Object.freeze({
  follow: id => command('POST', `/users/${encodeURIComponent(id)}/follow`, {}, 'user.follow'),
  unfollow: id => command('DELETE', `/users/${encodeURIComponent(id)}/follow`, undefined, 'user.unfollow'),
});

const feeds = Object.freeze({
  following: cursor => client.request(`/feed/following${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  discover: cursor => client.request(`/feed/discover${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  user: (id, cursor) => client.request(`/users/${encodeURIComponent(id)}/posts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
});

const pendingKey = 'sideways-network-pending-v1';
const sync = Object.freeze({
  pending() {
    try { return JSON.parse(localStorage.getItem(pendingKey) || '[]'); } catch { return []; }
  },
  enqueue(entry) {
    const pending = this.pending();
    pending.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...entry });
    localStorage.setItem(pendingKey, JSON.stringify(pending));
    return pending.at(-1);
  },
  clear(id) {
    localStorage.setItem(pendingKey, JSON.stringify(this.pending().filter(entry => entry.id !== id)));
  },
});

export const SidewaysNetwork = Object.freeze({
  session,
  profile,
  posts,
  graph,
  feeds,
  notifications: Object.freeze({ list: cursor => client.request(`/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`) }),
  sync,
});

window.SidewaysNetwork = SidewaysNetwork;
window.dispatchEvent(new CustomEvent('sideways:networkready'));
