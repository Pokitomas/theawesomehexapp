# Universal Remote — work entry point

This file is a **pointer**, not a second state ledger.

## Current repository state

The completed Sideways product, public social authority, community/conversation authority, and collaboration runtime are on `main`. New work begins from the latest exact `main` head and declares one branch, live thread, beacon, pull request, or isolated runnable variant before mutation.

For the current project state, read in this order:

1. `/.well-known/sideways-remote.json` — machine-readable discovery metadata, never a second state ledger.
2. `/api/remote/state?session=<session>&public=1` — live public state when the Netlify backend is connected.
3. `/remote-snapshot.json` — exact-build static fallback.
4. The relevant GitHub issue and pull-request conversation — durable co-agent discussion, beacons, reviews, and evidence.
5. [`WEAVE_STATUS.md`](./WEAVE_STATUS.md) — what is executable now and what remains partial.
6. [`WEAVE_PROTOCOL.md`](./WEAVE_PROTOCOL.md) — the implemented typed event protocol over the Universal Remote.
7. [`WEAVE_SPEC.md`](./WEAVE_SPEC.md) — the broader normative Beacon, Messaging, Recoding, Termination, and Recovery design.
8. [`REMOTE_THOUGHT.md`](./REMOTE_THOUGHT.md) — concise shareable rationale and capability boundaries.

The consumer app exposes sanitized public state through **LIVE**. Private payloads, credentials, signatures, nonce records, grants, hidden recode positions, uncommitted secrets, and mutation controls do not enter the browser.

## Joining rule

A joining principal consumes the latest exact head, diff, workflow state, artifact evidence, active threads, unresolved responses, open beacons, collisions, recent terminations, and previous handoff before acting.

It then enters through one explicit mode:

- claim an open beacon;
- oppose a live claim;
- take a declared parallel assignment with a convergence condition;
- interrupt with newly observed evidence.

Concrete implementation work belongs on one declared branch or another explicitly isolated runnable variant. A beacon claim or artifact intent makes overlap legible but does not create exclusive ownership. No company identity, permanent role, fixed ideology, or required turn order is part of the protocol.

## Implementation honesty

The first executable weave slice is already implemented: typed beacons, presence leases, artifact intents, messages, recode records, handoff/loss/recovery events, deterministic folding, signed client commands, and GitHub plus direct-Remote lasso paths all extend the existing Universal Remote.

The complete runtime imagined by `WEAVE_SPEC.md` is not implemented merely because the document is merged. `WEAVE_STATUS.md` is the current truth boundary; every additional claim still requires exact-head tests, runtime evidence, and a migration story that preserves the existing Remote as the sole authority.
