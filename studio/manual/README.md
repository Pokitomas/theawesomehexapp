# Manual workspace

Editable product source for `/manual/`.

## Product files

- `product/actions.js` — canonical action registry. Every visible product control has an ID, label, surface, intent, payload contract, lifecycle events, analytics shape, and test hook.
- `product/workspace-db.js` — versioned IndexedDB primitives shared by the corpus and workspace stores.
- `product/workspace-profile.js` — profile, autosaved drafts, and meaningful places.
- `product/workspace-records.js` — canonical authored records, image blobs, edits, deletion, and corpus refresh.
- `product/workspace-sync.js` — action-event outbox and optional endpoint adapter.
- `product/workspace-migration.js` — one-time migration from the retired social store.
- `product/workspace.js` — a small public facade that weaves those modules into one contract.
- `product/workspace-ui.js` — profile, composer, place routes and editors, and owned-post edit/delete controls.
- `product/core-actions.js` — contracts the unchanged core feed source, author, read, save, collect, and share controls.
- `product/workspace.css` — window, sheet, composer, profile, and place visuals.
- `product/system-icons.svg` — one restrained icon language shared by the shell and workspace.
- `product/copy.js` — current sentence-case product copy. No retro narration or manifesto layer.
- `product/studio.js` — Feed / Places / Library / You shell, New action, empty state, and route headers.
- `product/import-studio.js` — one-tap app imports generated from the action contract.
- `product/import-phone.js` — native iPhone multi-item picker compatibility.
- `imports/registry.js` — source adapters.
- `imports/runtime.js` — dedupe, chunked canonical IndexedDB writes, cancellation, and quota checks.
- `apply.py` — installs product assets and the core corpus-refresh bridge.
- `verify.py` — rejects retired social controls, acid-paper styling, reload hacks, observer loops, missing contracts, and split posting storage.
- `tests/workspace-clickthrough.mjs` — real 390×844 profile → place → photo post → canonical feed → edit → reload proof.

## Build

```bash
python studio/manual/prepare-kernel.py
python manual-kernel/patch.py
python studio/manual/apply.py
python studio/manual/verify.py
```

## One content model

Imports and authored posts both live in `sideways-manual-corpus-v1`. A post is not prepended from a second toy feed: it is normalized into the same record shape, written transactionally, and sent through the same extracted ranking kernel as imported material.

Authored image blobs use the corpus blob store. Editing and deletion update that same record and asset. Records carry stable `sideways:workspace:` native IDs and optional `place:<id>` tags.

The workspace database `sideways-workspace-v1` stores only supporting state:

- autosaved composer drafts
- user-created places and optional explicit coordinates
- action lifecycle events waiting in the sync outbox
- migration receipts and small workspace metadata

Legacy `sideways-social-v1` posts migrate once into the canonical corpus. The retired database is never used for new posts.

## Action architecture

`actions.js` is the interface between product design and future backend work.

Each action declares a stable ID, visible label, surface, intent, and payload fields. `bindAction()` emits `sideways:action` lifecycle events with `start`, `success`, and `error` phases. The workspace persists those events locally. An optional endpoint can receive the outbox through `Workspace.configureSync()` and `Workspace.flushOutbox()`; no credentials or server capability are invented by the client.

Tests select controls by `data-action-id`, not fragile copy or layout selectors.

## Consumer flow

- Feed: make a new post or import material.
- You: set a name, handle, bio, and restrained accent.
- Composer: write, add a photo, optionally attach a saved place, and publish.
- Places: create meaningful locations, explicitly capture current coordinates when desired, and start a post there.
- Library: import from an app or open saved material.
- Owned feed records: edit, send, or delete from the canonical feed card.

Mood selectors, novelty visual styles, emoji avatars, reactions, and remixing were removed. They were separate toys rather than parts of the content system.

## Visual rule

The interface borrows the calm hierarchy, physical depth, and predictable controls of a desktop operating system without performing retro nostalgia. Prose stays contemporary. Chrome is quiet. Accent color carries state rather than decoration. Mobile sheets and desktop windows are the same system at different sizes.

## Invariants

- No whole-document `MutationObserver`.
- No automatic reload.
- No capture-phase click hijacking.
- No visible manifesto or retro-roleplay copy.
- No custom product button without an action contract.
- No second authored-post database.
- Social writes resolve only after IndexedDB transaction completion.
- Geolocation is requested only from an explicit user action.
- Preserve `ADD`, `KEEP`, `READ`, `SEND`, `FILES +` underneath the shell.
- Preserve `#corpusStatus`, `#debugPolicy`, `#debugState`, `#debugPanel`.
- Do not duplicate or rewrite root ranking math.
