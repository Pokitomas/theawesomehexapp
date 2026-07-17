# Sideways

A local-first personal archive and public social instrument built around one inspectable saturation-ranking kernel, alongside the Archie + Maker intelligence-and-execution family and the Frontier World Expo research system.

## Product map

The repository has two commercial product families and one research system. See [`PRODUCT_PORTFOLIO.md`](./PRODUCT_PORTFOLIO.md) for audiences, pricing and valuation hypotheses, capital allocation, and the decisions to merge or demote surfaces.

- **Sideways public discovery:** `https://pokitomas.github.io/theawesomehexapp/`
- **Sideways private home:** `https://pokitomas.github.io/theawesomehexapp/manual/`
- **Archie personal atelier:** `https://pokitomas.github.io/theawesomehexapp/archie/`
- **Maker software workshop:** `https://pokitomas.github.io/theawesomehexapp/maker/`
- **Founder decision instrument:** `https://pokitomas.github.io/theawesomehexapp/founder/`
- **Frontier World Expo research preview:** `https://pokitomas.github.io/theawesomehexapp/world-expo/`

Archie and Maker are one commercial family: Archie owns objective, context, continuity, coordination, and admitted intelligence; Maker owns permissioned mutation, verification, delivery, and rollback. Sideways remains an independent product. Founder is an internal instrument, not a standalone company. Expo exposes its research substrate and blocked promotion state; it does not claim any multimodal candidate has passed.

```bash
npm run product:portfolio -- validate
npm run product:portfolio -- routes
npm run product:portfolio -- market
npm run product:portfolio -- route /archie/
```

- **Install or open Sideways:** [plain-language install guide](./INSTALL.md)
- **Install Archie preview:** `npm install --global https://github.com/Pokitomas/theawesomehexapp/archive/refs/heads/main.tar.gz`, then run `archie`
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

## Archie and Maker

Archie and Maker are one intelligence-and-execution family. Sideways is an independent application they may inspect and improve through ordinary repository permissions; Sideways is not the AI, its memory substrate, or a privileged self-modification path. See [`ARCHIE_MAKER_VISION.md`](./ARCHIE_MAKER_VISION.md).

Archie is exposed as a cross-platform package executable. A bare `archie` launch presents a guided local-world status; `archie setup --json` provides the same runtime, artifact, and runner readiness state to automation. The source-package preview bundles no model and makes no capability claim.

From a clean checkout:

```bash
npm run maker -- "describe the end state"
```

The default command passes through the native Archie memory bridge. It may surface matching reusable plans, but Maker’s read-only assessments, synthesis, single-writer lease, isolated worktree, verification, draft PR, and human merge boundaries remain authoritative.

See [`NATIVE_MAKER.md`](./NATIVE_MAKER.md) for setup, adapters, leases, recovery behavior, and the legacy endpoint-backed worker.

## Frontier World Expo

The Expo maps frontier benchmarks into twelve lived visual, sonic, speech, music, and persistent-world commissions. It generates six contradictory candidate roles per round and fails promotion closed until exact artifact, device, trace, independent metric, human preference, authorship, provenance, and portable-export receipts are complete.

```bash
npm run frontier:expo:derive -- --seed 466 --round issue-466 --output round.json
npm run frontier:expo:materialize -- --round-file round.json --output .archie/frontier-world-expo/issue-466
npm run frontier:expo:status -- --directory .archie/frontier-world-expo/issue-466
```

The current `/world-expo/` path is a research preview of this substrate. No candidate is promoted.

## Verification

The repository gates changes with manual overlay validation, exact kernel parity, phone and media proofs, Ark survival, social and authority contracts, exact-head build/deployment accounting, Frontier Expo contracts, and executable product-route, allocation, valuation-boundary, and Expo-claim checks.

The concentrated private-archive phone test must load exactly twenty records, enter saturation, fire the boundary, and visibly move the gate above zero. The Ark proof requires all four controls to exist as soon as the vault rail becomes visible and verifies zero horizontal overflow after destructive recovery.

## Capability boundary

Sideways is a production-shaped hybrid, not a claim that every deployment has every authority. Static GitHub Pages cannot provide canonical shared mutations. A configured server deployment can provide the repository-defined public social graph, but external branch rules, environment protection, installed-app grants, secret values, hosting-team roles, and database grants remain outside repository proof. The private archive still has no automatic multi-device synchronization or upload CDN; portability requires an explicit Ark export.

See [`PROGRAM_ONTOLOGY.md`](./PROGRAM_ONTOLOGY.md) for the authority, storage, eligibility, ranking, and portability vocabulary that governs new work.
