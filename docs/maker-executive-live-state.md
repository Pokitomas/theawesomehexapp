# Maker executive live-state synthesis

Issue: #679  
Integration base: `main@96b17dcdc0ee5c503d52fc548571451d4e211204` after PR #680 merged

## Purpose

`scripts/maker-executive-live-state.mjs` converts independently observed repository, coordination, CI, runner, artifact, model, deployment, and authority projections into the deterministic snapshot admitted by `scripts/maker-executive-state.mjs`.

This is the source-resolution and event-rescan lane. It does not perform network requests itself. Connectors and runtime adapters must provide explicit source envelopes bound to the same repository and exact `main_sha`; this module rejects inconsistent, stale, future-dated, or conflicting observations before they can enter an execution plan.

## Source envelope

Each source declares:

- a unique `source_id` and source `kind`;
- exact `owner/repository` identity;
- exact 40-character `main_sha`;
- observation timestamp;
- zero or more records for PRs, leases, issues, reviews, checks, jobs, runners, artifacts, datasets, checkpoints, receipts, deployments, and promotion states;
- any authority facts the source is allowed to project.

Sources may represent GitHub, Linear, CI, hosted or local runners, artifact stores, model state, deployment systems, or an authority manifest. The synthesizer does not infer missing external facts from repository source code.

## Synthesis rules

`synthesizeExecutiveLiveState`:

1. rejects sources for another repository, another `main_sha`, an expired observation, or a future observation;
2. requires stable record identities;
3. deduplicates byte-equivalent records from multiple sources;
4. rejects two sources that report different content for the same collection and identity;
5. rejects conflicting authority projections;
6. extracts active one-writer Maker leases from open PR bodies;
7. rejects malformed lease JSON, noncanonical paths, or writer counts other than one;
8. defaults model, adapter, checkpoint, and GGUF artifacts to `promotion:not-admitted` when no explicit promotion state exists;
9. emits the canonical executive snapshot plus a synthesis receipt binding source counts and the resulting snapshot digest.

A partial record and a complete record with the same identity are considered conflicting rather than silently merged. Source adapters must agree on the exact record they claim to project.

## Event-triggered rescans

`buildEventTriggeredRescan` compares two verified snapshots and emits only changed collections and identities. Watchpoints are bound to the previous exact head. A stale watchpoint is rejected instead of silently following a new branch state.

A watchpoint may name:

- the collections that can invalidate a lane;
- exact identities within those collections;
- high-risk mutation surfaces protected by the watchpoint.

When `main_sha` changes, every supplied watchpoint is triggered and rebound to the new exact head. This does not invent collection changes; the head transition remains a separate repository-truth event.

## Duplicate investigation control

`selectCanonicalInvestigations` collapses connected groups of investigations only when they share a hypothesis key and overlapping owned paths. Selection is deterministic:

1. running before ready, blocked, or pending;
2. more accumulated evidence;
3. earlier creation time;
4. lexical lane identity.

Every noncanonical member receives a terminal `duplicate-investigation` result linked to the selected lane. Overlap is transitive, so a chain of overlapping scopes cannot preserve multiple writers by avoiding direct overlap with the first lane.

## Attention eviction

`evictSupersededAttention` removes attention entries tied to:

- a stale repository head;
- a branch no longer in the active set;
- a disproven hypothesis;
- an expired log or observation.

Eviction returns explicit reasons and does not represent removed entries as completed work.

## Verification

Focused contract:

```bash
node --test scripts/tests/maker-executive-live-state.test.mjs
```

The isolated contract covers:

- multi-source synthesis and identical-record deduplication;
- lease extraction and one-writer enforcement;
- stale, mismatched, future, authority-conflict, and record-conflict rejection;
- automatic `promotion:not-admitted` defaults;
- collection-only rescans and exact-head watchpoints;
- repository-head transitions;
- transitive duplicate-investigation collapse;
- stale-head, superseded-branch, stale-log, and disproven-assumption eviction.

The isolated test passed seven cases before repository mutation. The branch was then metadata-rebound to the exact current `main` above so repository Actions could evaluate the synthetic merge tree rather than the stale stack base.

## Claim boundary

This lane admits deterministic synthesis of already collected source observations. It does not yet admit:

- connector-specific GitHub, Linear, CI, artifact, deployment, or model collectors;
- signed source messages or replay protection;
- atomic lease acquisition, inheritance, expiry, revocation, or supersession;
- capability-aware role or compute assignment;
- mutation transactions, commit-time lease enforcement, integration, release, or deployment;
- independent verifier orchestration or model evaluation.

Those remain dependent lanes in #679. Build, deploy, promotion, merge, secrets, production data, and training-spend authority remain separate and fail closed.
