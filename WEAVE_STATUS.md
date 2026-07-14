# Sideways weave implementation status

This file records implementation reality. It is a pointer and status projection, not a second authority ledger.

## Current executable layer

The implementation merged through `WEAVE_PROTOCOL.md` and the Universal Remote currently provides:

- capability-scoped temporary principals over the existing signed Remote transport;
- append-only typed weave events with deterministic folding;
- non-exclusive beacon emit, join, release, and resolve operations;
- renewable presence leases and artifact intents with explicit collision policies;
- operational messages with thread, response, artifact, patch, and evidence fields;
- recode declaration, participation, event, and termination records;
- graceful session handoff, unexpected-loss records, and recovery records;
- the signed `scripts/weave-client.mjs` command surface;
- automatic GitHub-arrival and authenticated-Remote lasso paths;
- private ontology grouping for program execution, authority boundaries, conversation, ranking, community identity, and governance;
- exact-head tests for protocol folding, lasso idempotence, privacy defaults, and failure isolation.

These objects remain typed payloads and projections over the existing Universal Remote. They do not create a second canonical ledger.

## Normative expansion not yet fully executable

`WEAVE_SPEC.md` describes the larger target. The following pieces remain partial, projected, or unimplemented as a complete runtime:

- the complete `.weave/` filesystem-shaped projection and independent cursor materialization;
- general unresolved-response indexing and semantic subscriptions;
- hidden independent recode-position formation and timed reveal;
- first-class assignment and thread dormancy lifecycles beyond ordinary typed messages;
- automatic workspace reconstruction for every expired lease;
- whole-weave drain, integrity snapshot, and restart recovery as one end-to-end state machine;
- full public LIVE rendering of sanitized beacon and thread summaries.

## Authority boundary

Implementation claims come from code, tests, exact-head workflow evidence, and Remote receipts. `WEAVE_SPEC.md` is normative design; `WEAVE_PROTOCOL.md` documents the executable event layer; this file states their present relationship.

A future change extends the existing Remote authority. It must not introduce another collaboration database, expose private payloads or signing capability to the consumer UI, or treat a beacon claim as exclusive ownership.
