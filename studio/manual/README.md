# Manual studio

Editable product source for `/manual/`.

## Product files

- `product/actions.js` — canonical action registry. Every product control gets an ID, label, surface, intent, payload contract, lifecycle events, analytics shape, and test hook here.
- `product/social.js` — profiles, posting, photos, reactions, remixing, saves, sharing, deletion, persistence, and action-result learning.
- `product/social.css` — profile picker, composer, and user-post visuals.
- `product/copy.js` — short labels only. No manifesto or editorial layer.
- `product/studio.js` — FEED / POST / IMPORT / SAVED / ME shell and empty-feed launchpad.
- `product/import-studio.js` — one-tap app imports generated from the action contract.
- `product/import-phone.js` — native iPhone multi-item picker compatibility.
- `imports/registry.js` — source adapters.
- `imports/runtime.js` — dedupe, chunked IndexedDB writes, cancellation, and quota checks.
- `apply.py` — installs product assets and the core corpus-refresh bridge.
- `verify.py` — rejects missing action contracts, editorial copy, reload hacks, observer loops, dead prototype UI, and missing generated assets.
- `tests/social-clickthrough.mjs` — real 390×844 profile → photo post → reaction → save → remix → reload proof.

## Build

```bash
python studio/manual/prepare-kernel.py
python manual-kernel/patch.py
python studio/manual/apply.py
python studio/manual/verify.py
```

## Action architecture

`actions.js` is the interface between product design and future backend work.

Each action declares:

- stable ID
- visible label
- product surface
- intent
- payload fields

`bindAction()` emits `sideways:action` lifecycle events with `start`, `success`, and `error` phases. The social layer stores those events and maintains local result aggregates. Picker order for moods, styles, avatars, colors, and reactions is generated from those results, so repeated behavior changes the next interface without hard-coding a recommendation service.

Future APIs can subscribe to the same event contract instead of reverse-engineering DOM clicks. Tests select controls by `data-action-id`, not fragile copy or layout selectors.

## Consumer flow

- Empty feed: `POST` or `IMPORT`.
- Profile: `ME`, then pick a face and color.
- Composer: say it, optionally add a photo, choose mood/look, `POST IT`.
- Post: react, remix, save, send, or delete.
- Import: tap an app; the native picker is an operating-system detail.

No visible setup essay, export tutorial, storage lecture, queue, or second confirmation.

## Persistence

Imported material remains in `sideways-manual-corpus-v1`.

Social profiles, posts, and action events use `sideways-social-v1` plus small local preference/result records. This keeps the social product independent from the canonical import database version and root ranking kernel.

## Invariants

- No whole-document `MutationObserver`.
- No automatic reload.
- No capture-phase click hijacking.
- No visible manifesto copy.
- No custom product button without an action contract.
- Preserve `ADD`, `KEEP`, `READ`, `SEND`, `FILES +` underneath the shell.
- Preserve `#corpusStatus`, `#debugPolicy`, `#debugState`, `#debugPanel`.
- Do not duplicate or rewrite root ranking math.
