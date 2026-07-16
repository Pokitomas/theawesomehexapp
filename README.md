# Sideways

A local-first personal archive and public social instrument built around one inspectable saturation-ranking kernel.

- Root feed: `https://pokitomas.github.io/theawesomehexapp/`
- Sideways consumer app: `https://pokitomas.github.io/theawesomehexapp/manual/`
- Root debug: `https://pokitomas.github.io/theawesomehexapp/?debug=1`
- Sideways debug: `https://pokitomas.github.io/theawesomehexapp/manual/?debug=1`
- Phone gate: `https://pokitomas.github.io/theawesomehexapp/manual/?debug=1&test=1&autorun=1`

## Three product realities, one ranking kernel

The root product is a reproducible one-million-candidate reader and ranking laboratory. It combines article, forum, and social-shaped records from Wikinews, Hacker News, and public Mastodon sources while preserving canonical links, authorship, replies, media provenance, and deterministic recommendation features. These delivery candidates are not the canonical public social graph.

`/manual/` contains the user-owned private personal archive. A person can create a local profile, install the small built-in starter fixture, write unpublished local posts, attach images and places, save and delete private material, import personal archives, and move through Feed, Places, Library, Saved, Full, and Desktop modes.

A function-capable deployment also exposes a canonical public social authority. Cookie-authenticated actors can create accounts and profiles, publish and delete posts, follow and react; the relational PostgreSQL authority additionally owns communities, membership, moderation actions, immutable appeals, viewer-local controls, event history, and idempotent mutation receipts. Browser caches and feed responses are projections of that authority, never substitutes for it.

The ranking candidate pool is temporary. Sideways may assemble eligible public projections beside private archive records for one viewer and one feed request, but the kernel owns neither source. Public cache retention, view membership, and active candidate materialization are stored separately so switching feeds changes eligibility without deleting public authority or private archive content.

The manual app does not contain a second approximation of the recommender. During every build, `manual-app/kernel.js` is generated from the root `src/app.js` declarations. A brace-aware extractor, syntax verification, kernel-parity workflow, and the phone gate prevent formatting drift or an incomplete copied kernel from shipping.

## Import anything useful

The Sideways importer recognizes exports from Instagram, Reddit, TikTok, YouTube, Spotify, X/Twitter, Mastodon, browser bookmarks, RSS/Atom, JSON, JSONL, NDJSON, CSV, plain text, Markdown, and HTML. The normal Library path also preserves PDF, ZIP, Office documents, images, audio, video, and unknown binary files.

Imports are classified by bytes rather than trusted file extensions, hashed in a worker, deduplicated, written in bounded IndexedDB transactions, cancellable between chunks, and reflected in the feed without an automatic page reload. Images and other assets remain blobs with reference-safe deletion and honest fallbacks. Imported social history remains private evidence; it does not become a live identity, publication, or engagement count in the public graph.

## Private ownership and recovery

IndexedDB is the canonical hot store for the private personal archive. Sideways exposes four compact Library controls:

- **PIN** requests persistent browser storage and mirrors the current private archive into OPFS where supported.
- **CHECK** audits private records, assets, missing references, orphaned blobs, bytes, and durability status.
- **BACKUP** creates a versioned, user-owned `.sideways` Ark containing private records, assets, the compatibility ledger, local profile, and places.
- **RESTORE** transactionally restores an Ark and records the survival receipt.

OPFS is same-origin redundancy, not an external backup. Browser storage and OPFS can still be evicted together; the downloaded `.sideways` Ark is the boundary that survives origin loss. Public social authority is not silently copied into that private backup; cached public projections are rebuildable delivery state.

## Profiles, posts, places, and media

Local profiles persist with a display name, handle, biography, accent, avatar treatment, and portable state. The private archive supports text and image records, saved material, deletable local content, place creation and selection, Feed/Full/Desktop media modes, intrinsic image/video/audio/PDF/archive surfaces, and zero-overflow phone layouts.

A static deployment remains a local-only product and can install the same profile-aware starter fixture without a backend. A configured function deployment adds the canonical public social operations described above. The interface currently exposes only part of that server authority; an implemented schema or endpoint is not evidence that every governance operation has a finished consumer UI.

## LIVE work surface

The **LIVE** window exposes public, read-only repository work state. `/.well-known/sideways-remote.json` is discovery metadata only; it is not a second state ledger and does not grant mutation authority. The browser receives no credentials, private payloads, signatures, nonce records, grants, deployment receipts, or remote mutation controls.

See [`REMOTE_WORK.md`](./REMOTE_WORK.md) for the durable entry point and [`REMOTE_THOUGHT.md`](./REMOTE_THOUGHT.md) for the protocol boundaries.

## Maker engineering surface

From a clean checkout, the primary engineering entrypoint is intentionally small:

```bash
npm run maker -- "describe the end state"
```

The default command now passes through the native Archie memory bridge. Before execution it checks the repository-scoped local skill mixture and surfaces any reusable matching plan with its confidence and margin. It does not silently trust or execute that plan: the existing read-only assessment, single-writer lease, isolated worktree, verification, draft-PR, and human merge boundaries remain authoritative. After a successful `sideways-maker-run/v2` receipt, the bridge redacts and stores the completed plan in the user-owned corpus, retrains the local mixture, and makes repeated work recallable.

By default the corpus lives under `~/.sideways/archie/<repository-name>-<path-digest>/`. Set `ARCHIE_CORPUS_ROOT` to choose another private location, set `ARCHIE_DISABLED=1` to disable local memory, or run `npm run maker:raw -- "..."` to bypass the bridge entirely.

Local Codex or another explicitly configured coding agent performs four parallel read-only assessments, one synthesis, and one isolated writer pass with full repository context. A draft PR is opened before mutation so `.github/workflows/maker-sprawl.yml` can reject path collisions with other open Maker PRs and fan verification across product, social, operator, and hostile lanes. Maker independently runs the exact repository gate and stops unmerged and undeployed.

See [`NATIVE_MAKER.md`](./NATIVE_MAKER.md) for setup, custom-agent adapters, leases, recovery behavior, and the legacy endpoint-backed worker.

## Verification

The repository gates changes with:

- manual overlay validation
- exact kernel parity
- the legacy 390×844 saturation phone gate
- universal-media phone proof
- profile-first starter and static-drop proof
- Ark mirror → backup → delete → restore → audit proof
- Remote, workflow-permission, social-authority, relational PostgreSQL, and migration-upgrade contracts
- executable authority-surface drift detection
- exact-head build and deployment accounting

The concentrated private-archive phone test must load exactly twenty records, enter saturation, fire the boundary, and visibly move the gate above zero. The Ark proof requires all four controls to exist as soon as the vault rail becomes visible and verifies zero horizontal overflow after destructive recovery.

## Capability boundary

Sideways is a production-shaped hybrid, not a claim that every deployment has every authority. Static GitHub Pages cannot provide canonical shared mutations. A configured server deployment can provide the repository-defined public social graph, but external branch rules, environment protection, installed-app grants, secret values, hosting-team roles, and database grants remain outside repository proof. The private archive still has no automatic multi-device synchronization or upload CDN; portability requires an explicit Ark export.

See [`PROGRAM_ONTOLOGY.md`](./PROGRAM_ONTOLOGY.md) for the authority, storage, eligibility, ranking, and portability vocabulary that governs new work.
