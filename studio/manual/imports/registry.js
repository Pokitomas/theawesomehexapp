const textDecoder = new TextDecoder('utf-8', { fatal: false });

function clean(value = '') {
  return String(value)
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function stripHTML(value = '') {
  const document = new DOMParser().parseFromString(String(value), 'text/html');
  return clean(document.body?.textContent || '');
}

function url(value = '') {
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function date(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function record(input = {}) {
  const text = clean(input.text || input.body || input.content || '');
  const title = clean(input.title || input.name || text.split('\n')[0] || 'UNTITLED').slice(0, 240) || 'UNTITLED';
  return {
    type: ['article', 'forum', 'social'].includes(input.type) ? input.type : 'social',
    title,
    summary: clean(input.summary || text.slice(0, 420)).slice(0, 900),
    text,
    body: Array.isArray(input.body) ? input.body.map(clean).filter(Boolean).slice(0, 100) : [],
    source: clean(input.source || 'MY IMPORT').slice(0, 120) || 'MY IMPORT',
    sourceUrl: url(input.sourceUrl || input.url || ''),
    outboundUrl: url(input.outboundUrl || ''),
    author: {
      name: clean(input.author?.name || input.authorName || 'Me').slice(0, 80),
      handle: clean(input.author?.handle || input.authorHandle || '').slice(0, 48),
      url: url(input.author?.url || input.authorUrl || ''),
      avatar: url(input.author?.avatar || input.avatar || '')
    },
    published: date(input.published || input.date || input.createdAt),
    nativeId: clean(input.nativeId || input.id || '').slice(0, 180),
    links: Array.isArray(input.links) ? input.links.map(item => ({
      label: clean(item.label || item.url || 'LINK').slice(0, 120),
      url: url(item.url)
    })).filter(item => item.url).slice(0, 100) : [],
    tags: Array.isArray(input.tags) ? input.tags.map(clean).filter(Boolean).slice(0, 30) : [],
    rank: input.rank && typeof input.rank === 'object' ? structuredClone(input.rank) : {}
  };
}

function parseAssignedJSON(text) {
  const trimmed = clean(text);
  const candidate = trimmed.includes('=') ? trimmed.slice(trimmed.indexOf('=') + 1).replace(/;\s*$/, '') : trimmed;
  return JSON.parse(candidate);
}

function flattenJSON(value, output = [], path = []) {
  if (output.length >= 50000) return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenJSON(item, output, [...path, index]));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  const text = clean(value.text || value.body || value.content || value.selftext || value.description || '');
  const title = clean(value.title || value.name || value.subject || '');
  if (text || title) output.push({ value, path });
  else Object.entries(value).forEach(([key, item]) => flattenJSON(item, output, [...path, key]));
  return output;
}

function csvRows(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() || []).map(item => clean(item).toLowerCase());
  return rows.filter(rowValue => rowValue.some(Boolean)).map(values => Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, values[index] || ''])));
}

function genericObject(item, source) {
  const value = item.value || item;
  const author = value.author && typeof value.author === 'object' ? value.author : { name: value.author || value.username || value.user || 'Me' };
  return record({
    type: value.type,
    title: value.title || value.name || value.subject,
    text: value.text || value.body || value.content || value.selftext || value.description,
    summary: value.summary || value.dek,
    source: value.source || source,
    sourceUrl: value.url || value.permalink || value.canonical_url,
    outboundUrl: value.outbound_url,
    author,
    published: value.published || value.created_at || value.createdAt || value.date || (value.created_utc ? Number(value.created_utc) * 1000 : ''),
    nativeId: value.id || value.native_id || value.uri,
    links: value.links,
    tags: value.tags
  });
}

function normalizedKeys(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key.toLowerCase().replace(/[^a-z0-9]+/g, '_'), item]));
}

