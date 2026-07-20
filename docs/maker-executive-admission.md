# Maker executive admission boundary

Issue: #679  
Review base: `main@19723c58ba9db322a39db573c06cc6cf5e737beb`

## Review result

The merged executive modules provide useful deterministic construction primitives, but their isolated contracts are not sufficient as a composed authorization boundary. The review found bypasses at module seams:

- a PR lease marker could be projected without matching the observed PR branch, base, head, session identity, or current `main`;
- a plan object could be tampered after construction or carry lanes bound to another source SHA;
- mutation ownership did not check lease expiry at execution time, and cyclic parent pointers could make ancestry traversal non-terminating;
- budget consumption trusted a caller-supplied authorization object instead of recomputing it against the current manifest;
- deterministic replay and changed-tensor requirements checked presence rather than exact expected identity;
- mutation receipts could accept a caller-selected promotion state and did not compose with the state kernel's ready-receipt requirement;
- frozen evaluation counted array rows without an exact unique case manifest, allowing repeated passing cases to inflate evidence;
- promotion decisions did not bind the exact evaluation, non-regression, and device evidence consumed;
- integration roots and stacked children were not compositionally bound to `main` and dependency result SHAs;
- signed coordination messages did not verify their declared message digest, state mutation lacked expected-state CAS, and terminal state could be resumed;
- output admission accepted a boolean `verified` claim without an evidence digest.

## Admitted entrypoint

`scripts/maker-executive-admission.mjs` is the composed admission boundary. The previously merged modules remain low-level construction and normalization primitives. They do not independently authorize mutation, completion, promotion, release, coordination, or narration.

The admission module adds:

- exact PR metadata and current-head validation for Maker lease markers;
- digest reconstruction and exact-snapshot validation for executable plans;
- lease-parent cycle rejection and execution-time expiry enforcement;
- manifest-bound authorization recomputation before budget consumption;
- exact replay and changed-tensor expectations;
- non-promoting ready mutation receipts and exact lane/terminal-evidence completion binding;
- explicit frozen case manifests with unique identities;
- evidence-bound promotion decisions with required device and gate evidence;
- root-to-main and child-to-dependency integration binding;
- coordination state CAS, message schema/signature/digest verification, root-only control actions, and irreversible terminal state;
- evidence-digest requirements for admitted executive output.

## Verification

```bash
node --test scripts/tests/maker-executive-admission.test.mjs
```

The adversarial contract covers the concrete bypasses above. Repository Actions provide the independent merge-tree result.

## Claim boundary

This change hardens deterministic contracts. It does not create a durable remote lease store, secret-management service, protected deployment, physical trainer/evaluator isolation, trained model, or production promotion. Every model remains `promotion:not-admitted` unless the complete evidence-bound promotion function returns an exact decision; that decision still does not grant deployment authority.

## Rollback

Revert the three additive files. Existing low-level modules are not modified.
