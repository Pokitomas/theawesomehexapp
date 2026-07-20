# Maker executive delegation and lease registry

Issue: #679  
Stacked dependency: PR #681 at `257c6f26e5886d8cfcda5a93740af2fad7730f8b`

## Purpose

`scripts/maker-executive-delegation.mjs` is the capability, ownership, and subtask-contract layer above the exact live-state kernel.

It admits deterministic decisions about who may inspect or mutate a lane, which compute class may execute it, and whether a canonical repository, generated-output, artifact, dataset, checkpoint, or deployment scope has exactly one writer. It does not create remote branches, start runners, or mutate GitHub by itself.

## Canonical scopes

Every owned or produced identity is represented as one of:

- `repository` — tracked files or directory prefixes;
- `generated` — generated files, including outputs not visible in the authored patch;
- `artifact` — build or model artifacts;
- `dataset` — exact dataset identities;
- `checkpoint` — model or adapter checkpoint identities;
- `deployment` — protected deployment identities.

Repository and generated scopes share one collision namespace. A lane owning `dist/**` therefore collides with another lane producing the hidden generated file `dist/app.js`.

Artifact, dataset, checkpoint, and deployment scopes collide by exact identity.

## Compare-and-swap lease registry

The lease registry binds:

- exact repository and generation identity;
- exact 40-character repository head;
- every lease, holder, lane, scope, parent, acquisition time, expiry time, status, and reason;
- a deterministic registry digest.

Every mutation of the registry requires the caller's expected registry digest. A stale expected digest is rejected before lease acquisition, inheritance, expiry, revocation, release, or supersession.

Top-level acquisition rejects overlap against active or delegated ownership. Every lease authorizes exactly one writer.

## Bounded inheritance

A parent writer may delegate a bounded subset of its scopes to one child lease:

1. every child scope must be covered by the parent;
2. the parent becomes `delegated` and cannot write;
3. the child becomes the only active writer for its scopes;
4. the child expiry cannot exceed the parent expiry;
5. releasing or expiring the last active child reactivates a still-valid parent;
6. revoking or superseding an ancestor cascades to mutable descendants;
7. a delegated parent cannot release while a child is active.

Registry normalization rejects forged states such as an active child under a nondelegated parent or a delegated parent with no active child.

## Commit-time ownership

`assertMutationOwned` and `verifyCommitPaths` require:

- an active writer lease;
- exact agreement between registry head, lease head, and mutation source head;
- every changed tracked and generated path to remain within the granted scopes;
- no ambiguous overlap with another mutable lease outside the current inheritance lineage.

This is the fail-closed commit boundary for unowned files and hidden generated outputs.

## Integration collision scan

`detectIntegrationScopeCollisions` compares produced scopes across lanes before integration. It reports the exact two lanes and exact two scopes that collide. A caller must deny integration or create a bounded repair lane; the function does not silently select a winner.

## Capability-aware assignment

A principal declares:

- readable source classes;
- write authority;
- supported environments;
- available hardware classes such as CPU, CUDA, device, or hosted runner;
- credentials it may use;
- repository, artifact, dataset, checkpoint, or deployment scopes it may own;
- current availability.

A lane declares the corresponding requirements. Assignment fails with explicit per-principal denial reasons when no principal satisfies them. Deterministic selection uses lexical principal identity among eligible principals, preventing nondeterministic writer races.

`reassignBlockedLane` excludes the previous or explicitly unavailable principal and reruns the same capability proof. It does not weaken lane requirements to force assignment.

## Read-only scout fanout

`buildReadOnlyScoutFanout` creates one scout contract per requested source class. Every scout:

- binds the exact source SHA and snapshot digest;
- has no allowed mutations;
- requires a source-envelope evidence output;
- terminates with an exact source envelope or an explicit unavailable-external-authority result.

This permits repository, Linear, CI, artifact, runner, deployment, and model-state fanout without creating additional writers.

## Subtask contracts and budgets

A subtask contract binds:

- lane and task identity;
- exact source SHA and snapshot digest;
- exact input digests;
- allowed mutation scopes;
- required evidence types;
- terminal output;
- token, compute-time, storage, and workflow-rerun ceilings.

The normalized contract receives its own SHA-256 digest. Missing evidence requirements or terminal output are rejected.

## Verification

Focused contract:

```bash
node --test scripts/tests/maker-executive-delegation.test.mjs
```

The isolated contract passed nine cases before repository mutation, covering:

- compare-and-swap acquisition and overlap denial;
- bounded inheritance and parent reactivation;
- expiry, revocation, supersession semantics, and descendant safety;
- delegated-parent release denial;
- exact-head mutation checks;
- tracked and generated commit-scope enforcement;
- hidden generated-output collision detection;
- capability routing, blocker reasons, and reassignment;
- read-only scout fanout;
- exact-input, evidence, terminal-output, and budget-bound subtask contracts.

PR #681's independent repository checks completed successfully before this stacked branch was created.

## Claim boundary

This lane admits deterministic lease and assignment state transitions. It does not yet admit:

- a remote durable lease store or distributed transaction protocol;
- GitHub branch and commit transactions;
- automatic rollback after failed verification;
- authority-manifest evaluation at selection and execution time;
- nonce-signed remote coordination;
- independent verifier execution;
- training, fusion, quantization, evaluation, promotion, integration, release, or deployment orchestration.

Those remain dependent lanes in #679. Merge, deployment, secrets, production data, and training spend remain human or separately granted authority.
