# Maker executive state kernel

Issue: #679  
Exact source `main`: `26b6f5f26c2daca8f7e173e2537a30069db8a02c`

## Purpose

`scripts/maker-executive-state.mjs` is the first dependency-complete slice of the executive capability changeset. It sits above the existing bounded Maker engine and turns mutable repository/model facts into deterministic state, executable dependency plans, expiring lane memory, attention priorities, and evidence-bound completion decisions.

It does not replace `scripts/maker-engine.mjs`. The engine remains responsible for bounded file mutation, command policy, backups, rollback, append-only events, verification, and mutation receipts. This module decides whether an executive lane is legal to begin or continue against a verified live snapshot.

## Admitted contracts

### Exact live-state identity

An executive snapshot binds:

- repository and exact 40-character `main_sha`;
- observation time;
- PR heads, leases, issues, reviews, checks, jobs, runners;
- artifacts, datasets, checkpoints, receipts, deployments, and promotion states;
- the currently projected authority state.

Collections require stable IDs, are deterministically sorted, and are covered by a canonical SHA-256 snapshot digest. Commit and content identities are rejected unless they are exact-length values.

### Stale-state rejection and delta rescans

`assertFreshSnapshot` rejects a mismatched head, an expired observation, or a future-dated observation. `diffExecutiveSnapshots` reports only added, removed, or updated identities by collection and separately records a `main_sha` transition. Consumers can therefore rescan changed state instead of narrating the full repository repeatedly.

### Dependency planning and legal transitions

`buildExecutivePlan` requires every lane to declare:

- exact source SHA;
- dependencies;
- owned repository paths;
- required authority and upstream evidence;
- environment and compute class;
- terminal condition;
- unblock value, collision risk, evidence yield, and compute cost.

The graph rejects missing dependencies, duplicate lane IDs, and cycles. `enumerateLegalTransitions` permits a lane only when dependencies are completed, leases do not overlap, authority is granted, required evidence exists, and the snapshot still matches the plan. `rankExecutableActions` orders only legal actions by the declared score.

### Plan invalidation

`assertPlanValid` fails closed when the snapshot digest, main SHA, expected authority, or active lease topology changes. A caller must rebuild the plan from newly resolved live state rather than mutate from a stale decision.

### Working memory and attention

Lane memory preserves source SHA, owned paths, hypotheses, commands, evidence, failures, negative results, provenance, next action, checkpoint digest, and expiry. Memory expires when repository truth advances or its time boundary passes.

The attention queue admits only blockers, regressions, failed gates, unverified claims, and expiring leases. It is deterministic and keeps blockers above ordinary lease urgency.

### Completion boundary

A lane is not complete because an agent produced a summary. `assertLaneCompletion` requires all three:

1. a ready mutation receipt with an exact receipt digest;
2. every required evidence type;
3. independent observation that the declared terminal condition is true.

## Verification

Focused contract:

```bash
node --test scripts/tests/maker-executive-state.test.mjs
```

The contract covers deterministic snapshots, exact SHA enforcement, stale-state rejection, delta-only state changes, dependency-cycle rejection, action ranking, head and lease invalidation, memory expiry, negative-result persistence, attention priority, and evidence-bound completion.

The implementation was also executed as an isolated Node test before repository mutation. Full repository verification remains a required independent PR check; an isolated pass is not a claim that every repository gate has passed.

## Claim boundary

This slice admits the E0 state/planning foundation and the minimum E1 memory/attention primitives needed to make later lanes exact-head bound. It does **not** claim implementation of:

- GitHub/Linear/CI live-state collectors;
- atomic remote lease acquisition, inheritance, revocation, or commit-time diff enforcement;
- capability-aware agent or hardware assignment;
- patch execution, branch transactions, integration, deployment, or remote coordination;
- independent verifier orchestration;
- model training, fusion, quantization, or promotion;
- self-monitoring metrics across real generations.

Those remain separate dependent lanes under #679. Every model remains `promotion:not-admitted` unless its own frozen evaluation and promotion gates independently admit it.

## Integration rule

The next lane must consume this module without broadening the current lease. It should implement a live-state collector and event-triggered rescan adapter in new paths, bind its output to this snapshot schema, and stop if `main`, authority, evidence, or lease state changes. Shared orchestration, workflow, package, authority-manifest, deployment, and generated-output files require their own explicit leases and independent verification.
