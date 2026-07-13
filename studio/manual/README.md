# Manual studio

This is the editable consumer product layer for `/manual/`.

The ranking core is assembled from verified overlays. Do not hand-edit generated or packed shards. Product work belongs here:

- `product/copy.js` — visible consumer language.
- `product/studio.css` — shared visual system, navigation, feed cards, and responsive shell.
- `product/studio-components.css` — progress, accessibility, and responsive components.
- `product/studio.js` — product behavior, including opening an empty Sideways directly on the app importer.
- `product/import-studio.js` — one-tap app imports, progress, error recovery, and completion.
- `product/import-studio.css` — app-card hierarchy and import states.
- `product/import-phone.js` — keeps the native multi-item picker reliable on iPhone.
- `imports/registry.js` — source adapters.
- `imports/runtime.js` — dedupe, chunked IndexedDB writes, cancellation, and quota checks.
- `prepare-kernel.py` — readable, idempotent compatibility preparation for the extracted kernel builder.
- `apply.py` — installs the editable layer into `manual-app/` without duplicate assets.
- `verify.py` — rejects syntax errors, render loops, setup gates, visible file-workbench UI, and broken compatibility contracts.
- `tests/onboarding-clickthrough.mjs` — real iPhone touch and quiescence proof.
- `tests/kernel-parity.mjs` — root/manual ranking-kernel parity proof.

## Build contract

After the normal overlays have produced `manual-kernel/` and `manual-app/`:

```bash
python studio/manual/prepare-kernel.py
python manual-kernel/patch.py
python studio/manual/apply.py
python studio/manual/verify.py
```

Pages, phone proof, and kernel parity use the same path.

## Consumer first-run contract

A new user should not need to understand exports, archives, file formats, local storage, or Sideways architecture.

1. Empty Sideways opens directly on the app cards.
2. Instagram and Reddit are the dominant choices.
3. Tapping `IMPORT REDDIT`, `IMPORT INSTAGRAM`, or another app opens the native system picker.
4. Choosing the downloaded item starts importing immediately.
5. No queue, profile form, storage panel, or second import confirmation appears.
6. Completion offers one action: `OPEN MY FEED`.
7. `NEED YOUR DOWNLOAD?` is secondary recovery help, not the main flow.

Static GitHub Pages cannot silently retrieve private account history. The product therefore keeps the browser picker as an operating-system detail while presenting the action as importing an app, not managing files.

## Supported sources

The adapter registry recognizes X/Twitter, Reddit, Instagram, TikTok, YouTube/Google Takeout, Spotify, Mastodon, bookmarks, RSS/Atom, JSON/JSONL, CSV, text, Markdown, and HTML. The canonical ADD engine continues to support PDF, Office, ZIP, images, audio, video, links, and pasted material underneath the consumer layer.

## Interaction contract

- No whole-document `MutationObserver`.
- No automatic reload after importing.
- No capture-phase click hijacking.
- No visible legacy ADD surface beside the consumer importer.
- No profile or storage gate before the app cards.
- The UI must become quiescent after its bounded startup retries.
- The core animation loop must not replace feed DOM while the feed is hidden or empty.

## Compatibility contract

Keep these underlying labels stable unless the test changes atomically:

`ADD`, `KEEP`, `READ`, `SEND`, `FILES +`

Keep these DOM hooks stable:

`#corpusStatus`, `#debugPolicy`, `#debugState`, `#debugPanel`

The studio layer may aggressively change the product shell, but it must not duplicate or rewrite the root ranking math.
