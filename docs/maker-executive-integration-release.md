# Maker executive integration, release, coordination, and termination

Issue: #679  
Stacked dependency: PR #684 at `8ef019ef90666bb448cf2e4e35acf84df25c1335`

## Purpose

`scripts/maker-executive-integration-release.mjs` closes the deterministic executive-control graph with exact-head integration, protected release contracts, signed coordination, independently meaningful metrics, terminalization, restart state, and narration admission.

It does not merge, deploy, rotate credentials, or alter protected environments. It decides whether those external actions are admissible and produces exact receipts or denial reasons.

## Integration

An integration plan accepts only completed lanes with:

- exact source and result SHAs;
- dependency identities;
- mutation receipt and evaluation digests;
- changed scopes;
- completed status.

The plan rejects duplicate lane IDs, missing dependencies, and cycles, then emits deterministic dependency order.

Integration admission fails when:

- `main` advanced after planning;
- the observed integration head differs from the expected head;
- produced scopes collide;
- integration regressions exist;
- a changed scope is unowned;
- an evaluation is stale;
- a receipt is missing.

A changed `main` produces `rebase-and-reverify`. Other failed gates produce a bounded repair-lane result rather than a broad retry.

Branches terminate only after merge, supersession, or disproof.

## Release

A release candidate binds:

- exact owner/repository, event, and head;
- separate build, deployment, and promotion principals;
- protected environment identity;
- exact OIDC subject;
- artifact and optional model digests;
- required and passed gates;
- preserved rollback target.

Release-command validation compares exact owner, repository, event, head, principal, action, and gate state. A model promotion decision never substitutes for deployment authority.

Deployment receipts compare intended and live artifact/model identities, record the deployed identity and URL, and preserve the rollback target. Post-deploy verification detects artifact, model, or deployment-identity divergence.

## Signed remote coordination

Coordination messages are canonical append-only HMAC-signed records containing:

- principal identity;
- sequence;
- unique nonce;
- generation;
- action kind and payload;
- previous-message digest.

Processing rejects invalid signatures, inactive principals, sequence gaps, predecessor mismatch, replayed nonces, generation mismatch, and unauthorized root-only actions.

The coordination state supports:

- principal grants and revocation;
- session pause, resume, stop, and terminalization;
- generation reset;
- blocker creation and removal;
- exact repository-head declaration;
- claims tied to repository truth;
- public and private state projections.

Generation reset invalidates prior claims. A new repository-head declaration invalidates any claim bound to another head.

## Self-monitoring

Metrics are derived from structured events, not prose or token volume:

- independently verified state transitions and throughput;
- duplicate-work ratio;
- stale-state mutation attempts;
- lease-contention rate;
- verification latency;
- evidence-defect rate;
- rollback frequency;
- promotion-rejection reasons;
- compute per admitted capability gain;
- mean error between claimed and independently observed outcomes.

## Termination

A lane completes only when mutation receipt, evidence completeness, and terminal observation agree. Otherwise it remains blocked.

Lanes may terminate for duplication, supersession, disproof, authority loss, or budget exhaustion.

A generation terminalizes only after every mutable lease is released. Terminalization preserves unresolved blockers and an exact restart state containing repository head, snapshot digest, unresolved blockers, and incomplete lanes.

## Narration admission

Only verified outputs of these classes are admitted:

- verified mutation;
- proven milestone;
- terminal result;
- unavailable external authority.

Activity summaries, token-volume claims, speculative progress, ordinary reads, and failed hypotheses cannot serve as completion evidence even when wrapped in an otherwise allowed output class.

## Verification

Focused contract:

```bash
node --test scripts/tests/maker-executive-integration-release.test.mjs
```

The isolated contract passed ten cases before repository mutation, covering:

- dependency-aware integration order;
- exact-head, collision, regression, ownership, receipt, and evaluation denial;
- smallest repair lanes and branch termination;
- separate release authorities, protected environments, OIDC identity, and command context;
- live deployment receipts, rollback targets, and post-deploy divergence;
- signed append-only coordination, replay protection, grants, resets, projections, and repository-truth claim invalidation;
- verified-transition throughput, duplicate/stale/contention/evidence/rollback metrics, promotion reasons, compute efficiency, and calibration;
- lane and generation terminalization;
- blocker and restart-state preservation;
- narration rejection.

PR #684's independent repository workflows completed successfully before this stacked branch was created.

## Claim boundary

This lane admits deterministic contracts and state transitions. It does not execute:

- Git merges, rebases, or branch deletion;
- protected-environment deployment;
- OIDC token exchange;
- production verification probes or rollback;
- persistent distributed coordination storage;
- key management or principal authentication beyond supplied signing secrets;
- actual model training or device benchmarks.

Those actions require the corresponding external system and separately granted authority. Merge and deployment remain human-controlled in this repository.
