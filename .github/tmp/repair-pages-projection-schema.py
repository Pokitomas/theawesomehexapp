from pathlib import Path

source_path = Path('scripts/web-source-records.mjs')
source = source_path.read_text()

old = """  return Object.freeze({
    id: stableId(providerId, sourceURL, title, published),
    kind,
    title,
    published,
    revision: 'bounded public source snapshot',
    contributor: clean(authorName(input, providerName)).slice(0, 160),
    categories: [...new Set([providerId, ...(Array.isArray(input.categories) ? input.categories : [])].map(clean).filter(Boolean))].slice(0, 24),
    dek: summary || title,
    body: [summary || title],
    sources: sourceURL ? [{ label: providerName, url: sourceURL }] : [],
    url: sourceURL,
    license: clean(provider.license || 'source-defined'),
    attribution: providerName,
    community: clean(provider.community || providerName),
    score: Math.max(0, Number(input.score || input.points || input.favourites_count || 0)),
    comments: Math.max(0, Number(input.comments || input.num_comments || input.replies_count || 0)),
    resurfaced: (provider.fetchedAt || published).slice(0, 10),
    synthetic: false,
    provenance: Object.freeze({
      schema: 'sideways-web-provenance/v1',
      provider: providerId,
      method: clean(provider.method || provider.format || 'web'),
      source_url: safeSourceURL(provider.url).href,
      fetched_at: provider.fetchedAt || published,
      cache: 'bounded-build-snapshot',
      robots: provider.robots || (provider.method?.includes('api') ? 'not-applicable' : 'respect')
    })
  });
"""
new = """  const recordId = stableId(providerId, sourceURL, title, published);
  const contributor = clean(authorName(input, providerName)).slice(0, 160);
  const score = Math.max(0, Number(input.score || input.points || input.favourites_count || 0));
  const comments = Math.max(0, Number(input.comments || input.num_comments || input.replies_count || 0));
  const sourceRoot = safeSourceURL(provider.url).href;
  const engagement = kind === 'forum'
    ? Object.freeze({ points: score, comments })
    : kind === 'social'
      ? Object.freeze({
        likes: score,
        boosts: Math.max(0, Number(input.reblogs_count || input.reblogs || input.boosts || 0)),
        replies: comments
      })
      : Object.freeze({});
  return Object.freeze({
    id: recordId,
    kind,
    type: kind,
    title,
    published,
    published_at: published,
    native_id: clean(input.id || input.nativeId || input.native_id || recordId).slice(0, 240),
    revision: 'bounded public source snapshot',
    contributor,
    author_name: contributor,
    categories: [...new Set([providerId, ...(Array.isArray(input.categories) ? input.categories : [])].map(clean).filter(Boolean))].slice(0, 24),
    dek: summary || title,
    text: summary || title,
    body: [summary || title],
    sources: sourceURL ? [{ label: providerName, url: sourceURL }] : [],
    url: sourceURL,
    canonical_url: sourceURL,
    outbound_url: clean(input.story_url || input.outbound_url || '').slice(0, 2000),
    source_name: providerName,
    source_url: sourceRoot,
    language: clean(input.language || provider.language || 'en').slice(0, 32),
    content_warning: clean(input.spoiler_text || input.content_warning || '').slice(0, 500),
    engagement,
    license: clean(provider.license || 'source-defined'),
    attribution: providerName,
    community: clean(provider.community || providerName),
    score,
    comments,
    resurfaced: (provider.fetchedAt || published).slice(0, 10),
    synthetic: false,
    provenance: Object.freeze({
      schema: 'sideways-web-provenance/v1',
      provider: providerId,
      method: clean(provider.method || provider.format || 'web'),
      source_url: sourceRoot,
      fetched_at: provider.fetchedAt || published,
      cache: 'bounded-build-snapshot',
      robots: provider.robots || (provider.method?.includes('api') ? 'not-applicable' : 'respect')
    })
  });
"""
if source.count(old) != 1:
    raise SystemExit(f'normalization replacement drift: {source.count(old)} matches')
source_path.write_text(source.replace(old, new, 1))

test_path = Path('scripts/tests/web-source-snapshot.test.mjs')
tests = test_path.read_text()
old_assertions = """  assert.equal(record.title, 'One & Two');
  assert.equal(record.url, 'https://example.com/post');
  assert.equal(record.synthetic, false);
"""
new_assertions = """  assert.equal(record.title, 'One & Two');
  assert.equal(record.url, 'https://example.com/post');
  assert.equal(record.kind, 'article');
  assert.equal(record.type, 'article');
  assert.equal(record.canonical_url, record.url);
  assert.equal(record.published_at, record.published);
  assert.equal(record.source_name, 'Example');
  assert.equal(record.source_url, 'https://example.com/feed.xml');
  assert.equal(record.author_name, 'Example');
  assert.deepEqual(record.engagement, {});
  assert.equal(record.synthetic, false);
"""
if tests.count(old_assertions) != 1:
    raise SystemExit(f'compatibility assertion insertion drift: {tests.count(old_assertions)} matches')
tests = tests.replace(old_assertions, new_assertions, 1)

marker = "test('live MIME admission ignores parser hints and HTML canonicals use the final fetched URL', async () => {"
addition = """test('projection compatibility aliases preserve the v2 source record truth', () => {
  const forum = normalizeWebRecord({
    id: 42,
    title: 'Forum item',
    url: 'https://example.com/forum/42',
    points: 17,
    num_comments: 5
  }, {
    id: 'forum-source',
    name: 'Forum Source',
    kind: 'forum',
    url: 'https://example.com/forum-feed',
    fetchedAt: '2026-07-15T00:00:00Z'
  });
  assert.equal(forum.kind, 'forum');
  assert.equal(forum.type, forum.kind);
  assert.equal(forum.canonical_url, forum.url);
  assert.equal(forum.published_at, forum.published);
  assert.equal(forum.native_id, '42');
  assert.deepEqual(forum.engagement, { points: 17, comments: 5 });

  const social = normalizeWebRecord({
    id: 'status-1',
    content: 'A public status',
    url: 'https://social.example/@person/1',
    favourites_count: 9,
    reblogs_count: 3,
    replies_count: 2,
    account: { display_name: 'Person' }
  }, {
    id: 'social-source',
    name: 'Social Source',
    kind: 'social',
    url: 'https://social.example/api/v1/timelines/public?local=true',
    fetchedAt: '2026-07-15T00:00:00Z'
  });
  assert.equal(social.type, 'social');
  assert.equal(social.author_name, 'Person');
  assert.deepEqual(social.engagement, { likes: 9, boosts: 3, replies: 2 });
});

"""
if tests.count(marker) != 1:
    raise SystemExit(f'compatibility test insertion drift: {tests.count(marker)} matches')
test_path.write_text(tests.replace(marker, addition + marker, 1))
