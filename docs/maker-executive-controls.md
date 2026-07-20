# Maker executive execution controls

Issue: #679  
Stacked dependency: PR #682 at `03e457cf7592c09e005523168f7a84a2423c5bc3`

## Purpose

`scripts/maker-executive-controls.mjs` is the deterministic inhibition, bounded-patch, hypothesis, verification, rollback, and mutation-receipt layer above exact live state and canonical leases.

It decides whether a proposed action is authorized and observable, which competing mutation is the smallest valid intervention, whether independent evidence admits the result, and whether rollback is mandatory. It does not execute shell commands, create Git commits, deploy, or promote models by itself.

## Authority manifest

The authority manifest binds:

- exact repository, generation, `main_sha`, and snapshot digest;
- principal grants for specific actions and canonical scopes;
- optional grant expiry;
- token, compute-time, storage, workflow-rerun, and recursive-training ceilings and current spend;
- independent recursion limit;
- required promotion and deployment gates;
- passed gates;
- separation of build and deployment authority.

The manifest receives a deterministic SHA-256 digest. Selection and execution callers must provide the expected digest. A changed manifest is denied with `authority-manifest-changed` instead of silently inheriting new power.

`authorizeExecutiveAction` returns explicit denial reasons for:

- stale repository head;
- terminal generation;
- unsupported or ungranted action;
- missing principal grant;
- expired grant;
- scope outside the grant;
- exceeded token, compute, storage, rerun, or recursive-training budget;
- exceeded evaluator-selected recursion limit;
- unmet promotion or deployment gates;
- invalid build/deployment authority separation.

`consumeExecutiveBudget` is compare-and-swap bound to the same manifest digest and refuses denied actions.

## Bounded patch planning

Every mutation candidate declares:

- exact source SHA;
- changed canonical scopes and estimated changed bytes;
- commands and produced artifacts;
- behavioral claims;
- tests that can observe those claims;
- estimated cost;
- rollback procedure.

The planner rejects stale, oversized, unobservable, under-observed, or non-rollbackable candidates. Among valid candidates it chooses the smallest scope count, then fewest changed bytes, then lowest estimated cost, then lexical identity.

A candidate cannot claim behavior that no test can observe. `deleteUnsupportedClaims` removes claims not admitted by evidence before the execution plan proceeds.

## Hypothesis management

High-impact mutations require:

1. at least two competing hypotheses;
2. explicit falsification criteria for every hypothesis;
3. an adversarial alternative authored by a principal other than the implementation author.

Evidence is directionally weighted as support or refutation. The collapse result preserves every rejected hypothesis and records whether it was disproved or merely lower-weight. Disproved assumptions produce explicit lane-termination records.

## Independent verification

The verification contract requires distinct writer and verifier principals and binds:

- exact source and result SHAs;
- exact input byte digests;
- expected repository-tree digest;
- required evidence types;
- mandatory negative tests for authority bypass, lease overlap, stale-head mutation, and artifact substitution;
- deterministic replay when supported;
- changed-tensor proof when a trained adapter or model requires it.

Evaluation captures case-level results and produces explicit failures for mismatched bytes, unexpected repository trees, missing evidence, failed negative tests, missing replay, missing changed-tensor proof, or individual failed cases. `selectSmallestFailedUnit` selects the narrowest failed unit for a bounded rerun or repair lane.

## Generated-output reproducibility

Two generated-output manifests must contain the same exact identities and digests. Any difference denies commit admission. A successful comparison emits a deterministic output-manifest digest.

## Rollback

Rollback is mandatory when:

- the expected repository head moved after planning; or
- independent verification failed.

Terminal, already rolled-back, or cancelled transaction states remain denied from ordinary continuation. The rollback decision preserves every denial reason.

## Mutation receipt

A mutation receipt is admitted only after passing independent verification. It binds:

- exact repository, source SHA, and result SHA;
- snapshot, patch-plan, and authority-manifest digests;
- lease identity;
- changed scopes;
- command evidence;
- produced artifact digests;
- verification digest;
- preserved rollback target;
- promotion state.

The default promotion state is `promotion:not-admitted`.

## Verification

Focused contract:

```bash
node --test scripts/tests/maker-executive-controls.test.mjs
```

The isolated contract passed nine cases before repository mutation, covering:

- exact authority-manifest CAS and explicit denial reasons;
- budget consumption and terminal/gate inhibition;
- smallest observable mutation selection;
- unsupported-claim deletion;
- competing and independently adversarial hypotheses;
- exact-byte and repository-tree verification;
- required negative tests, deterministic replay, changed-tensor proof, and case-level failures;
- smallest failed-unit selection;
- generated-output reproducibility;
- rollback on verification or head failure;
- evidence-complete mutation receipts with preserved rollback identity and `promotion:not-admitted`.

PR #682's independent repository workflows completed successfully before this stacked branch was created.

## Claim boundary

This lane defines deterministic controls and evidence contracts. It does not yet admit:

- a durable transactional Git branch/commit executor;
- automatic filesystem or remote rollback execution;
- connector-side authority or lease compare-and-swap;
- signed remote coordination and nonce replay protection;
- actual independent verifier runner isolation;
- dataset training, adapter fusion, quantization, or device evaluation;
- integration, release, deployment, or promotion orchestration;
- generation-level self-monitoring and terminalization.

Those remain dependent lanes in #679. Merge, deployment, production data, secrets, and training spend remain separately governed authority.
