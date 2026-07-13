# Sideways manual product

Editable source for `/manual/`.

Sideways is a browser-local personal operating system for imported internet and original posts. The generated root ranking kernel remains canonical; this directory owns the shell, workspace model, interaction physics, imports, and release proof around it.

## Product topology

- **Feed** — ranked imported records and local posts.
- **Places** — Everything, Later, Archive, and user-created persistent locations.
- **Create** — Post, Import, or New place.
- **Me** — local profile, drafts, counts, and archive access.

There is no permanent Saved tab: **Later** is the useful saved behavior generalized into Places. There is no permanent Import tab: importing is a Create action. There are no self-reaction counters in a single-user app.

## Source map

- `product/icons.js` — inline SVG asset system.
- `product/actions.js` — formal product/backend action contract.
- `product/shell.js` — titlebar, dock, routes, Create sheet, Places, and Me.
- `product/workspace.js` — transactional browser-local backend for places, drafts, entities, archive, undo, and snapshots.
- `product/social.js` — profile, composer, autosave, publish, edit, move, Later, remix, share, archive, restore, delete, and undo UI.
- `product/studio.css` — complete window/dock/sheet visual system, responsive physics, dark mode, and reduced-motion parity.
- `product/studio-components.css` — empty-feed launch and feed status surfaces.
- `product/social.css` — composer, profile, post, place-picker, and draft surfaces.
- `product/interaction.css` — context menus, toast/undo, links, and small sheets.
- `product/import-studio.js` / `import-studio.css` — one-tap source imports presented as a native Open-style surface.
- `product/import-phone.js` — native iPhone multi-item picker compatibility.
- `imports/registry.js` — source adapters.
- `imports/runtime.js` — inspection, dedupe, cancellation, and chunked transaction-complete writes.
- `apply.py` — installs assets/modules in deterministic order and preserves the core corpus-refresh bridge.
- `verify.py` — structural release contract for topology, backend schema, visual replacement, generated assets, compatibility hooks, and kernel isolation.

## Build

```bash
python studio/manual/prepare-kernel.py
python manual-kernel/patch.py
python studio/manual/apply.py
python studio/manual/verify.py
```

The generated module order is:

1. optional `workspace.js`
2. `shell.js`
3. `studio.js`
4. `social.js`
5. importer modules

This lets the shell and social layer discover the durable backend at boot while retaining a compatibility fallback during development.

## Workspace guarantees

`createWorkspaceBackend()` provides:

- `ready()`
- `listPlaces()`, `createPlace()`, `renamePlace()`, `deletePlace()`, `reorderPlaces()`
- `getActivePlace()`, `setActivePlace()`
- `listEntities()`, `getEntity()`, `updateEntity()`, `moveEntity()`
- `archiveEntity()`, `restoreEntity()`, `deleteEntity()`, `undo()`
- `listDrafts()`, `saveDraft()`, `deleteDraft()`, `publishDraft()`
- `exportSnapshot()`, `importSnapshot()`

Writes resolve only after their IndexedDB transaction completes. Publishing writes the entity and deletes its draft in one transaction. Deleting a Place reassigns its entities before removing the Place. Workspace-change events fire only after durable completion.

Existing `sideways-social-v1` posts migrate into the workspace rather than being discarded.

## Action contract

Every custom control is defined in `actions.js`. Each action declares:

- stable ID and visible label
- icon and product surface
- UI intent
- backend command
- payload and result shape
- optimistic, undoable, and destructive semantics

`bindAction()` emits `sideways:action` lifecycle events. Tests use `data-action-id` and inspect the same contract, so UI, analytics, backend adapters, and regression coverage share one vocabulary.

## Proof matrix

- `tests/workspace-model.mjs` — real Chromium + IndexedDB backend transaction and migration checks.
- `tests/onboarding-clickthrough.mjs` — Create → Import → Reddit native picker → completion, zero reloads, and startup quiescence.
- `tests/social-clickthrough.mjs` — profile → custom Place → autosaved draft → photo post → Later → edit → remix → archive → undo → reload, plus phone and desktop screenshots.
- `manual-kernel/verify-kernel.mjs` — exact root ranking constants and twenty-record proof.

## Visual rules

- Contemporary system language; no retro-themed prose.
- Familiar personal-computer window, dock, sheet, menu, and file-open behavior without period imitation.
- One-pixel structure, soft material depth, system typography, responsive spacing, pressed-state physics, dark mode, and reduced motion.
- No beige paper skin, thick comic outlines, offset black shadows, slogan blocks, or decorative controls with no durable effect.

## Invariants

- No whole-document `MutationObserver`.
- No automatic import reload.
- No capture-phase click hijacking.
- No custom product control without an action contract.
- Preserve underlying `ADD`, `KEEP`, `READ`, `SEND`, `FILES +` compatibility labels.
- Preserve `#corpusStatus`, `#debugPolicy`, `#debugState`, and `#debugPanel`.
- Never duplicate or rewrite the root ranking kernel.
