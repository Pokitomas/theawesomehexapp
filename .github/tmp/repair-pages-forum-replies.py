from pathlib import Path

records_path = Path('scripts/web-source-records.mjs')
records = records_path.read_text()

old_author = """function authorName(input, fallback) {
  if (typeof input.author === 'string') return input.author;
  return input.author?.name || input.author?.display_name || input.account?.display_name || input.account?.username || input.contributor || fallback;
}
"""
new_author = """function authorName(input, fallback) {
  const explicit = typeof input.author === 'string' ? clean(input.author) : '';
  if (explicit) return explicit;
  return input.author?.name || input.author?.display_name || input.account?.display_name || input.account?.username || input.contributor || fallback;
}

function normalizeReplies(value, fallbackPublished) {
  return Object.freeze((Array.isArray(value) ? value : [])
    .slice(0, 18)
    .map(reply => {
      if (!reply || typeof reply !== 'object') return null;
      const text = clean(decodeEntities(stripTags(reply.text || reply.content || reply.body || ''))).slice(0, 1200);
      if (!text) return null;
      const id = clean(reply.id || reply.objectID || reply.native_id || '').slice(0, 240);
      const author = clean(authorName(reply, 'unknown')).slice(0, 160) || 'unknown';
      let url = '';
      try {
        const raw = reply.url || reply.canonical_url || '';
        if (raw) url = safeSourceURL(raw).href;
      } catch {}
      return Object.freeze({
        id,
        author,
        text,
        published_at: isoDate(reply.published_at || reply.published || reply.created_at || reply.createdAt, fallbackPublished),
        url,
        children: Math.max(0, Number(reply.children || reply.children_count || 0))
      });
    })
    .filter(Boolean));
}
"""
if records.count(old_author) != 1:
    raise SystemExit(f'author/replies insertion drift: {records.count(old_author)} matches')
records = records.replace(old_author, new_author, 1)
records = records.replace(
    "  const engagement = kind === 'forum'\n",
    "  const replies = normalizeReplies(input.replies, published);\n  const engagement = kind === 'forum'\n",
    1
)
records = records.replace(
    "    native_id: clean(input.id || input.nativeId || input.native_id || recordId).slice(0, 240),\n",
    "    native_id: clean(input.id || input.objectID || input.nativeId || input.native_id || recordId).slice(0, 240),\n",
    1
)
records = records.replace(
    "    engagement,\n    license:",
    "    engagement,\n    replies,\n    license:",
    1
)
records_path.write_text(records)

build_path = Path('scripts/build-web-source-snapshot.mjs')
build = build_path.read_text()
build = build.replace(
    "  timeoutMs: 20_000,\n  robotsBytes: 256_000\n",
    "  timeoutMs: 20_000,\n  robotsBytes: 256_000,\n  forumThreadsPerSource: 3,\n  forumRepliesPerThread: 3,\n  forumReplyBytes: 512_000\n",
    1
)

clean_marker = """function clean(value = '') {
  return value == null ? '' : String(value).replace(/\\u0000/g, '').replace(/\\s+/g, ' ').trim();
}

export async function fetchBoundedSource(provider, options = {}) {
"""
helper = """function clean(value = '') {
  return value == null ? '' : String(value).replace(/\\u0000/g, '').replace(/\\s+/g, ' ').trim();
}

function isHackerNewsForum(provider) {
  try {
    return provider?.kind === 'forum' && new URL(provider.url).hostname === 'hn.algolia.com';
  } catch {
    return false;
  }
}

async function enrichHackerNewsRows(rows, provider, options = {}) {
  if (!isHackerNewsForum(provider)) return Object.freeze({ rows, receipt: null });
  const limits = options.limits || DEFAULT_LIMITS;
  const fetchResource = options.requestPublicResource || requestPublicResource;
  const lookup = options.lookup || dns.lookup;
  const candidates = rows
    .filter(row => clean(row?.objectID || row?.id) && Number(row?.num_comments || row?.comments || 0) > 0)
    .slice(0, limits.forumThreadsPerSource);
  let enriched = 0;
  let replyCount = 0;
  let failures = 0;
  const entries = await Promise.all(candidates.map(async row => {
    const storyId = clean(row.objectID || row.id).slice(0, 120);
    try {
      const target = safeSourceURL(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(storyId)}`);
      const response = await fetchResource(target, {
        lookup,
        timeoutMs: limits.timeoutMs,
        bytes: limits.forumReplyBytes,
        redirects: limits.redirects,
        accept: 'application/json'
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`reply source responded ${response.status}`);
      const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') throw new Error(`reply source content type is not allowed: ${contentType || '(missing)'}`);
      const item = JSON.parse(response.body.toString('utf8'));
      const replies = (Array.isArray(item.children) ? item.children : [])
        .filter(reply => reply && !reply.deleted && !reply.dead && clean(reply.text))
        .slice(0, limits.forumRepliesPerThread)
        .map(reply => ({
          id: reply.id,
          author: reply.author,
          text: reply.text,
          published_at: reply.created_at,
          url: `https://news.ycombinator.com/item?id=${encodeURIComponent(clean(reply.id || storyId))}`,
          children: Array.isArray(reply.children) ? reply.children.length : 0
        }));
      if (replies.length) {
        enriched += 1;
        replyCount += replies.length;
      }
      return [storyId, replies];
    } catch {
      failures += 1;
      return [storyId, []];
    }
  }));
  const byStory = new Map(entries);
  return Object.freeze({
    rows: rows.map(row => {
      const storyId = clean(row?.objectID || row?.id).slice(0, 120);
      const replies = byStory.get(storyId);
      return replies?.length ? { ...row, replies } : row;
    }),
    receipt: Object.freeze({
      schema: 'sideways-forum-reply-enrichment/v1',
      attempted: candidates.length,
      enriched,
      replies: replyCount,
      failures,
      threads_per_source: limits.forumThreadsPerSource,
      replies_per_thread: limits.forumRepliesPerThread
    })
  });
}

export async function fetchBoundedSource(provider, options = {}) {
"""
if build.count(clean_marker) != 1:
    raise SystemExit(f'enrichment helper insertion drift: {build.count(clean_marker)} matches')
