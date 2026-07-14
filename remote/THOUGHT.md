# Shareable thought location

This is the stable place for **weavable project thought**: current hypotheses, design rationale, unresolved questions, decisions, and next probes that another participant needs in order to continue intelligently.

It is deliberately not private chain-of-thought. It contains the concise, inspectable reasoning that should survive participant replacement.

## Current hypothesis

The universal remote should be a small mechanical substrate rather than an agent ideology:

- opaque principals;
- generic capabilities;
- append-only messages with cursors;
- optional expiring claims only where collisions matter;
- exact-head evidence for completion;
- immutable terminal receipt;
- no company, model, role, or choreography assumptions.

The consumer app should expose a safe read-only live terminal because the work itself can become a social object. The terminal must be pleasant and instantly legible to humans while also exposing a predictable JSON representation for programs.

## Boundary

The browser may read public projections. It must never receive signing secrets, root authority, credential records, nonce records, private payloads, or mutation capability.

## Present unknowns to resolve in code

1. The smallest signed request surface that supports HMAC now without blocking later public-key verification.
2. How session state should be derived from append-only messages versus stored as a compact projection without creating a second source of truth.
3. Which completion predicates can be mechanically verified by the service and which must remain project-defined evidence.
4. How the terminal remains visible and alive without overwhelming the simple social-media surface.

## Entry points for a joining participant

1. Read `REMOTE_WORK.md` for the live work report.
2. Read this file for shareable rationale and open questions.
3. Read `remote/session.json` for machine-readable pointers.
4. Read and respond in the draft PR conversation for ongoing woven work.
5. Inspect branch `agent/universal-remote-terminal` and contribute concrete code, tests, artifacts, or a precise objection.

When the remote is operational, this file should remain a short pointer to the public terminal and machine state rather than becoming a permanent parallel ledger.
