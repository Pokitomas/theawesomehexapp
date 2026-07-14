# Sideways

A local-first article, forum, social, and personal-media instrument built around one saturation-ranking kernel.

- Root feed: `https://pokitomas.github.io/theawesomehexapp/`
- Sideways consumer app: `https://pokitomas.github.io/theawesomehexapp/manual/`
- Root debug: `https://pokitomas.github.io/theawesomehexapp/?debug=1`
- Sideways debug: `https://pokitomas.github.io/theawesomehexapp/manual/?debug=1`
- Phone gate: `https://pokitomas.github.io/theawesomehexapp/manual/?debug=1&test=1&autorun=1`

## Two product surfaces, one kernel

The root product is the reproducible one-million-candidate feed. It combines article, forum, and social records from Wikinews, Hacker News, and public Mastodon sources while preserving canonical links, authorship, replies, media provenance, and deterministic recommendation features.

`/manual/` is the user-owned Sideways surface. It begins without a hidden corpus, but it is no longer merely an upload utility: a person can create a local workspace profile, install the small built-in starter feed, write posts, attach images and places, like, reply, remix, save, share, delete, import personal archives, and move through Feed, Places, Library, Saved, Full, and Desktop modes.

The manual app does not contain a second approximation of the recommender. During every build, `manual-app/kernel.js` is generated from the root `src/app.js` declarations. A brace-aware extractor, syntax verification, kernel-parity workflow, and the phone gate prevent formatting drift or an incomplete copied kernel from shipping.

## Private workspace, public social graph

Sideways now has one thin network boundary beneath the existing client. The local workspace remains canonical for imported files, blobs, drafts, private collections, Ark backups, ranking state, and session-load state. None of that material is uploaded merely because the user joins the network.

A function-capable deployment with `DATABASE_URL` owns only public social facts:

- account sessions and public profile identity
- public text posts
- follows and following-feed eligibility
- likes
- replies as first-class posts
- append-only idempotent mutation events

The workspace profile and public identity are deliberately separate. The old workspace fields remain local; account identity mutates only through `/api/me/profile`. Network posts are normalized into the same social-record shape as imported and authored local records, cached in IndexedDB only for offline reading, and ranked by the existing client kernel beside private material.

The implemented alpha endpoints are `/api/auth/*`, `/api/me`, `/api/users/*`, `/api/posts*`, and `/api/feed/following`. Passwords use scrypt, access and refresh credentials are stored server-side only as hashes, refresh sessions rotate, and credential material is excluded from the event ledger.

The GitHub Pages URLs above remain static deployments. They do not prove that the Postgres-backed social service is live. A production claim requires a function-capable deployment, a configured database, and an external receipt identifying the exact deployed commit.

## Import anything useful

The Sideways importer recognizes exports from Instagram, Reddit, TikTok, YouTube, Spotify, X/Twitter, Mastodon, browser bookmarks, RSS/Atom, JSON, JSONL, NDJSON, CSV, plain text, Markdown, and HTML. The normal Library path also preserves PDF, ZIP, Office documents, images, audio, video, and unknown binary files.

Imports are classified by bytes rather than trusted file extensions, hashed in a worker, deduplicated, written in bounded IndexedDB transactions, cancellable between chunks, and reflected in the feed without an automatic page reload. Images and other assets remain blobs with reference-safe deletion and honest fallbacks.

## Local ownership and recovery

IndexedDB is the canonical hot corpus. Sideways exposes four compact Library controls:

- **PIN** requests persistent browser storage and mirrors the current corpus into OPFS where supported.
- **CHECK** audits records, assets, missing references, orphaned blobs, bytes, and durability status.
- **BACKUP** creates a versioned, user-owned `.sideways` Ark containing records, assets, the compatibility ledger, workspace profile, and places.
- **RESTORE** transactionally restores an Ark and records the survival receipt.

OPFS is same-origin redundancy, not an external backup. Browser storage and OPFS can still be evicted together; the downloaded `.sideways` Ark is the boundary that survives origin loss. Network cache records may be rebuilt from the server, but private local records transfer only when the user explicitly moves an Ark.

## Profiles, posts, places, and media

The local workspace profile persists with a display name, handle, biography, accent, avatar treatment, and portable state. The account-owned public profile separately carries the network handle, display name, biography, avatar, cover, pronouns, and website. Profile or Ark import never silently overwrites server identity.

The app supports local text and image posts, public text posts, social actions, saved records, deletable local content, place creation and selection, Feed/Full/Desktop media modes, intrinsic image/video/audio/PDF/archive surfaces, and zero-overflow phone layouts. Public media upload is intentionally deferred until direct-to-object-storage grants and moderation limits exist.

## LIVE work surface

The **LIVE** window exposes public, read-only repository work state. `/.well-known/sideways-remote.json` is discovery metadata only; it is not a second state ledger and does not grant mutation authority. The browser receives no repository credentials, private payloads, signatures, nonce records, grants, or remote mutation controls.

See [`REMOTE_WORK.md`](./REMOTE_WORK.md) for the durable entry point and [`REMOTE_THOUGHT.md`](./REMOTE_THOUGHT.md) for the protocol boundaries.

## Verification

The repository gates changes with:

- manual overlay validation
- exact kernel parity
- the legacy 390×844 saturation phone gate
- universal-media phone proof
- profile-first starter and static-drop proof
- Ark mirror → backup → delete → restore → audit proof
- authoritative two-account social phone proof
- exact-head build and deployment accounting

The social proof uses two isolated mobile browser contexts and disposable server state. It creates accounts, follows, publishes through the existing composer, synchronizes into the existing feed, replies, likes, logs out, logs in from a fresh browser, restores public state, and proves that the original private local record did not transfer.

## Capability boundary

This repository now contains the account, session, relational social database, event ledger, public-profile, post, follow, reply, like, and following-feed spine needed for a networked alpha. It is not yet a public-launch-complete hosted social network. Moderation, block/mute/report enforcement, media-upload grants, rate limits, notification inboxes, operational database migrations, production observability, and a verified function-capable deployment remain required before public launch.
