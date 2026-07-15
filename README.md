# Sideways

Discover across the web, connect accounts you authorize, and keep anything you choose in a private archive you own.

- Root reader: `https://pokitomas.github.io/theawesomehexapp/`
- Private archive: `https://pokitomas.github.io/theawesomehexapp/manual/`
- Root debug: `https://pokitomas.github.io/theawesomehexapp/?debug=1`
- Archive debug: `https://pokitomas.github.io/theawesomehexapp/manual/?debug=1`
- Phone gate: `https://pokitomas.github.io/theawesomehexapp/manual/?debug=1&test=1&autorun=1`

## One product, four states

Sideways presents four ordinary states while preserving stricter authority boundaries underneath:

- **Web** — public material discovered through bounded public sources such as websites, RSS/Atom, sitemaps, public APIs, and ActivityPub-compatible endpoints.
- **Connected** — material available through an account connection the user explicitly authorizes.
- **Private** — material deliberately saved or imported into the person-owned local archive.
- **Shared** — material deliberately published through configured canonical public authority.

A Web or Connected item does not silently become Private. A Private import does not silently become Shared. Public caches and ranking candidate windows remain rebuildable delivery state, not canonical memory or public authority.

## Bounded web discovery

The Pages release builds one normalized, provenance-bearing public source snapshot through `scripts/build-web-source-snapshot.mjs`. Sources are bounded by count, bytes, records, and timeout. Credentials are omitted, private-network targets and credential-bearing URLs are rejected, content types are allowlisted, and individual unavailable providers fail honestly without manufacturing records.

The default snapshot can consume Hacker News, Wikinews, and public Mastodon-shaped records. Deployments may provide an explicit `SIDEWAYS_PUBLIC_SOURCES` configuration for additional lawful public feeds and APIs. Existing sources are ordinary providers rather than the definition of the product.

The root ranking build still materializes a large deterministic delivery pool from the bounded snapshot so the shipped saturation kernel can be evaluated at scale. The source snapshot itself is not a permanent downloaded web corpus.

## Add to Sideways

The archive exposes one ingestion surface with four choices:

1. **Connect an account**
2. **Add a website or feed**
3. **Import files**
4. **Restore a Sideways backup**

Files remain local and use byte-based classification, worker hashing, deduplication, bounded IndexedDB transactions, cancellation, quota checks, media blobs, reference-safe deletion, and in-place feed refresh.

Public websites and feeds are stored as enabled source definitions separately from the private archive. Their records become private only after an explicit save/import action.

Account connection support uses an adapter contract for OAuth/OIDC authorization with PKCE, state and nonce validation, exact callback paths, least-privilege scopes, expiry, refresh, revocation, incremental cursors, cancellation, and disconnect receipts. Static GitHub Pages cannot safely hold provider tokens, so it shows an honest unavailable state and retains file/public-feed alternatives. No provider is presented as connected until a server deployment has its exact client, callback, scopes, and official API contract configured.

Sideways does not collect provider passwords, automate login forms, replay browser sessions, scrape cookies, defeat MFA, or place access/refresh tokens in repository files, logs, URLs, public browser storage, generated Pages assets, public projections, or Ark backups.

## Private ownership and recovery

IndexedDB is the canonical hot store for the private archive. Sideways exposes four Library controls:

- **PIN** requests persistent browser storage and mirrors the private archive into OPFS where supported.
- **CHECK** audits records, assets, references, bytes, and durability state.
- **BACKUP** creates a versioned user-owned `.sideways` Ark.
- **RESTORE** transactionally restores an Ark and records the survival receipt.

OPFS is same-origin redundancy, not an external backup. Browser storage and OPFS can be evicted together; the downloaded Ark is the portability boundary that survives origin loss. Public social authority, connected-account tokens, and rebuildable public projections are excluded.

## Public social authority

A static deployment remains a local archive and public reader. A configured function deployment may expose cookie-authenticated canonical public operations for accounts, profiles, posts, follows, reactions, communities, membership, roles, moderation, appeals, and viewer-local controls. The interface must fail visibly when that authority is unavailable and never simulate shared success from a browser cache.

## One ranking kernel

The root reader and manual archive use the same inspectable saturation-ranking declarations. During every build, the manual kernel is generated from the root declarations, syntax checked, and proved by kernel-parity and phone workflows. Eligibility, score families, saturation, diversity, and bounded exploration remain distinct from source ownership and publication authority.

## Engineering entrypoint

From a clean checkout:

```bash
npm run maker -- "describe the end state"
```

Maker performs bounded read-only assessment, synthesizes one lane, grants exactly one isolated writer a path lease, runs focused tests and `npm run verify:repository`, and stops at a draft PR. Merge, deployment, secrets, repository settings, production data, and production credentials remain human authority.

## Verification

The repository gate covers:

- provider-neutral normalization and provenance;
- public URL and private-network rejection;
- bounded source snapshots and fail-honest providers;
- OAuth PKCE/state/nonce/callback/redaction contracts;
- resumable connected sync state;
- file import, profile, media, Ark recovery, and phone journeys;
- exact root/manual kernel parity;
- social and workflow authority;
- exact-head release and deployment receipts.

External hosting configuration, real provider credentials, production PostgreSQL/backup state, browser download retention, device-specific eviction, screen-reader journeys, additional browsers, and representative-device performance remain explicit external evidence boundaries rather than repository claims.
