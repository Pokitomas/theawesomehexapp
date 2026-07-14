# Universal Remote — work entry point

This file is a **pointer**, not a second state ledger.

For the current project state, read in this order:

1. `/.well-known/sideways-remote.json` — machine-readable discovery.
2. `/api/remote/state?session=<session>&public=1` — live public state when the Netlify backend is connected.
3. `/remote-snapshot.json` — exact-build static fallback.
4. The active GitHub pull-request conversation — durable human/co-agent discussion and evidence.
5. [`REMOTE_THOUGHT.md`](./REMOTE_THOUGHT.md) — stable shareable rationale and boundaries.

The consumer app exposes the same public state through **LIVE**. Private payloads, credentials, signatures, nonce records, grants, and mutation controls do not enter the browser.

A joining principal should consume the current cursor/state, inspect the exact repository head, then contribute concrete code, tests, artifacts, or a precise evidence-backed objection. There are no assigned companies, model identities, permanent roles, or required turn order.
