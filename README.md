# Sideways

A local-first article, forum, social, and personal-media instrument built around one saturation-ranking kernel.

- Root feed: `https://pokitomas.github.io/theawesomehexapp/`
- Sideways consumer app: `https://pokitomas.github.io/theawesomehexapp/manual/`
- Root debug: `https://pokitomas.github.io/theawesomehexapp/?debug=1`
- Sideways debug: `https://pokitomas.github.io/theawesomehexapp/manual/?debug=1`
- Phone gate: `https://pokitomas.github.io/theawesomehexapp/manual/?debug=1&test=1&autorun=1`

## Two product surfaces, one kernel

The root product is the reproducible one-million-candidate feed. It combines article, forum, and social records from Wikinews, Hacker News, and public Mastodon sources while preserving canonical links, authorship, replies, media provenance, and deterministic recommendation features.

`/manual/` is the user-owned Sideways surface. It begins without a hidden corpus, but it is no longer merely an upload utility: a person can create a profile, install the small built-in starter feed, write posts, attach images and places, like, reply, remix, save, share, delete, import personal archives, and move through Feed, Places, Library, Saved, Full, and Desktop modes.

The manual app does not contain a second approximation of the recommender. During every build, `manual-app/kernel.js` is generated from the root `src/app.js` declarations. A brace-aware extractor, syntax verification, kernel-parity workflow, and the phone gate prevent formatting drift or an incomplete copied kernel from shipping.

## Import anything useful

The Sideways importer recognizes exports from Instagram, Reddit, TikTok, YouTube, Spotify, X/Twitter, Mastodon, browser bookmarks, RSS/Atom, JSON, JSONL, NDJSON, CSV, plain text, Markdown, and HTML. The normal Library path also preserves PDF, ZIP, Office documents, images, audio, video, and unknown binary files.

Imports are classified by bytes rather than trusted file extensions, hashed in a worker, deduplicated, written in bounded IndexedDB transactions, cancellable between chunks, and reflected in the feed without an automatic page reload. Images and other assets remain blobs with reference-safe deletion and honest fallbacks.

## Local ownership and recovery

IndexedDB is the canonical hot corpus. Sideways exposes four compact Library controls:

- **PIN** requests persistent browser storage and mirrors the current corpus into OPFS where supported.
- **CHECK** audits records, assets, missing references, orphaned blobs, bytes, and durability status.
- **BACKUP** creates a versioned, user-owned `.sideways` Ark containing records, assets, the compatibility ledger, profile, and places.
- **RESTORE** transactionally restores an Ark and records the survival receipt.

OPFS is same-origin redundancy, not an external backup. Browser storage and OPFS can still be evicted together; the downloaded `.sideways` Ark is the boundary that survives origin loss.

## Profiles, posts, places, and media

Profiles persist locally with a display name, handle, biography, accent, avatar treatment, and portable state. The app supports text and image posts, social actions, saved records, deletable local content, place creation and selection, Feed/Full/Desktop media modes, intrinsic image/video/audio/PDF/archive surfaces, and zero-overflow phone layouts.

A static deployment saves the profile locally and can install the same profile-aware eight-item starter pack without a backend. A function-capable Netlify deployment adds unique-handle checks, durable profile synchronization, the starter endpoint, and live remote state; the starter still falls back locally when its endpoint is unavailable.

## LIVE work surface

The **LIVE** window exposes public, read-only repository work state. `/.well-known/sideways-remote.json` is discovery metadata only; it is not a second state ledger and does not grant mutation authority. The browser receives no credentials, private payloads, signatures, nonce records, grants, or remote mutation controls.

See [`REMOTE_WORK.md`](./REMOTE_WORK.md) for the durable entry point and [`REMOTE_THOUGHT.md`](./REMOTE_THOUGHT.md) for the protocol boundaries.

## Verification

The repository gates changes with:

- manual overlay validation
- exact kernel parity
- the legacy 390×844 saturation phone gate
- universal-media phone proof
- profile-first starter and static-drop proof
- Ark mirror → backup → delete → restore → audit proof
- exact-head build and deployment accounting

The concentrated-corpus phone test must load exactly twenty records, enter saturation, fire the boundary, and visibly move the gate above zero. The Ark proof requires all four controls to exist as soon as the vault rail becomes visible and verifies zero horizontal overflow after destructive recovery.

## Capability boundary

This is a production-shaped local-first product, not a completed hosted social network. It does not provide a general account system, moderation service, multi-device corpus synchronization, upload CDN, or transactional guarantees across devices. Personal content remains owned by the browser unless the user exports an Ark; live remote state requires the corresponding verified backend deployment.
