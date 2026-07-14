import { idempotencyKey, request } from './client.js';

export const create = input => request('/api/posts', { method: 'POST', body: input, idempotencyKey: idempotencyKey(input.replyToId ? 'reply' : 'post') });
export const get = id => request(`/api/posts/${encodeURIComponent(id)}`);
export const remove = id => request(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE', idempotencyKey: idempotencyKey('delete') });
export const thread = (id, cursor = '') => request(`/api/posts/${encodeURIComponent(id)}/thread${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
export const like = id => request(`/api/posts/${encodeURIComponent(id)}/like`, { method: 'POST', idempotencyKey: idempotencyKey('like') });
export const unlike = id => request(`/api/posts/${encodeURIComponent(id)}/like`, { method: 'DELETE', idempotencyKey: idempotencyKey('unlike') });

export const Posts = Object.freeze({ create, get, remove, thread, like, unlike });