build = build.replace(clean_marker, helper, 1)
old_rows = """  const rows = parseSourcePayload(response.body.toString('utf8'), contentType, parseProvider)
    .slice(0, limits.recordsPerSource);
  return Object.freeze({
    records: Object.freeze(rows.map(row => normalizeWebRecord(row, { ...provider, fetchedAt }))),
    receipt: Object.freeze({
      robots,
      hops: response.hops,
      bytes: response.body.length,
      contentType
    })
  });
"""
new_rows = """  const parsedRows = parseSourcePayload(response.body.toString('utf8'), contentType, parseProvider)
    .slice(0, limits.recordsPerSource);
  const enrichment = await enrichHackerNewsRows(parsedRows, provider, { ...options, limits, lookup, requestPublicResource: fetchResource });
  return Object.freeze({
    records: Object.freeze(enrichment.rows.map(row => normalizeWebRecord(row, { ...provider, fetchedAt }))),
    receipt: Object.freeze({
      robots,
      hops: response.hops,
      bytes: response.body.length,
      contentType,
      ...(enrichment.receipt ? { forum_reply_enrichment: enrichment.receipt } : {})
    })
  });
"""
if build.count(old_rows) != 1:
    raise SystemExit(f'enrichment call replacement drift: {build.count(old_rows)} matches')
build_path.write_text(build.replace(old_rows, new_rows, 1))

test_path = Path('scripts/tests/web-source-snapshot.test.mjs')
tests = test_path.read_text()
marker = "test('invalid configured-source JSON falls back truthfully without aborting the snapshot', () => {"
addition = """test('Hacker News forum enrichment admits only bounded truthful public replies and records failures', async () => {
  const provider = {
    id: 'hacker-news-test',
    name: 'Hacker News',
    kind: 'forum',
    format: 'json',
    method: 'public-api',
    robots: 'not-applicable',
    url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=250&page=0'
  };
  const calls = [];
  const result = await fetchBoundedSource(provider, {
    now: '2026-07-15T00:00:00.000Z',
    limits: { forumThreadsPerSource: 2, forumRepliesPerThread: 2, forumReplyBytes: 10000 },
    requestPublicResource: async target => {
      const url = new URL(target);
      calls.push(url.href);
      if (url.pathname.includes('/items/101')) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: Buffer.from(JSON.stringify({ children: [
            { id: 201, author: 'alice', text: '<p>Actual public reply</p>', created_at: '2026-07-14T01:00:00Z', children: [{ id: 301 }] },
            { id: 202, author: null, text: null, deleted: true }
          ] })),
          hops: [],
          url
        };
      }
      if (url.pathname.includes('/items/102')) {
        return { status: 503, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}'), hops: [], url };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ hits: [
          { objectID: '101', title: 'First story', url: 'https://news.ycombinator.com/item?id=101', points: 12, num_comments: 2, created_at: '2026-07-14T00:00:00Z' },
          { objectID: '102', title: 'Second story', url: 'https://news.ycombinator.com/item?id=102', points: 8, num_comments: 1, created_at: '2026-07-14T00:00:00Z' }
        ] })),
        hops: [],
        url
      };
    }
  });
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].native_id, '101');
  assert.deepEqual(result.records[0].replies, [{
    id: '201',
    author: 'alice',
    text: 'Actual public reply',
    published_at: '2026-07-14T01:00:00.000Z',
    url: 'https://news.ycombinator.com/item?id=201',
    children: 1
  }]);
  assert.deepEqual(result.records[1].replies, []);
  assert.equal(result.receipt.forum_reply_enrichment.attempted, 2);
  assert.equal(result.receipt.forum_reply_enrichment.enriched, 1);
  assert.equal(result.receipt.forum_reply_enrichment.replies, 1);
  assert.equal(result.receipt.forum_reply_enrichment.failures, 1);
  assert.equal(calls.filter(url => url.includes('/api/v1/items/')).length, 2);
});

"""
if tests.count(marker) != 1:
    raise SystemExit(f'forum enrichment test insertion drift: {tests.count(marker)} matches')
test_path.write_text(tests.replace(marker, addition + marker, 1))
