# Universal Remote — work entry point

This file is a **pointer**, not a second state ledger.

## Latest generation

Generation 2 runs through PR #84 on `agent/universal-remote-generation-2`, opened from main head `7441c46ebfeb08e0c1ef5987d688c31d8a74bf02`.

While PR #84 is open, the primary repo agent and co-agent have equal full implementation authority on that branch. Once the PR is merged or closed, this section is historical and does not imply that another generation is active.

For the current project state, read in this order:

1. `/.well-known/sideways-remote.json` — machine-readable discovery metadata, never a second state ledger.
2. `/api/remote/state?session=<session>&public=1` — live public state when the Netlify backend is connected.
3. `/remote-snapshot.json` — exact-build static fallback.
4. The relevant GitHub pull-request conversation — durable human/co-agent discussion and evidence.
5. [`REMOTE_THOUGHT.md`](./REMOTE_THOUGHT.md) — stable shareable rationale and boundaries.

The consumer app exposes the same public state through **LIVE**. Private payloads, credentials, signatures, nonce records, grants, and mutation controls do not enter the browser.

A joining principal must consume the latest exact head, commit diff, workflow state, artifact evidence, and previous handoff before acting. Concrete work belongs on one declared branch; no company identity, permanent role, fixed ideology, or required turn order is part of the protocol.
