const clean = value => String(value || '').replace(/\u0000/g, '').trim();

export function networkRecord(post = {}) {
  const text = clean(post.body);
  const title = clean(text.split('\n')[0] || 'Post').slice(0, 240) || 'Post';
  const author = post.author || {};
  return {
    type: 'social', title, summary: text.slice(0, 420), text, body: [], source: 'Sideways network', sourceUrl: '', outboundUrl: '',
    author: { name: author.displayName || author.handle || 'Sideways user', handle: author.handle ? `@${String(author.handle).replace(/^@/, '')}` : '', url: '', avatar: author.avatar || '' },
    published: post.createdAt, addedAt: post.createdAt, updatedAt: post.editedAt || post.createdAt,
    originalName: 'Public Sideways post', mime: 'text/plain', size: new Blob([text]).size,
    hash: `network:${post.id}:${post.editedAt || post.createdAt}`, assetKey: '', mediaKind: '', mediaConfidence: '', width: 0, height: 0,
    nativeId: `network:${post.id}`, links: [],
    tags: ['sideways:network', `network:author:${post.authorId}`, ...(post.replyToId ? [`network:reply:${post.replyToId}`] : []), ...(post.repostOfId ? [`network:repost:${post.repostOfId}`] : [])],
    rank: {}, engagement: structuredClone(post.engagement || {}),
    network: { id: post.id, authorId: post.authorId, replyToId: post.replyToId || null, repostOfId: post.repostOfId || null, visibility: post.visibility || 'public', deletedAt: post.deletedAt || null }
  };
}

export function networkPostId(record = {}) {
  if (record.network?.id) return record.network.id;
  const nativeId = String(record.nativeId || '');
  return nativeId.startsWith('network:') ? nativeId.slice(8) : '';
}

export const Schema = Object.freeze({ networkRecord, networkPostId });
