import { clean, fail } from './social-schema.mjs';

export const COMMUNITY_ROLES = Object.freeze(['member', 'moderator', 'owner']);
export const COMMUNITY_STATES = Object.freeze(['active', 'forked', 'archived']);
export const MODERATION_ACTIONS = Object.freeze(['remove', 'restore', 'lock', 'unlock', 'ban', 'unban', 'restrict', 'unrestrict']);

export function communitySlug(value) {
  return clean(value)
    .toLowerCase()
    .replace(/^c\//, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function contentVisibility(value = {}) {
  if (value.legalRestrictedAt || value.legal_restricted_at) return 'legal_restricted';
  if (value.moderatorRemovedAt || value.moderator_removed_at) return 'moderator_removed';
  if (value.authorDeletedAt || value.author_deleted_at) return 'author_deleted';
  return 'visible';
}

export function contentState(value = {}) {
  const visibility = contentVisibility(value);
  return {
    visibility,
    tombstone: visibility !== 'visible',
    locked: Boolean(value.lockedAt || value.locked_at),
    authorDeletedAt: value.authorDeletedAt || value.author_deleted_at || null,
    moderatorRemovedAt: value.moderatorRemovedAt || value.moderator_removed_at || null,
    legalRestrictedAt: value.legalRestrictedAt || value.legal_restricted_at || null,
    lockedAt: value.lockedAt || value.locked_at || null
  };
}

export function visibleText(value = {}) {
  const state = contentState(value);
  if (state.visibility === 'visible') return String(value.text || '');
  if (state.visibility === 'author_deleted') return '[deleted by author]';
  if (state.visibility === 'moderator_removed') return '[removed by moderators]';
  return '[restricted]';
}

export function assertCommunityRole(membership, allowed, message = 'Community authority required.') {
  const roles = new Set(Array.isArray(allowed) ? allowed : [allowed]);
  if (!membership || membership.status !== 'active' || !roles.has(membership.role)) throw fail(403, message);
  return membership;
}

export function postStatePatch(action, at) {
  switch (action) {
    case 'author-delete': return { author_deleted_at: at };
    case 'author-restore': return { author_deleted_at: null };
    case 'remove': return { moderator_removed_at: at };
    case 'restore': return { moderator_removed_at: null };
    case 'lock': return { locked_at: at };
    case 'unlock': return { locked_at: null };
    case 'restrict': return { legal_restricted_at: at };
    case 'unrestrict': return { legal_restricted_at: null };
    default: throw fail(400, `Unsupported post state action: ${action}.`);
  }
}

export function inverseModerationAction(action) {
  return ({ remove: 'restore', restore: 'remove', lock: 'unlock', unlock: 'lock', ban: 'unban', unban: 'ban', restrict: 'unrestrict', unrestrict: 'restrict' })[action] || null;
}

export function publicCommunity(row, membership = null, policy = null) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    state: row.state,
    parentCommunityId: row.parent_community_id || null,
    currentPolicyVersion: Number(row.current_policy_version || 1),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    membership: membership ? {
      role: membership.role,
      status: membership.status,
      reason: membership.reason || ''
    } : null,
    policy: policy ? {
      version: Number(policy.version),
      rules: policy.rules || {},
      createdAt: policy.created_at instanceof Date ? policy.created_at.toISOString() : String(policy.created_at)
    } : null
  };
}
