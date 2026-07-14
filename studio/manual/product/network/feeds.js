import { request } from './client.js';

export const following = (cursor = '') => request(`/api/feed/following${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
export const userPosts = (userId, cursor = '') => request(`/api/users/${encodeURIComponent(userId)}/posts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);

export const Feeds = Object.freeze({ following, userPosts });
