# Manual studio

This is the editable product layer for `/manual/`.

The large ingestion and ranking core is assembled from the repository's verified overlays. Do not hand-edit generated or packed shards. Product work belongs here:

- `product/copy.js` — visible onboarding, profile, feed, import, completion, and storage language.
- `product/studio.css` — visual tokens, navigation, feed cards, blank state, and the core responsive skin.
- `product/studio-components.css` — local-profile form, storage, progress, accessibility, and responsive components.
- `product/studio.js` — additive product behavior and the browser-local profile flow.
- `product/import-studio.js` — platform chooser, file handoff, import queue, progress, and completion flow.
- `product/import-studio.css` — source-card visuals and import layout.
- `product/import-phone.js` — iPhone-safe replacement for unsupported folder picking.
- `imports/registry.js` — structured export adapters.
- `imports/runtime.js` — inspection, dedupe, chunked IndexedDB writes, cancellation, quota checks, and profile attribution.
- `prepare-kernel.py` — readable, idempotent compatibility preparation for the extracted kernel builder. It accepts harmless whitespace drift in root constants and refuses to run if the bounded feed-render guard disappears.
- `apply.py` — installs the editable layer into the assembled `manual-app/` without duplicating tags.
- `verify.py` — rejects malformed UTF-8, binary bytes, syntax errors, render-loop regressions, missing assets, automatic import reloads, event hijacking, and broken phone-test contracts.
- `tests/onboarding-clickthrough.mjs` — real iPhone touch and post-interaction quiescence proof contributed through the #40 collaboration beacon.
- `tests/kernel-parity.mjs` — proves the generated manual kernel still contains the root feed's load-bearing constants.

## Build contract

After the normal overlays have produced `manual-kernel/` and `manual-app/`:

```bash
python studio/manual/prepare-kernel.py
python manual-kernel/patch.py
python studio/manual/apply.py
python studio/manual/verify.py
```

The Pages, phone-proof, and kernel-parity workflows run the same preparation before building. Compatibility fixes belong in readable source here instead of silently replacing a known-good packed overlay.

## First-run product contract

A new user should be able to understand the product without knowing what an “archive,” “corpus,” “kernel,” or “data dump” is:

1. Enter a local name and optional handle, or skip.
2. Choose a recognizable app.
3. Open that app's official data-download page when needed.
4. Choose the downloaded files.
5. Review what Sideways recognized.
6. Add it to the feed.
7. Explicitly open the feed after the completion screen.

The UI must never pretend that static GitHub Pages can perform OAuth or silently retrieve account data. “Connect” means guiding the user through the platform's official export and then importing locally.

## Supported structured sources

The editable adapter registry recognizes:

- X / Twitter archives
- Reddit posts and comments
- Instagram account exports
- TikTok user-data exports
- YouTube / Google Takeout history
- Spotify listening history
- Mastodon outbox files
- browser bookmarks
- RSS / Atom
- JSON / JSONL / NDJSON
- CSV
- plain text, Markdown, and HTML

The canonical ADD engine continues to handle PDF, Office, ZIP, images, audio, video, links, and pasted material.

## Interaction contract

Do not install a whole-document `MutationObserver` to keep the product layer mounted. The product uses real route/application events plus a bounded setup retry window. The interface must become quiescent after that window so taps are never competing with endless remount work.

Imports must not automatically reload or navigate. Completion shows a deliberate `OPEN MY FEED` action. Persistent-storage approval is best-effort and must never block importing.

On iPhone, unsupported folder selection is replaced by a cloned `PICK MORE FILES` control. Do not use capture-phase `stopImmediatePropagation()` to steal clicks from other behavior.

The core animation loop may continue updating ranking state, but it must not replace the feed DOM when there are no records or while the feed view is hidden.

## Editing the product

Change language in `copy.js`. Change the shared palette, borders, shadows, navigation, and feed cards in `studio.css`. Change profile/storage/progress/mobile components in `studio-components.css`. Change platform onboarding in `import-studio.js` and `import-studio.css`. Add or improve parsers in `imports/registry.js`.

Every pass should re-evaluate whether a phrase, screen, or component deserves to exist. Do not preserve developer-shaped language or aesthetic decoration solely because it is already implemented.

## Compatibility contract

Keep these phone-test labels stable unless the test changes atomically in the same commit:

`ADD`, `KEEP`, `READ`, `SEND`, `FILES +`

Keep these DOM hooks stable:

`#corpusStatus`, `#debugPolicy`, `#debugState`, `#debugPanel`

The root saturation kernel remains generated from the root feed. The studio layer can change the product shell aggressively, but it must not duplicate or rewrite that math.