function portableRecords(value, source, output = [], seen = new WeakSet()) {
  if (output.length >= 50000) return output;
  if (Array.isArray(value)) {
    for (const item of value) portableRecords(item, source, output, seen);
    return output;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);

  const keys = normalizedKeys(value);
  const stringList = value.string_list_data || value.stringListData;
  if (Array.isArray(stringList)) {
    for (const item of stringList) {
      output.push(record({
        type: 'social',
        title: item.value || value.title || source,
        text: item.value || value.title || '',
        source,
        sourceUrl: item.href || item.url,
        published: item.timestamp ? Number(item.timestamp) * 1000 : '',
        nativeId: item.href || `${item.value || ''}:${item.timestamp || ''}`
      }));
    }
  }

  const mapData = value.string_map_data || value.stringMapData;
  if (mapData && typeof mapData === 'object') {
    for (const [label, item] of Object.entries(mapData)) {
      if (!item || typeof item !== 'object') continue;
      output.push(record({
        type: 'social',
        title: value.title || label,
        text: item.value || value.title || label,
        source,
        sourceUrl: item.href || item.url,
        published: item.timestamp ? Number(item.timestamp) * 1000 : '',
        nativeId: item.href || `${label}:${item.timestamp || item.value || ''}`
      }));
    }
  }

  const title = keys.title || keys.name || keys.track_name || keys.master_metadata_track_name || keys.video_title || keys.caption || keys.query || keys.search_term;
  const text = keys.text || keys.body || keys.content || keys.comment || keys.description || keys.caption || keys.value || keys.video_link || keys.link;
  const href = keys.url || keys.href || keys.link || keys.video_link || keys.share_url || keys.webpage_url;
  const timestamp = keys.timestamp || keys.time || keys.date || keys.created_at || keys.creation_timestamp || keys.ts;
  if (title || text || href) {
    output.push(record({
      type: href && !text ? 'article' : 'social',
      title: title || text || href,
      text: text || title || '',
      source,
      sourceUrl: href,
      published: typeof timestamp === 'number' && timestamp < 100000000000 ? timestamp * 1000 : timestamp,
      nativeId: keys.id || keys.item_id || keys.media_id || href || `${title || text}:${timestamp || ''}`,
      author: { name: keys.author || keys.username || keys.artist_name || keys.master_metadata_album_artist_name || 'Me' }
    }));
  }

  for (const item of Object.values(value)) portableRecords(item, source, output, seen);
  return output;
}

function parsePortableFile(text, file, source) {
  if (/\.csv$/i.test(file.name)) return csvRows(text).map(item => genericObject(item, source));
  const payload = parseAssignedJSON(text);
  return portableRecords(payload, source);
}

export class AdapterRegistry {
  #adapters = [];

