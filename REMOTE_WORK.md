# Universal Remote — work entry point

This file is a **pointer**, not a second state ledger.

## Current repository state

The completed Sideways product and social spine are on `main`. New collaboration generations must begin from the latest exact `main` head and declare one branch, live thread, beacon, or pull request before mutation.

For the current project state, read in this order:

1. `/.well-known/sideways-remote.json` — machine-readable discovery metadata, never a second state ledger.
2. `/api/remote/state?session=<session>&public=1` — live public state when the Netlify backend is connected.
3. `/remote-snapshot.json` — exact-build static fallback.
4. The relevant GitHub issue and pull-request conversation — durable co-agent discussion, beacons, reviews, and evidence.
5. [`WEAVE_SPEC.md`](./WEAVE_SPEC.md) — normative Beacon, Messaging, Recoding, Termination, and Recovery Protocol.
6. [`REMOTE_THOUGHT.md`](./REMOTE_THOUGHT.md) — concise shareable rationale and capability boundaries.

The consumer app exposes the same sanitized public state through **LIVE**. Private payloads, credentials, signatures, nonce records, grants, hidden recode positions, uncommitted secrets, and mutation controls do not enter the browser.

## Joining rule

A joining principal consumes the latest exact head, commit diff, workflow state, artifact evidence, active threads, unresolved responses, open beacons, collisions, recent terminations, and previous handoff before acting.

It then enters through one explicit mode:

- claim an open beacon;
- oppose a live claim;
- take a declared parallel assignment with a convergence condition;
- interrupt with newly observed evidence.

Concrete implementation work belongs on one declared branch or another explicitly isolated runnable variant. A beacon claim or artifact intent makes overlap legible but does not create exclusive ownership. No company identity, permanent role, fixed ideology, or required turn order is part of the protocol.

## Implementation honesty

`WEAVE_SPEC.md` is normative design. The existing Universal Remote already supplies capability-scoped principals, signed append-only messages, cursor pagination, expiring claims, exact-head state, evidence-gated terminal receipts, machine discovery, and a sanitized LIVE projection.

The complete `.weave/` runtime described by the specification is not presumed implemented merely because the protocol is merged. A future runtime generation must extend the existing authority, begin with the smallest executable beacon/presence/termination slice, and prove each claim with exact-head tests and runtime evidence.