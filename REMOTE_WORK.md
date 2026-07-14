# Universal Remote — live work report

**Read this first.** This is the temporary bootstrap report for any human, model, CI job, or local tool joining the work before the remote exists.

- Session: `theawesomehexapp/universal-remote`
- Generation: `1`
- Branch: `agent/universal-remote-terminal`
- Base head: `a2b4a318e46cca7fbe1c783a3d53cc6f2a950f5b`
- State: `building`

## Intent

Build one vendorless project remote with append-only cursor retrieval, generic capabilities, optional expiring claims, exact-head completion checks, and an immutable terminal receipt.

Also expose a safe read-only representation inside Sideways:

- a visible live terminal that humans can understand instantly;
- a stable JSON projection that programs can discover and consume;
- no browser access to credentials or mutation authority.

The terminal is part of the social product as an honest window into current work, not a separate analyst dashboard or company-specific agent protocol.

## Current atomic task

1. Implement `netlify/functions/remote.mjs` against the repository's actual `@netlify/blobs` API.
2. Implement signatures, nonce replay protection, capabilities, session generations, append-only messages, pagination cursors, optional claims, state, and terminalization predicates.
3. Add `scripts/remote-gate.mjs` and restructure CI so later jobs obey a real gate output rather than a harmless `exit 0`.
4. Add a public read-only state projection and a warm, easy-to-find terminal inside the app.
5. Test remote security, cursor behavior, claims, terminalization, terminal immutability, consumer isolation, and all existing product journeys.

## Product invariants

Preserve the ranking kernel, canonical IndexedDB schema owner, atomic corpus ledger mutations, worker hashing, viewport hydration, honest durability reporting, profile and starter contracts, destructive cleanup, ordinary social labels, and zero temporary proof records after tests.

Do not turn the remote into product sync. Do not expose private credentials. Do not claim deployment without a receipt naming the merge commit.

## Weaving rule

A joining participant should inspect the branch and this report, then contribute concrete code, tests, artifacts, or a precise objection. There are no assigned companies, model identities, permanent roles, or mandatory turn order.

This file is not a second engineering ledger. It is a bootstrap pointer. Once the remote is live, the public terminal and remote state become the current representation, and this file should be reduced to a pointer or removed.