  register(adapter) {
    if (!adapter?.id || typeof adapter.match !== 'function' || typeof adapter.parse !== 'function') {
      throw new TypeError('adapter needs id, match, and parse');
    }
    if (this.#adapters.some(item => item.id === adapter.id)) throw new Error(`adapter already exists: ${adapter.id}`);
    this.#adapters.push(Object.freeze(adapter));
    return this;
  }

  list() { return [...this.#adapters]; }

  find(file, sample = '') {
    return this.#adapters.find(adapter => adapter.match(file, sample)) || this.#adapters.at(-1);
  }
}

export function createDefaultRegistry() {
  return new AdapterRegistry()
    .register({
      id: 'x-archive', label: 'X / TWITTER',
      match: (file, sample) => /(^|\/)(tweet|tweets)(\.js|\.json)$/i.test(file.name) || /window\.YTD\.tweets/i.test(sample),
      async parse(file, context) {
        const payload = parseAssignedJSON(await file.text());
        const rows = Array.isArray(payload) ? payload : payload.tweets || [];
        return rows.map(wrapper => wrapper.tweet || wrapper).map(tweet => record({
          type: 'social', title: clean(tweet.full_text || tweet.text).slice(0, 90), text: tweet.full_text || tweet.text,
          source: 'X', sourceUrl: tweet.id_str ? `https://x.com/i/web/status/${tweet.id_str}` : '',
          author: { name: context.profileName || 'Me', handle: context.profileHandle || '' },
          published: tweet.created_at, nativeId: tweet.id_str, links: (tweet.entities?.urls || []).map(link => ({ label: link.display_url, url: link.expanded_url }))
        }));
      }
    })
    .register({
      id: 'reddit-export', label: 'REDDIT',
      match: (file, sample) => /reddit|comments|posts|saved/i.test(file.name) && /subreddit|permalink|created_utc|reddit/i.test(sample),
      async parse(file) {
        const text = await file.text();
        const payload = file.name.toLowerCase().endsWith('.csv') ? csvRows(text) : parseAssignedJSON(text);
        const rows = Array.isArray(payload) ? payload : flattenJSON(payload).map(item => item.value);
        return rows.map(item => record({
          type: item.title ? 'forum' : 'social', title: item.title || clean(item.body).slice(0, 90), text: item.selftext || item.body || item.text,
          source: item.subreddit ? `r/${item.subreddit}` : 'REDDIT',
          sourceUrl: item.permalink ? `https://www.reddit.com${item.permalink}` : item.url,
          author: { name: item.author || 'Me', handle: item.author ? `u/${item.author}` : '' },
          published: item.created_utc ? Number(item.created_utc) * 1000 : item.created_at,
          nativeId: item.id || item.name
        }));
      }
    })
    .register({
      id: 'instagram-export', label: 'INSTAGRAM',
      match: (file, sample) => /instagram|saved_saved_media|liked_posts|comments|following|followers/i.test(file.webkitRelativePath || file.name) || /string_(list|map)_data|media_list_data/i.test(sample),
      async parse(file) { return parsePortableFile(await file.text(), file, 'INSTAGRAM'); }
    })
    .register({
      id: 'tiktok-export', label: 'TIKTOK',
      match: (file, sample) => /tiktok|user_data|like list|favorite|video browsing|search history/i.test(file.webkitRelativePath || file.name) || /ItemFavoriteList|VideoList|SearchList/i.test(sample),
      async parse(file) { return parsePortableFile(await file.text(), file, 'TIKTOK'); }
    })
    .register({
      id: 'youtube-takeout', label: 'YOUTUBE',
      match: (file, sample) => /youtube|watch-history|search-history|subscriptions|playlists/i.test(file.webkitRelativePath || file.name) || /youtube\.com\/watch|youtu\.be/i.test(sample),
      async parse(file) {
        const text = await file.text();
        if (/\.html?$/i.test(file.name)) {
          const document = new DOMParser().parseFromString(text, 'text/html');
          return [...document.querySelectorAll('a[href]')].map(anchor => record({
            type: 'article', title: anchor.textContent || anchor.href, source: 'YOUTUBE', sourceUrl: anchor.href,
            published: anchor.closest('div')?.textContent?.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^\n]*/)?.[0] || file.lastModified,
            nativeId: anchor.href
          }));
        }
        return parsePortableFile(text, file, 'YOUTUBE');
      }
    })
    .register({
      id: 'spotify-history', label: 'SPOTIFY',
      match: (file, sample) => /spotify|streaming_history|endsong|playlist/i.test(file.webkitRelativePath || file.name) || /master_metadata_track_name|trackName|artistName|ms_played/i.test(sample),
      async parse(file) {
        const payload = parseAssignedJSON(await file.text());
        const rows = Array.isArray(payload) ? payload : portableRecords(payload, 'SPOTIFY');
        if (!Array.isArray(rows) || !rows.length || rows[0]?.type) return rows;
        return rows.map(item => record({
          type: 'social',
          title: item.trackName || item.master_metadata_track_name || item.episode_name || 'LISTENED ON SPOTIFY',
          text: [item.artistName || item.master_metadata_album_artist_name, item.albumName || item.master_metadata_album_album_name].filter(Boolean).join(' · '),
          source: 'SPOTIFY',
          published: item.endTime || item.ts,
          nativeId: item.spotify_track_uri || item.spotify_episode_uri || `${item.trackName || item.master_metadata_track_name}:${item.endTime || item.ts}`,
          author: { name: item.artistName || item.master_metadata_album_artist_name || 'Spotify' },
          tags: item.reason_end ? [item.reason_end] : []
        }));
      }
    })
    .register({
      id: 'mastodon-outbox', label: 'MASTODON',
      match: (file, sample) => /outbox\.json$/i.test(file.name) || /"orderedItems"\s*:/i.test(sample),
      async parse(file) {
        const payload = JSON.parse(await file.text());
        return (payload.orderedItems || []).map(activity => activity.object || activity).filter(Boolean).map(item => record({
          type: 'social', title: stripHTML(item.summary || item.content).slice(0, 90), text: stripHTML(item.content),
          source: 'MASTODON', sourceUrl: item.url || item.id, published: item.published,
          nativeId: item.id, links: (item.attachment || []).map(attachment => ({ label: attachment.name || 'MEDIA', url: attachment.url }))
        }));
      }
    })
    .register({
      id: 'bookmarks-html', label: 'BOOKMARKS',
      match: (file, sample) => /bookmark.*\.html?$/i.test(file.name) || /<!DOCTYPE NETSCAPE-Bookmark-file/i.test(sample),
      async parse(file) {
        const document = new DOMParser().parseFromString(await file.text(), 'text/html');
        return [...document.querySelectorAll('a[href]')].map(anchor => record({
          type: 'article', title: anchor.textContent || anchor.href, summary: anchor.getAttribute('tags') || '',
          source: 'BOOKMARKS', sourceUrl: anchor.href, published: Number(anchor.getAttribute('add_date')) * 1000 || file.lastModified,
          nativeId: anchor.href, tags: (anchor.getAttribute('tags') || '').split(',').filter(Boolean)
        }));
      }
    })
    .register({
      id: 'rss-atom', label: 'RSS / ATOM',
      match: (file, sample) => /\.(rss|xml|atom)$/i.test(file.name) || /<(rss|feed)[\s>]/i.test(sample),
      async parse(file) {
        const document = new DOMParser().parseFromString(await file.text(), 'application/xml');
        return [...document.querySelectorAll('item, entry')].map(item => {
          const linkNode = item.querySelector('link');
          const itemUrl = linkNode?.getAttribute('href') || linkNode?.textContent || '';
          return record({
            type: 'article', title: item.querySelector('title')?.textContent, text: stripHTML(item.querySelector('content, content\\:encoded, description, summary')?.textContent || ''),
            source: document.querySelector('channel > title, feed > title')?.textContent || 'RSS', sourceUrl: itemUrl,
            author: { name: item.querySelector('author name, creator')?.textContent || '' },
            published: item.querySelector('pubDate, published, updated')?.textContent, nativeId: item.querySelector('guid, id')?.textContent || itemUrl
          });
        });
      }
    })
    .register({
      id: 'json-lines', label: 'JSON / JSONL',
      match: file => /\.(json|jsonl|ndjson)$/i.test(file.name) || file.type === 'application/json',
      async parse(file) {
        const text = await file.text();
        let rows;
        if (/\.(jsonl|ndjson)$/i.test(file.name)) rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        else {
          const payload = parseAssignedJSON(text);
          rows = Array.isArray(payload) ? payload : flattenJSON(payload).map(item => item.value);
        }
        return rows.map(item => genericObject(item, file.name));
      }
    })
    .register({
      id: 'csv', label: 'CSV',
      match: file => /\.csv$/i.test(file.name) || file.type === 'text/csv',
      async parse(file) { return csvRows(await file.text()).map(item => genericObject(item, file.name)); }
    })
    .register({
      id: 'plain-text', label: 'TEXT / MARKDOWN / HTML',
      match: () => true,
      async parse(file) {
        const raw = textDecoder.decode(await file.arrayBuffer());
        const body = /\.html?$/i.test(file.name) ? stripHTML(raw) : clean(raw);
        return [record({ type: 'article', title: file.name.replace(/\.[^.]+$/, ''), text: body, source: file.name, published: file.lastModified })];
      }
    });
}
