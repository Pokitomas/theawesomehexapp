import { idempotencyKey, request } from './client.js';

export const follow = userId => request(`/api/users/${encodeURIComponent(userId)}/follow`, { method: 'POST', idempotencyKey: idempotencyKey('follow') });
export const unfollow = userId => request(`/api/users/${encodeURIComponent(userId)}/follow`, { method: 'DELETE', idempotencyKey: idempotencyKey('unfollow') });

export const Graph = Object.freeze({ follow, unfollow });
