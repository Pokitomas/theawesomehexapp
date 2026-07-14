import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertMemberModerationHierarchy,
  assertModerationTargetAction,
  communitySlug,
  contentState,
  inverseModerationAction,
  postStatePatch,
  visibleText
} from '../../netlify/functions/community-authority.mjs';

const active = role => ({ role, status: 'active', reason: '' });

test('community slugs become stable authority identifiers', () => {
  assert.equal(communitySlug('c/Anime Titties!!!'), 'anime-titties');
  assert.equal(communitySlug('  Local_Politics  '), 'local_politics');
});

test('content state keeps author deletion, moderator removal, legal restriction, and locking distinct', () => {
  assert.deepEqual(contentState({}), {
    visibility: 'visible', tombstone: false, locked: false,
    authorDeletedAt: null, moderatorRemovedAt: null, legalRestrictedAt: null, lockedAt: null
  });
  assert.equal(contentState({ author_deleted_at: 'a' }).visibility, 'author_deleted');
  assert.equal(contentState({ author_deleted_at: 'a', moderator_removed_at: 'm' }).visibility, 'moderator_removed');
  assert.equal(contentState({ author_deleted_at: 'a', moderator_removed_at: 'm', legal_restricted_at: 'l' }).visibility, 'legal_restricted');
  assert.equal(contentState({ locked_at: 'k' }).locked, true);
  assert.equal(contentState({ locked_at: 'k' }).visibility, 'visible');
});

test('tombstones preserve linkable conversation nodes without leaking hidden text', () => {
  assert.equal(visibleText({ text: 'secret', author_deleted_at: 'a' }), '[deleted by author]');
  assert.equal(visibleText({ text: 'secret', moderator_removed_at: 'm' }), '[removed by moderators]');
  assert.equal(visibleText({ text: 'secret', legal_restricted_at: 'l' }), '[restricted]');
  assert.equal(visibleText({ text: 'public' }), 'public');
});

test('moderation and author state changes are reversible without collapsing their authority', () => {
  assert.deepEqual(postStatePatch('author-delete', 't1'), { author_deleted_at: 't1' });
  assert.deepEqual(postStatePatch('remove', 't2'), { moderator_removed_at: 't2' });
  assert.deepEqual(postStatePatch('restrict', 't3'), { legal_restricted_at: 't3' });
  assert.deepEqual(postStatePatch('lock', 't4'), { locked_at: 't4' });
  assert.equal(inverseModerationAction('remove'), 'restore');
  assert.equal(inverseModerationAction('ban'), 'unban');
});

test('moderation target discriminants and action families fail closed', () => {
  assert.deepEqual(assertModerationTargetAction('post', 'remove'), { targetType: 'post', action: 'remove' });
  assert.deepEqual(assertModerationTargetAction('member', 'ban'), { targetType: 'member', action: 'ban' });
  assert.throws(() => assertModerationTargetAction('banana', 'ban'), /Unsupported moderation target or action/);
  assert.throws(() => assertModerationTargetAction('member', 'remove'), /Unsupported moderation target or action/);
  assert.throws(() => assertModerationTargetAction('post', 'ban'), /Unsupported moderation target or action/);
});

test('member moderation follows an explicit actor-target role hierarchy', () => {
  assert.doesNotThrow(() => assertMemberModerationHierarchy({
    actorId: 'moderator', actorMembership: active('moderator'),
    targetId: 'member', targetMembership: active('member')
  }));
  assert.doesNotThrow(() => assertMemberModerationHierarchy({
    actorId: 'owner', actorMembership: active('owner'),
    targetId: 'moderator', targetMembership: active('moderator')
  }));
  assert.throws(() => assertMemberModerationHierarchy({
    actorId: 'moderator', actorMembership: active('moderator'),
    targetId: 'moderator', targetMembership: active('moderator')
  }), /themselves/);
  assert.throws(() => assertMemberModerationHierarchy({
    actorId: 'moderator-a', actorMembership: active('moderator'),
    targetId: 'moderator-b', targetMembership: active('moderator')
  }), /Only an owner/);
  assert.throws(() => assertMemberModerationHierarchy({
    actorId: 'moderator', actorMembership: active('moderator'),
    targetId: 'owner', targetMembership: active('owner')
  }), /owners cannot be banned/);
  assert.throws(() => assertMemberModerationHierarchy({
    actorId: 'former-moderator', actorMembership: { role: 'member', status: 'active' },
    targetId: 'member', targetMembership: active('member')
  }), /Community authority required/);
});

test('the migration encodes authority objects and database-level conversation invariants', async () => {
  const sql = await readFile(new URL('../../migrations/002_community_conversation_authority.sql', import.meta.url), 'utf8');
  for (const token of [
    'social_communities',
    'social_community_memberships',
    'social_community_policy_versions',
    'social_post_revisions',
    'social_moderation_cases',
    'social_moderation_actions',
    'social_appeals',
    'social_local_controls',
    'social_enforce_conversation_authority',
    'Replies inherit the parent community authority.',
    'social_sync_legacy_deletion_visibility'
  ]) assert.ok(sql.includes(token), `migration missing ${token}`);
});
