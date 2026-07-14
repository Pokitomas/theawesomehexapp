import { fail } from './social-schema.mjs';

export const LOCAL_CONTROL_MATRIX = Object.freeze({
  post: Object.freeze(['hide']),
  community: Object.freeze(['mute']),
  user: Object.freeze(['mute', 'block'])
});

export function assertLocalControlPair(targetType, kind) {
  const kinds = LOCAL_CONTROL_MATRIX[targetType];
  if (!kinds || !kinds.includes(kind)) throw fail(400, 'Unsupported local control target or kind.');
  return { targetType, kind };
}

export function localControlSets(rows = []) {
  const hiddenPosts = new Set();
  const mutedCommunities = new Set();
  const mutedUsers = new Set();
  const blockedUsers = new Set();
  for (const row of rows) {
    if (row.target_type === 'post' && row.kind === 'hide') hiddenPosts.add(String(row.target_id));
    if (row.target_type === 'community' && row.kind === 'mute') mutedCommunities.add(String(row.target_id));
    if (row.target_type === 'user' && row.kind === 'mute') mutedUsers.add(String(row.target_id));
    if (row.target_type === 'user' && row.kind === 'block') blockedUsers.add(String(row.target_id));
  }
  return { hiddenPosts, mutedCommunities, mutedUsers, blockedUsers };
}

export function viewerPostEligible(post, controls) {
  if (!post || !controls) return true;
  const postId = String(post.id || '');
  const authorId = String(post.author?.id || post.authorId || post.author_id || '');
  const communityId = String(post.community?.id || post.communityId || post.community_id || '');
  if (controls.hiddenPosts.has(postId)) return false;
  if (controls.mutedCommunities.has(communityId)) return false;
  if (controls.mutedUsers.has(authorId) || controls.blockedUsers.has(authorId)) return false;
  return true;
}

export function viewerThreadProjection(post, controls) {
  if (viewerPostEligible(post, controls)) return post;
  return {
    ...post,
    text: '[hidden locally]',
    rawTextAvailable: false,
    locallyHidden: true
  };
}
