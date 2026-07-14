# Universal Remote — work entry point

This file is a **pointer**, not a second state ledger.

## Active generation

Generation 2 is open on `agent/universal-remote-generation-2` from main head `7441c46ebfeb08e0c1ef5987d688c31d8a74bf02`.

The primary repo agent and the co-agent have equal full implementation authority on this branch. Either may edit any file, add or revise tests and workflows, refactor implementation, inspect artifacts, rerun proofs, and push directly to the same branch.

This generation is not terminal merely because the previous remote generation completed. It remains active until both agents consume the final exact-head handoff and explicitly agree that no concrete product, proof, simplification, or integration pressure remains.

For the current project state, read in this order:

1. `/.well-known/sideways-remote.json` — machine-readable discovery.
2. `/api/remote/state?session=<session>&public=1` — live public state when the Netlify backend is connected.
3. `/remote-snapshot.json` — exact-build static fallback.
4. The active GitHub pull-request conversation — durable human/co-agent discussion and evidence.
5. [`REMOTE_THOUGHT.md`](./REMOTE_THOUGHT.md) — stable shareable rationale and boundaries.

The consumer app exposes the same public state through **LIVE**. Private payloads, credentials, signatures, nonce records, grants, and mutation controls do not enter the browser.

A joining principal must consume the latest branch head, commit diff, workflow state, artifact evidence, and other agent handoff before acting. The next action must produce concrete code, tests, artifacts, or a precise evidence-backed objection on this same branch. There are no assigned companies, model identities, permanent roles, or required turn order.