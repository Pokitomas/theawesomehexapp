# Sideways repository revival

Issue #223 is the parent generation. This document is the human map; `.frankenstate` is the canonical machine-readable ledger.

## Assembly state

All eight child implementation lanes have been transported into PR #233 using expected-head checks and history-preserving merges or exact blob overlays where shared manifests conflicted.

| Lane | Source PR | Transported exact head | Assembly result |
|---|---:|---|---|
| product | #234 | `eeaf6a292049a309a3bad5e5b1b32e56d1f25ce2` | journey audit and admission present |
| archive | #235 | `3b816a76c8705a63ef6563691f8192065255d8dc` | survival truth and failure witnesses present |
| social | #236 | `00d78fa41acd336db82f026081cb691aaff59b7f` | reachability audit plus concurrent profile/diagnostic repairs present |
| ranking | #237 | `49b5dbc319d6bf1435fa7e4994ea05d4f8439bda` | deterministic evaluation and cumulative exact-tree admission present |
| weave | #238 | `33bd3d68588b605e833c43b6353ef26a06c723d9` | replay privacy, complete lasso history, and terminal lifecycle present |
| Maker | #239 | `10ee0cd41b4ae5373db1e905651b5b62f27a7179` | provider-neutral worker, distinct role contracts, and terminal release present |
| operations | #240 | `fddfd0d0cd8afe499201f5f5656ad0669eb1a8b8` | fail-honest operations report and exact-tree admission present |
| quality | #241 | `5183e6d3ed5e3d3dd3e4a5f308930ef7c0ef7667` | Founder accessibility repair and human-quality admission present |

The current assembly includes cumulative `package.json` and `audit/repository-verification.json` composition. No lane’s suite was removed to admit another.

## Collision handling

- Product and quality both touched Founder-facing surfaces; the reviewed label and focus treatment was preserved.
- Ranking, Maker, operations, and quality all changed exact-tree controls; their suites are cumulative.
- Weave and Maker modified shared execution tests; exact source blobs were overlaid on the live assembly tree while `.frankenstate` remained assembly-owned.
- Concurrent social profile actions and manual-assembly diagnostics moved the branch during transport; both movements interrupted the pending ref update and were preserved before integration resumed.
- No force-push was used.

## Deployment boundary

The code-local assembly proceeds to merge only after the final combined head passes its complete triggered workflow matrix. Merge uses an expected-head lock. The resulting push to `main` must independently pass the Pages deployment workflow and exact served-commit verification before a live deployment is claimed.

The following are not manufactured as repository facts and remain post-merge operational work:

- a real Maker model endpoint or self-hosted runner episode;
- dated production backup/restore, rollback, rate-limit, environment, and database observations;
- delayed-feedback ranking outcomes beyond the synthetic fixture;
- broader runtime browser, screen-reader, network, quota, and storage-pressure evidence.

Those external gaps do not erase the implemented code, but the repository must continue to label them as unknown until observed.
