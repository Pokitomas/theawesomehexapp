/**
 * Social schema definitions for relational store
 * Type definitions and utility functions for schema validation
 */

export const SOCIAL_TABLES = {
  accounts: 'social_accounts',
  sessions: 'social_sessions',
  posts: 'social_posts',
  follows: 'social_follows',
  likes: 'social_likes',
  events: 'social_events',
  idempotency: 'social_idempotency'
};

export const SOCIAL_EVENT_TYPES = [
  'account.registered',
  'session.started',
  'profile.updated',
  'post.created',
  'post.replied',
  'follow.created',
  'follow.deleted',
  'like.created',
  'like.deleted'
];

/**
 * Validate that an event payload does not contain secrets
 * Returns true if payload is clean (no password hashes, tokens, etc.)
 */
export function isSecretFreePayload(payload = {}) {
  const str = JSON.stringify(payload);
  const secrets = ['password', 'hash', 'token', 'secret', 'scrypt', 'sideways_session'];
  return !secrets.some(s => str.toLowerCase().includes(s.toLowerCase()));
}

/**
 * Build SELECT query for account with public fields only
 */
export function publicAccountSelect() {
  return `
    id, handle, name, bio, accent, created_at, updated_at
  `;
}
