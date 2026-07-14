# Sideways import workbench

This folder extends the user-owned manual corpus without forking its ranking kernel.

```text
user export or file
→ source adapter / byte classifier
→ shared article, forum, or social record
→ canonical IndexedDB corpus transaction
→ in-place corpus refresh
→ exact root saturation gate
```

The workbench never calculates recommendation scores. After a successful import it dispatches the canonical corpus-refresh path; the running app reads the new records, derives missing rank metadata, and rerenders without an automatic page reload.

## Files

- `registry.js` — source adapters and the shared normalized record envelope.
- `runtime.js` — quota checks, persistence requests, hash/native-ID dedupe, chunked writes, cancellation, progress events, and the canonical IndexedDB schema.
- `media-classifier.js` — byte-first media and document classification.
- `file-hash.js` / `hash-worker.js` — bounded hashing outside the main UI path.
- `corpus-writer.js` — atomic corpus writes and compatibility receipts.
- `apply.py` — idempotently installs the importer into assembled `manual-app/`.
- `verify.mjs` — syntax, wiring, adapter selection, storage-contract, and no-kernel-duplication checks.
- `../product/import-studio.js` — browser workbench UI.
- `../product/import-studio.css` — product styling.

## Add a source adapter

Register one object:

```js
registry.register({
  id: 'my-export',
  label: 'MY EXPORT',
  match(file, sample) {
    return /my-export\.json$/i.test(file.name);
  },
  async parse(file) {
    const payload = JSON.parse(await file.text());
    return payload.items.map(item => ({
      type: 'social',
      title: item.title,
      text: item.text,
      source: 'MY EXPORT',
      sourceUrl: item.url,
      author: { name: item.author },
      published: item.createdAt,
      nativeId: item.id
    }));
  }
});
```

Return ordinary records. Do not write IndexedDB inside an adapter, assign manual IDs, or copy kernel math. The runtime owns persistence, dedupe, chunking, cancellation, progress, and refresh.

## Current adapters

- X/Twitter archive `tweets.js` and JSON
- Reddit JSON and CSV exports
- Instagram portable-data exports
- TikTok portable-data exports
- YouTube Takeout history, subscriptions, playlists, JSON, and HTML
- Spotify streaming-history and playlist exports
- Mastodon ActivityPub `outbox.json`
- browser bookmark HTML
- RSS and Atom XML
- JSON, JSONL, and NDJSON
- CSV
- plain text, Markdown, and HTML fallback

PDF, ZIP, Office documents, images, audio, video, and unknown binary files remain in the canonical Library path so the adapter layer does not duplicate the mature byte-first media pipeline.

## Browser behavior

`navigator.storage.estimate()` is checked before large imports. Persistent storage is requested where supported, but denial is treated as normal rather than misreported as durable. Files are hashed and written in bounded transactions; imports can stop between chunks. Successful writes trigger an in-place feed refresh.

The corpus remains in IndexedDB. OPFS is an optional same-origin mirror, and the user-owned `.sideways` Ark is the external backup/restore boundary.

## Verification

After the canonical product and studio shell have been assembled:

```bash
python studio/manual/imports/apply.py
node studio/manual/imports/verify.mjs
```

The complete phone gate remains:

```text
/manual/?debug=1&test=1&autorun=1
```