# Manual import workbench

This folder extends the existing manual corpus without forking its ranking kernel.

The sequence is:

```text
user export
→ source adapter
→ shared article/forum/social record
→ existing IndexedDB record store
→ canonical manual rebuild
→ exact root saturation gate
```

The workbench never calculates recommendation scores. After a successful import it reloads the manual app; the canonical core reads the records, derives missing rank metadata, and runs the same gate, axes, and lateral ranker already verified by the phone test.

## Files

- `registry.js` — small source adapters and the shared normalized record envelope.
- `runtime.js` — quota check, persistent-storage request, SHA-256/native-ID dedupe, chunked writes, cancellation, progress events, and the canonical IndexedDB schema.
- `apply.py` — idempotently installs this extension into assembled `manual-app/`.
- `verify.mjs` — syntax, wiring, adapter selection, storage-contract, and no-kernel-duplication checks.
- `../product/import-studio.js` — browser workbench UI.
- `../product/import-studio.css` — square, token-compatible visual layer.

## Add a source adapter

Register one object:

```js
registry.register({
  id: 'my-export',
  label: 'MY EXPORT',
  match(file, sample) {
    return /my-export\.json$/i.test(file.name);
  },
  async parse(file, context) {
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

Return ordinary records. Do not write IndexedDB inside an adapter, do not assign manual IDs, and do not copy kernel math into the adapter. The runtime handles persistence, dedupe, chunking, stop signals, and progress.

## Current adapters

- X/Twitter `tweets.js` exports
- Reddit JSON/CSV exports
- Mastodon ActivityPub `outbox.json`
- browser bookmark HTML
- RSS/Atom XML files
- JSON, JSONL, NDJSON
- CSV
- plain text, Markdown, and HTML fallback

PDF, Office, ZIP, image, audio, and video handling remains in the existing normal ADD path so this extension does not duplicate its mature file parser.

## Browser behavior

`navigator.storage.estimate()` is used before large imports. The workbench requests persistent storage where supported, but treats denial as normal rather than pretending persistence is guaranteed. Files are written in small IndexedDB transactions and imports can be stopped between chunks.

## Verification

After the canonical product and studio shell have been assembled:

```bash
python studio/manual/imports/apply.py
node studio/manual/imports/verify.mjs
```

The phone proof remains:

```text
/manual/?debug=1&test=1&autorun=1
```
